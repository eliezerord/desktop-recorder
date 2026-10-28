// The look of an exported video: where the Card and the Bubble go, and how the fixed layers (the
// Background with its shadow, the Card's rounded mask, the Bubble's circle and ring) are drawn.
// Plain functions with no window or file access, so Export (through the hidden renderer window) and
// the Editor preview use the same numbers. Docs: docs/CONTEXT.md and the README.

export const BACKGROUNDS = [
  { id: 'ocean', angle: 135, stops: [[0, '#1d4e89'], [1, '#00b4d8']] },
  { id: 'sunset', angle: 135, stops: [[0, '#f12711'], [1, '#f5af19']] },
  { id: 'forest', angle: 135, stops: [[0, '#134e5e'], [1, '#71b280']] },
  { id: 'dusk', angle: 135, stops: [[0, '#3a1c71'], [0.55, '#d76d77'], [1, '#ffaf7b']] },
  { id: 'peach', angle: 135, stops: [[0, '#ffecd2'], [1, '#fcb69f']] },
  { id: 'mint', angle: 135, stops: [[0, '#d4fc79'], [1, '#96e6a1']] },
  { id: 'slate', angle: 135, stops: [[0, '#2c3e50'], [1, '#4ca1af']] },
  { id: 'midnight', angle: 135, stops: [[0, '#0f0c29'], [0.5, '#302b63'], [1, '#24243e']] },
  { id: 'sand', angle: 135, stops: [[0, '#e6dccd'], [1, '#c9b79c']] },
  { id: 'rose', angle: 135, stops: [[0, '#ee9ca7'], [1, '#ffdde1']] },
];

// The two canvases an export can be: 16:9 for YouTube and 9:16 for Reels.
export const ASPECTS = { '16:9': { w: 1920, h: 1080 }, '9:16': { w: 1080, h: 1920 } };
export const PLACES = ['inside', 'outside'];
export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
// The camera Bubble's shape: a circle, or a square with rounded corners of the same size.
export const BUBBLE_SHAPES = ['circle', 'rounded'];
const ROUNDED_CORNER = 0.2; // a rounded Bubble's corner radius, as a share of its width
// margin is the space around the Card and cardCorners the roundness of its corners, both in percent of the
// shorter side. backgroundImage is the path of a picture to use instead of the built-in Background (left out
// or null: none).
export const DEFAULT_LOOK = { background: 'ocean', bubblePlace: 'outside', bubbleCorner: 'bottom-left', bubbleShape: 'circle', aspect: '16:9', margin: 5, cardCorners: 2.2, zoom: true, cursor: true, clicks: true };
export const MARGIN_RANGE = { min: 0, max: 15 };
export const CARD_CORNERS_RANGE = { min: 0, max: 6 };
// bubbleSize is the Bubble's width in percent of the shorter side. Left out or null, the Bubble keeps the size it
// was recorded with (small 20, medium 37).
export const BUBBLE_SIZE_RANGE = { min: 10, max: 40 };
// The look settings a Project keeps for itself (project.json, exportLook), set in the Editor.
export const PROJECT_LOOK_KEYS = [...Object.keys(DEFAULT_LOOK), 'bubbleSize', 'backgroundImage'];

// The look an export uses: the saved default look (drec set --look-...), then the Project's own look (the
// Editor), then what is asked for on this export. Each one only overrides what it sets.
export function resolveLook({ defaults = {}, project = {}, asked = {} }) {
  const own = Object.fromEntries(Object.entries(project.exportLook || {}).filter(([k]) => PROJECT_LOOK_KEYS.includes(k)));
  return { ...defaults, ...own, ...asked };
}

// Fractions of the canvas's shorter side (1080 px in both canvases), so the same look works at any export size.
const BUBBLE = { small: 0.2, medium: 0.37 }; // the bubble sizes the app records with (200 and 400 px on 1080)
const INSIDE_INSET = 0.03; // gap between an inside Bubble and the Card's edge
const SHADOW = { blur: 0.04, offsetY: 0.02, alpha: 0.4 };

const even = (n) => 2 * Math.floor(n / 2);
// The space around a Card in pixels, for a canvas whose shorter side is `unit` (the Split Layout uses it too).
export const marginPx = (look, unit) => even(Math.round(((look.margin ?? DEFAULT_LOOK.margin) / 100) * unit));

function inRange(value, { min, max }, name) {
  if (typeof value !== 'number' || !(value >= min && value <= max)) throw new Error(`${name}: use a number from ${min} to ${max} (percent of the shorter side).`);
}

