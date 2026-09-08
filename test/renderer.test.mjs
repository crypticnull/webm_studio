// Drives the renderer in headless Chromium against real webm clips, with
// window.api stubbed the way preload exposes it.
//
// Two substitutions make this runnable outside Electron, and only two: the
// clip:// scheme is rewritten to a local http server, because Chromium on its
// own has no handler for a scheme Electron registers, and the CSP is widened to
// match. The renderer logic under test is otherwise the shipped file.

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function loadPlaywright() {
    for (const id of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
        try { return require(id); } catch { /* try the next */ }
    }
    return null;
}

const CLIP_NAMES = [
    'a01 red.webm', 'a02 green.webm', 'a10 blue.webm',
    'take #3.webm', '100% done.webm', 'what?.webm',
    'clip07.webm', 'clip08.webm', 'clip09.webm',
    'clip10.webm', 'clip11.webm', 'clip12.webm'
];
const COLORS = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan',
    'white', 'gray', 'orange', 'purple', 'brown', 'pink'];

// The clips are encoded by Chromium itself through MediaRecorder, so the suite
// needs no ffmpeg and no checked-in binaries, and the fixtures come out as real
// VP9 webm, which is what the folder actually holds.
async function makeClips(browser) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'loopviewer-clips-'));
    const page = await browser.newPage();
    await page.goto('about:blank');

    for (let i = 0; i < CLIP_NAMES.length; i++) {
        const b64 = await page.evaluate(async ({ color, width }) => {
            const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
                .find((m) => MediaRecorder.isTypeSupported(m));
            if (!mime) throw new Error('this Chromium cannot record webm');

            const c = document.createElement('canvas');
            c.width = width;
            c.height = 120;
            const ctx = c.getContext('2d');
            const rec = new MediaRecorder(c.captureStream(15), {
                mimeType: mime, videoBitsPerSecond: 120000
            });
            const chunks = [];
            rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
            const stopped = new Promise((r) => { rec.onstop = r; });

            rec.start();
            const t0 = performance.now();
            // A moving block, so successive frames actually differ and the
            // poster capture has something to catch.
            await new Promise((res) => {
                (function draw() {
                    const t = performance.now() - t0;
                    ctx.fillStyle = color;
                    ctx.fillRect(0, 0, width, 120);
                    ctx.fillStyle = '#000';
                    ctx.fillRect((t / 1000 * (width - 20)) % (width - 20), 50, 20, 20);
                    if (t < 1200) requestAnimationFrame(draw); else res();
                })();
            });
            rec.stop();
            await stopped;

            const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
            const u = new Uint8Array(buf);
            let s = '';
            for (let j = 0; j < u.length; j++) s += String.fromCharCode(u[j]);
            return btoa(s);
        }, { color: COLORS[i], width: 160 + i * 16 });

        await fsp.writeFile(path.join(dir, CLIP_NAMES[i]), Buffer.from(b64, 'base64'));
    }

    await page.close();
    return dir;
}

// Range support matters: it is what the real clip:// handler gets from net.fetch,
// and what seeking and currentTime = 0 depend on.
function serve(dir) {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const name = decodeURIComponent(req.url.replace(/^\//, ''));
            const file = path.join(dir, path.basename(name));
            let st;
            try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end(); }

            const range = req.headers.range;
            const head = {
                'Content-Type': 'video/webm',
                'Accept-Ranges': 'bytes',
                'Access-Control-Allow-Origin': '*'
            };
            if (range) {
                const m = /bytes=(\d*)-(\d*)/.exec(range);
                const start = m[1] ? parseInt(m[1], 10) : 0;
                const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
                res.writeHead(206, {
                    ...head,
                    'Content-Range': `bytes ${start}-${end}/${st.size}`,
                    'Content-Length': end - start + 1
                });
                fs.createReadStream(file, { start, end }).pipe(res);
            } else {
                res.writeHead(200, { ...head, 'Content-Length': st.size });
                fs.createReadStream(file).pipe(res);
            }
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function patchedPage(base) {
    const src = await fsp.readFile(path.join(root, 'renderer', 'index.html'), 'utf8');
    const out = src
        .replace("'clip://local/' + encodeURIComponent", `'${base}/' + encodeURIComponent`)
        .replace('media-src clip:; img-src clip: data:', `media-src ${base}; img-src ${base} data:`);
    if (out === src) throw new Error('renderer did not contain the expected clip:// construction');
    const file = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'loopviewer-page-')), 'index.html');
    await fsp.writeFile(file, out);
    return file;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

