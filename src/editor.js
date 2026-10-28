// The Editor window: previews a Project with its look and changes that look (ticket 09). Every change goes
// to the main process (editor-window.js), which checks it, saves it in project.json and sends back the new
// plan, so the preview always shows what drec export would make now.
import { BACKGROUNDS, bubbleSpot } from './look.mjs';
import { drawFrame } from './preview.mjs';
import { FPS, visibleRect } from './pointer.mjs';
import { zoomAt } from './zoom.mjs';
import { frameAt, bubbleOf, LAYOUT } from './layouts.mjs';

const $ = (id) => document.getElementById(id);
const { t } = window.DrecI18n;
let lang = window.DrecI18n.DEFAULT;
const tr = (key, vars) => t(lang, key, vars);

const canvas = $('preview');
const ctx = canvas.getContext('2d');
const screen = $('screen');
const camera = $('camera');
let plan = null;
let picture = null;
let nowMs = 0;
let playing = false;
let exporting = false;
let statusKey = ['', {}];

const status = (key, vars = {}) => { statusKey = [key, vars]; $('status').textContent = key ? tr(key, vars) : ''; };
const showError = (err) => { statusKey = ['', {}]; $('status').textContent = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); };

// ---------- Video at a moment ----------

const halfFrame = 1000 / FPS / 2; // seek to the middle of a frame, so the browser shows that frame and not the one before
function seek(video, sec) {
  const target = Math.max(0, Math.min(sec, (video.duration || Infinity) - 0.001));
  if (Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); video.removeEventListener('error', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 3000); // a seek that never reports back must not freeze the Editor
    video.addEventListener('seeked', done);
    video.addEventListener('error', done);
    video.currentTime = target;
  });
}
const loaded = (video, url) => new Promise((resolve, reject) => {
  if (video.dataset.url === url && video.readyState >= 2) { resolve(); return; }
  video.dataset.url = url;
  video.onloadeddata = () => resolve();
  video.onerror = () => reject(new Error(`Could not open ${url}`));
  video.src = url;
});

function draw() {
  if (!plan) return;
  drawFrame(ctx, { plan, screen, camera: plan.cameraUrl ? camera : null, picture, tMs: nowMs });
  $('time').textContent = clock(nowMs - plan.startMs);
  $('scrub').value = String(Math.round(nowMs));
  $('playhead').style.left = `${pct(nowMs)}%`;
}

let renderCount = 0;
async function renderAt(ms) {
  pause();
  const mine = ++renderCount;
  const at = Math.max(plan.startMs, Math.min(ms, plan.endMs));
  nowMs = at;
  const camSec = (at - plan.cameraOffsetMs + halfFrame) / 1000;
  await Promise.all([seek(screen, (at + halfFrame) / 1000), plan.cameraUrl && camSec >= 0 ? seek(camera, camSec) : null]);
  if (mine !== renderCount) return; // a newer moment was asked for meanwhile
  nowMs = at;
  draw();
}

// ---------- Playing ----------

function tick() {
  frameCallback = null;
  if (!playing) return;
  nowMs = screen.currentTime * 1000;
  if (nowMs >= plan.endMs || screen.ended) { pause(); renderAt(plan.endMs); return; }
  if (plan.cameraUrl) {
    const camSec = (nowMs - plan.cameraOffsetMs) / 1000;
    if (camSec >= 0 && camera.paused) camera.play().catch(() => {});
    if (camSec >= 0 && Math.abs(camera.currentTime - camSec) > 0.15) camera.currentTime = camSec; // keep it in step
  }
  draw();
  frameCallback = screen.requestVideoFrameCallback(tick);
}

let frameCallback = null;
async function play() {
  if (playing) return;
  if (nowMs >= plan.endMs - 50) await renderAt(plan.startMs);
  playing = true;
  showPlaying();
  await screen.play().catch(() => {});
  if (playing && frameCallback === null) frameCallback = screen.requestVideoFrameCallback(tick);
}

// The play button shows its icon and names what a press does (Play or Pause).
function showPlaying() {
  const b = $('play');
  b.classList.toggle('playing', playing);
  const label = tr(playing ? 'editor.pause' : 'editor.play');
  b.setAttribute('aria-label', label);
  b.title = label;
}

function pause() {
  if (!playing) return;
  playing = false;
  if (frameCallback !== null) { screen.cancelVideoFrameCallback(frameCallback); frameCallback = null; }
  screen.pause();
  camera.pause();
  showPlaying();
}

// The canvas keeps the export's pixels; on screen it is shrunk to fit the frame, whatever the format.
function fitCanvas() {
  const frame = canvas.parentElement;
  const style = getComputedStyle(frame);
  const w = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const h = frame.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const scale = Math.min(w / canvas.width, h / canvas.height);
  canvas.style.width = `${Math.max(0, Math.floor(canvas.width * scale))}px`;
  canvas.style.height = `${Math.max(0, Math.floor(canvas.height * scale))}px`;
}
new ResizeObserver(fitCanvas).observe(canvas.parentElement);

