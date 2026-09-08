'use strict';

// The whole bridge. Five calls from the handoff, plus a thumb write-back for the
// canvas fallback, a drop handler, and the folder-changed nudge. No node in the
// renderer, nothing else exposed.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
    pickFolder: () => ipcRenderer.invoke('pickFolder'),
    getState: () => ipcRenderer.invoke('getState'),
    saveState: (partial) => ipcRenderer.invoke('saveState', partial),
    listClips: (folder) => ipcRenderer.invoke('listClips', folder),
    getThumb: (path, mtime) => ipcRenderer.invoke('getThumb', path, mtime),
    saveThumb: (path, mtime, dataUrl) => ipcRenderer.invoke('saveThumb', path, mtime, dataUrl),
    setFolderFromDrop: (path) => ipcRenderer.invoke('setFolderFromDrop', path),

    // Chromium hands the renderer a File with no usable path under sandboxing.
    // webUtils is the supported way back to one.
    pathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch {
            return null;
        }
    },

    onClipsChanged: (cb) => {
        ipcRenderer.on('clips-changed', () => cb());
    }
});