// Fills in the defaults and says what is wrong in words an agent can act on.
export function normalizeLook(partial = {}) {
  const look = { ...DEFAULT_LOOK, ...Object.fromEntries(Object.entries(partial).filter(([, v]) => v !== undefined)) };
  if (!BACKGROUNDS.some((b) => b.id === look.background)) throw new Error(`background: use one of ${BACKGROUNDS.map((b) => b.id).join(', ')}.`);
  if (!PLACES.includes(look.bubblePlace)) throw new Error('bubble-place: use inside or outside.');
  if (!CORNERS.includes(look.bubbleCorner)) throw new Error(`bubble-corner: use one of ${CORNERS.join(', ')}.`);
  if (!BUBBLE_SHAPES.includes(look.bubbleShape)) throw new Error('bubble-shape: use circle or rounded.');
  if (!ASPECTS[look.aspect]) throw new Error('aspect: use 16:9 or 9:16.');
  inRange(look.cardCorners, CARD_CORNERS_RANGE, 'card-corners');
  inRange(look.margin, MARGIN_RANGE, 'margin');
  if (look.bubbleSize != null) inRange(look.bubbleSize, BUBBLE_SIZE_RANGE, 'bubble-size');
  if (look.backgroundImage !== undefined && look.backgroundImage !== null && (typeof look.backgroundImage !== 'string' || !look.backgroundImage)) throw new Error('background-image: use the path of a picture.');
  for (const key of ['zoom', 'cursor', 'clicks']) if (typeof look[key] !== 'boolean') throw new Error(`${key}: use on or off.`);
  return look;
}

// canvas and source are { w, h } in pixels. Returns the Card, the Bubble (or null) and the shadow,
// all in canvas pixels. The Bubble is { x, y, d, r }: r is its corner radius, d / 2 for a circle. An outside Bubble gets its own strip of Background and the Card shrinks to leave it,
// so the two never touch: in 16:9 the strip runs along the top or bottom edge; in 9:16 the Card keeps the
// width and the Bubble sits just above or below it, the two together centred in the tall canvas.
export function layout({ canvas, source, hasCamera, bubbleSize, look }) {
  const ratio = canvas.w / canvas.h;
  const vertical = Math.abs(ratio - 9 / 16) <= 0.01;
  if (!vertical && Math.abs(ratio - 16 / 9) > 0.01) throw new Error('Only 16:9 or 9:16 canvases are supported.');
  const unit = Math.min(canvas.w, canvas.h);
  const m = marginPx(look, unit);
  const above = look.bubbleCorner.startsWith('top');
  const left = look.bubbleCorner.endsWith('left');
  const share = look.bubbleSize != null ? look.bubbleSize / 100 : BUBBLE[bubbleSize] || BUBBLE.small;
  const d = hasCamera ? even(Math.round(share * unit)) : 0;
  const outside = hasCamera && look.bubblePlace === 'outside';
  const r = Math.round(((look.cardCorners ?? DEFAULT_LOOK.cardCorners) / 100) * unit);
  const fit = (avail) => {
    const scale = Math.min(avail.w / source.w, avail.h / source.h);
    return { w: even(source.w * scale), h: even(source.h * scale) };
  };

  let card;
  let outsideBubble = null;
  if (vertical) {
    const room = outside ? m + d : 0; // the Bubble and the gap between it and the Card
    const avail = { x: m, w: canvas.w - 2 * m, h: canvas.h - 2 * m - room };
    const { w, h } = fit(avail);
    const top = even((canvas.h - (h + room)) / 2);
    card = { x: avail.x + even((avail.w - w) / 2), y: outside && above ? top + room : top, w, h, r };
    if (outside) outsideBubble = { d, x: left ? m : canvas.w - m - d, y: above ? top : top + h + m };
  } else {
    const strip = outside ? d + Math.round(1.5 * m) : 0;
    const avail = { x: m, y: m + (outside && above ? strip - m : 0), w: canvas.w - 2 * m, h: canvas.h - 2 * m - (outside ? strip - m : 0) };
    const { w, h } = fit(avail);
    card = { x: avail.x + even((avail.w - w) / 2), y: avail.y + even((avail.h - h) / 2), w, h, r };
    if (outside) outsideBubble = { d, x: left ? m : canvas.w - m - d, y: above ? m : canvas.h - m - d };
  }

  const bubble = hasCamera ? { ...(outsideBubble || bubbleIn(card, d, look.bubbleCorner, unit)), r: bubbleRadius(d, look.bubbleShape) } : null;
  return { card, bubble, shadow: { blur: Math.round(SHADOW.blur * unit), offsetY: Math.round(SHADOW.offsetY * unit), alpha: SHADOW.alpha } };
}

// The corner radius of a Bubble d pixels wide in that shape (left out: a circle, as older looks have it).
export const bubbleRadius = (d, shape) => (shape === 'rounded' ? Math.round(ROUNDED_CORNER * d) : d / 2);