// ---------- The plan from the main process ----------

async function applyPlan(next) {
  plan = next;
  document.title = `${tr('editor.title')}: ${plan.name}`;
  $('projectName').textContent = plan.name;
  $('projectName').title = plan.name; // a long name is cut on screen; the full one shows on hover
  canvas.width = plan.canvas.w;
  canvas.height = plan.canvas.h;
  fitCanvas();
  if (!plan.picture) picture = null;
  else if (!picture || picture.src !== plan.picture) {
    const img = new Image();
    img.src = plan.picture;
    await img.decode();
    picture = img;
  }
  await loaded(screen, plan.screenUrl);
  if (plan.cameraUrl) await loaded(camera, plan.cameraUrl);
  const scrub = $('scrub');
  scrub.min = String(plan.startMs);
  scrub.max = String(plan.endMs);
  showControls();
  renderTimeline();
  await renderAt(Math.max(plan.startMs, Math.min(nowMs, plan.endMs)));
}

// Changes run one after another, so plans come back in the order they were asked for.
let changes = Promise.resolve();
function queue(send, after = () => {}) {
  const run = changes.then(async () => {
    const before = plan;
    try {
      const next = await send();
      after(before, next);
      await applyPlan(next);
      status('editor.savedNow');
      return next;
    } catch (err) {
      if (plan) renderTimeline(); // puts a dragged block back where the saved list has it
      throw err;
    }
  });
  changes = run.catch(() => {}); // a refused change does not stop the next one
  return run;
}
const change = (partial) => queue(() => window.api.editorSet(partial));

// ---------- Zoom timeline ----------

let selected = 0; // the number (from 1) of the Zoom picked on the timeline, 0 for none

// The edited Zoom stays picked (its number may change, the list is kept in time order). After a delete
// made from the keyboard, the Zoom now in that place is picked, so the keys keep working.
function editZoom(edit, { fromKeys = false } = {}) {
  return queue(() => window.api.editorZoom(edit), (_before, next) => {
    selected = next.edited || (fromKeys ? Math.min(edit.number, next.zoomList.length) : 0);
    refocus = fromKeys;
  });
}

// The timeline shows the whole recording; the parts the trim leaves out are shaded.
const span = () => Math.max(1, plan.fullMs);
const pct = (ms) => (ms / span()) * 100;
const msAt = (clientX, track) => ((clientX - track.left) / track.width) * span(); // the moment under the pointer
function place(el, start, end) {
  const left = Math.max(0, Math.min(100, pct(start)));
  el.style.left = `${left}%`;
  el.style.width = `${Math.max(0, Math.min(100, pct(end)) - left)}%`;
}

let refocus = false; // the focused block is rebuilt after an edit made from the keyboard; focus goes back to it
function renderTimeline() {
  const tl = $('timeline');
  tl.setAttribute('aria-label', tr('editor.timeline'));
  tl.classList.toggle('off', !plan.zoomOn);
  if (selected > plan.zoomList.length) selected = 0;
  tl.querySelectorAll('.zoom').forEach((el) => el.remove());
  plan.zoomList.forEach((z, i) => {
    const b = document.createElement('button');
    b.className = 'zoom';
    b.dataset.number = String(i + 1);
    b.textContent = String(i + 1);
    // Times as the time display counts them: from the start of the trimmed video.
    const label = tr('editor.zoomNamed', { n: i + 1, start: clock(z.start - plan.startMs), end: clock(z.end - plan.startMs), strength: z.strength });
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(selected === i + 1));
    for (const side of ['start', 'end']) { const h = document.createElement('span'); h.className = `handle ${side}`; b.append(h); }
    place(b, z.start, z.end);
    tl.append(b);
  });
  if (refocus && selected) tl.querySelector(`.zoom[data-number="${selected}"]`)?.focus();
  refocus = false;
  placeTrim(plan.startMs, plan.endMs);
  $('trimStart').setAttribute('aria-label', tr('editor.trimStart', { time: clock(plan.startMs) }));
  $('trimEnd').setAttribute('aria-label', tr('editor.trimEnd', { time: clock(plan.endMs) }));
  showZoomPanel();
  renderLayouts();
}

// ---------- Layout track ----------
// Each Layout point is a segment from its moment to the next point, coloured by kind with its drawing (the
// same as on the panel's kind buttons). The first point always starts at 0: it has no handle and stays.

let layoutPicked = 0; // the number (from 1) of the Layout point picked on the timeline, 0 for none
let layoutRefocus = false;
let layoutDrag = null;
const KIND_TEXT = { card: 'editor.layoutCard', screen: 'editor.layoutScreen', camera: 'editor.layoutCamera', split: 'editor.layoutSplit' };
const kindName = (p) => {
  const kind = KIND_TEXT[p.kind] ? tr(KIND_TEXT[p.kind]) : p.kind;
  return p.swap ? tr('editor.layoutSwapped', { kind }) : kind;
};
let keyLayout = null; // the point and time the arrow keys asked for and that are not saved yet
const layoutEnd = (i) => (plan.layouts.points[i + 1] ? plan.layouts.points[i + 1].at : plan.fullMs);

