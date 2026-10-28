# Desktop Recorder

A free screen recorder for Windows. Record a screen or a single window with a camera bubble on top, or just the camera, and get an MP4 that is ready to edit. Turn a recording into a polished video afterwards: the screen as a rounded Card on a Background, smooth zoom where you clicked and a camera Bubble, in 16:9 or 9:16. Layouts can switch between the screen and your camera during the video. AI agents can drive it too, through the `drec` command.

The interface comes in English, Spanish and Brazilian Portuguese: pick one at the top of the panel, or with `drec set --language es`.

## Download

1. Go to [Releases](https://github.com/eliezerord/desktop-recorder/releases/latest) and download `Desktop-Recorder-Setup-x.y.z.exe`.
2. Run it. It adds a desktop shortcut, a Start menu entry and the `drec` command.
3. The installer is not signed, so the first time Windows may show "Windows protected your PC". Click **More info**, then **Run anyway**.

To uninstall: Settings, Apps, Desktop Recorder.

## What it does

- **Record a screen** (any of your monitors) **or a window**, such as one browser window. A single browser tab can only be captured from inside the browser, so pick the browser window.
- **Camera bubble** you drag anywhere. Hover it for its toolbar: remove, small, medium, full screen (Esc to leave).
- **Camera effects:** blur the background, or replace it with a color or a picture. A ring around the camera, in any color.
- **Highlight mouse clicks** with a soft circle, handy for tutorials.
- **Microphone and PC sound**, mixed into one track.
- **Record, pause, resume and stop** from the panel, from the pill next to the bubble, or with Ctrl+Shift+R and Ctrl+Shift+P.
- **The panel, the bubble toolbar, the pill and, in screen recordings, the camera bubble itself never show up in the video.** The camera is saved as its own file instead (see Projects below).
- **Saves an MP4** (H.264, constant 30 fps, AAC audio) to your own `Videos\Desktop Recorder` folder. Change it in the panel ("Recordings folder") or with `drec set --output-dir`. A screen or window recording has no camera bubble in this MP4.
- **Keeps a Project for every screen or window recording**, in a `Projects` folder inside the recordings folder: `screen.mp4` (the same file as the MP4, stored once), `camera.webm` (the camera with its effect, when you recorded with one), `events.json` (every click and the mouse path, in milliseconds of video time, pauses not counted, positions in physical screen pixels) and `project.json` (what was recorded). Nothing is deleted automatically (see Project storage below). On a screen recording the system cursor is part of the video; a window recording has none (`drec doctor --probe-cursor on` tests your PC).

- **Export a polished video** from any Project (`drec export`, or Export in the Editor): the screen as a rounded Card with a soft shadow on a Background, smooth zoom at every click, a smooth cursor and click circles, the camera as a Bubble (round, or a square with rounded corners) on the Card or beside it, 16:9 for YouTube or 9:16 for Reels, trimmed if you like. The plain MP4 stays as it was.
- **Layouts that change during the video:** the Card, the screen filling the video, your camera filling the video, or the screen and the camera side by side (one above the other in 9:16). Each change glides in about 0.3 s.
- **The Editor** (Edit next to a Project in the panel, or `drec edit`) previews that video and lets you change it: Background, margin, corners, format, the Layouts and every Zoom on a timeline, where the Bubble sits, its shape and how big it is, and where the video starts and ends.

Everything runs on your PC. The background effect uses Google's MediaPipe selfie segmenter, which ships inside the app, so it works offline.

## drec: control it from a terminal or an AI agent

### Quick start

```bash
drec doctor                        # checks screens, camera, mic, MP4 converter and save folder
drec screens                       # numbered list of screens
drec windows                       # numbered list of open windows
drec start --screen 2 --clicks on  # 3 s countdown, then records
drec pause
drec resume
drec stop                          # waits for the MP4 and prints its path
drec record --seconds 30 --window "Chrome" --background blur
drec projects                      # your Projects, newest first, with their size
drec delete-raw 3 --yes            # free the space of Project 3, keep its plain MP4
drec edit latest                   # open the Editor on the last Project
drec zooms latest                  # the last Project's Zooms, numbered
drec zoom-add latest --at 12.5 --strength 2   # a Zoom at 12.5 s where no click happened
drec zoom-delete latest 2          # remove Zoom 2
drec layouts latest                # the last Project's Layout points, numbered
drec layout-add latest --at 8 --kind split    # from 8 s, the screen and the camera side by side
drec layout-change latest 2 --kind camera     # point 2 now fills the video with the camera
drec layout-move latest 2 --at 10  # point 2 now starts at 10 s
drec layout-delete latest 2        # remove Layout point 2
drec export latest --background dusk --bubble-place outside   # a styled MP4 from the last Project
```

`drec export` puts the screen or window on a 1920x1080 canvas as a rounded Card with a soft shadow on a Background (ten built-in gradients: `ocean`, `sunset`, `forest`, `dusk`, `peach`, `mint`, `slate`, `midnight`, `sand`, `rose`) and draws the camera as a round Bubble, either on the Card (`--bubble-place inside`) or on the Background beside it (`outside`, the default, which makes the Card a little smaller). `--bubble-corner` picks the corner, and `--bubble-shape rounded` makes the Bubble a square with rounded corners, the same size and in the same place, its ring following the shape (`circle`, the default, keeps it round; the Editor's Bubble panel has the same two shapes, Circle and Square). The shape is for the exported video: the live bubble you see while recording stays round. The MP4 is saved next to the plain one, as `<project name> styled.mp4`.

**Vertical and trim.** `--aspect 9:16` makes a 1080x1920 video for Reels (`16:9`, 1920x1080, is the default). The Card keeps the usual margin and fills the width, and the Background fills the rest: an outside Bubble sits just above the Card (top corners) or just below it (bottom corners), and the two are centred together. `--trim-start 12.5` and `--trim-end 40` export only that part of the recording: the sound, the camera, the Zoom, the cursor and the click circles stay in step with it, and a Zoom that falls outside it is left out. The trim is kept in the Project (`project.json`, `trim` with `start` and `end` in milliseconds), so the next export of that Project uses it; `--trim-start 0 --trim-end end` brings the whole recording back. The aspect is chosen on each export, or saved as part of your default look (below).

**Your own picture as the Background.** `drec export latest --background-image C:\pictures\wall.jpg` uses a PNG, JPEG or WebP of your own, scaled to cover the whole canvas. It is checked first (it must exist, be a real picture and not be damaged; otherwise the export stops with a clear message and nothing is made or changed) and then copied into the Project as `background.png`, `.jpg` or `.webp`, so moving or deleting the original does not matter. The Project keeps it: its next exports use it too, until you take it out with `--background-image none`. Choosing a built-in Background on purpose (`--background rose`) wins for that one export only.

**Default look.** `drec set` also saves how every export should look unless told otherwise. Its options carry a `look-` prefix because `drec set --background` is already the camera's background effect: `--look-background`, `--look-bubble-place`, `--look-bubble-corner`, `--look-bubble-shape`, `--look-aspect`, `--look-margin`, `--look-card-corners`, `--look-bubble-size`, `--look-zoom`, `--look-cursor`, `--look-clicks` and `--look-background-image PATH|none` (the picture is copied into the app's own folder; it is used from there and not copied into each Project). `drec status` shows what is saved, `--look-reset on` forgets it all, and a wrong value is refused before anything is saved. Whatever you say on an export wins over the default, and the rest stays default. `--margin 0` to `15` is the space around the Card in percent of the shorter side (default 5).

**Zoom.** Every click makes the view glide in about 1.6 times on the spot that was clicked, hold for a moment and glide back. Clicks that come close together share one zoom, and a click far from the last one slides the view over to it. The zooms are worked out the first time you export and kept in the Project's `project.json` under `zoom` (`enabled` and a list of `start`, `end`, `strength`, `x`, `y`; times in milliseconds of video time, `x` and `y` as fractions of the screen), so a later edit is what the next export uses. `drec export latest --zoom off` makes one without zoom.

**Cursor and click circles.** A window recording has no cursor in its video, so Export draws one: a smooth, slightly larger arrow that glides after the mouse (it follows the recorded path with about 70 ms of smoothing, and disappears while the mouse is outside the window). A screen recording already has the real cursor in its video, so no second one is drawn. Every click gets a yellow circle that grows and fades, in both kinds of recording, unless you recorded with click highlights on (`project.json` then says `clicksInVideo: true`, because the circles are already in the video). Both follow the Zoom, so they stay on the spot they point at. `--cursor off` and `--clicks off` switch them off. A yellow circle does not show on a yellow background.

**Editor.** The Edit button next to a Project in the panel, or `drec edit <project>`, opens the Editor on it; it never opens by itself after a recording. It plays the Project with its look and lets you scrub through it, and you can pick a built-in Background or your own picture (copied into the Project), set the margin and how round the Card's corners are, and choose 16:9 or 9:16. Every change is saved in the Project's `project.json` under `exportLook`, so `drec export` uses it too and `drec projects` shows it: an export takes the default look, then the Project's own look, then whatever you ask for on that export. Its Export button makes the same video `drec export` makes with no options. The preview is drawn with the same functions and from the same plan as Export, and a test compares its frames with exported ones. `--card-corners 0` to `6` (percent of the shorter side, default 2.2) sets the corners from `drec` as well, and `--look-card-corners` saves it in the default look.

**Zoom timeline.** Under the preview, the Editor shows every Zoom of the Project as a block on a timeline. Pick a block to change it: drag it to move it in time, drag one of its edges to change its length (at least 0.5 s), set its strength (1.1 to 3) with the slider, click the preview to aim it at that spot, or delete it. On a focused block the arrow keys move it by 0.1 s (1 s with Ctrl), Shift with an arrow changes its length, and Delete removes it. "Add a Zoom here" puts a new 2 s Zoom at the playhead, aimed at the middle. The "Zoom on" switch turns all Zoom off or on for this Project (saved as `zoom` in `exportLook`) and keeps the list. Every edit is saved in `project.json` under `zoom.zooms`, the list `drec export` uses.

**Zoom commands.** An agent can edit a Project's Zooms without the Editor, on the same list the Editor's timeline shows and `drec export` uses. `drec zooms [project]` lists them: number, start and length in seconds, strength and aim (fractions of the screen), and whether Zoom is on for the Project. `drec zoom-add <project> --at SECONDS` adds one at that moment of the recording, 2 s long and strength 1.6 unless `--length` and `--strength` say otherwise, aimed at the middle unless `--aim X,Y` says where (`0.8,0.2` is near the top right). `drec zoom-strength <project> <number> <strength>` sets how far one goes in (1.1 to 3), and `drec zoom-delete <project> <number>` removes one; the Zooms after it move down one number. Zooms are numbered in time order from 1, so run `drec zooms` again after a change. The Project must be named for the three edits (`latest` works), so a Zoom number is never read as a Project number. A wrong number, strength or Project is refused with what to fix, and an Editor open on that Project reloads so its numbers stay right.

**Bubble and trim in the Editor.** Drag the camera Bubble in the preview by its middle: where you let go decides where it goes, on the Card or beside it, and in which corner (the same eight spots `--bubble-place` and `--bubble-corner` offer; a dashed outline in the Bubble's shape shows where it is going, and the Card lights up when it would land on it). Drag its edge to make it bigger or smaller. The Bubble panel does the same with buttons for the place and the corner and a size slider. The size is `bubbleSize` in the look, 10 to 40 percent of the shorter side; left out, the Bubble keeps the size it was recorded with. `--bubble-size` sets it for one export and `--look-bubble-size` in the default look. The timeline shows the whole recording: drag the yellow handles to set where the video starts and ends (at least 0.5 s apart; arrow keys move a focused handle), and the parts left out are shaded. The trim is saved in `project.json` as `trim`, the same one `--trim-start` and `--trim-end` set, and the preview plays only the kept part.

**Layouts.** A Layout is how the screen and the camera share the video, and it can change during it. **Card** is the look above; **Full screen** fills the video with the screen recording (keeping its shape, with square corners and no shadow; the Bubble keeps its size in its corner of the video); **Full camera** fills the video with the camera, mirrored and cropped around its middle, and hides the screen (so a Zoom has no visible effect there). **Split** puts the screen and the camera side by side in 16:9 (the screen on the left 60 %, the camera on the right 40 %) or one above the other in 9:16 (the screen in the top half, the camera in the bottom half): the camera fills its part, cropped around its middle, and the screen is a Card fitted to its own part, with the usual margin; `--swap on` puts the camera first (left, or on top). Full camera and Split need a Project recorded with a camera; without one they are refused with the reason. A Project has a list of Layout points, each "from this moment, use this Layout"; with none it is all Card, as before. `drec layouts [project]` lists them (number, start, kind and swap) and `drec layout-add <project> --at SECONDS --kind card|screen|camera|split [--swap on]` adds one (`--at 0` sets the Layout the video starts with). `drec layout-change <project> <number> --kind ... [--swap on|off]` changes one (`--swap` alone turns a Split's swap on or off), `drec layout-move <project> <number> --at SECONDS` moves one and `drec layout-delete <project> <number>` removes one; like the Zoom commands, edits name the Project, numbers count from 1 in time order, the first point stays at 0 s, points stay 0.3 s apart, and an Editor open on the Project reloads. From each point the view moves to the new Layout in about 0.3 s, fast at first and then gliding to rest: the Bubble grows into the full camera or the camera's part of a Split and shrinks back into its corner, and a part that appears or goes (the screen, for Full camera) fades in place with a small scale. The points are saved in `project.json` under `layouts`. A Project whose Layouts move is exported by drawing every frame with the Editor preview's own code, so the export looks exactly like the preview; it takes about twice as long as a plain export (`docs/adr/0002-draw-moving-layouts-frame-by-frame.md`). In the Editor the timeline has a Layout row: each point is a segment, coloured by kind with a small drawing, that lasts until the next point. "Add Layout here" adds one at the playhead; a click picks one and the panel's Layout section changes its kind (four buttons with drawings), turns Swap on or off for a Split, or deletes it; dragging a segment's start moves the point; arrow keys move a focused point (Ctrl for 1 s steps) and Delete removes it. The first point always starts at 0: it can only change kind. Full camera and Split are off for a Project with no camera.

**Colours.** The plain MP4 and the Project's screen video keep the recorder's BT.601 colours and say so in all three colour tags, so browsers and players show them exactly. A styled export is converted to BT.709, the standard for HD video, and tagged that way. Recordings made before this change carry only one tag, so a browser shows their reds a little orange; their exports are right.

**Project storage.** A Project's raw material (camera, clicks, the picture) takes space on top of the plain MP4; the screen video itself is stored once, shared with the plain MP4. The panel's Projects list and `drec projects` show each Project's size. "Delete raw material, keep MP4" (a button per Project in the panel, after a confirmation, or `drec delete-raw <project> --yes`) removes everything but `project.json` and keeps the plain MP4; that Project then says its raw material is gone and cannot be exported again. It is refused when the plain MP4 is missing or is not the same recording, because the raw material would then be the only copy. Without `--yes`, `drec delete-raw` only says what it would free. Nothing is ever deleted on its own.

Every setting in the app can be changed from `drec`: what to record (`--mode`, `--screen`, `--window`), camera and mic, PC sound, bubble size and corner, background effect, border and its color, click highlights, the save folder and the interface language. `drec help` lists every option. If the app is closed, `drec` opens it.

### Agent usage

- Add `--json` to any command for machine-readable output. Errors go to stderr and the exit code is 1.
- `drec` never asks questions, so it is safe in scripts and agent loops.
- Pick windows by part of their title (`--window "Claude"`): window numbers can change between calls.
- `drec start` returns once recording has begun, after the 3 s countdown; `drec stop` returns the MP4 path.
- `drec` only controls the recording. To record a tutorial, an agent moves the mouse and types with its own computer-use tools while `drec` records. The skill in [`skills/desktop-recorder/`](skills/desktop-recorder/SKILL.md) tells an agent how to turn a request like "get ready to record my second monitor" into commands, and how to act at a human pace.

`drec` talks to the app through a Windows named pipe, which only exists on your PC, and every call needs a token that the app keeps in your user profile. Nothing listens on the network.

### Troubleshooting

- **`drec` is not recognized:** open a new terminal after installing; terminals opened before the install do not see the updated PATH.
- **`not running and could not be reached`:** run `drec open`.
- **`Wrong CLI token`:** close and reopen Desktop Recorder.
- **`No Project matches "..."`:** run `drec projects` and use `latest`, a number or part of the name.
- **`... raw material was deleted`:** that Project can no longer be exported or edited; its plain MP4 is still there.
- **`Zoom N does not exist`:** run `drec zooms` again; Zooms are numbered in time order, so the numbers change after an edit.
- **`Layout point N does not exist`:** run `drec layouts` again; Layout points are numbered in time order too.
- **`... needs a camera, and this Project was recorded without one`:** Full camera and Split need a camera; use `card` or `screen` for that Project.
- **Anything else:** `drec doctor` names the broken part and how to fix it.

## Build from source

```bash
npm install
npm start          # run the app
npm run dist       # build the installer into dist/
npm run icon       # redraw build/icon.png and build/icon.ico
node cli/drec.js help
```

If Electron did not download its program during `npm install`, run `node node_modules/electron/install.js`.

### Tests

```bash
node test/convert-test.js
node test/look-test.js
node test/zoom-test.js
node test/layouts-test.js
node test/pointer-test.js
node test/storage-test.js
./node_modules/electron/dist/electron.exe test/export-test.js
./node_modules/electron/dist/electron.exe test/editor-test.js
```

- `convert-test` - the WebM to MP4 step, without opening the app.
- `look-test` - where the Card and the Bubble go, and where a dragged Bubble lands.
- `zoom-test` - which clicks make a Zoom, how the view moves, the edits to the Zoom list, and that the expressions given to ffmpeg compute the same numbers as the JavaScript.
- `layouts-test` - editing the Layout points (Full camera refused without a camera), where each Layout puts the screen and the camera, and the 0.3 s move between them.
- `pointer-test` - the cursor and click circles: the smoothing, which clicks are alive, where they land on the Card (also while zoomed) and what the little pictures look like.
- `storage-test` - a Project's size and deleting its raw material.
- `export-test` - Export on a made-up Project (green screen, red camera) in a hidden window, reading pixels from the result.
- `editor-test` - the real Editor on made-up Projects: it changes the look, the Layouts, the Zooms, the Bubble and its shape, and the trim through its own buttons and drags, and compares preview frames with exported ones.

`test/spikes/moving-export.js` is not a test: it times two ways of exporting a Card that moves and prints how close each is to the preview (`docs/adr/0002-draw-moving-layouts-frame-by-frame.md`).

The full smoke test opens the app, drives it with simulated clicks and with the real `drec` command, records short clips of a screen, a window and the camera, and closes. It saves to the folder you give it and keeps its own settings, so it does not touch yours:

```bash
DR_SMOKE=1 DR_OUTPUT_DIR="C:\path\to\temp" DR_LOG="C:\path\to\smoke.log" ./node_modules/electron/dist/electron.exe .
```

It writes one `SMOKE {...}` line with every check. Run it on `dist/win-unpacked/Desktop Recorder.exe` too before publishing, since that is where ffmpeg, the effect model and the click hook have to load from the package. Simulated clicks run inside the app's windows, so dragging and real mouse clicks still need a manual check. `DR_DEBUG=1` copies the windows' console messages to the log.

The cursor probe asks whether this PC can capture a screen or a window without the system cursor. It shows a blue window over the first screen and moves the mouse by itself for about 30 seconds, so leave the mouse alone. Run it on its own, or from the running app:

```bash
DR_PROBE=cursor DR_LOG="C:\path\to\probe.log" ./node_modules/electron/dist/electron.exe .
drec doctor --probe-cursor on
```

The first prints one `PROBE {...}` line with the measurements. The second saves the answer, and plain `drec doctor` reports it afterwards.

## Files

- `src/main.js` - windows, screen and window choice, PC sound, shortcuts, saving, the `drec` commands.
- `src/control.html`, `control.js`, `control.css` - the panel and the recording itself.
- `src/camera-pipeline.js` - the camera with its background effect, shared by the bubble and the panel.
- `src/bubble-windows.js` - the bubble, its toolbar and the recording pill.
- `src/bubble.*`, `src/toolbar.*`, `src/recpill.*` - what each of those windows shows.
- `src/click-overlay.js`, `src/clicks.*` - click highlights.
- `src/cli-server.js` and `cli/drec.js`, `cli/drec.cmd` - the `drec` command, app side and terminal side.
- `src/convert.js` - WebM to MP4 with ffmpeg.
- `src/capture-project.js` - the Project folder of a screen or window recording: files, clicks and mouse path.
- `src/export.js`, `look.mjs`, `look-window.js`, `look-renderer.*` - Export: `look.mjs` holds the backgrounds and the layout, the hidden window draws the fixed layers as PNGs, ffmpeg puts the video together.
- `src/layouts.mjs` - the Layout points: editing them, where each Layout puts the screen and the camera, and the move between them (`node test/layouts-test.js`).
- `src/frame-export.js`, `frame-export.html`, `frame-export-page.mjs`, `frame-export-preload.js` - Export by drawing every frame with the preview's code, for Projects whose Layouts move.
- `src/zoom.mjs` - the Zoom rules, the motion, and the same motion as ffmpeg expressions.
- `src/pointer.mjs` - the smooth cursor and the click circles: positions on the Card and the little pictures Export overlays.
- `src/editor-window.js`, `src/editor.html`, `src/editor.js` and `src/preview.mjs` - the Editor: its window and settings, its page, and the preview frame drawn with Export's own pieces (`test/editor-test.js`).
- `src/project-storage.js` - a Project's size and "delete raw material, keep MP4" (`node test/storage-test.js`).
- `src/cursor-probe.js` - the test behind `drec doctor --probe-cursor`.
- `src/i18n.js` - every text in English, Spanish and Portuguese.
- `src/smoke.js` - the smoke test; `src/smoke-capture.js` is its Project checks and runs alone with `DR_SMOKE=capture`.
- `build/` - the icon, the script that draws it, and the installer step that adds `drec` to your PATH.

## License

MIT, see [LICENSE](LICENSE).

The installer also ships third-party software under its own licenses:

- [FFmpeg](https://ffmpeg.org) (GPL-3.0, via `ffmpeg-static`), run as a separate program; its license is installed with the app.
- [MediaPipe](https://mediapipe.dev) and its selfie segmenter model (Apache-2.0).
- [Electron](https://www.electronjs.org) (MIT) and [uiohook-napi](https://github.com/SnosMe/uiohook-napi) (MIT).
