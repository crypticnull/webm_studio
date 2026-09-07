'use strict';

// Main process: one window, a remembered folder, a recursive scan, the clip://
// protocol that feeds the <video> tags, and a poster-frame cache. Nothing here
// touches the network. The only files ever read are the ones under the folder
// the user picked.

const { app, BrowserWindow, dialog, ipcMain, protocol, net } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');

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

// clip:// is registered as a standard scheme so URL parsing behaves and
// net.fetch can answer range requests. Range matters: without it, seeking and
// currentTime = 0 misbehave on the larger clips.
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

        protocol.handle('clip', async (req) => {
            const p = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
            // Headers are forwarded so Range survives, which is what seeking and
            // currentTime = 0 ride on.
            const res = await net.fetch(pathToFileURL(p).toString(), { headers: req.headers });
            // The renderer draws a tile into a canvas to make its own poster when
            // there is no ffmpeg. Reading that canvas back taints unless the clip
            // is served as explicitly shareable, and the read throws instead.
            const headers = new Headers(res.headers);
            headers.set('Access-Control-Allow-Origin', '*');
            return new Response(res.body, {
                status: res.status,
                statusText: res.statusText,
                headers
            });
        });

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
module.exports = { scan, clipUrl, thumbFile, VIDEO_RE, findFfmpeg, loadConfig };
