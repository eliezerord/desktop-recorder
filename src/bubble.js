// Camera bubble: shows the chosen camera with its effects and starts or ends the drag.
// Hover and click-through are handled by the main process, which watches the cursor.
import { createCameraPipeline } from './camera-pipeline.js';

const bubble = document.getElementById('bubble');
const pipeline = createCameraPipeline(document.getElementById('cam'));
let full = false;
let dragging = false;

bubble.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || full) return;
  dragging = true;
  bubble.setPointerCapture(e.pointerId); // keeps the release even if the mouse outruns the window
  window.api.bubbleDragStart();
});

function endDrag() {
  if (!dragging) return;
  dragging = false;
  window.api.bubbleDragEnd();
}
bubble.addEventListener('pointerup', endDrag);
bubble.addEventListener('pointercancel', endDrag);
bubble.addEventListener('lostpointercapture', endDrag);

window.api.onBubbleCamera((id) => pipeline.setCamera(id));
window.api.onBubbleMode((mode) => {
  full = mode.full;
  document.body.classList.toggle('full', full);
});

// Background effect and the optional colored ring around the bubble.
window.api.onBubbleEffects((fx) => {
  pipeline.setEffect({ background: fx.background, color: fx.bgColor, image: fx.bgImage });
  document.body.classList.toggle('ring', Boolean(fx.border));
  document.body.style.setProperty('--ring', fx.borderColor || '#ffffff');
});

// For the smoke test: whether the camera and the effect are running.
window.bubbleStatus = () => ({ camera: pipeline.hasCamera(), effectReady: pipeline.effectReady(), error: pipeline.lastError() });
