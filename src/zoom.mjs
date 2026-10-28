// Zoom: the smooth moves into the screen at clicks, in Export and (later) the Editor.
// Three jobs, all plain functions with no window or file access:
//   computeZooms     clicks -> a list of Zooms { start, end, strength, x, y } (times in ms of video time,
//                    x and y the aim as fractions 0..1 of the recorded screen or window)
//   zoomAt           what the view is at one moment: { scale, cx, cy }
//   zoomExpressions  the same motion as expressions for ffmpeg's zoompan filter
// zoomAt and zoomExpressions must agree: test/zoom-test.js checks them against each other.

export const ZOOM = {
  strength: 1.6, // how far in: the view shows 1/1.6 of the screen
  lead: 450, // the move starts this long before the click, so it has arrived (same as ramp) when the click lands
  hold: 1400, // and stays this long after the last click
  ramp: 450, // time to ease in, and to ease out
  mergeDistance: 0.15, // clicks closer than this (fraction of the screen) share one Zoom
};

const round4 = (n) => Math.round(n * 10000) / 10000;

// Where a click falls in the recorded picture as fractions 0..1, or null when it is outside it.
function toFraction(click, source, windowRects) {
  let box;
  if (source.kind === 'window') {
    const rects = windowRects || [];
    box = [...rects].reverse().find((r) => r.t <= click.t) || rects[0]; // the window's rectangle in force at the click
    if (!box) return null;
    box = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
  } else {
    box = source.bounds;
  }
  const fx = (click.x - box.x) / box.width;
  const fy = (click.y - box.y) / box.height;
  return fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 ? { fx, fy } : null;
}

// Clicks as { t, fx, fy } (fractions of the recorded picture), leaving out those outside it. Click circles use it too.
export function clickFractions({ clicks, source, windowRects }) {
  return [...clicks]
    .sort((a, b) => a.t - b.t)
    .map((c) => ({ t: c.t, ...toFraction(c, source, windowRects) }))
    .filter((p) => p.fx !== undefined);
}

// Clicks that come while a Zoom is still held and land close to where it started join it; any other
// click starts a new Zoom, which overlaps the old one so the view pans instead of dropping out.
export function computeZooms({ clicks, source, windowRects }) {
  const points = clickFractions({ clicks, source, windowRects });
  const groups = [];
  for (const p of points) {
    const g = groups[groups.length - 1];
    const joins = g && p.t <= g.end - ZOOM.ramp && Math.hypot(p.fx - g.points[0].fx, p.fy - g.points[0].fy) <= ZOOM.mergeDistance;
    if (joins) {
      g.points.push(p);
      g.end = p.t + ZOOM.hold;
    } else {
      groups.push({ points: [p], start: Math.max(0, p.t - ZOOM.lead), end: p.t + ZOOM.hold });
    }
  }
  return groups.map((g) => ({
    start: g.start,
    end: g.end,
    strength: ZOOM.strength,
    x: round4(g.points.reduce((s, p) => s + p.fx, 0) / g.points.length),
    y: round4(g.points.reduce((s, p) => s + p.fy, 0) / g.points.length),
  }));
}

// ---- Edits to a Project's Zoom list, by the Editor's timeline and by drec. Each returns { zooms, number }:
// a new list in time order (the old one is left alone) and the number the added or changed Zoom has in it
// (0 after a delete). A wrong edit throws a message that says what to fix.
// Zooms are numbered from 1 in time order, as `drec` and people count them.
//   { action: 'delete', number }
//   { action: 'change', number, start?, end?, strength?, x?, y? }
//   { action: 'add', start, end?, strength?, x?, y? }   (end defaults to start + addLength, aim to the middle)
export const ZOOM_EDIT = { minLength: 500, addLength: 2000, strength: { min: 1.1, max: 3 } };

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const byTime = (a, b) => a.start - b.start || a.end - b.end;

function checkZoom(z, fullMs) {
  const s = (ms) => (ms / 1000).toFixed(1);
  if (![z.start, z.end].every(isNum) || z.start < 0 || z.end > fullMs) throw new Error(`A Zoom must be inside the recording, from 0 to ${s(fullMs)} s.`);
  if (z.end - z.start < ZOOM_EDIT.minLength) throw new Error(`A Zoom must last at least ${s(ZOOM_EDIT.minLength)} s.`);
  const { min, max } = ZOOM_EDIT.strength;
  if (!isNum(z.strength) || z.strength < min || z.strength > max) throw new Error(`strength: use a number from ${min} to ${max}.`);
  if (![z.x, z.y].every((n) => isNum(n) && n >= 0 && n <= 1)) throw new Error('aim: use numbers from 0 to 1 (0.5 is the middle).');
  return { start: Math.round(z.start), end: Math.round(z.end), strength: Math.round(z.strength * 100) / 100, x: round4(z.x), y: round4(z.y) };
}

