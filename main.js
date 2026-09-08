'use strict';

// Main process: one window, a remembered folder, a recursive scan, the clip://
// protocol that feeds the <video> tags, and a poster-frame cache. Nothing here
// touches the network. The only files ever read are the ones under the folder
// the user picked.

const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Readable } = require('node:stream');

const VIDEO_RE = /\.(webm|mp4|m4v|mov|ogv|ogg|mkv|avi)$/i;

const DEFAULTS = {
    folder: null,
    per: 8,
    sort: 'name',
    muted: true,
    fill: false,
    page: 0,
    bounds: null,
    maximized: false
};

// clip:// is registered as a standard scheme so URL parsing behaves. The
// handler below answers Range itself, which is what seeking rides on.
protocol.registerSchemesAsPrivileged([{
    scheme: 'clip',
    privileges: { standard: true, supportFetchAPI: true, stream: true, bypassCSP: false }
}]);

// ---------------------------------------------------------------- config

let configPath = null;
let thumbDir = null;
let config = { ...DEFAULTS };
let saveTimer = null;

function loadConfig() {
    configPath = path.join(app.getPath('userData'), 'config.json');
    thumbDir = path.join(app.getPath('userData'), 'thumbs');
    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config = { ...DEFAULTS, ...raw };
    } catch {
        config = { ...DEFAULTS };
    }
    try {
        fs.mkdirSync(thumbDir, { recursive: true });
    } catch { /* thumbs are a cache, a failure here only costs posters */ }
}

// Writes are debounced because the renderer saves on every page turn.
function saveConfig() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        } catch { /* a config that will not write is not worth crashing over */ }
    }, 250);
}

function saveConfigNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch { /* ditto */ }
}

// ---------------------------------------------------------------- clip urls

// Arbitrary filenames: #, ? and % all appear in real clip names and all break
// naive URL building, so the whole path goes through encodeURIComponent and is
// decoded back in the handler.
function clipUrl(p) {
    return 'clip://local/' + encodeURIComponent(String(p).replace(/\\/g, '/'));
}

const MIME = {
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.ogv': 'video/ogg',
    '.ogg': 'video/ogg',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.png': 'image/png'
};

function mimeFor(p) {
    return MIME[path.extname(String(p)).toLowerCase()] || 'application/octet-stream';
}

// Range parsing, kept pure so it can be tested without a window. A video
// element asks for "bytes=start-", "bytes=start-end" and occasionally
// "bytes=-suffix", and it treats a source that answers any of them wrong as
// one it cannot seek in at all.
function parseRange(header, size) {
    if (!header) return null;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
    if (!m) return null;
    const hasStart = m[1] !== '';
    const hasEnd = m[2] !== '';
    if (!hasStart && !hasEnd) return null;

    let start;
    let end;
    if (!hasStart) {
        // A suffix range: the last N bytes.
        const n = parseInt(m[2], 10);
        if (!n) return 'unsatisfiable';
        start = Math.max(0, size - n);
        end = size - 1;
    } else {
        start = parseInt(m[1], 10);
        end = hasEnd ? parseInt(m[2], 10) : size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end >= size) end = size - 1;
    if (start > end || start >= size || start < 0) return 'unsatisfiable';
    return { start, end };
}

// ---------------------------------------------------------------- scanning

async function scan(dir) {
    const out = [];
    const seen = new Set();

    async function walk(current) {
        // Symlinked directories can point back up the tree; realpath plus a
        // seen set keeps the walk finite.
        let real;
        try {
            real = await fsp.realpath(current);
        } catch {
            return;
        }
        if (seen.has(real)) return;
        seen.add(real);

        let entries;
        try {
            entries = await fsp.readdir(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
            } else if (entry.isSymbolicLink()) {
                let st;
                try {
                    st = await fsp.stat(full);
                } catch {
                    continue;
                }
                if (st.isDirectory()) await walk(full);
                else if (VIDEO_RE.test(entry.name)) out.push(record(full, dir, st));
            } else if (entry.isFile() && VIDEO_RE.test(entry.name)) {
                let st;
                try {
                    st = await fsp.stat(full);
                } catch {
                    continue;
                }
                out.push(record(full, dir, st));
            }
        }
    }

    function record(full, root, st) {
        return {
            path: full,
            rel: path.relative(root, full).split(path.sep).join('/'),
            size: st.size,
            time: st.mtimeMs
        };
    }

    await walk(dir);
    return out;
}

// ---------------------------------------------------------------- thumbnails

let ffmpegPath = null;
let ffmpegResolved = false;

