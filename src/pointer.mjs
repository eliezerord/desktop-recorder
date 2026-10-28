// Pointer: the smooth cursor and the click circles that Export draws on the Card.
// Pure functions with no window or file access (so the Editor preview can use them too):
//   cursorPath / trackCursor   recorded mouse samples -> a smooth position for every video frame
//   ripplesAt                  which click circles are alive at a moment
//   toCard                     a spot on the screen -> a spot on the Card, through the Zoom's view
//   drawSheet                  draws the cursor and the circles into one small RGBA picture per frame
// The cursor and the circles are tiles of that picture; ffmpeg overlays each tile at the position
// drawSheet returns (export.js). Positions are whole pixels, the fraction is drawn inside the tile.

export const FPS = 30;
export const SLOTS = 3; // click circles that can be on screen at once
export const TILE = { cursor: 48, ripple: 96 };
export const SHEET = { w: TILE.cursor + SLOTS * TILE.ripple, h: Math.max(TILE.cursor, TILE.ripple) };
export const CURSOR_PAD = 4; // the arrow's tip sits this far inside its tile, so its outline is not cut
// Same look as the circles drawn while recording (clicks.js and control.js): yellow, growing, fading.
export const RIPPLE = { ms: 550, r0: 10, r1: 34, fill: 0.35, stroke: 0.9, width: 3, color: [255, 214, 10] };
export const POINTER = { cursorHeightOfCard: 0.034, smoothMs: 70, holdGapMs: 100 };

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const OFF_SCREEN = -1000;

// ---- Where the cursor is

