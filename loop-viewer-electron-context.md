# Loop Viewer — Electron port handoff

## What this is

`loop-viewer.html` is a finished, working single-file web app: a paged grid video player for
browsing a folder of ~120 short looping clips (mostly VP9 webm). It runs in Chrome from
`file://`, uses a `webkitdirectory` picker, and works well. It is not a prototype.

**The job is a port, not a redesign.** Keep the existing UI, layout, interaction model and
keyboard map exactly as they are unless a change is listed under "What Electron should
change". Every behavior below has been used and approved. Do not "improve" the grid, restyle
the chrome, add a sidebar, add a settings modal, or introduce a framework. No React, no
Tailwind, no build step for the renderer.

---

## Current implementation (the renderer, as shipped)

Single HTML file, vanilla ES5-flavored JS in one IIFE, no dependencies.

**State**

```js
state = { all:[], page:0, per:8, sort:"name", filter:"",
          muted:true, paused:false, urls:[], vids:[], soloIndex:-1, soloUrl:null }
```

Each entry in `all` is `{ file, name, path, size, time, rand }`. `file` is a `File`;
`path` is `webkitRelativePath`; `rand` is a stable shuffle key assigned once per file.

**Key functions**

- `addFiles(list)` — filters by `VIDEO_RE = /\.(webm|mp4|m4v|mov|ogv|ogg|mkv|avi)$/i`, resets page, renders
- `visible()` — applies the name filter, then sorts by name (Intl.Collator numeric) / newest / oldest / largest / shuffle
- `render()` — revokes old object URLs, sets grid template from `LAYOUTS`, builds the page's tiles, calls `syncPlay()`
- `syncPlay()` — waits for `canplay` on every tile (5s timeout each), then sets `currentTime = 0` and plays them together
- `releaseUrls()` — pauses, clears `src`, calls `load()`, revokes URLs. This is what keeps 118 files cheap: **only the current page is ever decoding**
- `openSolo(i)` / `closeSolo()` — full-screen single clip with its own object URL; closing returns to the page containing that index
- `updateChrome()` — counts, page indicator, button states

**Layouts** — `{1:[1,1], 2:[2,1], 4:[2,2], 6:[3,2], 8:[4,2], 12:[4,3], 16:[4,4]}` (cols, rows)

**Keyboard** — `←/→` page (or step file-by-file in solo), `Esc` close solo, `Space` pause/play
all, `R` resync restart, `M` mute, `F` fullscreen, `1-9` solo that tile. Keys are ignored while
an `INPUT` or `SELECT` has focus; the two dropdowns call `.blur()` on change so shortcuts keep
working afterward.

**Other behavior worth preserving**

- Drag-and-drop of a folder onto the window (recursive `webkitGetAsEntry` walk)
- Tiles that fail to decode get a `.bad` class and a red "can't decode" caption
- `per`, `sort` and `muted` persist via `localStorage` in a try/catch
- Tiles are `object-fit: contain` on black, captions are the relative path, dimmed until hover

**Verified** in headless Chromium against 10 generated VP9 clips: paging, solo + solo nav,
Esc returning to the right page, per-page change, name filter, shuffle, mute, pause-all. No
console errors.

---

## What Electron should change

These are the only reasons the port is worth doing. Each one is a real annoyance in the
browser build.

1. **Remember the folder.** Native `dialog.showOpenDialog({ properties: ['openDirectory'] })`,
   path persisted to a JSON config in `app.getPath('userData')`, re-scanned on launch. The
   picker should be needed once, ever. Keep a "Change folder" button in the header where the
   current picker sits.
2. **Read from disk instead of `File` objects.** Main process scans recursively with
   `fs.promises.readdir(dir, { withFileTypes: true })` + `stat` for size and mtime, returns a
   plain array of `{ path, rel, size, time }` over IPC. Drop `webkitdirectory` and the object
   URL churn; `state.all` entries carry a real path instead of a `File`.
3. **Poster frames.** Cache a first-frame (or ~10%-in) PNG per clip in `userData/thumbs`,
   keyed by path + mtime, so pages paint instantly instead of showing black while buffering.
   Generate with `ffmpeg-static` if present, otherwise a hidden offscreen video + canvas.
   Set the poster on each `<video>`; the video still autoplays and loops over it.
4. **Real app window.** Own window, taskbar entry, remembered window bounds and maximized
   state, no browser chrome. Remember the last page index too.
5. **Optional, only if easy:** `fs.watch` on the folder to pick up new files without a
   relaunch, and duration read from ffprobe shown in the caption.

Nothing else. Do not add tagging, ratings, playlists, export, or a database.

---

## Architecture

```
loop-viewer/
  package.json
  main.js         # window, config, folder dialog, fs scan, clip:// protocol, thumb cache
  preload.js      # contextBridge, no node in the renderer
  renderer/
    index.html    # loop-viewer.html, ported
```

**Serving the video files.** Do not disable `webSecurity` and do not point `<video>` at
`file://`. Register a custom protocol in the main process and hand it off to `net.fetch`, which
supports range requests (needed for seeking and for reliable playback of larger files):

```js
protocol.handle('clip', (req) => {
  const p = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
  return net.fetch(pathToFileURL(p).toString());
});
```

Register it as a privileged scheme with `{ standard: true, supportFetchAPI: true, stream: true,
bypassCSP: false }` before `app.whenReady()`. Encode paths with `encodeURIComponent` — the
clips have arbitrary filenames and `#`, `?`, `%` will break naive URL building.

**webPreferences:** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
`autoplayPolicy: 'no-user-gesture-required'` (without that last one the sync-play behavior
falls apart). Keep hardware acceleration on; Chromium decodes VP9 fine.

**IPC surface** (keep it this small):

- `pickFolder()` → `string | null`
- `getState()` → `{ folder, per, sort, muted, page, bounds }`
- `saveState(partial)` → void
- `listClips(folder)` → `[{ path, rel, size, time }]`
- `getThumb(path, mtime)` → `string | null` (a `clip://` or data URL)

**Renderer changes are mechanical:** replace `addFiles(FileList)` with a handler for the IPC
array, replace `URL.createObjectURL(f.file)` with `clip://` + encoded path, and make
`releaseUrls()` just detach `src` (nothing to revoke). Replace the `localStorage` prefs with
`saveState`/`getState`. Everything else in the renderer stays byte-for-byte where possible.

---

## Packaging

`electron-builder`, Windows target, portable `.exe` preferred over an installer, no code
signing. It only ever runs on one machine (Windows 11). Ship a `npm start` dev script too.

---

## Gotchas

- The sync-play `canplay` wait races if a page change lands mid-wait. The current code guards
  with an identity check on `state.vids`; keep that guard when refactoring.
- Range requests matter. If seeking or `currentTime = 0` misbehaves, the protocol handler is
  the first suspect.
- Poster frames must be invalidated by mtime, not just path.
- At 16-up with a folder of long clips, decode load is the ceiling. Keep the "only the current
  page is live" rule absolutely — it is the reason this is usable at 118 files.
- Do not stream, upload, index, or transmit the clips anywhere. Local only, no telemetry, no
  network calls at all.

## Definition of done

Launches to the last folder with no picker, grid paints with posters immediately, all tiles
loop in unison, every existing keyboard shortcut still works, window position and settings
survive a restart, and it packages to a portable exe.