// The edited point stays picked; after a delete from the keyboard, the point now in its place.
function editLayout(edit, { fromKeys = false } = {}) {
  return queue(() => window.api.editorLayout(edit), (_before, next) => {
    layoutPicked = next.edited || (fromKeys ? Math.min(edit.number, next.layouts.points.length) : 0);
    layoutRefocus = fromKeys;
  });
}

function renderLayouts() {
  const tl = $('timeline');
  const { points } = plan.layouts;
  // An <svg> has no hidden property, only the attribute.
  for (const svg of $('layoutKind').querySelectorAll('svg[data-aspect]')) svg.toggleAttribute('hidden', svg.dataset.aspect !== plan.look.aspect);
  if (layoutPicked > points.length) layoutPicked = 0;
  tl.querySelectorAll('.layout-point').forEach((el) => el.remove());
  points.forEach((p, i) => {
    const n = i + 1;
    const b = document.createElement('button');
    b.className = 'layout-point';
    b.dataset.number = String(n);
    b.dataset.kind = p.kind;
    const name = document.createElement('span');
    name.textContent = kindName(p);
    const icon = $('layoutKind').querySelector(`[data-kind="${p.kind}"] svg:not([hidden])`); // a kind this Editor does not know has none
    b.append(...(icon ? [icon.cloneNode(true)] : []), name);
    const label = n === 1 ? tr('editor.layoutFirstNamed', { kind: kindName(p) }) : tr('editor.layoutNamed', { n, kind: kindName(p), time: clock(p.at - plan.startMs) });
    b.setAttribute('aria-label', label);
    b.title = n === 1 ? label : `${label} ${tr('editor.layoutHowTo')}`; // the label names it; the tooltip also says how to edit it
    b.setAttribute('aria-pressed', String(layoutPicked === n));
    if (n > 1) { const h = document.createElement('span'); h.className = 'handle start'; b.append(h); }
    place(b, p.at, layoutEnd(i));
    tl.append(b);
  });
  if (layoutRefocus && layoutPicked) tl.querySelector(`.layout-point[data-number="${layoutPicked}"]`)?.focus();
  layoutRefocus = false;
  showLayoutPanel();
}

function pickLayout(number) {
  layoutPicked = number;
  for (const b of $('timeline').querySelectorAll('.layout-point')) b.setAttribute('aria-pressed', String(Number(b.dataset.number) === number));
  showLayoutPanel();
}

// The picked point's kind, Swap for a Split, and Delete (not for the first point). Without a camera, Full
// camera and Split are off and the hint says why.
function showLayoutPanel() {
  const p = plan.layouts.points[layoutPicked - 1];
  $('layoutSelected').hidden = !p;
  const noCamera = !plan.cameraUrl;
  $('layoutHint').textContent = !p ? tr('editor.layoutPick') : noCamera ? tr('editor.layoutNeedsCamera') : '';
  if (!p) return;
  $('layoutTitle').textContent = layoutPicked === 1 ? tr('editor.layoutFirstTitle') : tr('editor.layoutTitle', { n: layoutPicked, time: clock(p.at - plan.startMs) });
  for (const b of $('layoutKind').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.kind === p.kind));
    b.disabled = noCamera && LAYOUT.cameraKinds.includes(b.dataset.kind);
    if (b.disabled) b.setAttribute('aria-describedby', 'layoutHint'); // the hint says why
    else b.removeAttribute('aria-describedby');
  }
  $('layoutSwap').hidden = p.kind !== 'split';
  $('layoutSwap').setAttribute('aria-pressed', String(p.swap === true));
  $('layoutDelete').disabled = layoutPicked === 1;
}

// "Add Layout here": a point at the playhead, in the other of Card and Full screen, picked so its kind can be
// set at once.
function addLayoutHere() {
  const { points } = plan.layouts;
  let i = points.length - 1;
  while (i > 0 && points[i].at > nowMs) i--;
  return editLayout({ action: 'add', at: Math.round(nowMs), kind: points[i].kind === 'card' ? 'screen' : 'card' });
}