function findFfmpeg() {
    if (ffmpegResolved) return ffmpegPath;
    ffmpegResolved = true;
    // An explicit override wins, so a system ffmpeg can be pointed at without
    // reinstalling anything.
    if (process.env.LOOP_VIEWER_FFMPEG && fs.existsSync(process.env.LOOP_VIEWER_FFMPEG)) {
        ffmpegPath = process.env.LOOP_VIEWER_FFMPEG;
        return ffmpegPath;
    }
    try {
        let p = require('ffmpeg-static');
        if (typeof p === 'string' && p) {
            // Packed builds unpack ffmpeg beside the asar rather than inside it.
            if (!fs.existsSync(p) && p.includes('app.asar')) {
                const unpacked = p.replace('app.asar', 'app.asar.unpacked');
                if (fs.existsSync(unpacked)) p = unpacked;
            }
            if (fs.existsSync(p)) ffmpegPath = p;
        }
    } catch {
        ffmpegPath = null;
    }
    return ffmpegPath;
}

// Keyed by path and mtime together, so an edited clip gets a new poster instead
// of the stale one.
function thumbFile(p, mtime) {
    const key = crypto.createHash('sha1').update(String(p) + ':' + String(mtime)).digest('hex');
    return path.join(thumbDir, key + '.png');
}

function runFfmpeg(args) {
    return new Promise((resolve) => {
        execFile(findFfmpeg(), args, { timeout: 20000, windowsHide: true }, (err) => resolve(!err));
    });
}

async function getThumb(p, mtime) {
    if (!thumbDir) return null;
    const file = thumbFile(p, mtime);
    try {
        await fsp.access(file);
        return clipUrl(file);
    } catch { /* not cached yet */ }

    if (!findFfmpeg()) return null; // renderer falls back to canvas capture

    const ok = await runFfmpeg([
        '-y', '-loglevel', 'error',
        '-i', p,
        '-frames:v', '1',
        '-vf', 'scale=640:-2:flags=bilinear',
        file
    ]);
    if (!ok) return null;
    try {
        await fsp.access(file);
        return clipUrl(file);
    } catch {
        return null;
    }
}

// The canvas fallback in the renderer hands the frame back here so the next
// launch reads it off disk like any ffmpeg-made poster.
async function saveThumb(p, mtime, dataUrl) {
    if (!thumbDir || typeof dataUrl !== 'string') return null;
    const comma = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:image/png;base64,') || comma < 0) return null;
    const file = thumbFile(p, mtime);
    try {
        await fsp.writeFile(file, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
        return clipUrl(file);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- serving

// Files are served straight off disk rather than handed to net.fetch on a
// file:// URL, because that does not answer a Range request, and a video
// element treats a source it cannot range-request as one it cannot seek in.
// Seeking then snaps back to the start, which is exactly what the handoff
// warned this would look like.
async function serveClip(req) {
    let p;
    try {
        p = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    } catch {
        return new Response(null, { status: 400 });
    }

    let st;
    try {
        st = await fsp.stat(p);
    } catch {
        return new Response(null, { status: 404 });
    }
    if (!st.isFile()) return new Response(null, { status: 404 });

    const headers = {
        'Content-Type': mimeFor(p),
        'Accept-Ranges': 'bytes',
        // The poster fallback draws a tile into a canvas and reads it back,
        // which taints unless the clip is explicitly shareable.
        'Access-Control-Allow-Origin': '*',
        // Scrubbing is a burst of range requests over one clip. no-cache made
        // Chromium revalidate every one of them and kept the media cache from
        // holding the clip at all, so each seek went back to disk. The
        // validators carry the mtime, so an edited clip still invalidates.
        'Cache-Control': 'private, max-age=3600',
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
        'ETag': '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"'
    };

    const body = (start, end) => Readable.toWeb(fs.createReadStream(p, { start, end }));
    const range = parseRange(req.headers.get('range'), st.size);

    if (range === 'unsatisfiable') {
        return new Response(null, {
            status: 416,
            headers: { ...headers, 'Content-Range': 'bytes */' + st.size }
        });
    }

    if (range) {
        return new Response(body(range.start, range.end), {
            status: 206,
            headers: {
                ...headers,
                'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + st.size,
                'Content-Length': String(range.end - range.start + 1)
            }
        });
    }

    return new Response(body(0, Math.max(0, st.size - 1)), {
        status: 200,
        headers: { ...headers, 'Content-Length': String(st.size) }
    });
}

// ---------------------------------------------------------------- watching

let watcher = null;
let watchTimer = null;

function watchFolder(win, folder) {
    if (watcher) {
        try { watcher.close(); } catch { /* already gone */ }
        watcher = null;
    }
    if (!folder) return;
    try {
        // Recursive watch is supported on Windows, which is the target. Where it
        // is not, this throws and the app simply does not auto-refresh.
        watcher = fs.watch(folder, { recursive: true }, (_event, name) => {
            if (name && !VIDEO_RE.test(String(name))) return;
            if (watchTimer) clearTimeout(watchTimer);
            watchTimer = setTimeout(() => {
                watchTimer = null;
                if (!win.isDestroyed()) win.webContents.send('clips-changed');
            }, 600);
        });
    } catch {
        watcher = null;
    }
}

// ---------------------------------------------------------------- window

let mainWindow = null;
let boundsTimer = null;

function rememberBounds(win) {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
        boundsTimer = null;
        if (win.isDestroyed()) return;
        config.maximized = win.isMaximized();
        if (!config.maximized && !win.isMinimized()) config.bounds = win.getNormalBounds();
        saveConfig();
    }, 400);
}

function createWindow() {
    const b = config.bounds && typeof config.bounds.width === 'number' ? config.bounds : null;
    mainWindow = new BrowserWindow({
        width: b ? b.width : 1400,
        height: b ? b.height : 900,
        x: b ? b.x : undefined,
        y: b ? b.y : undefined,
        backgroundColor: '#000000',
        title: 'Loop Viewer',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Without this the tiles never start together and the whole
            // sync-play behavior falls apart.
            autoplayPolicy: 'no-user-gesture-required'
        }
    });

    if (config.maximized) mainWindow.maximize();
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('resize', () => rememberBounds(mainWindow));
    mainWindow.on('move', () => rememberBounds(mainWindow));
    mainWindow.on('maximize', () => rememberBounds(mainWindow));
    mainWindow.on('unmaximize', () => rememberBounds(mainWindow));
    mainWindow.on('close', () => {
        if (!mainWindow.isDestroyed()) {
            config.maximized = mainWindow.isMaximized();
            if (!config.maximized && !mainWindow.isMinimized()) {
                config.bounds = mainWindow.getNormalBounds();
            }
        }
        saveConfigNow();
    });
    mainWindow.on('closed', () => { mainWindow = null; });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    watchFolder(mainWindow, config.folder);
    return mainWindow;
}

