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

test('mimeFor names the containers, and the posters', () => {
    assert.strictEqual(main.mimeFor('/a/b.webm'), 'video/webm');
    assert.strictEqual(main.mimeFor('/a/b.WEBM'), 'video/webm');
    assert.strictEqual(main.mimeFor('/a/b.mp4'), 'video/mp4');
    assert.strictEqual(main.mimeFor('/a/b.m4v'), 'video/mp4');
    assert.strictEqual(main.mimeFor('/a/b.mov'), 'video/quicktime');
    assert.strictEqual(main.mimeFor('/a/b.mkv'), 'video/x-matroska');
    assert.strictEqual(main.mimeFor('/a/b.png'), 'image/png');
    assert.strictEqual(main.mimeFor('/a/b.weird'), 'application/octet-stream');
});

// This is what seeking rides on. A source that answers Range wrong is one the
// video element treats as unseekable, and a seek then snaps back to zero.
test('parseRange handles the forms a video element actually sends', () => {
    const size = 1000;
    assert.strictEqual(main.parseRange(null, size), null, 'no header means whole file');
    assert.strictEqual(main.parseRange('', size), null);

    assert.deepStrictEqual(main.parseRange('bytes=0-', size), { start: 0, end: 999 },
        'open ended range should run to the last byte');
    assert.deepStrictEqual(main.parseRange('bytes=500-', size), { start: 500, end: 999 });
    assert.deepStrictEqual(main.parseRange('bytes=100-199', size), { start: 100, end: 199 });
    assert.deepStrictEqual(main.parseRange(' bytes=0-0 ', size), { start: 0, end: 0 },
        'a single byte is a legal range');

    // The suffix form, which Chromium uses to read a trailing index.
    assert.deepStrictEqual(main.parseRange('bytes=-200', size), { start: 800, end: 999 });
    assert.deepStrictEqual(main.parseRange('bytes=-5000', size), { start: 0, end: 999 },
        'a suffix longer than the file is the whole file');

    // An end past the file is clamped rather than refused.
    assert.deepStrictEqual(main.parseRange('bytes=900-99999', size), { start: 900, end: 999 });

    assert.strictEqual(main.parseRange('bytes=1000-', size), 'unsatisfiable',
        'a start at or past the end cannot be served');
    assert.strictEqual(main.parseRange('bytes=600-500', size), 'unsatisfiable');
    assert.strictEqual(main.parseRange('bytes=-0', size), 'unsatisfiable');

    // Anything malformed falls back to the whole file rather than throwing.
    for (const bad of ['bytes=', 'bytes=abc-def', 'items=0-10', 'bytes=0-10, 20-30', 'nonsense']) {
        const r = main.parseRange(bad, size);
        assert.ok(r === null || r === 'unsatisfiable', bad + ' should not parse to a range');
    }
});

// The real handler, driven end to end against real files. This is the path
// that was broken: it answered every request with the whole file, so the video
// element decided the clip was not seekable and every seek snapped to zero.
test('serveClip answers a range request with the right bytes', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loopviewer-serve-'));
    const file = path.join(dir, 'take #3.webm');
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
    await fsp.writeFile(file, data);

    const ask = (headers) => main.serveClip(new Request(main.clipUrl(file), { headers }));

    const whole = await ask({});
    assert.strictEqual(whole.status, 200);
    assert.strictEqual(whole.headers.get('accept-ranges'), 'bytes',
        'without this the element will not even try to seek');
    assert.strictEqual(whole.headers.get('content-type'), 'video/webm');
    assert.strictEqual(whole.headers.get('content-length'), '1000');
    assert.ok(Buffer.from(await whole.arrayBuffer()).equals(data), 'whole file should round trip');

    const mid = await ask({ range: 'bytes=100-199' });
    assert.strictEqual(mid.status, 206, 'a range request must be answered 206, not 200');
    assert.strictEqual(mid.headers.get('content-range'), 'bytes 100-199/1000');
    assert.strictEqual(mid.headers.get('content-length'), '100');
    assert.ok(Buffer.from(await mid.arrayBuffer()).equals(data.subarray(100, 200)),
        'the served bytes should be the ones asked for');

    const open = await ask({ range: 'bytes=990-' });
    assert.strictEqual(open.status, 206);
    assert.strictEqual(open.headers.get('content-range'), 'bytes 990-999/1000');
    assert.ok(Buffer.from(await open.arrayBuffer()).equals(data.subarray(990)));

    const suffix = await ask({ range: 'bytes=-10' });
    assert.strictEqual(suffix.status, 206);
    assert.ok(Buffer.from(await suffix.arrayBuffer()).equals(data.subarray(990)));

    const past = await ask({ range: 'bytes=1000-' });
    assert.strictEqual(past.status, 416);
    assert.strictEqual(past.headers.get('content-range'), 'bytes */1000');
});

test('serveClip serves posters and refuses what is not there', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loopviewer-serve2-'));
    const png = path.join(dir, 'poster.png');
    await fsp.writeFile(png, Buffer.from([1, 2, 3, 4]));

    const ok = await main.serveClip(new Request(main.clipUrl(png), { headers: {} }));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('content-type'), 'image/png');
    // The canvas poster fallback reads a tile back out of a canvas, which is
    // only allowed if the clip came with this.
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), '*');

    const missing = await main.serveClip(
        new Request(main.clipUrl(path.join(dir, 'gone.webm')), { headers: {} }));
    assert.strictEqual(missing.status, 404);

    const isDir = await main.serveClip(new Request(main.clipUrl(dir), { headers: {} }));
    assert.strictEqual(isDir.status, 404, 'a directory is not a clip');
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