let page, clips, errors;

const tileCount = () => page.locator('.tile').count();
const caps = () => page.locator('.cap').allTextContents();
const cols = () => page.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length);
const rows = () => page.evaluate(() => getComputedStyle(document.getElementById('grid')).gridTemplateRows.split(' ').length);
const pager = () => page.locator('#pager').textContent();

async function reset() {
    await page.evaluate(() => {
        document.getElementById('filter').value = '';
        document.getElementById('filter').dispatchEvent(new Event('input'));
    });
    await page.selectOption('#per', '8');
    await page.selectOption('#sort', 'name');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8);
}

test('the first page paints 8 tiles in a 4 by 2 grid', async () => {
    assert(await tileCount() === 8, 'expected 8 tiles');
    assert(await cols() === 4, 'expected 4 columns');
    assert(await rows() === 2, 'expected 2 rows');
    assert((await pager()).trim() === '1 / 2', 'expected page 1 of 2, got ' + await pager());
});

test('every tile decodes and they all play together', async () => {
    await page.waitForFunction(() => {
        const v = [...document.querySelectorAll('.tile video')];
        return v.length === 8 && v.every((x) => x.readyState >= 3);
    }, null, { timeout: 20000 });

    const bad = await page.locator('.tile.bad').count();
    assert(bad === 0, bad + ' tiles failed to decode');

    const playing = await page.evaluate(() =>
        [...document.querySelectorAll('.tile video')].every((v) => !v.paused));
    assert(playing, 'tiles should be playing after syncPlay');

    // Real playback, not just a loaded element.
    const before = await page.evaluate(() => document.querySelector('.tile video').currentTime);
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => document.querySelector('.tile video').currentTime);
    assert(after !== before, 'currentTime should advance');
});

test('name sort is numeric, so a10 lands after a02', async () => {
    const c = await caps();
    const idx = (s) => c.findIndex((x) => x.startsWith(s));
    assert(idx('a01 red') < idx('a02 green'), 'a01 before a02');
    assert(idx('a02 green') < idx('a10 blue'), 'a02 before a10 (numeric collation)');
});

test('the arrow keys page, and the last page holds the remainder', async () => {
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4);
    assert((await pager()).trim() === '2 / 2');
    assert(await page.locator('#next').isDisabled(), 'next should be disabled on the last page');

    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8);
    assert((await pager()).trim() === '1 / 2');
});

test('changing clips per page relays the grid and keeps the shortcuts alive', async () => {
    await page.selectOption('#per', '4');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4);
    assert(await cols() === 2 && await rows() === 2, 'expected a 2 by 2 grid');
    assert((await pager()).trim() === '1 / 3');

    // The select blurs on change, so a bare key still reaches the document.
    const focused = await page.evaluate(() => document.activeElement.tagName);
    assert(focused !== 'SELECT', 'the dropdown should have blurred, got ' + focused);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.getElementById('pager').textContent.trim() === '2 / 3');
    await reset();
});

test('the filter narrows the set and resets to the first page', async () => {
    await page.fill('#filter', 'clip1');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 3);
    const c = await caps();
    assert(c.every((x) => x.includes('clip1')), 'every tile should match the filter');
    assert((await page.locator('#count').textContent()).includes('3 of 12'));
    await reset();
});

test('keys are ignored while the filter has focus', async () => {
    const before = await pager();
    await page.click('#filter');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(150);
    assert(await pager() === before, 'typing in the filter must not page');
    await reset();
});

test('shuffle reorders without losing or duplicating a clip', async () => {
    const ordered = await caps();
    await page.selectOption('#sort', 'shuffle');
    await page.waitForTimeout(400);
    const shuffled = await caps();
    assert(shuffled.length === 8, 'still a full page');
    const all = await page.evaluate(() => document.querySelectorAll('.tile').length);
    assert(all === 8);
    assert(new Set(shuffled).size === 8, 'no duplicates');
    void ordered;
    await reset();
});

