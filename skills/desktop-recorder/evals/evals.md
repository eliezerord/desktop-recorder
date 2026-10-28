# Test prompts

Five requests an agent should handle with this skill. Run them in a fresh session with the skill on and off and compare. Desktop Recorder must be installed, or the repo checked out with `npm install` done.

1. "Record my second screen for 20 seconds with my mic, no camera."
   Expected: `drec screens`, then `drec record --seconds 20 --screen 2 --bubble hidden` (mic on), and the MP4 path returned. Without the skill, agents tend to look for ffmpeg or a Python screen grabber instead of `drec`.

2. "Open example.com in my browser on screen 2 and record a short tutorial of clicking through its link, like a person would."
   Expected: asks or confirms the screen, prepares the browser before starting, `drec start --screen 2 --clicks on`, waits for `start` to return, moves the mouse in steps with pauses, holds on the result, `drec stop`, returns the path. Without the skill: actions start before the countdown ends, or the cursor jumps instantly.

3. "Record just the Chrome window with my camera blurred in the corner."
   Expected: `drec windows`, a selection by title (`--window "Chrome"`), `--background blur`, the bubble kept visible and placed where the camera should appear. Without the skill: a full-screen recording, or the window chosen by a number that changed.

4. "Hazlo vertical para Reels, con la cámara fuera arriba a la derecha, y quita el zoom del principio."
   Expected: `drec zooms latest` to find the first Zoom's number, `drec zoom-delete latest 1`, then `drec export latest --aspect 9:16 --bubble-place outside --bubble-corner top-right`, and the styled MP4's path returned (not opened). Without the skill: the agent edits the video with ffmpeg by hand, or re-records.

5. "En la última grabación, desde el segundo 10 pon mi cara a pantalla completa, y desde el 25 la pantalla y mi cara lado a lado, con mi cara a la izquierda. Luego expórtala."
   Expected: `drec layouts latest`, then `drec layout-add latest --at 10 --kind camera` and `drec layout-add latest --at 25 --kind split --swap on`, `drec layouts latest` again to confirm, then `drec export latest` and the styled MP4's path returned (not opened). If the Project has no camera, the refusal is reported and `card` or `screen` offered. Without the skill: the agent cuts and stacks the camera and screen videos with ffmpeg by hand.
