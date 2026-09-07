'use strict';

// The main-process parts that can be checked without a window: the recursive
// scan, the clip:// encoding against filenames that break naive URL building,
// and the thumb cache key.

require('./electron-stub.cjs');

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const main = require('../main.js');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('VIDEO_RE takes the listed containers and nothing else', () => {
    for (const ok of ['a.webm', 'a.mp4', 'a.m4v', 'a.MOV', 'a.ogv', 'a.ogg', 'a.mkv', 'a.avi']) {
        assert.ok(main.VIDEO_RE.test(ok), ok + ' should match');
    }
    for (const no of ['a.png', 'a.txt', 'a.webm.part', 'webm', 'a.mp3']) {
        assert.ok(!main.VIDEO_RE.test(no), no + ' should not match');
    }
});

test('clipUrl survives #, ? and % and decodes back to the same path', () => {
    const cases = [
        'X:/clips/plain.webm',
        'X:/clips/take #3.webm',
        'X:/clips/100% done.webm',
        'X:/clips/what?.webm',
        'X:/clips/a b/c+d&e.webm',
        'X:/clips/\u00e9\u00e8 accent.webm'
    ];
    for (const p of cases) {
        const url = main.clipUrl(p);
        // The same two lines the protocol handler runs.
        const decoded = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
        assert.strictEqual(decoded, p, 'round trip failed for ' + p);
        assert.ok(pathToFileURL(decoded).toString().length > 0);
    }
});

test('clipUrl normalizes Windows backslashes', () => {
    const url = main.clipUrl('X:\\clips\\sub\\take.webm');
    const decoded = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
    assert.strictEqual(decoded, 'X:/clips/sub/take.webm');
});

test('thumbFile is keyed by path and mtime together', () => {
    main.loadConfig();
    const a = main.thumbFile('X:/c/a.webm', 1000);
    const b = main.thumbFile('X:/c/a.webm', 1000);
    const c = main.thumbFile('X:/c/a.webm', 2000);
    const d = main.thumbFile('X:/c/b.webm', 1000);
    assert.strictEqual(a, b, 'same path and mtime should be the same file');
    assert.notStrictEqual(a, c, 'a new mtime must invalidate the poster');
    assert.notStrictEqual(a, d, 'a different clip must be a different poster');
    assert.ok(a.endsWith('.png'));
});

test('scan walks subfolders, keeps only video files, and reports rel, size and time', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'loopviewer-scan-'));
    await fsp.mkdir(path.join(root, 'sub', 'deeper'), { recursive: true });
    await fsp.writeFile(path.join(root, 'top.webm'), 'aaaa');
    await fsp.writeFile(path.join(root, 'notes.txt'), 'ignore me');
    await fsp.writeFile(path.join(root, 'sub', 'mid.mp4'), 'bbbbbb');
    await fsp.writeFile(path.join(root, 'sub', 'deeper', 'take #3.webm'), 'cc');

    const out = await main.scan(root);
    const rels = out.map((c) => c.rel).sort();

    assert.deepStrictEqual(rels, ['sub/deeper/take #3.webm', 'sub/mid.mp4', 'top.webm']);
    for (const c of out) {
        assert.ok(path.isAbsolute(c.path), 'path should be absolute');
        assert.ok(!c.rel.includes('\\'), 'rel should use forward slashes');
        assert.ok(c.size > 0, 'size should be real');
        assert.ok(c.time > 0, 'mtime should be real');
    }
    const top = out.find((c) => c.rel === 'top.webm');
    assert.strictEqual(top.size, 4);
});

test('scan does not loop forever on a symlink pointing back up the tree', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'loopviewer-loop-'));
    await fsp.mkdir(path.join(root, 'sub'));
    await fsp.writeFile(path.join(root, 'sub', 'a.webm'), 'x');
    try {
        await fsp.symlink(root, path.join(root, 'sub', 'back'), 'dir');
    } catch {
        return 'skipped, no symlink permission';
    }
    const out = await Promise.race([
        main.scan(root),
        new Promise((_r, reject) => setTimeout(() => reject(new Error('scan did not terminate')), 8000))
    ]);
    assert.strictEqual(out.length, 1);
});

test('scan returns empty rather than throwing on a folder it cannot read', async () => {
    const out = await main.scan(path.join(os.tmpdir(), 'loopviewer-does-not-exist-' + Date.now()));
    assert.deepStrictEqual(out, []);
});

(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            const note = await fn();
            console.log('  ok   ' + name + (note ? '  (' + note + ')' : ''));
        } catch (err) {
            failed++;
            console.log('  FAIL ' + name);
            console.log('       ' + err.message);
        }
    }
    console.log(failed ? '\nmain: ' + failed + ' failed' : '\nmain: all ' + tests.length + ' passed');
    process.exit(failed ? 1 : 0);
})();