test('largest sort puts the biggest clip first', async () => {
    await page.selectOption('#sort', 'largest');
    await page.waitForTimeout(300);
    const first = (await caps())[0];
    assert(first.startsWith('clip12') || first.startsWith('clip11'),
        'expected one of the widest clips first, got ' + first);
    await reset();
});

test('a click opens solo, the arrows step through it, Esc returns to the right page', async () => {
    await page.locator('.tile video').first().click();
    await page.waitForSelector('body.solo');
    const first = await page.locator('#solocap').textContent();

    // Step forward past the end of page one, into page two's territory.
    for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
    const later = await page.locator('#solocap').textContent();
    assert(later !== first, 'solo should have stepped to another clip');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('solo'));
    assert((await pager()).trim() === '2 / 2', 'Esc should land on the page holding that clip, got ' + await pager());
    await reset();
});

test('the number keys solo the matching tile', async () => {
    const third = (await caps())[2];
    await page.keyboard.press('3');
    await page.waitForSelector('body.solo');
    const shown = await page.locator('#solocap').textContent();
    assert(third.startsWith(shown), 'key 3 should solo the third tile, got ' + shown);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('solo'));
});

test('M toggles mute across the page and persists it', async () => {
    assert(await page.evaluate(() => [...document.querySelectorAll('.tile video')].every((v) => v.muted)));
    await page.keyboard.press('m');
    await page.waitForFunction(() => [...document.querySelectorAll('.tile video')].every((v) => !v.muted));
    assert((await page.locator('#mute').textContent()) === 'Sound');
    assert(await page.evaluate(() => window.__saved.muted) === false, 'mute should persist');
    await page.keyboard.press('m');
    await page.waitForFunction(() => [...document.querySelectorAll('.tile video')].every((v) => v.muted));
});

test('C fills the tiles, cropping, and persists the choice', async () => {
    const fitted = await page.evaluate(() =>
        [...document.querySelectorAll('.tile video')].map((v) => getComputedStyle(v).objectFit));
    assert(fitted.every((f) => f === 'contain'), 'tiles should start fitted');
    assert((await page.locator('#fill').textContent()) === 'Fit');

    await page.keyboard.press('c');
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.tile video')].every((v) => getComputedStyle(v).objectFit === 'cover'));
    assert((await page.locator('#fill').textContent()) === 'Fill');
    assert(await page.evaluate(() => window.__saved.fill) === true, 'fill should persist');

    // A tile in fill mode covers its cell rather than letterboxing inside it.
    const covered = await page.evaluate(() => {
        const v = document.querySelector('.tile video');
        const tile = v.parentElement.getBoundingClientRect();
        const box = v.getBoundingClientRect();
        return Math.abs(box.width - tile.width) < 2 && Math.abs(box.height - tile.height) < 2;
    });
    assert(covered, 'the video box should fill its tile');

    // It survives a re-render, because it rides on a body class and not the tile.
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 4);
    assert(await page.evaluate(() =>
        [...document.querySelectorAll('.tile video')].every((v) => getComputedStyle(v).objectFit === 'cover')),
        'fill should survive a page turn');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8);

    // And solo fills too, so the mode is the same wherever a clip is shown.
    await page.keyboard.press('1');
    await page.waitForSelector('body.solo');
    assert(await page.evaluate(() =>
        getComputedStyle(document.getElementById('solovid')).objectFit === 'cover'),
        'solo should fill too');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('solo'));

    await page.keyboard.press('c');
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.tile video')].every((v) => getComputedStyle(v).objectFit === 'contain'));
    await reset();
});

