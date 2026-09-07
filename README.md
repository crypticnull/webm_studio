# Loop Viewer

A folder of 120 short loops is unwatchable in a file browser, and it's
worse in a normal player, because the thing you're judging is how a loop
sits next to the fifteen loops around it. This is a paged grid that plays
a whole page in unison, keeps only that page decoding, and gets out of
the way.

It started as a single-file web app that worked, but that ran from
`file://`, forgot the folder every launch, and painted black while it
buffered. This is the Electron port of it. The grid, the layout map and
the keyboard are the same, and the four things the browser couldn't do
are the reason the port exists.

## Quick start

Needs Node 22 on the PATH for the first run only.

```
X:\_CLAUDE\26_09_07_webm-studio\app.cmd
```

That's the whole thing. Pin it to the taskbar. The first launch installs
Electron, which takes a minute, then asks once for the folder and never
asks again. Every launch after that opens on the last folder, the last
page, and the window where you left it.

If npm is set to block install scripts, that first launch stops and says
so, because Electron's postinstall is what downloads `electron.exe` and
the install reports success without it. Two commands clear it:

```
npm --prefix X:\_CLAUDE\26_09_07_webm-studio install-scripts approve electron ; npm --prefix X:\_CLAUDE\26_09_07_webm-studio rebuild electron
```

`ffmpeg-static` is blocked the same way and is optional. Approve it the
same way for sharper posters, or skip it and let the app draw its own.

To work on it instead of just run it:

```
npm --prefix X:\_CLAUDE\26_09_07_webm-studio install ; npm --prefix X:\_CLAUDE\26_09_07_webm-studio start
```

## The keyboard

| Key | What |
| --- | --- |
| `←` `→` | page, or step clip by clip inside solo |
| `1` to `9` | solo that tile |
| `Esc` | close solo, landing on the page holding that clip |
| `Space` | pause and play everything |
| `R` | restart the page together |
| `C` | fill the tiles, cropping what doesn't fit |
| `M` | mute |
| `F` | fullscreen |

Keys are ignored while the filter box or a dropdown has focus, and the
dropdowns hand focus back on change so the shortcuts keep working right
after you use one.

Fill is the one worth knowing about. Tiles letterbox by default, so you
see the whole frame on black. Fill makes every tile edge to edge and
crops whatever doesn't fit, which is what you want when you're reading
the grid as a wall rather than judging a single frame. Solo follows the
same setting, and it survives a relaunch.

## Layout

| Path | What |
| --- | --- |
| `app.cmd` | the launcher, the only thing to run |
| `main.js` | window, config, folder dialog, recursive scan, `clip://` protocol, poster cache |
| `preload.js` | the whole bridge, nine calls, no node in the renderer |
| `renderer/index.html` | the app, one file, vanilla JS, no framework and no build step |
| `test/main.test.cjs` | scan, URL encoding and poster keying, against real temp folders |
| `test/renderer.test.mjs` | the grid driven in headless Chromium against real VP9 clips |
| `loop-viewer-electron-context.md` | the handoff this was built from, kept as the record |

## Tests

```
npm --prefix X:\_CLAUDE\26_09_07_webm-studio test
```

Twenty six tests, offline, no network and no fixtures in the repo. The
renderer suite generates its own VP9 clips through Chromium's own
`MediaRecorder`, serves them over a loopback server, and drives the real
renderer file: paging, solo and its arrows, `Esc` landing on the right
page, the numeric name sort, the filter, mute, pause, resync, and the
guard that stops a page turn landing mid load from restarting the wrong
page. It checks the tiles actually decode and play rather than only that
the elements exist. Two substitutions make that possible outside
Electron, and only two, both of them in the test and not the app: the
`clip://` scheme becomes a loopback URL, because Chromium on its own has
no handler for a scheme Electron registers, and the CSP is widened to
match.

Playwright installs the library but not the browser it drives, so the
renderer suite needs one more command the first time:

```
npx --prefix X:\_CLAUDE\26_09_07_webm-studio playwright install chromium
```

Without it that suite skips itself and says exactly that, rather than
failing. Playwright is a dev dependency and ships in nothing. CI runs
both suites on every push, on Ubuntu, against the lockfile.

## What the port changed, and nothing else

1. **The folder is remembered.** A native directory dialog, the path kept
   in `userData`, rescanned on launch. The picker is needed once.
2. **Files are read from disk**, not through a `webkitdirectory` picker,
   so there are no `File` objects and no object URL churn. Clips reach the
   `<video>` tags over a registered `clip://` protocol backed by
   `net.fetch`, which answers range requests, and every path is encoded
   whole because real clip names contain `#`, `?` and `%`.
3. **Poster frames**, cached per clip in `userData/thumbs` and keyed by
   path and mtime together, so an edited clip gets a new poster instead of
   a stale one. Pages paint instantly instead of going black.
4. **A real window**, with its own taskbar entry, remembered bounds and
   maximized state, and the last page index.
5. `fs.watch` picks up new files without a relaunch, and each caption
   carries the clip's duration, read off the video element.

Nothing else moved. There's no tagging, no ratings, no playlists, no
export and no database, and the rule that only the current page ever
holds a `src` is intact, which is the reason 118 files stay cheap.

## Honest limits

Posters come from `ffmpeg-static` when it's installed, and it's an
optional dependency, so a plain `npm install` that skips it falls back to
the renderer drawing its own first frame into a canvas and handing it
back to be cached. That fallback needs the clip served as shareable, so
the `clip://` handler sets `Access-Control-Allow-Origin` and the tiles
are `crossOrigin`. Without both, the canvas read throws instead of
returning a frame, and that's the first thing to check if posters go
missing.

`fs.watch` is recursive here, which Windows supports and Linux doesn't.
On a platform without it the watch is skipped and you relaunch to see new
files. Nothing else in the app is Windows only, but Windows 11 is the
only place it's been run for real.

The suites run in this container against clips Chromium encodes on the
spot. What hasn't been exercised anywhere is Electron itself, because
this was built in a sandbox with no display, so the window, the dialog,
the `clip://` handler and the packaged exe are all first-run items on the
workstation. The two pieces most likely to want a second look are range
requests through `net.fetch`, which is what seeking rides on, and
`webUtils.getPathForFile`, which is what a dropped folder rides on.

Local only. No telemetry, no network calls, nothing uploaded or indexed
anywhere.