// A press on a segment picks it and shows its Layout settled; a press on its start handle drags the point.
function onLayoutDown(e, block, track) {
  const number = Number(block.dataset.number);
  const p = plan.layouts.points[number - 1];
  pickLayout(number);
  if (number > 1 && e.target.classList.contains('handle')) {
    layoutDrag = { block, number, x: e.clientX, width: track.width, from: p.at, to: p.at, moved: false };
    try { block.setPointerCapture(e.pointerId); } catch { /* a made-up pointer (tests) cannot be captured */ }
    block.classList.add('dragging');
    e.preventDefault();
    return;
  }
  renderAt(Math.min(plan.endMs, p.at + LAYOUT.moveMs)).catch(showError);
}
function onLayoutMove(e) {
  const d = layoutDrag;
  if (Math.abs(e.clientX - d.x) > 2) d.moved = true;
  if (!d.moved) return;
  // It stays between its neighbours, at least the move's length from each (as the saved list must).
  const { points } = plan.layouts;
  const low = points[d.number - 2].at + LAYOUT.moveMs;
  const high = (points[d.number] ? points[d.number].at : plan.fullMs) - LAYOUT.moveMs;
  d.to = Math.max(low, Math.min(high, d.from + ((e.clientX - d.x) / d.width) * span()));
  place(d.block, d.to, layoutEnd(d.number - 1));
  const before = $('timeline').querySelector(`.layout-point[data-number="${d.number - 1}"]`);
  if (before) place(before, plan.layouts.points[d.number - 2].at, d.to);
}
function onLayoutUp() {
  const d = layoutDrag;
  layoutDrag = null;
  d.block.classList.remove('dragging');
  if (d.moved) editLayout({ action: 'move', number: d.number, at: Math.round(d.to) }).catch(showError);
}

// Arrow keys move the focused point, 0.1 s a press or 1 s with Ctrl; Delete removes it. The first point stays.
function onLayoutKey(e, block) {
  const number = Number(block.dataset.number);
  const isDelete = e.key === 'Delete' || e.key === 'Backspace';
  if (!isDelete && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  if (number === 1) return;
  if (isDelete) { editLayout({ action: 'delete', number }, { fromKeys: true }).catch(showError); return; }
  pickLayout(number);
  const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.ctrlKey ? 1000 : 100);
  // Quick presses build on the time asked for last, not on the plan, which only changes once it is saved.
  const from = keyLayout && keyLayout.number === number ? keyLayout.at : plan.layouts.points[number - 1].at;
  const next = { number, at: from + step };
  keyLayout = next;
  const done = () => { if (keyLayout === next) keyLayout = null; };
  editLayout({ action: 'move', number, at: next.at }, { fromKeys: true }).then(done, (err) => { done(); showError(err); });
}

function placeTrim(start, end) {
  $('cutBefore').style.width = `${pct(start)}%`;
  $('cutAfter').style.left = `${pct(end)}%`;
  $('trimStart').style.left = `${pct(start)}%`;
  $('trimEnd').style.left = `${pct(end)}%`;
}

function select(number) {
  selected = number;
  for (const b of $('timeline').querySelectorAll('.zoom')) b.setAttribute('aria-pressed', String(Number(b.dataset.number) === number));
  showZoomPanel();
}

function showZoomPanel() {
  const z = plan.zoomList[selected - 1];
  $('zoomOn').checked = plan.zoomOn;
  $('zoomSelected').hidden = !z;
  $('zoomHint').textContent = !plan.zoomList.length ? tr('editor.zoomNone') : z ? '' : tr('editor.zoomPick');
  canvas.classList.toggle('aiming', Boolean(z));
  if (!z) return;
  const s = $('zoomStrength');
  s.min = String(plan.zoomRanges.strength.min);
  s.max = String(plan.zoomRanges.strength.max);
  s.value = String(z.strength);
  $('zoomTitle').textContent = tr('editor.zoomStrength', { n: selected });
  $('zoomStrengthValue').textContent = `${z.strength}×`;
}

// Dragging a block moves it; dragging one of its edges changes its length. Nothing is saved until the
// pointer is let go; a press without a move picks the Zoom and shows its middle.
let drag = null;
// A Zoom moved (mode 'move') or with one edge moved ('start', 'end') by `dms` milliseconds. It stays at
// least the shortest length, and inside the recording.
function shifted(z, mode, dms) {
  const min = plan.zoomRanges.minLength;
  if (mode === 'start') return { start: Math.max(0, Math.min(z.start + dms, z.end - min)), end: z.end };
  if (mode === 'end') return { start: z.start, end: Math.min(plan.fullMs, Math.max(z.end + dms, z.start + min)) };
  const start = Math.max(0, Math.min(z.start + dms, plan.fullMs - (z.end - z.start)));
  return { start, end: start + (z.end - z.start) };
}

// ---------- Trim: the two handles on the timeline ----------

let trimDrag = null;
let keyTrim = null; // the trim the arrow keys asked for and that is not saved yet
// The trim with one side moved to `ms`, kept inside the recording and at least the shortest length.
function trimmed(side, ms, { start, end }) {
  const min = plan.ranges.trimMin;
  if (side === 'start') return { start: Math.max(0, Math.min(ms, end - min)), end };
  return { start, end: Math.min(plan.fullMs, Math.max(ms, start + min)) };
}
// A side left out keeps the saved one; null as the end means to the end of the recording.
const editTrim = (trim) => {
  const ms = (n) => (typeof n === 'number' ? Math.round(n) : n);
  return queue(() => window.api.editorTrim({ start: ms(trim.start), end: ms(trim.end) }));
};