// A Bubble of width d inside `rect`, in that corner, a small gap from its edges. unit is the canvas's shorter side.
export function bubbleIn(rect, d, corner, unit) {
  const inset = Math.round(INSIDE_INSET * unit);
  return {
    d,
    x: corner.endsWith('left') ? rect.x + inset : rect.x + rect.w - inset - d,
    y: corner.startsWith('top') ? rect.y + inset : rect.y + rect.h - inset - d,
  };
}

// Where a Bubble dragged in the Editor lands, from the canvas point (x, y) it was dropped on: inside the Card
// when the point is on the Card, outside on the Background otherwise, and in the corner on that side of the
// Card's middle. The layout then puts it exactly there.
export function bubbleSpot({ card, x, y }) {
  const onCard = x >= card.x && x <= card.x + card.w && y >= card.y && y <= card.y + card.h;
  const top = y < card.y + card.h / 2;
  const left = x < card.x + card.w / 2;
  return { bubblePlace: onCard ? 'inside' : 'outside', bubbleCorner: `${top ? 'top' : 'bottom'}-${left ? 'left' : 'right'}` };
}

// ---- Drawing. `ctx` is a 2D canvas context, 1 canvas pixel = 1 export pixel.

function gradientFor(ctx, bg, w, h) {
  const a = (bg.angle * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2;
  const cy = h / 2;
  const g = ctx.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  for (const [at, color] of bg.stops) g.addColorStop(at, color);
  return g;
}

// The Background (a picture, covering the canvas, or the chosen gradient) with the Card's soft shadow on it
// (the shadow is only drawn outside the Card). `backgroundImage` is a loaded image or null.
export function drawBase(ctx, { canvas, backgroundId, backgroundImage, card, shadow }) {
  if (backgroundImage) {
    const scale = Math.max(canvas.w / backgroundImage.width, canvas.h / backgroundImage.height);
    const w = backgroundImage.width * scale;
    const h = backgroundImage.height * scale;
    ctx.drawImage(backgroundImage, (canvas.w - w) / 2, (canvas.h - h) / 2, w, h);
  } else {
    const bg = BACKGROUNDS.find((b) => b.id === backgroundId) || BACKGROUNDS[0];
    ctx.fillStyle = gradientFor(ctx, bg, canvas.w, canvas.h);
    ctx.fillRect(0, 0, canvas.w, canvas.h);
  }
  ctx.save();
  const outsideCard = new Path2D();
  outsideCard.rect(0, 0, canvas.w, canvas.h);
  outsideCard.roundRect(card.x, card.y, card.w, card.h, card.r);
  ctx.clip(outsideCard, 'evenodd');
  ctx.shadowColor = `rgba(0, 0, 0, ${shadow.alpha})`;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetY = shadow.offsetY;
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.roundRect(card.x, card.y, card.w, card.h, card.r);
  ctx.fill();
  ctx.restore();
}

// White where the Card shows, black outside: ffmpeg turns the grey value into transparency.
export function drawCardMask(ctx, card) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, card.w, card.h);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.roundRect(0, 0, card.w, card.h, card.r);
  ctx.fill();
}

// The outline of a camera region { w, h, r } with its top left at 0, 0: a circle when it is one (a round
// Bubble), otherwise a rectangle with corners of radius r (a rounded Bubble, or the camera growing into Full
// camera). The ffmpeg path's masks and the preview both draw it, so the two match.
const isCircle = ({ w, h, r }) => w === h && r >= w / 2;
const cornerOf = ({ w, h, r }) => Math.max(0, Math.min(r, w / 2, h / 2)); // never larger than the region allows
export function cameraPath(ctx, region) {
  const { w, h } = region;
  ctx.beginPath();
  if (isCircle(region)) ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
  else ctx.roundRect(0, 0, w, h, cornerOf(region));
}

export function drawBubbleMask(ctx, d, r = d / 2) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, d, d);
  ctx.fillStyle = '#fff';
  cameraPath(ctx, { w: d, h: d, r });
  ctx.fill();
}

// How thick the Bubble's ring is for a Bubble d pixels wide.
export const ringWidth = (d) => Math.max(2, Math.round(d * 0.02));
// The ring around a camera region { w, h, r } with its top left at 0, 0, following its shape, just inside it.
export function drawRingOn(ctx, region, color) {
  const width = ringWidth(Math.min(region.w, region.h));
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  if (isCircle(region)) ctx.arc(region.w / 2, region.h / 2, region.w / 2 - width / 2, 0, Math.PI * 2);
  else ctx.roundRect(width / 2, width / 2, region.w - width, region.h - width, Math.max(0, cornerOf(region) - width / 2));
  ctx.stroke();
}
// The ring around a Bubble d pixels wide (corner radius r), on a transparent square.
export const drawRing = (ctx, d, color, r = d / 2) => drawRingOn(ctx, { w: d, h: d, r }, color);
