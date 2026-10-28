// Runs in the hidden window that Export opens (look-window.js): draws the fixed layers of the look
// as PNGs, with the drawing functions of look.mjs. The video itself is put together by ffmpeg.
import { drawBase, drawCardMask, drawBubbleMask, drawRing } from './look.mjs';

function png(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'));
  return canvas.toDataURL('image/png');
}

// spec: { canvas, backgroundId, backgroundImage (a data: URL or null), card, shadow, bubble, ringColor }. Layers that do
// not apply are null. A picture that cannot be opened gives { unreadable: true } instead of layers.
window.renderLayers = async (spec) => {
  let picture = null;
  if (spec.backgroundImage) {
    picture = new Image();
    picture.src = spec.backgroundImage;
    try { await picture.decode(); } catch { return { unreadable: true }; }
  }
  return layers({ ...spec, backgroundImage: picture });
};

const layers = (spec) => ({
  base: png(spec.canvas.w, spec.canvas.h, (ctx) => drawBase(ctx, spec)),
  cardMask: png(spec.card.w, spec.card.h, (ctx) => drawCardMask(ctx, spec.card)),
  bubbleMask: spec.bubble ? png(spec.bubble.d, spec.bubble.d, (ctx) => drawBubbleMask(ctx, spec.bubble.d, spec.bubble.r)) : null,
  ring: spec.bubble && spec.ringColor ? png(spec.bubble.d, spec.bubble.d, (ctx) => drawRing(ctx, spec.bubble.d, spec.ringColor, spec.bubble.r)) : null,
});