export function editZooms(zooms, edit, { fullMs }) {
  const list = [...zooms].sort(byTime);
  const pick = (number) => {
    if (!list.length) throw new Error('This Project has no Zooms. Add one first.');
    if (!Number.isInteger(number) || number < 1 || number > list.length) throw new Error(`Zoom ${number} does not exist: use a number from 1 to ${list.length}.`);
    return number - 1;
  };
  const given = (keys) => Object.fromEntries(keys.filter((k) => edit[k] !== undefined).map((k) => [k, edit[k]]));
  const sortedWith = (z) => { list.sort(byTime); return { zooms: list, number: list.indexOf(z) + 1 }; };
  if (edit.action === 'delete') {
    list.splice(pick(edit.number), 1);
    return { zooms: list, number: 0 };
  }
  if (edit.action === 'change') {
    const i = pick(edit.number);
    list[i] = checkZoom({ ...list[i], ...given(['start', 'end', 'strength', 'x', 'y']) }, fullMs);
    return sortedWith(list[i]);
  }
  if (edit.action === 'add') {
    let { start } = edit;
    let end = edit.end;
    if (end === undefined && isNum(start)) {
      end = Math.min(fullMs, start + ZOOM_EDIT.addLength);
      start = Math.max(0, Math.min(start, end - ZOOM_EDIT.addLength)); // near the end it moves back so it still fits
    }
    const z = checkZoom({ strength: ZOOM.strength, x: 0.5, y: 0.5, ...given(['strength', 'x', 'y']), start, end }, fullMs);
    list.push(z);
    return sortedWith(z);
  }
  throw new Error(`Unknown Zoom change: ${edit.action}. Use add, change or delete.`);
}

// ---- The motion. A Zoom's pull is 0 outside [start, end], eases up over `ramp`, holds at 1, eases down.
// Where Zooms overlap the pulls add (capped), so the view slides from one aim to the next.

const smooth = (u) => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c); };
const rampOf = (z) => Math.min(ZOOM.ramp, (z.end - z.start) / 2);
const pull = (z, t) => smooth((t - z.start) / rampOf(z)) * smooth((z.end - t) / rampOf(z));

export function zoomAt(zooms, tMs) {
  let sum = 0;
  let extra = 0;
  let sx = 0;
  let sy = 0;
  for (const z of zooms) {
    const e = pull(z, tMs);
    sum += e;
    extra += e * (z.strength - 1);
    sx += e * z.x;
    sy += e * z.y;
  }
  return { scale: 1 + extra / Math.max(1, sum), cx: sum > 0 ? sx / Math.max(sum, 1e-6) : 0.5, cy: sum > 0 ? sy / Math.max(sum, 1e-6) : 0.5 };
}

// ---- The same motion for ffmpeg. `timeExpr` is the time in seconds as ffmpeg's expression language
// spells it ("on/30" in zoompan, "T" in geq). The expressions are a balanced tree of `if(lt(time, ...))`
// over the moments when the set of active Zooms changes, so a frame evaluates only the few Zooms that
// are active then, however many the Project has.

const sec = (ms) => (ms / 1000).toFixed(3);
const clip01 = (a) => `clip(${a},0,1)`;
const sm = (a) => `${clip01(a)}*${clip01(a)}*(3-2*${clip01(a)})`;

function pullExpr(z, T) {
  const r = sec(rampOf(z));
  return `${sm(`(${T}-${sec(z.start)})/${r}`)}*${sm(`(${sec(z.end)}-${T})/${r}`)}`;
}

function leafExpr(kind, set, T) {
  if (!set.length) return kind === 'z' ? '1' : '0.5';
  const sumPull = `(${set.map((z) => pullExpr(z, T)).join('+')})`;
  if (kind === 'z') return `1+(${set.map((z) => `${pullExpr(z, T)}*${(z.strength - 1).toFixed(4)}`).join('+')})/max(1,${sumPull})`;
  return `(${set.map((z) => `${pullExpr(z, T)}*${kind === 'x' ? z.x : z.y}`).join('+')})/max(${sumPull},0.000001)`;
}

export function zoomExpressions(zooms, timeExpression) {
  if (!zooms.length) return { z: '1', x: '0.5', y: '0.5' };
  const timeExpr = `(${timeExpression})`; // in brackets so "3.2+on/30" is one number wherever it is used
  const marks = [...new Set(zooms.flatMap((z) => [z.start, z.end]))].sort((a, b) => a - b);
  // Leaf i covers [marks[i-1], marks[i]); the first and last leaves are before and after every Zoom.
  const active = (i) => (i === 0 || i === marks.length ? [] : zooms.filter((z) => z.start <= marks[i - 1] && z.end >= marks[i]));
  const tree = (kind, lo, hi) => {
    if (hi - lo === 1) return leafExpr(kind, active(lo), timeExpr);
    const mid = (lo + hi) >> 1;
    return `if(lt(${timeExpr},${sec(marks[mid - 1])}),${tree(kind, lo, mid)},${tree(kind, mid, hi)})`;
  };
  return { z: tree('z', 0, marks.length + 1), x: tree('x', 0, marks.length + 1), y: tree('y', 0, marks.length + 1) };
}
