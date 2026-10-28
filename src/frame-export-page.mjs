// Draws every frame of a frame-by-frame Export with the Editor preview's own drawFrame (preview.mjs). The screen
// and camera frames arrive decoded, in order, from the main process (frame-export.js); each finished frame goes
// back to the encoder. Asking for the next screen frame and sending the last finished one overlap the drawing.
import { drawFrame } from './preview.mjs';

const FPS = 30;

// A canvas that drawFrame can use like a <video>: it reads videoWidth and videoHeight.
function sourceCanvas({ w, h }) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.videoWidth = w;
  canvas.videoHeight = h;
  const ctx = canvas.getContext('2d');
  const image = new ImageData(w, h);
  return { canvas, put(px) { image.data.set(px); ctx.putImageData(image, 0, 0); } };
}

async function loadPicture(dataUrl) {
  if (!dataUrl) return null;
  const img = new Image();
  img.src = dataUrl;
  try { await img.decode(); } catch { throw new Error('unreadable-background-image'); } // export.js says it in plain words
  return img;
}

window.runExport = async (plan) => {
  const out = document.createElement('canvas');
  out.width = plan.canvas.w;
  out.height = plan.canvas.h;
  const ctx = out.getContext('2d');
  const screen = sourceCanvas(plan.screenSize);
  const camera = plan.cameraSize ? sourceCanvas(plan.cameraSize) : null;
  const picture = await loadPicture(plan.picture);
  const api = window.frameApi;
  let nextScreen = api.screen();
  let sending = Promise.resolve();
  let cameraStarted = false;
  for (let n = 0; n < plan.frames; n++) {
    const tMs = plan.startMs + (n * 1000) / FPS;
    const px = await nextScreen;
    if (n + 1 < plan.frames) nextScreen = api.screen();
    if (px) screen.put(px); // past the end of the screen video the last frame stays
    if (camera && tMs >= plan.cameraOffsetMs) {
      const cpx = await api.camera();
      if (cpx) { camera.put(cpx); cameraStarted = true; } // past the camera's end its last frame stays
    }
    drawFrame(ctx, { plan, screen: screen.canvas, camera: camera && cameraStarted ? camera.canvas : null, picture, tMs });
    const frame = ctx.getImageData(0, 0, out.width, out.height).data;
    await sending;
    sending = api.frame(frame);
  }
  await sending;
  return { frames: plan.frames };
};
