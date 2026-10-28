# Desktop Recorder

A desktop app that records the screen or a window with a camera bubble, for tutorials and content. The next step is to make recordings look polished (smooth zoom, backgrounds) without a separate editing app, in the way a well-known Mac screen recorder does.

## Language

**Capture**:
The raw material saved while recording: the screen or window video, the camera video, the audio, and the record of clicks and cursor movement. Nothing in it is styled.
_Avoid_: Recording (ambiguous: use it only for the final exported video), take, session

**Project**:
A Capture together with the look chosen for it (background, zoom, bubble place). It can be reopened and changed.
_Avoid_: Draft, file

**Editor**:
The screen where a Project is previewed and its look is changed before export.
_Avoid_: Studio, post-production

**Export**:
Turning a Project into the final MP4.
_Avoid_: Render (fine in speech, not in the app), save

**Card**:
The captured screen or window, shown smaller and inset on top of the Background.
_Avoid_: Frame, window, canvas

**Background**:
The picture or colour behind the Card. Comes from the built-in set or from an image the user uploads.
_Avoid_: Wallpaper, backdrop

**Zoom**:
A smooth move into part of the Card that starts automatically at a click and eases back out when clicking stops. It can be switched off.
_Avoid_: Magnify, punch-in

**Bubble**:
The small camera view, a circle or a square with rounded corners. In the Editor it can sit on the Background outside the Card, or inside the Card.
_Avoid_: Webcam, camera window

**Layout**:
How the screen and the camera share the video at a moment. Four kinds: **Card** (the screen as a Card on the Background, with the Bubble), **Full screen** (the screen fills the video, with the Bubble), **Full camera** (only the camera fills the video) and **Split** (the screen and the camera side by side in 16:9, 60/40, or one above the other in 9:16, half and half; the camera fills its part, and **swap** puts it first).
_Avoid_: Scene, template, mode (mode is screen, window or camera recording)

**Layout point**:
A moment of the Project where a new Layout starts. The first one is always at the start. Between two Layout points the video moves smoothly from one Layout to the next.
_Avoid_: Keyframe, cut, marker