// Recorded samples [t, x, y] (physical pixels) -> { t, fx, fy, inside } with fx and fy as fractions of
// the recorded picture. A window recording uses the window's rectangle in force at the sample.
export function cursorPath({ cursor, source, windowRects }) {
  const rects = windowRects || [];
  return cursor.map(([t, x, y]) => {
    let box;
    if (source.kind === 'window') {
      const r = [...rects].reverse().find((w) => w.t <= t) || rects[0];
      box = r ? { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } : null;
    } else {
      box = source.bounds;
    }
    if (!box) return { t, fx: 0, fy: 0, inside: false };
    const fx = (x - box.x) / box.width;
    const fy = (y - box.y) / box.height;
    return { t, fx, fy, inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
  });
}

// A position for every frame. Samples are only kept when the mouse moved, so two samples close together are
// a movement (joined with a straight line) and a long gap is the mouse resting (held). The result is
// smoothed so the cursor glides: each frame it covers part of the way to where the mouse really is.
export function trackCursor({ path, frames, fps = FPS }) {
  const out = [];
  let state = null;
  let k = 0;
  for (let i = 0; i < frames; i++) {
    const t = (i * 1000) / fps;
    while (k + 1 < path.length && path[k + 1].t <= t) k++;
    const a = path[k];
    const b = path[k + 1];
    let raw;
    if (!a) raw = { visible: false, fx: 0, fy: 0 };
    else if (t < a.t || !b || b.t - a.t > POINTER.holdGapMs || !a.inside || !b.inside) raw = { visible: a.inside, fx: a.fx, fy: a.fy };
    else {
      const u = (t - a.t) / (b.t - a.t);
      raw = { visible: true, fx: a.fx + (b.fx - a.fx) * u, fy: a.fy + (b.fy - a.fy) * u };
    }
    if (!raw.visible) { state = null; out.push({ visible: false, fx: 0, fy: 0 }); continue; }
    if (!state) state = { fx: raw.fx, fy: raw.fy };
    else {
      const follow = 1 - Math.exp(-(1000 / fps) / POINTER.smoothMs);
      state = { fx: state.fx + (raw.fx - state.fx) * follow, fy: state.fy + (raw.fy - state.fy) * follow };
    }
    out.push({ visible: true, fx: state.fx, fy: state.fy });
  }
  return out;
}

// ---- Click circles

// Clicks are { t, fx, fy } sorted by time. The newest ones win when more than SLOTS are alive.
export function ripplesAt(clicks, tMs) {
  const alive = [];
  for (let i = clicks.length - 1; i >= 0 && alive.length < SLOTS; i--) {
    const age = (tMs - clicks[i].t) / RIPPLE.ms;
    if (age >= 0 && age <= 1) alive.push({ ...clicks[i], age });
  }
  return alive;
}

// ---- From the screen to the Card

// `view` is the Zoom's { scale, cx, cy }. The visible part of the screen is 1/scale wide, centred on cx
// but never past the screen's edge (the same rule the zoompan expression in export.js uses).
export function toCard(view, fx, fy, card) {
  const { x0, y0, s } = visibleRect(view);
  return { x: (fx - x0) * s * card.w, y: (fy - y0) * s * card.h };
}

// The part of the screen the Card shows: top-left corner as fractions, and the scale (it is 1/s wide and high).
// The Editor preview cuts the screen video with it.
export function visibleRect(view) {
  const s = view.scale;
  return { x0: clamp(view.cx - 0.5 / s, 0, 1 - 1 / s), y0: clamp(view.cy - 0.5 / s, 0, 1 - 1 / s), s };
}

// ---- Drawing

// The classic arrow, in a box 12 wide and 19 tall, tip at (0, 0).
const ARROW = [[0, 0], [0, 16], [4.2, 12.4], [7.2, 19], [10, 17.7], [7.1, 11.3], [12, 11.3]];
const ARROW_HEIGHT = 19;
const OUTLINE_PX = 1.5;
const SUBSAMPLES = 4;
const PHASES = 8; // the arrow is drawn once for each eighth of a pixel it can sit at, then copied

function insidePolygon(u, v) {
  let inside = false;
  for (let i = 0, j = ARROW.length - 1; i < ARROW.length; j = i++) {
    const [xi, yi] = ARROW[i];
    const [xj, yj] = ARROW[j];
    if ((yi > v) !== (yj > v) && u < ((xj - xi) * (v - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(u, v) {
  let best = Infinity;
  for (let i = 0, j = ARROW.length - 1; i < ARROW.length; j = i++) {
    const [ax, ay] = ARROW[j];
    const [bx, by] = ARROW[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp(((u - ax) * dx + (v - ay) * dy) / (dx * dx + dy * dy), 0, 1);
    best = Math.min(best, Math.hypot(u - (ax + t * dx), v - (ay + t * dy)));
  }
  return best;
}

const spriteCache = new Map();
function cursorSprite(height, phaseX, phaseY) {
  const key = `${height}/${phaseX}/${phaseY}`;
  if (spriteCache.has(key)) return spriteCache.get(key);
  const s = height / ARROW_HEIGHT;
  const px = new Uint8Array(TILE.cursor * TILE.cursor * 4);
  for (let y = 0; y < TILE.cursor; y++) {
    for (let x = 0; x < TILE.cursor; x++) {
      let fill = 0;
      let edge = 0;
      for (let b = 0; b < SUBSAMPLES; b++) {
        for (let a = 0; a < SUBSAMPLES; a++) {
          const u = (x + (a + 0.5) / SUBSAMPLES - (CURSOR_PAD + phaseX / PHASES)) / s;
          const v = (y + (b + 0.5) / SUBSAMPLES - (CURSOR_PAD + phaseY / PHASES)) / s;
          if (insidePolygon(u, v)) fill++;
          else if (distanceToPolygon(u, v) * s <= OUTLINE_PX) edge++;
        }
      }
      const n = fill + edge;
      if (!n) continue;
      const o = (y * TILE.cursor + x) * 4;
      const white = Math.round((255 * fill) / n);
      px[o] = white; px[o + 1] = white; px[o + 2] = white;
      px[o + 3] = Math.round((255 * n) / (SUBSAMPLES * SUBSAMPLES));
    }
  }
  spriteCache.set(key, px);
  return px;
}

function drawRipple(buf, col, x, y, age, scale) {
  const r = (RIPPLE.r0 + (RIPPLE.r1 - RIPPLE.r0) * age) * scale;
  const w = Math.max(2, RIPPLE.width * scale);
  const fade = 1 - age;
  const cx = TILE.ripple / 2 + (x - Math.floor(x));
  const cy = TILE.ripple / 2 + (y - Math.floor(y));
  const reach = Math.ceil(r + w) + 1;
  for (let py = Math.max(0, Math.floor(cy) - reach); py < Math.min(TILE.ripple, Math.floor(cy) + reach + 1); py++) {
    for (let px = Math.max(0, Math.floor(cx) - reach); px < Math.min(TILE.ripple, Math.floor(cx) + reach + 1); px++) {
      const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy);
      const disc = RIPPLE.fill * fade * clamp(r - d + 0.5, 0, 1);
      const ring = RIPPLE.stroke * fade * clamp(w / 2 - Math.abs(d - r) + 0.5, 0, 1);
      const alpha = 1 - (1 - disc) * (1 - ring);
      if (alpha <= 0) continue;
      const o = (py * SHEET.w + col + px) * 4;
      buf[o] = RIPPLE.color[0]; buf[o + 1] = RIPPLE.color[1]; buf[o + 2] = RIPPLE.color[2];
      buf[o + 3] = Math.round(alpha * 255);
    }
  }
}

// Where to overlay each tile, [cursor, circle 1, 2, 3], as whole Card pixels; tiles with nothing in
// them are sent out of sight. state: { cursor: {x, y} | null, ripples: [{x, y, age}] } in Card pixels.
export function tileSpots(state) {
  const spots = [state.cursor ? { x: Math.floor(state.cursor.x) - CURSOR_PAD, y: Math.floor(state.cursor.y) - CURSOR_PAD } : { x: OFF_SCREEN, y: OFF_SCREEN }];
  for (let i = 0; i < SLOTS; i++) {
    const rp = state.ripples[i];
    spots.push(rp ? { x: Math.floor(rp.x) - TILE.ripple / 2, y: Math.floor(rp.y) - TILE.ripple / 2 } : { x: OFF_SCREEN, y: OFF_SCREEN });
  }
  return spots;
}

// Clears `buf` (SHEET.w x SHEET.h, RGBA) and draws one frame: the cursor in the first tile and a click
// circle in each of the others (the fraction of a pixel is drawn inside the tile). Returns tileSpots(state).
export function drawSheet(buf, state, { cursorHeight, scale }) {
  buf.fill(0);
  if (state.cursor) {
    const phase = (f) => Math.min(PHASES - 1, Math.round(f * PHASES));
    const sprite = cursorSprite(cursorHeight, phase(state.cursor.x - Math.floor(state.cursor.x)), phase(state.cursor.y - Math.floor(state.cursor.y)));
    for (let y = 0; y < TILE.cursor; y++) buf.set(sprite.subarray(y * TILE.cursor * 4, (y + 1) * TILE.cursor * 4), y * SHEET.w * 4);
  }
  for (let i = 0; i < SLOTS; i++) {
    const rp = state.ripples[i];
    if (rp) drawRipple(buf, TILE.cursor + i * TILE.ripple, rp.x, rp.y, rp.age, scale);
  }
  return tileSpots(state);
}
