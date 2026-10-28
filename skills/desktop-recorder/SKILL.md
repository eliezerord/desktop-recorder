---
name: desktop-recorder
description: Records the screen, a window or the camera with Desktop Recorder on Windows through its drec command, changes any of the app's settings, and turns a recording into a polished video (Background, smooth zoom, Layouts that switch between screen and camera, 16:9 or 9:16, trim), including tutorials the agent performs itself while it records. Use when the user asks to record their screen, a monitor or a window, get ready to record, make a tutorial, walkthrough or demo, film the agent doing a task "like a human", export or polish a recording, make it vertical for Reels, add or remove a zoom, show their face full screen or in a split with the screen, open the Editor, or mentions Desktop Recorder or drec; Spanish requests count too, like "graba mi pantalla", "graba el monitor 2", "graba solo la ventana de", "prepárate para grabar", "haz un tutorial grabando", "exporta la grabación con fondo", "hazlo vertical para Reels", "quita el zoom", "pantalla dividida" or "abre el editor".
---

# Desktop Recorder

`drec` changes the Desktop Recorder app's settings, starts, pauses and stops recordings, and returns the MP4. It never moves the mouse or types: when the user wants a tutorial, you perform the steps with your own computer-use tools while `drec` records them.

Every screen or window recording also becomes a **Project**: the plain MP4 (no camera bubble in it) plus the camera, the clicks and the mouse path. From a Project, `drec export` makes a polished copy: the screen as a rounded **Card** on a **Background**, a smooth **Zoom** at each click, the camera as a **Bubble** (round, or a square with rounded corners). **Layout points** change, from a moment on, how the screen and the camera share the video: `card` (the default), `screen` (the screen fills the video), `camera` (the camera fills it) or `split` (side by side in 16:9, one above the other in 9:16). The **Editor** lets the user adjust it by hand. The plain MP4 is never changed.

## Rules for every run

1. **Record only what the user agreed to show.** The video captures everything on the chosen screen or window, notifications included. Confirm which screen or window before starting, and clear private content from it first.
2. **Act at a human pace while recording.** Viewers have to follow along: move the mouse in a few steps instead of jumping, type at reading speed, and hold about 1 to 2 seconds on each result before the next action. A tutorial that is too fast is useless to the viewer, however correct.
3. **Start acting only after `drec start` returns.** It returns once the 3 second countdown is over and the recording is running; anything done earlier is not in the video.
4. **Run `drec help` for the exact options.** It is the source of truth for flags and values; this skill does not repeat it.
5. **Delete raw material only after the user says yes to that Project.** `drec delete-raw <project> --yes` removes it for good: the Project can no longer be exported or edited. Without `--yes` it only says what it would free.

## Find drec

Try `drec status`. If the command is not found:
- Installed app: `"%LOCALAPPDATA%/Programs/Desktop Recorder/resources/cli/drec.cmd"` (the installer adds this folder to PATH; terminals opened before the install do not see it).
- Source folder: `node cli/drec.js` from the repo.

If the app is closed, `drec` opens it. Add `--json` when you need to read the output. The first time, or when something fails, run `drec doctor`: it checks screens, camera, mic, the MP4 converter and the save folder, with a fix for each problem.

## From request to command

| The user says | Run |
|---|---|
| "Record my second monitor" | `drec screens`, then `drec start --screen 2` |
| "Only the Claude Code window" | `drec windows`, then `drec start --window "Claude"` (part of the title) |
| "Get ready to record screen 2, I'll tell you when" | `drec set --screen 2 ...` now, `drec start` when they say go |
| "Camera bottom right, background blurred" | `--bubble-corner bottom-right --background blur` (the live bubble; for the exported video, `drec export latest --bubble-corner bottom-right`) |
| "No camera" | `--bubble hidden` (or `--camera none`) |
| "A blue ring around my camera" | `--border on --border-color "#2f5bff"` |
| "Show my clicks" | `--clicks on` |
| "Use my OBS camera" | `--camera "OBS"` (OBS must have its virtual camera started) |
| "Save them in D:/Videos" | `--output-dir "D:/Videos"` |
| "Put the app in Spanish" | `--language es` (`en`, `es` or `pt`) |
| "Stop" / "Pause" | `drec stop` (prints the MP4 path) / `drec pause`, `drec resume` |
| "Make it look nice" / "dale un fondo bonito" | `drec export latest --background dusk` |
| "Vertical for Reels" / "hazlo vertical para Reels" | `drec export latest --aspect 9:16` |
| "Cut the first 3 seconds" / "corta el principio" | `drec export latest --trim-start 3` (`--trim-end 40`, or `end`); the trim is kept |
| "Camera beside the screen, top right" / "la cámara fuera, arriba a la derecha" | `drec export latest --bubble-place outside --bubble-corner top-right` (`inside` puts it on the Card) |
| "Bigger camera in the video" / "la burbuja más grande" | `drec export latest --bubble-size 30` |
| "Square camera, not a circle" / "la cámara cuadrada" | `drec export latest --bubble-shape rounded` (`circle` is the default; `drec set --look-bubble-shape rounded` for every export) |
| "My own picture behind it" / "usa esta imagen de fondo" | `drec export latest --background-image "C:/pics/wall.jpg"` (`none` takes it out) |
| "No zoom" / "sin zoom" | `drec export latest --zoom off` |
| "Show me the zooms" / "qué zooms tiene" | `drec zooms latest` |
| "Zoom in at 12 s on the top right" / "haz zoom en el segundo 12" | `drec zoom-add latest --at 12 --aim 0.8,0.2` |
| "Remove the second zoom" / "quita el segundo zoom" | `drec zooms latest`, then `drec zoom-delete latest 2` |
| "A softer zoom" / "el zoom más suave" | `drec zoom-strength latest 1 1.3` |
| "Show me the layouts" / "qué layouts tiene" | `drec layouts latest` |
| "From 20 s, my face full screen" / "desde el segundo 20, mi cara a pantalla completa" | `drec layout-add latest --at 20 --kind camera` |
| "Screen and face side by side from 8 s" / "pantalla dividida desde el segundo 8" | `drec layout-add latest --at 8 --kind split` (`--swap on` puts the camera first: left, or on top in 9:16) |
| "Start with the screen filling the video" / "empieza con la pantalla completa" | `drec layout-add latest --at 0 --kind screen` (`--at 0` changes the first point) |
| "Make the second one a split" / "cambia el segundo a dividido" | `drec layouts latest`, then `drec layout-change latest 2 --kind split` |
| "In the split, my face on the left" / "en el dividido, mi cara a la izquierda" | `drec layouts latest`, then `drec layout-change latest 2 --swap on` on that Split point (only a Split swaps; in 9:16 it puts the camera on top) |
| "Move it to 15 s" / "muévelo al segundo 15" | `drec layouts latest`, then `drec layout-move latest 2 --at 15` |
| "Remove that layout change" / "quita ese cambio de layout" | `drec layouts latest`, then `drec layout-delete latest 2` (the Layout before it carries on) |
| "Always export like this" / "expórtalo siempre así" | `drec set --look-background dusk --look-aspect 9:16` |
| "Let me adjust it" / "abre el editor" | `drec edit latest` |
| "Which recordings do I have?" / "qué grabaciones tengo" | `drec projects` |
| "Free up space" / "libera espacio" | `drec projects`, ask which, then `drec delete-raw <project> --yes` on a yes |

