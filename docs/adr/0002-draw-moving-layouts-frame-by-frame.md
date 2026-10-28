# Draw moving Layouts frame by frame with the preview's code

Layouts move: a Full screen recording eases into its Card, the Bubble grows into a full camera, a Split slides in. Today's Export composes each video with a fixed ffmpeg graph in which the Card and the Bubble never move, while the Editor preview draws the same plan on a canvas. For moving Layouts we will export by drawing every frame with the preview's own drawing code in a hidden window, with the screen and camera frames decoded in order by ffmpeg, and let ffmpeg only encode the finished frames. Projects with no Layout points keep today's faster ffmpeg path.

## Measured (2026-10-27, `test/spikes/moving-export.js`)

A 60 s 1080p Project (test pattern, sound) that is Full screen until 10 s and then eases into its Card over 0.6 s, on this PC (Ryzen 5 5600G, 12 threads). "Difference" is the mean difference per colour channel, 0 to 255, between the exported frame (decoded by Chromium, as a player shows it) and the preview's frame, at 13 moments before, during and after the move.

| Way | Time | CPU (all processes) | Difference |
|---|---|---|---|
| Today's static export, for reference (no move) | 51 s | not measured | n/a |
| A: preview code, each frame found by seeking the `<video>` | about 820 s (measured 165 s for 12 s) | very high | 0.7 to 1.0 |
| A2: preview code, screen frames decoded in order by ffmpeg | 109 s | 251 s | 1.3 to 1.5, steady |
| B: ffmpeg graph, the screen and its mask moved with `perspective` | 95 s | 586 s | 2.5 everywhere, up to 7.4 during the move |

- A is slow because every seek decodes from the last keyframe (about 390 ms a frame).
- In A2 most of the time goes to the encoder taking frames (42 ms a frame) and to reading the canvas back (16 ms a frame); drawing takes under 1 ms.
- B cannot change a frame's size mid-stream (ffmpeg silently scales it back to the first size), so the move needs the `perspective` filter on a canvas-size image. That resamples every frame (the 2.5 when nothing moves), and the shadow and the corner radius cannot follow without more layers: the shadow appears at its final place at once and a full screen frame keeps rounded corners.

## Why A2

- **The preview and the export match by construction** (1.3 to 1.5, which is the difference between ffmpeg's and Chromium's decoding). Every Layout, transition, shadow, corner and Bubble growth is drawn once, in one place. With B each new Layout needs its own ffmpeg expressions and extra layers, and still differs during moves.
- **It uses less than half the CPU of B** (251 s against 586 s), so the PC stays usable during an export. B is about 13% faster in wall time.
- **It is simpler to grow.** Full camera and Split are a few lines of canvas code, not new filter graphs.

## Consequences

- Exports with moving Layouts take about twice as long as today's static export (109 s against 51 s for 60 s). Projects with no Layout points keep the ffmpeg path and its speed.
- Export needs a hidden renderer window for the whole run (it already uses one for the fixed layers), plus a second in-order decoder for the camera file. The cursor and click circles are drawn by the same code the preview already uses.
- Later speed-ups, not needed now: encoding in the renderer with WebCodecs `VideoEncoder` (hardware H.264) would remove the canvas readback and the frame copies; several frames could be drawn in flight.
- The spike script stays in `test/spikes/` to measure again after changes. It is not part of the test suite.
