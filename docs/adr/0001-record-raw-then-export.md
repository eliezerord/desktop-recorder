# Record raw, style and export afterwards

Status: accepted (2026-10-26)

Smooth zoom, backgrounds and a camera Bubble outside the Card are applied in an Editor after recording, not drawn live. Recording saves a Capture (screen or window video, camera video, audio, and the record of clicks and cursor movement) and a plain MP4 of the screen. Export builds the styled MP4 from the Capture. This replaces the earlier decisions "the Bubble is recorded as it looks" and "no composition afterwards".

We chose it over live drawing on a canvas because a live result cannot be fixed when a zoom looks wrong, and because it is how the Mac screen recorder we are matching works. Cost: an Editor and an export step have to be built, and Captures take more disk space.

## Consequences

- The camera is a separate file, so the plain MP4 of the screen no longer has the Bubble burned in. Only Export puts it back.
- Preview and Export must use the same drawing code, or what the user sees will not match the file.
- Stopping a recording still gives an MP4 straight away, so `drec stop` keeps working for agents.
- Windows only for now. Capture without the system cursor must be proven on Windows first; if it fails, the real cursor stays in the video and Zoom still works.