Settings stay as set until changed, so `drec status` shows what the next recording will use. An export takes the default look (`drec set --look-...`), then what the user set for that Project in the Editor, then what you ask on that export.

## Workflow

Copy this checklist and tick it off:

```text
Recording progress:
- [ ] Step 1: Plan the take
- [ ] Step 2: Pick what to record
- [ ] Step 3: Prepare the screen
- [ ] Step 4: Set up and start
- [ ] Step 5: Perform the steps
- [ ] Step 6: Stop and hand over the file
- [ ] Step 7: Polish it (when asked)
```

**Step 1. Plan the take.** Write the steps of the task as a short list, and ask the user anything that changes the video: which screen or window, camera on or off, narration (mic) or silent, PC sound. Done when the step list and those choices are settled.

**Step 2. Pick what to record.** `drec screens` or `drec windows`. A window recording shows only that window; a screen recording shows the whole monitor. Neither puts the camera in the plain MP4: it is saved apart and added when the Project is exported. Window numbers can change between calls, so select a window by part of its title. Done when you know the exact `--screen N` or `--window "title"`.

**Step 3. Prepare the screen.** Open the app or page the tutorial starts from, put it on the screen you will record, and close or hide anything private. Done when the screen shows the starting point and nothing else the user did not agree to.

**Step 4. Set up and start.** Typical tutorial setup: `drec start --screen 2 --clicks on --mic none --bubble hidden`. Keep the camera and mic only when the user is presenting. Done when `drec start` returns with `phase: recording`.

**Step 5. Perform the steps** with your computer-use tools, following Rule 2. If something goes wrong, `drec pause`, fix it off camera, then `drec resume`: the cut in the video is clean. When a pause cannot save the take (wrong screen, something private appeared), `drec stop`, tell the user, and return to Step 3. Done when the last step's result has been on screen for about 2 seconds.

**Step 6. Stop and hand over the file.** `drec stop` waits for the MP4 and prints its path. Give the user that path; leave opening the video to them. If `stop` reports a failed conversion, it names the WebM it kept; pass that path on instead. Done when the user has the path.

**Step 7 (when asked). Polish it.** `drec export latest` with the options the user asked for, then give the new path (`<name> styled.mp4`, next to the plain one) without opening it. For zoom changes, `drec zooms latest` first: Zooms are numbered in time order, so list again after each change before using a number. If an edit says Zoom is off for the Project, tell the user. Layout points work the same way: `drec layouts latest` first, list again after each change, and keep points at least 0.3 s apart. `camera` and `split` need a Project recorded with a camera; if one is refused for that, say so and offer `card` or `screen`. When the user wants to adjust it by eye, `drec edit latest` opens the Editor. Done when the user has the styled path or the Editor is open.

## When something fails

- **`not running and could not be reached`:** run `drec open`, then retry.
- **`Wrong CLI token`:** close and reopen the app, then retry.
- **`No window "..."` or `No screen "..."`:** the message lists what exists; pick from it.
- **`Can't change ... while recording`:** screen, window, mode, mic and PC sound are set before `start`; camera, bubble, effects and clicks can change mid-recording.
- **`No Project matches "..."`:** run `drec projects` and use `latest`, a number or part of the name.
- **`... raw material was deleted`:** that Project can no longer be exported or edited; only its plain MP4 is left.
- **`Zoom N does not exist`:** run `drec zooms` again; the numbers changed.
- **`Layout point N does not exist`:** run `drec layouts` again; the numbers changed.
- **`... needs a camera, and this Project was recorded without one`:** use `card` or `screen` for that Project.
- **Anything else:** `drec doctor` names the broken part and how to fix it.
