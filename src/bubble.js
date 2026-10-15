// Camera bubble: shows the chosen camera and starts or ends the drag.
// Hover and click-through are handled by the main process, which watches the cursor.
const video = document.getElementById('cam');
const bubble = document.getElementById('bubble');
let stream = null;
let currentId = null;
let request = 0;
let full = false;
let dragging = false;

async function useCamera(deviceId) {
  if (deviceId === currentId) return; // same camera: keep the stream, so resizing does not flicker
  currentId = deviceId;
  const mine = ++request;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  if (!deviceId) return;
  try {
    const next = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    // A newer camera choice arrived while this one was opening: drop this one.
    if (mine !== request) { next.getTracks().forEach((t) => t.stop()); return; }
    stream = next;
    video.srcObject = stream;
  } catch (err) {
    currentId = null; // lets the same camera be tried again
    console.error(`No se pudo abrir la cámara en la burbuja: ${err.name} ${err.message}`);
  }
}

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

window.api.onBubbleCamera(useCamera);
window.api.onBubbleMode((mode) => {
  full = mode.full;
  document.body.classList.toggle('full', full);
});