function onTimelineDown(e) {
  if (e.button !== 0 || !plan) return;
  const track = $('timeline').getBoundingClientRect();
  const handle = e.target.closest('.trim');
  if (handle) {
    trimDrag = { side: handle.dataset.side, track, x: e.clientX, to: { start: plan.startMs, end: plan.endMs }, moved: false };
    try { handle.setPointerCapture(e.pointerId); } catch { /* a made-up pointer (tests) cannot be captured */ }
    e.preventDefault();
    return;
  }
  const segment = e.target.closest('.layout-point');
  if (segment) { onLayoutDown(e, segment, track); return; }
  const block = e.target.closest('.zoom');
  if (!block) { renderAt(msAt(e.clientX, track)).catch(showError); return; }
  const number = Number(block.dataset.number);
  const z = plan.zoomList[number - 1];
  select(number);
  const mode = e.target.classList.contains('start') ? 'start' : e.target.classList.contains('end') ? 'end' : 'move';
  drag = { block, number, mode, x: e.clientX, width: track.width, from: z, to: z, moved: false };
  try { block.setPointerCapture(e.pointerId); } catch { /* a made-up pointer (tests) cannot be captured */ }
  block.classList.add('dragging');
  e.preventDefault();
}
function onTimelineMove(e) {
  if (trimDrag) {
    const { track, side } = trimDrag;
    if (Math.abs(e.clientX - trimDrag.x) > 2) trimDrag.moved = true;
    if (!trimDrag.moved) return; // a press that barely moves saves nothing
    trimDrag.to = trimmed(side, msAt(e.clientX, track), trimDrag.to);
    placeTrim(trimDrag.to.start, trimDrag.to.end);
    return;
  }
  if (layoutDrag) { onLayoutMove(e); return; }
  if (!drag) return;
  if (Math.abs(e.clientX - drag.x) > 2) drag.moved = true;
  if (!drag.moved) return; // a press that barely moves is a pick, not a drag
  drag.to = shifted(drag.from, drag.mode, ((e.clientX - drag.x) / drag.width) * span());
  place(drag.block, drag.to.start, drag.to.end);
}
function onTimelineUp() {
  if (trimDrag) {
    const t = trimDrag;
    trimDrag = null;
    if (t.moved) editTrim(t.to).catch(showError);
    return;
  }
  if (layoutDrag) { onLayoutUp(); return; }
  if (!drag) return;
  const d = drag;
  drag = null;
  d.block.classList.remove('dragging');
  if (!d.moved) { renderAt((d.from.start + d.from.end) / 2).catch(showError); return; }
  editZoom({ action: 'change', number: d.number, start: Math.round(d.to.start), end: Math.round(d.to.end) }).catch(showError);
}

// Arrow keys move the focused Zoom (Shift: change its length), 0.1 s a press or 1 s with Ctrl; Delete removes it.
function onTimelineKey(e) {
  const handle = e.target.closest('.trim');
  if (handle && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.ctrlKey ? 1000 : 100);
    // Quick presses build on the trim asked for last, not on the plan, which only changes once it is saved.
    const now = keyTrim || { start: plan.startMs, end: plan.endMs };
    const next = trimmed(handle.dataset.side, now[handle.dataset.side] + step, now);
    keyTrim = next;
    placeTrim(next.start, next.end);
    const done = () => { if (keyTrim === next) keyTrim = null; };
    editTrim(next).then(() => { done(); handle.focus(); }, (err) => { done(); showError(err); });
    return;
  }
  const segment = e.target.closest('.layout-point');
  if (segment) { onLayoutKey(e, segment); return; }
  const block = e.target.closest('.zoom');
  if (!block) return;
  const number = Number(block.dataset.number);
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editZoom({ action: 'delete', number }, { fromKeys: true }).catch(showError); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  select(number);
  const step = (e.key === 'ArrowLeft' ? -1 : 1) * (e.ctrlKey ? 1000 : 100);
  const { start, end } = shifted(plan.zoomList[number - 1], e.shiftKey ? 'end' : 'move', step);
  editZoom({ action: 'change', number, start, end }, { fromKeys: true }).catch(showError);
}