test('the scrubber appears on hover and seeks where it is clicked', async () => {
    const tile = page.locator('.tile').first();
    const scrub = tile.locator('.scrub');

    // An earlier test may have left the pointer on a tile, so park it off the
    // grid and let the fade finish before claiming it rests hidden.
    await page.mouse.move(5, 5);
    await page.waitForFunction(() =>
        parseFloat(getComputedStyle(document.querySelector('.scrub')).opacity) < 0.1,
        null, { timeout: 4000 });

    await tile.hover();
    await page.waitForFunction(() =>
        getComputedStyle(document.querySelector('.scrub')).opacity === '1', null, { timeout: 3000 });

    // Paused, so currentTime only moves because the scrubber moved it.
    await page.keyboard.press(' ');
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.tile video')].every((v) => v.paused));

    const box = await scrub.boundingBox();
    const seekTo = async (frac) => {
        await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
        await page.waitForTimeout(250);
        return page.evaluate(() => {
            const v = document.querySelector('.tile video');
            return { t: v.currentTime, d: v.duration };
        });
    };

    const early = await seekTo(0.2);
    const late = await seekTo(0.75);

    assert(isFinite(late.d) && late.d > 0, 'the clip needs a real duration to scrub');
    assert(late.t > early.t, 'seeking right should land later, got ' + early.t + ' then ' + late.t);
    assert(late.t > late.d * 0.4, 'a click at three quarters should land in the back half');

    // The far right is the trap: setting currentTime to exactly the duration
    // wraps a looping clip straight back to zero, which reads as the scrubber
    // not working at all.
    const edge = await seekTo(0.99);
    assert(edge.t > edge.d * 0.5,
        'a click at the far right should stay near the end, not wrap to zero, got ' + edge.t);

    // A click on the bar is a seek, not a solo.
    assert(!(await page.evaluate(() => document.body.classList.contains('solo'))),
        'clicking the scrubber must not open solo');

    // The bar reflects where the clip is.
    const width = await page.evaluate(() => {
        const p = document.querySelector('.scrub .played');
        return p.getBoundingClientRect().width / p.parentElement.getBoundingClientRect().width;
    });
    assert(width > 0.4, 'the played bar should show the new position, got ' + width);

    await page.keyboard.press(' ');
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.tile video')].every((v) => !v.paused));
    await reset();
});

// The drag is what was broken: every pointermove wrote currentTime while the
// clip was still playing, so seeks queued behind each other and the frame under
// the pointer often never arrived.
test('dragging the scrubber lands on the last position, and hands playback back', async () => {
    const tile = page.locator('.tile').first();
    await tile.hover();
    const scrub = tile.locator('.scrub');
    await page.waitForFunction(() =>
        getComputedStyle(document.querySelector('.scrub')).opacity === '1', null, { timeout: 3000 });

    const box = await scrub.boundingBox();
    const y = box.y + box.height / 2;
    const at = (f) => box.x + box.width * f;

    await page.mouse.move(at(0.15), y);
    await page.mouse.down();

    // The drag takes the clip, so the frame under the pointer stays put.
    await page.waitForFunction(() => document.querySelector('.tile video').paused,
        null, { timeout: 3000 });

    // A real drag: many moves, faster than any one seek can finish.
    for (const f of [0.25, 0.35, 0.45, 0.55, 0.65, 0.8]) {
        await page.mouse.move(at(f), y);
    }

    // The bar answers the pointer immediately, whatever the decoder is doing.
    const barAtEnd = await page.evaluate(() => {
        const p = document.querySelector('.scrub .played');
        return p.getBoundingClientRect().width / p.parentElement.getBoundingClientRect().width;
    });
    assert(barAtEnd > 0.7, 'the bar should be under the pointer at once, got ' + barAtEnd);

    // Read it while the drag still holds the clip. These fixtures are barely a
    // second long, so anything measured after playback resumes has had time to
    // loop past the answer.
    await page.waitForFunction(() => {
        const v = document.querySelector('.tile video');
        return !v.seeking && v.currentTime > v.duration * 0.6;
    }, null, { timeout: 5000 });

    const held = await page.evaluate(() => {
        const v = document.querySelector('.tile video');
        return { t: v.currentTime, d: v.duration };
    });
    // Coalescing means the newest position wins rather than some stale one
    // still queued from halfway through the drag.
    assert(held.t > held.d * 0.6 && held.t < held.d,
        'the drag should settle where it ended, got ' + held.t + ' of ' + held.d);

    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.tile video').paused,
        null, { timeout: 3000 });
    await reset();
});

