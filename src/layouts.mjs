// Layouts: how the screen and the camera share the video, changing at Layout points (docs/CONTEXT.md).
// Plain functions with no window or file access, used by the Editor preview and the frame-by-frame Export
// (docs/adr/0002), so the two draw the same thing:
//   layoutPoints   a Project's list of Layout points, { at, kind } in time order (at in ms of the recording;
//                  a Split point that is swapped also has swap: true)
//   editLayouts    add, change, move or delete a point (numbered from 1); a wrong edit says what to fix
//   layoutShapes   where the screen region (the Card) and the camera region are in each Layout kind
//   frameAt        where they are at one moment, moving from one Layout to the next after each point
//   bubbleOf       the camera region as a Bubble ({ x, y, d, r }) when it is one, for the Editor's drag
// The move takes about 0.3 s with a strong ease-out: most of it in the first 0.1 s, then a glide to rest.
import { bubbleIn, marginPx } from './look.mjs';

export const LAYOUT = {
  moveMs: 300, // how long a move from one Layout to the next takes
  kinds: ['card', 'screen', 'camera', 'split'],
  cameraKinds: ['camera', 'split'], // the kinds that need a camera recording
  hiddenScale: 0.95, // a region that appears or disappears fades in or out at this share of its size
  splitScreenShare: 0.6, // the screen's share of the width in a 16:9 Split (the camera has the rest); 9:16 is half and half
};
const KIND_NAMES = { camera: 'Full camera', split: 'Split' }; // for messages

const DEFAULT_POINTS = [{ at: 0, kind: 'card' }];
const byTime = (a, b) => a.at - b.at;
const isSwappedSplit = (p) => p.kind === 'split' && p.swap === true;

export function layoutPoints(project) {
  const points = project && project.layouts && Array.isArray(project.layouts.points) ? project.layouts.points : DEFAULT_POINTS;
  return points.map((p) => ({ at: p.at, kind: p.kind, ...(isSwappedSplit(p) && { swap: true }) })).sort(byTime);
}

// The shape a point uses: a swapped Split has its own, the mirror image of Split (layoutShapes).
const shapeKey = (p) => (isSwappedSplit(p) ? 'split-swap' : p.kind);

// Only a Project that leaves the Card at some point needs the frame-by-frame Export.
export const needsFrames = (points) => points.some((p) => p.kind !== 'card');

