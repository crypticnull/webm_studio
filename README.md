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
| `0` | reset the zoom in solo |
| `M` | mute |
| `F` | fullscreen |

Keys are ignored while the filter box or a dropdown has focus, and the
dropdowns hand focus back on change so the shortcuts keep working right
after you use one.

Solo fills the window. A clip smaller than the screen is scaled up to
fit rather than sitting at its own resolution in the middle of all that
black, and `C` crops it to fill edge to edge instead.

Solo carries a step arrow on each side. They answer to movement rather
than to hover, so they're there the moment the mouse does anything and
gone again a second and a half after it settles, and the one pointing
past the end of the list is dead rather than missing. The arrow keys do
the same thing without reaching for them.

In solo, the scroll wheel zooms, anchored to whatever is under the
pointer, from a fifth of a fit up to eight times it. Past a fit, drag to
pan, and the picture stops where its edge would come inside the frame
rather than sliding off into nothing. Under a fit the whole thing is on
screen anyway, so it sits centred and there is nothing to drag. `0` puts
it back, and so does closing solo or stepping to the next clip, because
carrying a zoom to another clip means arriving somewhere with no idea
where you are. Scaling past the source resolution is the point, so it
gets soft rather than refusing.

Tiles carry no file name. The grid is there to be read as a wall, and a
caption under every tile is noise, so the only thing one ever says is
that a clip could not be decoded. Solo still names the clip it's showing.

Hovering a tile brings up a scrub bar along its bottom edge. Click or
drag it to move through that clip, and it seeks live while you drag. The
drag takes the clip and hands it back on release, because seeking a clip
that's still playing fights the playback and the frame you picked never
settles. Only one seek is ever in flight and it always targets the
newest pointer position, so a fast drag lands where you let go instead
of working through a queue of places you already left.
Solo has the same bar, a little taller since there's room for it.
Clicking the bar never opens the clip full screen and never closes solo,
so scrubbing doesn't fight either of them. Move the pointer away and the bar stays
up for a second and a half before fading, which is long enough to cross
a gap between two tiles without it flickering. A clip whose duration
can't be read doesn't get a bar, because there would be nothing to scrub
along.

Fill is the other one worth knowing about. Tiles letterbox by default, so you
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
   a handler that answers range requests itself, and every path is encoded
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
workstation. `webUtils.getPathForFile`, which is what a dropped folder
rides on, is the piece still worth watching on a first run.

Range requests were the first thing to actually break here, and they
broke exactly where the handoff said they would. Handing a `file://` URL
to `net.fetch` returns the whole clip and never answers a Range request,
so the video element decided the clips weren't seekable and every seek
snapped back to zero. The handler reads the file itself now and answers
206 with a real `Content-Range`, and `serveClip` is exported so the
tests drive that path directly rather than a stand-in that was answering
ranges correctly and hiding the bug.

Local only. No telemetry, no network calls, nothing uploaded or indexed
anywhere.