// With a Zoom picked, a click on the preview aims it at the spot clicked, in what the preview shows now.
const WHOLE = { scale: 1, cx: 0.5, cy: 0.5 };
function onPreviewClick(e) {
  if (skipClick) { skipClick = false; return; } // the press was on the Bubble
  if (!plan || !selected) return;
  const r = canvas.getBoundingClientRect();
  const { card } = geometryNow();
  if (card.a === 0) return; // Full camera hides the screen, so there is nothing to aim at
  const u = (((e.clientX - r.left) / r.width) * canvas.width - card.x) / card.w;
  const v = (((e.clientY - r.top) / r.height) * canvas.height - card.y) / card.h;
  if (u < 0 || u > 1 || v < 0 || v > 1) return; // outside the Card
  const { x0, y0, s } = visibleRect(plan.zooms.length ? zoomAt(plan.zooms, nowMs) : WHOLE);
  const clamp = (n) => Math.max(0, Math.min(1, n));
  editZoom({ action: 'change', number: selected, x: clamp(x0 + u / s), y: clamp(y0 + v / s) }).catch(showError);
}

// ---------- The Bubble, dragged and resized on the preview ----------
// Its middle drags it: where it is let go decides the place (on the Card or beside it) and the corner, the
// spots drec offers too (look.mjs bubbleSpot). Its edge resizes it. A dashed outline in the Bubble's shape shows the change until
// it is saved and the preview is drawn again.

let bubbleDrag = null;
// Where the Card and the camera are on the preview now: they move when the Project has Layout points. The
// Bubble can be dragged only while it is one (not while it grows into Full camera, or fills the video).
const geometryNow = () => frameAt(plan.layouts, nowMs);
const bubbleNow = () => bubbleOf(geometryNow());
let skipClick = false;
const unit = () => Math.min(plan.canvas.w, plan.canvas.h);
const percentOfUnit = (px) => Math.round((px / unit()) * 1000) / 10; // how the look sizes the Bubble
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * canvas.width, y: ((e.clientY - r.top) / r.height) * canvas.height };
}
// 'move' or 'resize' for a point on the Bubble, or null off it.
function bubblePart(p) {
  const b = plan && bubbleNow();
  if (!b) return null;
  // How far the point is from the middle, measured along the Bubble's own shape (a circle, or a square with
  // rounded corners): d / 2 exactly on its edge.
  const qx = Math.abs(p.x - (b.x + b.d / 2)) - (b.d / 2 - b.r);
  const qy = Math.abs(p.y - (b.y + b.d / 2)) - (b.d / 2 - b.r);
  const dist = b.d / 2 - b.r + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  const grip = Math.max(10, b.d * 0.12); // the ring near the edge that resizes
  if (dist > b.d / 2 + grip / 2) return null;
  return dist >= b.d / 2 - grip ? 'resize' : 'move';
}

function onCanvasDown(e) {
  if (e.button !== 0 || !plan) return;
  const p = canvasPoint(e);
  const mode = bubblePart(p);
  skipClick = Boolean(mode);
  if (!mode) return;
  pause();
  const b = bubbleNow();
  const c = { x: b.x + b.d / 2, y: b.y + b.d / 2 };
  bubbleDrag = { mode, from: p, c, at: c, d: b.d, size: b.d, moved: false };
  try { canvas.setPointerCapture(e.pointerId); } catch { /* a made-up pointer (tests) cannot be captured */ }
  e.preventDefault();
}
function onCanvasDrag(e) {
  if (!bubbleDrag) return;
  const g = bubbleDrag;
  const p = canvasPoint(e);
  if (Math.hypot(p.x - g.from.x, p.y - g.from.y) > 3) g.moved = true;
  if (!g.moved) return;
  if (g.mode === 'move') g.at = { x: g.c.x + p.x - g.from.x, y: g.c.y + p.y - g.from.y };
  else {
    const { min, max } = plan.ranges.bubbleSize;
    const grow = Math.hypot(p.x - g.c.x, p.y - g.c.y) - Math.hypot(g.from.x - g.c.x, g.from.y - g.c.y);
    g.size = Math.max((min / 100) * unit(), Math.min((max / 100) * unit(), g.d + grow));
  }
  draw();
  drawGhost(g);
}
function onCanvasUp() {
  setTimeout(() => { skipClick = false; }); // after the click that may follow this release
  if (!bubbleDrag) return;
  const g = bubbleDrag;
  bubbleDrag = null;
  if (!g.moved) return;
  if (g.mode === 'resize') { change({ bubbleSize: percentOfUnit(g.size) }).catch(showError); return; }
  const spot = bubbleSpot({ card: plan.card, x: g.at.x, y: g.at.y });
  if (spot.bubblePlace === plan.look.bubblePlace && spot.bubbleCorner === plan.look.bubbleCorner) { draw(); return; }
  change(spot).catch(showError);
}
function drawGhost(g) {
  ctx.save();
  ctx.lineWidth = Math.max(3, unit() * 0.004);
  ctx.setLineDash([14, 10]);
  if (g.mode === 'move' && bubbleSpot({ card: plan.card, x: g.at.x, y: g.at.y }).bubblePlace === 'inside') {
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); // it would land on the Card
    ctx.beginPath();
    ctx.roundRect(plan.card.x, plan.card.y, plan.card.w, plan.card.h, plan.card.r);
    ctx.stroke();
  }
  ctx.strokeStyle = '#fff';
  ctx.beginPath();
  const corner = g.size * (plan.bubble.r / plan.bubble.d); // the Bubble's own shape, at the new size
  ctx.roundRect(g.at.x - g.size / 2, g.at.y - g.size / 2, g.size, g.size, Math.min(corner, g.size / 2));
  ctx.stroke();
  ctx.restore();
}
// The pointer shows what a press would do.
function onCanvasHover(e) {
  if (bubbleDrag || !plan) return;
  const part = bubblePart(canvasPoint(e));
  canvas.style.cursor = part === 'move' ? 'grab' : part === 'resize' ? 'nwse-resize' : '';
}