// ---- Edits. Each returns { points, number }: a new list in time order and the number the added, changed or
// moved point has in it (0 after a delete). The first point is always at 0: it can change kind but not move or go.
//   { action: 'add', at, kind, swap }   { action: 'change', number, kind, swap }   { action: 'move', number, at }
//   { action: 'delete', number }
// swap (true or false, left out to keep it) only applies to Split; a point that stops being Split loses it.
// hasCamera: whether the Project has a camera recording; the camera kinds need one.
export function editLayouts(points, edit, { fullMs, hasCamera = false }) {
  const list = points.map((p) => ({ ...p })).sort(byTime);
  const s = (ms) => (ms / 1000).toFixed(1);
  const pick = (number) => {
    if (!Number.isInteger(number) || number < 1 || number > list.length) throw new Error(`Layout point ${number} does not exist: use a number from 1 to ${list.length}.`);
    return number - 1;
  };
  const kindOf = (kind) => {
    if (!LAYOUT.kinds.includes(kind)) throw new Error(`kind: use ${LAYOUT.kinds.slice(0, -1).join(', ')} or ${LAYOUT.kinds[LAYOUT.kinds.length - 1]}.`);
    if (LAYOUT.cameraKinds.includes(kind) && !hasCamera) {
      const others = LAYOUT.kinds.filter((k) => !LAYOUT.cameraKinds.includes(k));
      throw new Error(`${KIND_NAMES[kind] || kind} needs a camera, and this Project was recorded without one. Use ${others.join(' or ')}.`);
    }
    return kind;
  };
  // Sets the point's swap from the edit, or keeps it while the point stays Split.
  const setSwap = (p, swap) => {
    if (swap !== undefined && typeof swap !== 'boolean') throw new Error('swap: use on or off.');
    const on = swap ?? isSwappedSplit(p);
    if (on && p.kind !== 'split') throw new Error('swap: only a Split point can be swapped.');
    if (on) p.swap = true;
    else delete p.swap;
  };
  // A new time for a point that is not the first: inside the recording, after 0, apart from its neighbours.
  const timeOf = (at, others) => {
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at >= fullMs) throw new Error(`A Layout point must be inside the recording, from 0 to ${s(fullMs)} s.`);
    const ms = Math.round(at);
    if (ms === 0) throw new Error('The first Layout point is at 0 s: change its kind instead.');
    if (others.some((p) => Math.abs(p.at - ms) < LAYOUT.moveMs)) throw new Error(`Layout points must be at least ${s(LAYOUT.moveMs)} s apart.`);
    return ms;
  };
  const sortedWith = (p) => { list.sort(byTime); return { points: list, number: list.indexOf(p) + 1 }; };

  if (edit.action === 'add') {
    const kind = kindOf(edit.kind);
    const p = { at: timeOf(edit.at, list), kind };
    setSwap(p, edit.swap);
    list.push(p);
    return sortedWith(p);
  }
  if (edit.action === 'change') {
    const p = list[pick(edit.number)];
    if (edit.kind === undefined && edit.swap === undefined) throw new Error('Say what to change: the kind, or swap for a Split point.');
    if (edit.kind !== undefined) p.kind = kindOf(edit.kind);
    setSwap(p, edit.swap);
    return sortedWith(p);
  }
  if (edit.action === 'move') {
    const i = pick(edit.number);
    if (i === 0) throw new Error('The first Layout point stays at 0 s.');
    const p = list[i];
    p.at = timeOf(edit.at, list.filter((q) => q !== p));
    return sortedWith(p);
  }
  if (edit.action === 'delete') {
    const i = pick(edit.number);
    if (i === 0) throw new Error('The first Layout point stays: change its kind instead.');
    list.splice(i, 1);
    return { points: list, number: 0 };
  }
  throw new Error(`Unknown Layout change: ${edit.action}. Use add, change, move or delete.`);
}

// ---- Geometry. lay is look.mjs layout() for this canvas and look: the Card Layout. Each Layout gives two
// regions, both rounded rectangles with an opacity `a`:
//   card     the screen region, with `s`, how strong its shadow is (1 for the Card, 0 when it is no longer one)
//   camera   the camera region, mirrored and cropped to cover it, with `ring`, how strong the Bubble's ring is;
//            null when the Project has no camera. The Bubble is a camera region that is a circle.
// Full screen: the screen as large as the canvas allows, keeping its shape, square corners, no shadow, centred
// (the Background shows around it when the shapes differ); the Bubble keeps its size and its corner of the video.
// Full camera: the camera fills the canvas with square corners and no ring; the screen is hidden.
// Split: in 16:9 the screen's part is the left 60 % and the camera's the right 40 %; in 9:16 the top half and
// the bottom half. The camera fills its part (square corners, no ring); the screen is a Card fitted to its part,
// with the usual margin, corners and shadow. Swapped ('split-swap') is the mirror image.
const even = (n) => 2 * Math.floor(n / 2);
export const bubbleRegion = (b) => (b ? { x: b.x, y: b.y, w: b.d, h: b.d, r: b.r ?? b.d / 2, a: 1, ring: 1 } : null);

// The largest box of the source's shape that fits in `part` with `margin` around it, centred.
function fitIn(part, source, margin) {
  const scale = Math.min((part.w - 2 * margin) / source.w, (part.h - 2 * margin) / source.h);
  const w = even(source.w * scale);
  const h = even(source.h * scale);
  return { x: part.x + even((part.w - w) / 2), y: part.y + even((part.h - h) / 2), w, h };
}