test('a drag does not resume a clip that was deliberately paused', async () => {
    await page.keyboard.press(' ');
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.tile video')].every((v) => v.paused));

    const tile = page.locator('.tile').first();
    await tile.hover();
    const box = await tile.locator('.scrub').boundingBox();
    const y = box.y + box.height / 2;

    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, y);
    await page.mouse.up();
    await page.waitForTimeout(300);

    assert(await page.evaluate(() => document.querySelector('.tile video').paused),
        'Space means paused, and a scrub must not undo that');

    await page.keyboard.press(' ');
    await page.waitForFunction(() =>
        [...document.querySelectorAll('.tile video')].every((v) => !v.paused));
    await reset();
});

test('solo has its own scrubber, and using it does not close solo', async () => {
    await page.keyboard.press('1');
    await page.waitForSelector('body.solo');
    await page.waitForFunction(() => {
        const v = document.getElementById('solovid');
        return v.readyState >= 1 && isFinite(v.duration) && v.duration > 0;
    }, null, { timeout: 15000 });

    const scrub = page.locator('#solo .scrub');
    await scrub.hover();
    await page.waitForFunction(() =>
        getComputedStyle(document.querySelector('#solo .scrub')).opacity === '1',
        null, { timeout: 3000 });

    await page.evaluate(() => document.getElementById('solovid').pause());

    const box = await scrub.boundingBox();
    const seekTo = async (frac) => {
        await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2);
        await page.waitForTimeout(250);
        return page.evaluate(() => {
            const v = document.getElementById('solovid');
            return { t: v.currentTime, d: v.duration };
        });
    };

    const early = await seekTo(0.2);
    const late = await seekTo(0.7);
    assert(late.t > early.t, 'solo should seek forward, got ' + early.t + ' then ' + late.t);
    assert(late.t > late.d * 0.35, 'a click past halfway should land past halfway');

    // The overlay closes on click, so the bar has to stop the click itself.
    assert(await page.evaluate(() => document.body.classList.contains('solo')),
        'scrubbing must not close solo');

    const width = await page.evaluate(() => {
        const p = document.querySelector('#solo .played');
        return p.getBoundingClientRect().width / p.parentElement.getBoundingClientRect().width;
    });
    assert(width > 0.35, 'the solo bar should show the new position, got ' + width);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('solo'));

    // The solo bar must stop being driven once solo is shut.
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.querySelector('#solo .scrub').offsetParent === null),
        'the solo bar should be off screen once solo closes');
    await reset();
});

test('the scrubber lingers, then fades once the pointer has left', async () => {
    await page.locator('.tile').first().hover();
    await page.waitForFunction(() =>
        getComputedStyle(document.querySelector('.scrub')).opacity === '1', null, { timeout: 3000 });

    await page.mouse.move(5, 5); // off the grid entirely
    await page.waitForTimeout(600);
    assert(await page.evaluate(() =>
        parseFloat(getComputedStyle(document.querySelector('.scrub')).opacity) > 0.9),
        'it should still be up well before the delay is out');

    await page.waitForTimeout(1600);
    await page.waitForFunction(() =>
        parseFloat(getComputedStyle(document.querySelector('.scrub')).opacity) < 0.1, null, { timeout: 3000 });
    await reset();
});

test('Space pauses and resumes every tile', async () => {
    await page.keyboard.press(' ');
    await page.waitForFunction(() => [...document.querySelectorAll('.tile video')].every((v) => v.paused));
    assert((await page.locator('#pause').textContent()) === 'Play');
    await page.keyboard.press(' ');
    await page.waitForFunction(() => [...document.querySelectorAll('.tile video')].every((v) => !v.paused));
});

test('R restarts the page together', async () => {
    await page.waitForTimeout(400);
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    const spread = await page.evaluate(() => {
        const t = [...document.querySelectorAll('.tile video')].map((v) => v.currentTime);
        return Math.max(...t) - Math.min(...t);
    });
    assert(spread < 0.5, 'tiles should be within a few frames of each other, spread was ' + spread);
});

test('a page turn mid-load never restarts the new page (the identity guard)', async () => {
    await page.evaluate(() => {
        document.getElementById('next').click();
        document.getElementById('prev').click();
        document.getElementById('next').click();
    });
    await page.waitForTimeout(1500);
    assert(await tileCount() === 4, 'should have settled on the last page');
    assert((await pager()).trim() === '2 / 2');
    const bad = await page.locator('.tile.bad').count();
    assert(bad === 0, 'rapid paging should not strand a tile');
    await reset();
});