// ---------------------------------------------------------------- ipc

function registerIpc() {
    ipcMain.handle('pickFolder', async () => {
        const res = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose a folder of clips',
            properties: ['openDirectory']
        });
        if (res.canceled || !res.filePaths.length) return null;
        config.folder = res.filePaths[0];
        config.page = 0;
        saveConfig();
        watchFolder(mainWindow, config.folder);
        return config.folder;
    });

    ipcMain.handle('getState', () => ({
        folder: config.folder,
        per: config.per,
        sort: config.sort,
        muted: config.muted,
        fill: config.fill,
        page: config.page,
        bounds: config.bounds
    }));

    ipcMain.handle('saveState', (_e, partial) => {
        if (!partial || typeof partial !== 'object') return;
        for (const key of ['folder', 'per', 'sort', 'muted', 'fill', 'page']) {
            if (key in partial) config[key] = partial[key];
        }
        saveConfig();
    });

    ipcMain.handle('listClips', async (_e, folder) => {
        const dir = folder || config.folder;
        if (!dir) return [];
        try {
            const st = await fsp.stat(dir);
            if (!st.isDirectory()) return [];
        } catch {
            return [];
        }
        return scan(dir);
    });

    ipcMain.handle('getThumb', (_e, p, mtime) => getThumb(p, mtime));
    ipcMain.handle('saveThumb', (_e, p, mtime, dataUrl) => saveThumb(p, mtime, dataUrl));

    // A folder dropped on the window. A dropped file is taken as its parent,
    // which is what dropping one clip out of a folder means in practice.
    ipcMain.handle('setFolderFromDrop', async (_e, p) => {
        if (!p) return null;
        let dir = p;
        try {
            const st = await fsp.stat(p);
            if (!st.isDirectory()) dir = path.dirname(p);
        } catch {
            return null;
        }
        config.folder = dir;
        config.page = 0;
        saveConfig();
        watchFolder(mainWindow, dir);
        return dir;
    });
}

// ---------------------------------------------------------------- lifecycle

// One window, always. A second launch focuses the one already open.
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        loadConfig();

        protocol.handle('clip', serveClip);

        registerIpc();
        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}

// Exported for the offline tests. Electron never reads these; requiring this
// file outside Electron is what the test harness does to reach the pure parts.
module.exports = { scan, clipUrl, thumbFile, VIDEO_RE, findFfmpeg, loadConfig, parseRange, mimeFor, serveClip };
