// Draws one frame of the Editor preview on a canvas the size of the export. It follows the steps Export's
// ffmpeg graph takes (export.js), with the same pieces: the Background and shadow from look.mjs, the part of
// the screen the Zoom shows (zoom.mjs, pointer.mjs visibleRect), the cursor and click circles from the same
// sheet Export streams (pointer.mjs drawSheet), the Card's rounded corners, then the mirrored camera (the
// Bubble, its part of a Split, or the whole video in Full camera) and its ring. test/editor-test.js compares its frames with exported ones.
import { drawBase, drawRingOn, cameraPath } from './look.mjs';
import { zoomAt } from './zoom.mjs';
import { frameAt, bubbleRegion } from './layouts.mjs';
import { drawSheet, visibleRect, SHEET, TILE, FPS } from './pointer.mjs';

const WHOLE = { scale: 1, cx: 0.5, cy: 0.5 };
const TILE_X = [0, TILE.cursor, TILE.cursor + TILE.ripple, TILE.cursor + 2 * TILE.ripple];
const TILE_SIZE = [TILE.cursor, TILE.ripple, TILE.ripple, TILE.ripple];

// The sheet canvas and its pixel buffer are made once and reused for every frame.
let sheet = null;
function sheetCanvas() {
  if (!sheet) {
    const canvas = document.createElement('canvas');
    canvas.width = SHEET.w;
    canvas.height = SHEET.h;
    const buf = new Uint8ClampedArray(SHEET.w * SHEET.h * 4);
    sheet = { canvas, ctx: canvas.getContext('2d'), buf, image: new ImageData(buf, SHEET.w, SHEET.h) };
  }
  return sheet;
}

// plan: what editor-window.js load() sends (or the frame-by-frame Export, docs/adr/0002). screen and camera:
// <video> elements already at the right moment, or canvases with videoWidth and videoHeight set. picture: a
// decoded <img> or null. tMs: the moment, in milliseconds of the recording.
// With Layout points the screen region and the camera region move, resize and fade (layouts.mjs frameAt); the
// cursor and the circles are in pixels of the Card Layout's Card, so they are scaled to the Card's size now.
export function drawFrame(ctx, { plan, screen, camera, picture, tMs }) {
  const { canvas, shadow } = plan;
  // A plan with no Layouts (test/spikes) is the Card Layout.
  const { card, camera: cameraRegion } = plan.layouts ? frameAt(plan.layouts, tMs) : { card: plan.card, camera: bubbleRegion(plan.bubble) };
  const cardScale = card.w / plan.card.w;
  ctx.save();
  ctx.clearRect(0, 0, canvas.w, canvas.h);
  // A Card fades its shadow out as it stops being one (card.s, layouts.mjs).
  drawBase(ctx, { canvas, backgroundId: plan.look.background, backgroundImage: picture, card, shadow: { ...shadow, alpha: shadow.alpha * (card.s ?? 1) } });
  if ((card.a ?? 1) > 0) drawScreen(ctx, { plan, screen, card, cardScale, tMs });
  // Before the camera starts (cameraOffsetMs, usually a few hundredths of a second) there is no camera to draw,
  // so a video that opens in Full camera shows the Background for that moment.
  const ready = camera && (camera.readyState === undefined || camera.readyState >= 2); // a canvas has no readyState
  if (cameraRegion && cameraRegion.a > 0 && ready && tMs >= plan.cameraOffsetMs) drawCamera(ctx, { camera, region: cameraRegion, ringColor: plan.ringColor });
  ctx.restore();
}

// The screen region: the visible part of the screen, then the cursor and circles on it, all inside the
// rounded corners, faded by the region's opacity (Full camera hides it).
function drawScreen(ctx, { plan, screen, card, cardScale, tMs }) {
  ctx.save();
  ctx.globalAlpha = card.a ?? 1;
  ctx.beginPath();
  ctx.roundRect(card.x, card.y, card.w, card.h, card.r);
  ctx.clip();
  const view = plan.zooms.length ? zoomAt(plan.zooms, tMs) : WHOLE;
  const { x0, y0, s } = visibleRect(view);
  const vw = screen.videoWidth;
  const vh = screen.videoHeight;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(screen, x0 * vw, y0 * vh, vw / s, vh / s, card.x, card.y, card.w, card.h);
  if (plan.pointer) {
    const i = Math.min(plan.pointer.states.length - 1, Math.max(0, Math.round(((tMs - plan.startMs) * FPS) / 1000)));
    const sh = sheetCanvas();
    const spots = drawSheet(sh.buf, plan.pointer.states[i], plan.pointer);
    sh.ctx.putImageData(sh.image, 0, 0);
    spots.forEach((spot, n) => {
      ctx.drawImage(sh.canvas, TILE_X[n], 0, TILE_SIZE[n], TILE_SIZE[n], card.x + spot.x * cardScale, card.y + spot.y * cardScale, TILE_SIZE[n] * cardScale, TILE_SIZE[n] * cardScale);
    });
  }
  ctx.restore();
}

// The camera region: the camera mirrored and cropped around its middle to cover the region, inside the
// region's outline (look.mjs cameraPath, as Export's ffmpeg path masks it); the ring on top, following the same
// outline and fading out as the Bubble grows into Full camera.
function drawCamera(ctx, { camera, region, ringColor }) {
  const vw = camera.videoWidth;
  const vh = camera.videoHeight;
  const sw = Math.min(vw, vh * (region.w / region.h));
  const sh = sw * (region.h / region.w);
  ctx.save();
  ctx.globalAlpha = region.a;
  ctx.translate(region.x, region.y);
  cameraPath(ctx, region);
  ctx.clip();
  ctx.translate(region.w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(camera, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, region.w, region.h);
  ctx.restore();
  if (!ringColor || !(region.ring > 0)) return;
  ctx.save();
  ctx.globalAlpha = region.a * region.ring;
  ctx.translate(region.x, region.y);
  drawRingOn(ctx, region, ringColor);
  ctx.restore();
}