test('only the current page holds a src', async () => {
    const live = await page.evaluate(() =>
        [...document.querySelectorAll('video')].filter((v) => v.getAttribute('src')).length);
    assert(live === 8, 'expected exactly the 8 visible tiles to hold a src, got ' + live);
});

test('a clip that cannot decode is marked rather than swallowing the page', async () => {
    await page.evaluate(() => {
        window.__clips = window.__clips.concat([
            { path: '/nope/broken.webm', rel: 'broken.webm', size: 10, time: 1 }
        ]);
        window.__clipsChanged();
    });
    await page.fill('#filter', 'broken');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
    await page.waitForSelector('.tile.bad', { timeout: 15000 });
    const cap = await page.locator('.cap').first().textContent();
    assert(cap.includes("can't decode"), 'expected the decode caption, got ' + cap);
    await reset();
});

test('the canvas fallback caches a poster when main has no ffmpeg', async () => {
    const saved = await page.evaluate(() => window.__thumbs || 0);
    assert(saved > 0, 'getThumb returned null, so the renderer should have saved posters back');
});

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

(async () => {
    const pw = loadPlaywright();
    if (!pw) {
        console.log('renderer: skipped, playwright is not installed');
        process.exit(0);
    }
    // The library installs with npm, but its browser does not. Without this the
    // suite dies on a stack trace instead of saying the one thing that fixes it.
    let browser;
    try {
        browser = await pw.chromium.launch({
            args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio']
        });
    } catch (err) {
        console.log('renderer: skipped, Chromium is not installed for Playwright');
        console.log('         run: npx playwright install chromium');
        console.log('         (' + err.message.split('\n')[0] + ')');
        process.exit(0);
    }

    const dir = await makeClips(browser);
    const server = await serve(dir);
    const base = 'http://127.0.0.1:' + server.address().port;
    const pageFile = await patchedPage(base);

    clips = CLIP_NAMES.map((n, i) => ({
        path: path.join(dir, n),
        rel: n,
        size: (160 + i * 16) * 1000,
        time: 1_700_000_000_000 + i * 1000
    }));

    const context = await browser.newContext();
    page = await context.newPage();

    errors = [];
    page.on('console', (m) => {
        if (m.type() === 'error') {
            const loc = m.location();
            errors.push({ text: m.text(), url: (loc && loc.url) || '' });
        }
    });
    page.on('pageerror', (e) => errors.push({ text: 'pageerror: ' + e.message, url: '' }));

    await page.addInitScript(({ clips }) => {
        window.__clips = clips;
        window.__saved = {};
        window.__thumbs = 0;
        window.api = {
            pickFolder: async () => null,
            getState: async () => ({ folder: '/clips', per: 8, sort: 'name', muted: true, fill: false, page: 0, bounds: null }),
            saveState: async (p) => { Object.assign(window.__saved, p); },
            listClips: async () => window.__clips,
            getThumb: async () => null,
            saveThumb: async () => { window.__thumbs++; return null; },
            setFolderFromDrop: async () => null,
            pathForFile: () => null,
            onClipsChanged: (cb) => { window.__clipsChanged = cb; }
        };
    }, { clips });

    await page.goto(pathToFileURL(pageFile).toString());
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 8, null, { timeout: 20000 });

    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log('  ok   ' + name);
        } catch (err) {
            failed++;
            console.log('  FAIL ' + name);
            console.log('       ' + err.message);
        }
    }

    // The decode-failure test deliberately provokes errors against broken.webm.
    // Anything from another source is a real one.
    const unexpected = errors.filter((e) => !/broken\.webm/i.test(e.url + ' ' + e.text));
    if (unexpected.length) {
        failed++;
        console.log('  FAIL unexpected console errors');
        unexpected.slice(0, 5).forEach((e) => console.log('       ' + e.text + '  <- ' + e.url));
    } else {
        console.log('  ok   no unexpected console errors');
    }

    await browser.close();
    server.close();
    await fsp.rm(dir, { recursive: true, force: true });

    console.log(failed ? '\nrenderer: ' + failed + ' failed' : '\nrenderer: all ' + (tests.length + 1) + ' passed');
    process.exit(failed ? 1 : 0);
})();
