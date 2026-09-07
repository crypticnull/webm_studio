'use strict';

// main.js is written for Electron. To test the pure parts (the recursive scan,
// the clip:// encoding, the mtime-keyed thumb cache) outside it, intercept the
// electron require with just enough surface to let the module load.

const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'loopviewer-userdata-'));

const stub = {
    app: {
        getPath: () => userData,
        requestSingleInstanceLock: () => true,
        on() {},
        whenReady: () => new Promise(() => {}), // never resolves: no window in a test
        quit() {}
    },
    BrowserWindow: class { static getAllWindows() { return []; } },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle() {} },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    net: { fetch: async () => ({}) }
};

const load = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return stub;
    return load.call(this, request, parent, isMain);
};

module.exports = { userData };
