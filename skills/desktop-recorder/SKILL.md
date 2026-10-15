---
name: desktop-recorder
description: Records the screen, a window or the camera with Desktop Recorder on Windows through its drec command, and changes any of the app's settings (screen or window, camera, mic, PC sound, bubble size and corner, background blur, border, click highlights, save folder, interface language), including tutorials the agent performs itself while it records. Use when the user asks to record their screen, a monitor or a window, get ready to record, make a screen recording, tutorial, walkthrough or demo video, film the agent doing a task "like a human", or mentions Desktop Recorder or drec; Spanish requests count too, like "graba mi pantalla", "graba el monitor 2", "graba solo la ventana de", "prepárate para grabar" or "haz un tutorial grabando".
---

# Desktop Recorder

`drec` changes the Desktop Recorder app's settings, starts, pauses and stops recordings, and returns the MP4. It never moves the mouse or types: when the user wants a tutorial, you perform the steps with your own computer-use tools while `drec` records them.

## Rules for every run

1. **Record only what the user agreed to show.** The video captures everything on the chosen screen or window, notifications included. Confirm which screen or window before starting, and clear private content from it first.
2. **Act at a human pace while recording.** Viewers have to follow along: move the mouse in a few steps instead of jumping, type at reading speed, and hold about 1 to 2 seconds on each result before the next action. A tutorial that is too fast is useless to the viewer, however correct.
3. **Start acting only after `drec start` returns.** It returns once the 3 second countdown is over and the recording is running; anything done earlier is not in the video.
4. **Run `drec help` for the exact options.** It is the source of truth for flags and values; this skill does not repeat it.

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
| "Camera bottom right, background blurred" | `--bubble-corner bottom-right --background blur` |
| "No camera" | `--bubble hidden` (or `--camera none`) |
| "A blue ring around my camera" | `--border on --border-color "#2f5bff"` |
| "Show my clicks" | `--clicks on` |
| "Use my OBS camera" | `--camera "OBS"` (OBS must have its virtual camera started) |
| "Save them in D:/Videos" | `--output-dir "D:/Videos"` |
| "Put the app in Spanish" | `--language es` (`en`, `es` or `pt`) |
| "Stop" / "Pause" | `drec stop` (prints the MP4 path) / `drec pause`, `drec resume` |

Settings stay as set until changed, so `drec status` shows what the next recording will use.

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
```

**Step 1. Plan the take.** Write the steps of the task as a short list, and ask the user anything that changes the video: which screen or window, camera on or off, narration (mic) or silent, PC sound. Done when the step list and those choices are settled.

**Step 2. Pick what to record.** `drec screens` or `drec windows`. A window recording shows only that window, with the camera drawn where the bubble covers the window; a screen recording shows the whole monitor. Window numbers can change between calls, so select a window by part of its title. Done when you know the exact `--screen N` or `--window "title"`.

**Step 3. Prepare the screen.** Open the app or page the tutorial starts from, put it on the screen you will record, and close or hide anything private. Done when the screen shows the starting point and nothing else the user did not agree to.

**Step 4. Set up and start.** Typical tutorial setup: `drec start --screen 2 --clicks on --mic none --bubble hidden`. Keep the camera and mic only when the user is presenting. Done when `drec start` returns with `phase: recording`.

**Step 5. Perform the steps** with your computer-use tools, following Rule 2. If something goes wrong, `drec pause`, fix it off camera, then `drec resume`: the cut in the video is clean. When a pause cannot save the take (wrong screen, something private appeared), `drec stop`, tell the user, and return to Step 3. Done when the last step's result has been on screen for about 2 seconds.

**Step 6. Stop and hand over the file.** `drec stop` waits for the MP4 and prints its path. Give the user that path; leave opening the video to them. If `stop` reports a failed conversion, it names the WebM it kept; pass that path on instead.

## When something fails

- **`not running and could not be reached`:** run `drec open`, then retry.
- **`Wrong CLI token`:** close and reopen the app, then retry.
- **`No window "..."` or `No screen "..."`:** the message lists what exists; pick from it.
- **`Can't change ... while recording`:** screen, window, mode, mic and PC sound are set before `start`; camera, bubble, effects and clicks can change mid-recording.
- **Anything else:** `drec doctor` names the broken part and how to fix it.
