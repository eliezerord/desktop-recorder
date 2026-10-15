# Desktop Recorder

A free screen recorder for Windows. Record a screen or a single window with a camera bubble on top, or just the camera, and get an MP4 that is ready to edit. AI agents can drive it too, through the `drec` command.

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
- **The panel, the bubble toolbar and the pill never show up in the video.**
- **Saves an MP4** (H.264, constant 30 fps, AAC audio) to your own `Videos\Desktop Recorder` folder. Change it in the panel ("Recordings folder") or with `drec set --output-dir`.

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
```

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
```

Checks the WebM to MP4 step without opening the app.

The full smoke test opens the app, drives it with simulated clicks and with the real `drec` command, records short clips of a screen, a window and the camera, and closes. It saves to the folder you give it and keeps its own settings, so it does not touch yours:

```bash
DR_SMOKE=1 DR_OUTPUT_DIR="C:\path\to\temp" DR_LOG="C:\path\to\smoke.log" ./node_modules/electron/dist/electron.exe .
```

It writes one `SMOKE {...}` line with every check. Run it on `dist/win-unpacked/Desktop Recorder.exe` too before publishing, since that is where ffmpeg, the effect model and the click hook have to load from the package. Simulated clicks run inside the app's windows, so dragging and real mouse clicks still need a manual check. `DR_DEBUG=1` copies the windows' console messages to the log.

## Files

- `src/main.js` - windows, screen and window choice, PC sound, shortcuts, saving, the `drec` commands.
- `src/control.html`, `control.js`, `control.css` - the panel and the recording itself.
- `src/camera-pipeline.js` - the camera with its background effect, shared by the bubble and the panel.
- `src/bubble-windows.js` - the bubble, its toolbar and the recording pill.
- `src/bubble.*`, `src/toolbar.*`, `src/recpill.*` - what each of those windows shows.
- `src/click-overlay.js`, `src/clicks.*` - click highlights.
- `src/cli-server.js` and `cli/drec.js`, `cli/drec.cmd` - the `drec` command, app side and terminal side.
- `src/convert.js` - WebM to MP4 with ffmpeg.
- `src/i18n.js` - every text in English, Spanish and Portuguese.
- `src/smoke.js` - the smoke test.
- `build/` - the icon, the script that draws it, and the installer step that adds `drec` to your PATH.

## License

MIT, see [LICENSE](LICENSE).

The installer also ships third-party software under its own licenses:

- [FFmpeg](https://ffmpeg.org) (GPL-3.0, via `ffmpeg-static`), run as a separate program; its license is installed with the app.
- [MediaPipe](https://mediapipe.dev) and its selfie segmenter model (Apache-2.0).
- [Electron](https://www.electronjs.org) (MIT) and [uiohook-napi](https://github.com/SnosMe/uiohook-napi) (MIT).