// ---------- Controls ----------

const gradientCss = (bg) => `linear-gradient(${bg.angle}deg, ${bg.stops.map(([at, c]) => `${c} ${Math.round(at * 100)}%`).join(', ')})`;

function buildControls() {
  $('backgrounds').replaceChildren(...BACKGROUNDS.map((bg) => {
    const b = document.createElement('button');
    b.dataset.background = bg.id;
    b.style.background = gradientCss(bg);
    b.addEventListener('click', () => change({ background: bg.id }).catch(showError));
    return b;
  }));
  $('picture').addEventListener('click', async () => {
    try {
      const next = await window.api.editorPickPicture();
      if (next) { await applyPlan(next); status('editor.savedNow'); }
    } catch (err) { showError(err); }
  });
  for (const [id, label, suffix] of [['margin', 'marginValue', '%'], ['cardCorners', 'cornersValue', '%']]) {
    const input = $(id);
    input.addEventListener('input', () => { $(label).textContent = `${input.value}${suffix}`; });
    input.addEventListener('change', () => change({ [id]: Number(input.value) }).catch(showError));
  }
  for (const b of $('aspect').querySelectorAll('button')) b.addEventListener('click', () => change({ aspect: b.dataset.aspect }).catch(showError));
  $('play').addEventListener('click', () => (playing ? pause() : play()));
  $('scrub').addEventListener('input', (e) => renderAt(Number(e.target.value)));
  $('export').addEventListener('click', exportNow);
  const tl = $('timeline');
  tl.addEventListener('pointerdown', onTimelineDown);
  window.addEventListener('pointermove', (e) => { onTimelineMove(e); onCanvasDrag(e); });
  window.addEventListener('pointerup', () => { onTimelineUp(); onCanvasUp(); });
  window.addEventListener('pointercancel', () => {
    if (drag || trimDrag || layoutDrag) { drag = null; trimDrag = null; layoutDrag = null; renderTimeline(); }
    if (bubbleDrag) { bubbleDrag = null; draw(); }
  });
  tl.addEventListener('keydown', onTimelineKey);
  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointermove', onCanvasHover);
  canvas.addEventListener('click', onPreviewClick);
  for (const b of $('bubblePlace').querySelectorAll('button')) b.addEventListener('click', () => change({ bubblePlace: b.dataset.place }).catch(showError));
  for (const b of $('bubbleShape').querySelectorAll('button')) b.addEventListener('click', () => change({ bubbleShape: b.dataset.shape }).catch(showError));
  for (const b of $('bubbleCorner').querySelectorAll('button')) b.addEventListener('click', () => change({ bubbleCorner: b.dataset.corner }).catch(showError));
  const size = $('bubbleSize');
  size.addEventListener('input', () => { $('bubbleSizeValue').textContent = `${size.value}%`; });
  size.addEventListener('change', () => change({ bubbleSize: Number(size.value) }).catch(showError));
  $('layoutAdd').addEventListener('click', () => addLayoutHere().catch(showError));
  for (const b of $('layoutKind').querySelectorAll('button')) b.addEventListener('click', () => editLayout({ action: 'change', number: layoutPicked, kind: b.dataset.kind }).catch(showError));
  $('layoutSwap').addEventListener('click', () => {
    const p = plan.layouts.points[layoutPicked - 1];
    editLayout({ action: 'change', number: layoutPicked, swap: !(p && p.swap) }).catch(showError);
  });
  // The panel's own buttons hide with the pick, so focus goes on to "Add Layout here".
  $('layoutDelete').addEventListener('click', () => editLayout({ action: 'delete', number: layoutPicked }).then(() => $('layoutAdd').focus(), showError));
  $('zoomOn').addEventListener('change', (e) => change({ zoom: e.target.checked }).catch(showError));
  $('zoomAdd').addEventListener('click', () => editZoom({ action: 'add', start: Math.round(nowMs) }).catch(showError));
  const strength = $('zoomStrength');
  strength.addEventListener('input', () => { $('zoomStrengthValue').textContent = `${strength.value}×`; });
  strength.addEventListener('change', () => editZoom({ action: 'change', number: selected, strength: Number(strength.value) }).catch(showError));
  $('zoomDelete').addEventListener('click', () => editZoom({ action: 'delete', number: selected }).catch(showError));
  window.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); playing ? pause() : play(); } });
}