function splitShape({ canvas, source, lay, look }) {
  const wide = canvas.w > canvas.h;
  const cut = even(wide ? canvas.w * LAYOUT.splitScreenShare : canvas.h / 2);
  const screenPart = wide ? { x: 0, y: 0, w: cut, h: canvas.h } : { x: 0, y: 0, w: canvas.w, h: cut };
  const cameraPart = wide ? { x: cut, y: 0, w: canvas.w - cut, h: canvas.h } : { x: 0, y: cut, w: canvas.w, h: canvas.h - cut };
  const fitted = fitIn(screenPart, source, marginPx(look, Math.min(canvas.w, canvas.h)));
  const split = { card: { ...fitted, r: lay.card.r, s: 1, a: 1 }, camera: { ...cameraPart, r: 0, a: 1, ring: 0 } };
  const mirror = (r) => (wide ? { ...r, x: canvas.w - r.x - r.w } : { ...r, y: canvas.h - r.y - r.h });
  return { split, swapped: { card: mirror(split.card), camera: mirror(split.camera) } };
}

export function layoutShapes({ canvas, source, lay, look }) {
  const unit = Math.min(canvas.w, canvas.h);
  const whole = { x: 0, y: 0, w: canvas.w, h: canvas.h };
  const card = { card: { ...lay.card, s: 1, a: 1 }, camera: bubbleRegion(lay.bubble) };
  const { split, swapped } = splitShape({ canvas, source, lay, look });
  return {
    card,
    screen: {
      card: { ...fitIn(whole, source, 0), r: 0, s: 0, a: 1 },
      camera: lay.bubble ? bubbleRegion({ ...bubbleIn(whole, lay.bubble.d, look.bubbleCorner, unit), r: lay.bubble.r }) : null,
    },
    // Without a camera (its file gone after the points were set) Full camera and Split fall back to the Card.
    camera: lay.bubble ? { card: hidden(card.card), camera: { ...whole, r: 0, a: 1, ring: 0 } } : card,
    split: lay.bubble ? split : card,
    'split-swap': lay.bubble ? swapped : card,
  };
}

// A region that is not shown: a little smaller around its own centre, fully transparent. Moving to or from it
// fades the region in place with a small scale, instead of sliding it.
function hidden(region) {
  const k = LAYOUT.hiddenScale;
  const w = region.w * k;
  const h = region.h * k;
  const out = { ...region, x: region.x + (region.w - w) / 2, y: region.y + (region.h - h) / 2, w, h, r: region.r * k, a: 0 };
  if ('s' in region) out.s = 0;
  return out;
}

// A strong ease-out: most of the move in its first third, then a glide to rest (ease-out quint).
const ease = (u) => 1 - (1 - Math.min(1, Math.max(0, u))) ** 5;
const lerp = (a, b, e) => a + (b - a) * e;
const CARD_KEYS = ['x', 'y', 'w', 'h', 'r', 's', 'a'];
const CAMERA_KEYS = ['x', 'y', 'w', 'h', 'r', 'a', 'ring'];
// One region between two Layouts. A hidden side takes the other side's place, so the region fades where it is.
// Hidden on both sides, it simply stays hidden.
const shown = (region) => Boolean(region) && region.a !== 0;
function blend(from, to, e, keys) {
  if (!shown(from) && !shown(to)) return to;
  const start = shown(from) ? from : hidden(to);
  const end = shown(to) ? to : hidden(from);
  return Object.fromEntries(keys.map((k) => [k, lerp(start[k], end[k], e)]));
}

// Where the screen region and the camera region are at tMs. A move starts from wherever the view is at its
// point, so a point that comes during another move never jumps.
export function frameAt({ points, shapes }, tMs) {
  let i = points.length - 1;
  while (i > 0 && points[i].at > tMs) i--;
  const to = shapes[shapeKey(points[i])];
  if (i === 0 || tMs - points[i].at >= LAYOUT.moveMs) return to;
  const from = frameAt({ points: points.slice(0, i), shapes }, points[i].at);
  const e = ease((tMs - points[i].at) / LAYOUT.moveMs);
  return { card: blend(from.card, to.card, e, CARD_KEYS), camera: blend(from.camera, to.camera, e, CAMERA_KEYS) };
}

// The camera region as the Bubble the Editor lets the user drag: only while it is a whole, settled Bubble.
export function bubbleOf(frame) {
  const c = frame.camera;
  return c && c.ring === 1 && c.a === 1 && c.w === c.h ? { x: c.x, y: c.y, d: c.w, r: c.r } : null;
}