function showControls() {
  const { look, ranges, pictureFrom } = plan;
  for (const b of $('backgrounds').querySelectorAll('button')) b.setAttribute('aria-pressed', String(!pictureFrom && b.dataset.background === look.background));
  $('pictureNote').textContent = pictureFrom === 'default' ? tr('editor.pictureDefault') : pictureFrom ? tr('editor.pictureProject') : '';
  for (const [id, label, range] of [['margin', 'marginValue', ranges.margin], ['cardCorners', 'cornersValue', ranges.cardCorners]]) {
    const input = $(id);
    input.min = String(range.min);
    input.max = String(range.max);
    input.value = String(look[id]);
    $(label).textContent = `${look[id]}%`;
  }
  for (const b of $('aspect').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.aspect === look.aspect));
  showBubbleControls();
}

// The Bubble's section, only for a Project with a camera. The size shown is the one in use (as recorded
// until it is changed), in percent of the shorter side.
function showBubbleControls() {
  const { look, ranges } = plan;
  $('bubbleSection').hidden = !plan.bubble;
  if (!plan.bubble) return;
  for (const b of $('bubblePlace').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.place === look.bubblePlace));
  for (const b of $('bubbleShape').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.shape === look.bubbleShape));
  for (const b of $('bubbleCorner').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.corner === look.bubbleCorner));
  const size = $('bubbleSize');
  size.min = String(ranges.bubbleSize.min);
  size.max = String(ranges.bubbleSize.max);
  size.value = String(percentOfUnit(plan.bubble.d));
  $('bubbleSizeValue').textContent = `${size.value}%`;
}

async function exportNow() {
  if (exporting) return;
  exporting = true;
  pause();
  $('export').disabled = true;
  status('editor.exporting', { pct: 0 });
  try {
    const done = await window.api.editorExport();
    status('editor.exported', { name: done.file.split(/[\\/]/).pop() });
  } catch (err) {
    showError(err);
  } finally {
    exporting = false;
    $('export').disabled = false;
  }
}
// drec changed the Project (its Zooms or Layouts): load it again, in line with the changes made here. The
// picked Zoom and Layout point are dropped, since their numbers may now belong to others.
window.api.onEditorRefresh(() => {
  drag = null; // a drag under way holds a number from the old list
  trimDrag = null;
  layoutDrag = null;
  const run = changes.then(async () => { selected = 0; layoutPicked = 0; await applyPlan(await window.api.editorLoad()); });
  changes = run.catch(() => {});
  run.catch(showError);
});
window.api.onEditorProgress((p) => { if (exporting) status('editor.exporting', { pct: Math.round(p * 100) }); });

function clock(ms) {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}

// ---------- Language ----------

function applyLanguage(next) {
  lang = window.DrecI18n.pick(next);
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-label]')) { el.setAttribute('aria-label', tr(el.dataset.i18nLabel)); el.title = tr(el.dataset.i18nLabel); }
  $('scrub').setAttribute('aria-label', tr('editor.time'));
  // Each colour is named as drec names it (drec export --background <name>).
  for (const b of $('backgrounds').querySelectorAll('button')) { b.title = b.dataset.background; b.setAttribute('aria-label', tr('editor.backgroundNamed', { name: b.dataset.background })); }
  showPlaying();
  if (plan) { document.title = `${tr('editor.title')}: ${plan.name}`; showControls(); renderTimeline(); }
  if (statusKey[0]) status(...statusKey);
}
window.api.onLanguage(applyLanguage);

// ---------- What tests (and the smoke test) call ----------

// A frame at `ms`, shrunk to w x h, as base64 RGBA.
async function snapshot(ms, w, h) {
  await renderAt(ms);
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, w, h);
  const px = sctx.getImageData(0, 0, w, h).data;
  let bin = '';
  for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000));
  return btoa(bin);
}

const ready = (async () => {
  buildControls();
  applyLanguage(await window.api.getLanguage());
  await applyPlan(await window.api.editorLoad());
})();
ready.catch(showError);

window.editor = {
  ready,
  set: change,
  editZoom,
  editLayout,
  trim: editTrim,
  plan: () => plan,
  // Runs `fn` (which clicks or drags something) and waits until what it changed is saved and shown.
  whenSaved: async (fn) => { fn(); await changes; },
  // A click on the preview at a spot of the Card, as fractions 0..1 of its width and height.
  aimAt: (u, v) => {
    const r = canvas.getBoundingClientRect();
    const { card } = geometryNow();
    const x = r.left + ((card.x + u * card.w) / canvas.width) * r.width;
    const y = r.top + ((card.y + v * card.h) / canvas.height) * r.height;
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  },
  reload: async () => applyPlan(await window.api.editorLoad()),
  renderAt,
  snapshot,
  look: () => plan && plan.look,
};
