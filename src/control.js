// Control panel: picks what to record (a screen, a window or only the camera), the camera and its
// effects, and runs the recording. The recording is sent to the main process in 1-second pieces,
// which writes them to a temp file. window.drec at the bottom is what the drec CLI calls.
import { createCameraPipeline } from './camera-pipeline.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_EFFECTS = { background: 'none', bgColor: '#2f5bff', bgImage: null, bgImageName: '', border: false, borderColor: '#ffffff' };
const prefs = load('prefs', { mode: 'screen', cameraId: null, micId: 'default', systemAudio: false, bubble: 'small', clicks: false, effects: {} });
const state = {
  ...prefs,
  effects: { ...DEFAULT_EFFECTS, ...(prefs.effects || {}) },
  sourceId: null,
  displayId: null,
  windowId: null,
  windowName: '',
};

let phase = 'idle'; // idle | countdown | recording | paused | saving
let recorder = null;
let ownedStreams = []; // streams opened only for this recording, closed when it ends
let audioCtx = null;
let compositor = null;
let pending = Promise.resolve(); // keeps the pieces in order while they are converted to bytes
let elapsedMs = 0;
let lastTick = 0;
let timerId = null;
let lastResult = null;
let lastError = null;
const waiters = { started: [], finished: [] }; // CLI calls waiting for a recording to start or finish

// The camera as the panel sees it: the preview in camera-only mode, and the camera drawn into
// window recordings. The bubble window has its own copy for screen recordings.
const pipeline = createCameraPipeline($('preview'), { idealWidth: 1920, idealHeight: 1080 });

function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return fallback; }
}
function save() {
  const { mode, cameraId, micId, systemAudio, bubble, clicks, effects } = state;
  try { localStorage.setItem('prefs', JSON.stringify({ mode, cameraId, micId, systemAudio, bubble, clicks, effects })); } catch { /* prefs are a convenience */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (text) => { $('status').textContent = text; };
const busy = () => phase !== 'idle';
const live = () => phase === 'recording' || phase === 'paused';

// ---------- Screens and windows ----------

function thumbButton(item, selected, onPick) {
  const b = document.createElement('button');
  b.className = 'screen' + (selected ? ' on' : '');
  const img = document.createElement('img');
  img.src = item.thumb;
  img.alt = item.name;
  const name = document.createElement('span');
  name.textContent = item.name;
  b.append(img, name);
  if (item.size) {
    const size = document.createElement('small');
    size.textContent = item.size;
    b.append(size);
  }
  b.onclick = onPick;
  return b;
}

async function loadScreens() {
  const list = await window.api.listScreens();
  if (!list.some((s) => s.id === state.sourceId)) {
    const pick = list.find((s) => s.primary) || list[0];
    if (pick) await chooseScreen(pick);
  }
  $('screens').replaceChildren(...list.map((s) => thumbButton(s, s.id === state.sourceId, async () => { await chooseScreen(s); loadScreens(); })));
  render();
  return list;
}

async function chooseScreen(s) {
  state.sourceId = s.id;
  state.displayId = s.displayId;
  if (state.mode === 'screen') await window.api.selectScreen(s.id, s.displayId);
}

async function loadWindows() {
  const list = await window.api.listWindows();
  if (state.windowId && !list.some((w) => w.id === state.windowId)) { state.windowId = null; state.windowName = ''; }
  $('windows').replaceChildren(...list.map((w) => thumbButton(w, w.id === state.windowId, async () => { await chooseWindow(w); loadWindows(); })));
  if (!list.length) $('windows').textContent = 'No hay ventanas para grabar.';
  render();
  return list;
}

async function chooseWindow(w) {
  state.windowId = w.id;
  state.windowName = w.name;
  if (state.mode === 'window') await window.api.selectWindow(w.id);
}

// ---------- Cameras and microphones ----------

async function unlockLabels() {
  // Device names only appear after one permission grant, so open each kind once and close it.
  for (const kind of ['video', 'audio']) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ [kind]: true });
      s.getTracks().forEach((t) => t.stop());
    } catch { /* no device of that kind, or permission denied */ }
  }
}

async function devices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const named = (kind, word) => all.filter((d) => d.kind === kind).map((d, i) => ({ id: d.deviceId, label: d.label || `${word} ${i + 1}` }));
  return { cameras: named('videoinput', 'Cámara'), mics: named('audioinput', 'Micrófono') };
}

async function loadDevices() {
  const { cameras, mics } = await devices();
  fillSelect($('camera'), cameras.map((d) => [d.id, d.label]), 'No hay cámaras');
  if (!cameras.some((d) => d.id === state.cameraId)) state.cameraId = cameras[0] ? cameras[0].id : null;
  $('camera').value = state.cameraId || '';

  fillSelect($('mic'), [['none', 'Sin micrófono'], ...mics.map((d) => [d.id, d.label])]);
  if (state.micId !== 'none' && !mics.some((d) => d.id === state.micId)) state.micId = mics[0] ? mics[0].id : 'none';
  $('mic').value = state.micId;

  window.api.setCamera(state.cameraId);
  updatePanelCamera();
  save();
}

function fillSelect(select, options, emptyText) {
  select.replaceChildren();
  if (!options.length && emptyText) options = [['', emptyText]];
  for (const [value, label] of options) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.append(o);
  }
}

// The panel only opens the camera when it needs it: the camera-only preview, or window recordings.
function updatePanelCamera() {
  const needed = state.mode === 'camera' || state.mode === 'window';
  pipeline.setCamera(needed ? state.cameraId : null);
}

function setCamera(id) {
  state.cameraId = id || null;
  save();
  $('camera').value = state.cameraId || '';
  window.api.setCamera(state.cameraId);
  updatePanelCamera();
}

// ---------- Mode, bubble and effects ----------

async function setMode(mode) {
  state.mode = mode;
  save();
  $('screenSection').hidden = mode !== 'screen';
  $('windowSection').hidden = mode !== 'window';
  $('bubbleSection').hidden = mode === 'camera';
  $('systemAudioRow').hidden = mode === 'camera';
  $('clicksSection').hidden = mode === 'camera'; // a camera-only video has no pointer to highlight
  $('preview').hidden = mode !== 'camera';
  // In camera-only mode the panel shows the camera, so the bubble lets go of it.
  window.api.setBubbleEnabled(mode !== 'camera');
  if (mode === 'screen' && state.sourceId) await window.api.selectScreen(state.sourceId, state.displayId);
  if (mode === 'window') {
    await loadWindows();
    if (state.windowId) await window.api.selectWindow(state.windowId);
  }
  updatePanelCamera();
  markOn('mode', 'mode', mode);
}

function setBubble(size) {
  rememberBubble(size);
  window.api.setBubbleSize(size);
}

// Full screen is not remembered, so the app never opens with the camera covering the screen.
function rememberBubble(size) {
  if (size !== 'full') {
    state.bubble = size;
    save();
  }
  markOn('bubbleSize', 'size', size);
}

function applyEffects(changes = {}) {
  const { pickingImage, ...fxChanges } = changes; // pickingImage only shows the image row while the picker is open
  Object.assign(state.effects, fxChanges);
  const fx = state.effects;
  if (fx.background === 'image' && !fx.bgImage) fx.background = 'none'; // no image chosen yet
  save();
  window.api.setEffects(fx);
  pipeline.setEffect({ background: fx.background, color: fx.bgColor, image: fx.bgImage });
  markOn('background', 'bg', fx.background);
  $('bgColorRow').hidden = fx.background !== 'color';
  $('bgImageRow').hidden = fx.background !== 'image' && !pickingImage;
  $('bgColor').value = fx.bgColor;
  $('bgImageName').textContent = fx.bgImageName || '';
  $('border').checked = fx.border;
  $('borderRow').hidden = !fx.border;
  $('borderColor').value = fx.borderColor;
  for (const b of $('swatches').querySelectorAll('button')) b.classList.toggle('on', b.dataset.color === fx.borderColor);
  $('effectStatus').textContent = fx.background === 'none' ? '' : 'El efecto tarda un momento en cargar la primera vez.';
}

async function pickImage() {
  const picked = await window.api.pickBackgroundImage();
  if (picked) applyEffects({ background: 'image', bgImage: picked.dataUrl, bgImageName: picked.name });
}

function setClicks(on) {
  state.clicks = Boolean(on);
  $('clicks').checked = state.clicks;
  save();
  reportRecState();
}

function markOn(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === value);
}

// ---------- Recording ----------

// Window recordings: the bubble is another window, so it is not in the capture. The camera is
// drawn into the video here instead, at the same spot and size the bubble has on its screen.
async function startCompositor(windowTrack) {
  const src = document.createElement('video');
  src.muted = true;
  src.srcObject = new MediaStream([windowTrack]);
  await src.play();
  const out = document.createElement('canvas');
  const ctx = out.getContext('2d');
  const cam = $('preview');
  let place = await window.api.bubblePlacement();
  const placeTimer = setInterval(async () => { place = await window.api.bubblePlacement(); }, 250);
  const draw = () => {
    const w = src.videoWidth & ~1; // even sizes, which H.264 needs
    const h = src.videoHeight & ~1;
    if (!w || !h) return;
    if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
    ctx.drawImage(src, 0, 0, w, h);
    if (place && pipeline.hasCamera() && cam.width) drawCamera(ctx, cam, place, w, h);
    drawClickRipples(ctx, w, h);
  };
  draw();
  const timer = setInterval(draw, 1000 / 30);
  compositor = { stop() { clearInterval(timer); clearInterval(placeTimer); src.srcObject = null; clickRipples.length = 0; } };
  const stream = out.captureStream(30);
  ownedStreams.push(stream);
  return stream.getVideoTracks()[0];
}

// Click circles for window recordings, drawn into the video. The main process sends each click's
// spot inside the window as fractions. Same look as the screen overlay (clicks.js), scaled to the
// video so a small window does not get huge circles.
const RIPPLE_MS = 550;
const RIPPLE_START = 10;
const RIPPLE_END = 34;
const RIPPLE_COLOR = '255, 214, 10';
const REFERENCE_HEIGHT = 1080; // circle sizes above are for a 1080-pixel-tall video
const clickRipples = [];
window.api.onWindowClick(({ fx, fy }) => {
  if (compositor) clickRipples.push({ fx, fy, start: performance.now() });
});

function drawClickRipples(ctx, w, h) {
  const now = performance.now();
  const scale = h / REFERENCE_HEIGHT;
  for (let i = clickRipples.length - 1; i >= 0; i--) {
    const r = clickRipples[i];
    const t = (now - r.start) / RIPPLE_MS;
    if (t >= 1) { clickRipples.splice(i, 1); continue; }
    const radius = (RIPPLE_START + (RIPPLE_END - RIPPLE_START) * t) * scale;
    const fade = 1 - t;
    ctx.beginPath();
    ctx.arc(r.fx * w, r.fy * h, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${RIPPLE_COLOR}, ${0.35 * fade})`;
    ctx.fill();
    ctx.lineWidth = Math.max(2, 3 * scale);
    ctx.strokeStyle = `rgba(${RIPPLE_COLOR}, ${0.9 * fade})`;
    ctx.stroke();
  }
}

// For the smoke test.
window.clickRippleCount = () => clickRipples.length;

function drawCamera(ctx, cam, p, w, h) {
  if (p.full) { drawCover(ctx, cam, 0, 0, w, h); return; }
  const d = Math.round(Math.min(p.size * h, w, h));
  const x = Math.min(Math.max(Math.round(p.x * w), 0), w - d);
  const y = Math.min(Math.max(Math.round(p.y * h), 0), h - d);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
  ctx.clip();
  drawCover(ctx, cam, x, y, d, d);
  ctx.restore();
  if (state.effects.border) {
    ctx.lineWidth = Math.max(2, d * 0.02);
    ctx.strokeStyle = state.effects.borderColor;
    ctx.beginPath();
    ctx.arc(x + d / 2, y + d / 2, d / 2 - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// Fills the box with the camera, cropped to fit, mirrored like the bubble.
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  ctx.save();
  ctx.translate(x + w, y);
  ctx.scale(-1, 1);
  ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
  ctx.restore();
}

async function buildStream() {
  let video;
  const audioSources = [];

  if (state.mode === 'screen' || state.mode === 'window') {
    if (state.mode === 'window' && !state.windowId) throw new Error('Elige una ventana.');
    // The main process answers this with the chosen screen or window (and PC sound when asked).
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: state.systemAudio });
    ownedStreams.push(display);
    const captured = display.getVideoTracks()[0];
    captured.addEventListener('ended', () => { if (live()) stopRecording(); });
    if (display.getAudioTracks().length) audioSources.push(new MediaStream(display.getAudioTracks()));
    video = state.mode === 'window' ? await startCompositor(captured) : captured;
  } else {
    if (!pipeline.hasCamera()) await pipeline.setCamera(state.cameraId);
    if (!pipeline.hasCamera()) throw new Error('No hay cámara disponible.');
    const cam = pipeline.stream(30); // the canvas, so the effect is in the video too
    ownedStreams.push(cam);
    video = cam.getVideoTracks()[0];
  }

  if (state.micId !== 'none') {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: state.micId }, echoCancellation: false, noiseSuppression: true, autoGainControl: false },
    });
    ownedStreams.push(mic);
    audioSources.push(mic);
  }

  const out = new MediaStream([video]);
  if (audioSources.length === 1) {
    out.addTrack(audioSources[0].getAudioTracks()[0]);
  } else if (audioSources.length > 1) {
    // Mic and PC sound become one track, because a recording keeps a single audio track.
    audioCtx = new AudioContext();
    const mix = audioCtx.createMediaStreamDestination();
    for (const s of audioSources) audioCtx.createMediaStreamSource(s).connect(mix);
    out.addTrack(mix.stream.getAudioTracks()[0]);
  }
  return out;
}

function pickMimeType() {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

function settle(list, fn) {
  while (list.length) fn(list.shift());
}

async function startRecording() {
  if (phase !== 'idle') return;
  lastError = null;
  phase = 'countdown';
  $('timer').textContent = '00:00';
  render();
  for (let n = 3; n > 0; n--) {
    $('countdown').textContent = n;
    $('countdown').hidden = false;
    reportRecState(n);
    await sleep(1000);
  }
  $('countdown').hidden = true;

  try {
    const stream = await buildStream();
    recorder = new MediaRecorder(stream, {
      mimeType: pickMimeType(),
      videoBitsPerSecond: state.mode === 'camera' ? 8_000_000 : 10_000_000,
      audioBitsPerSecond: 160_000,
    });
    await window.api.recBegin();
    pending = Promise.resolve();
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const blob = e.data;
      pending = pending.then(async () => window.api.recChunk(new Uint8Array(await blob.arrayBuffer())));
    };
    recorder.onstop = finishRecording;
    recorder.start(1000);
    phase = 'recording';
    elapsedMs = 0;
    lastTick = performance.now();
    timerId = setInterval(tick, 250);
    status('Grabando.');
    settle(waiters.started, (w) => w.resolve());
  } catch (err) {
    releaseStreams();
    phase = 'idle';
    lastError = err.message;
    status(`No se pudo empezar: ${err.message}`);
    settle(waiters.started, (w) => w.reject(err));
  }
  render();
}

function tick() {
  const now = performance.now();
  if (phase === 'recording') elapsedMs += now - lastTick;
  lastTick = now;
  const s = Math.floor(elapsedMs / 1000);
  $('timer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  reportRecState();
}

// Keeps the recording pill and the click overlay in step with this panel.
function reportRecState(count) {
  window.api.reportRecState({ phase, time: $('timer').textContent, count, mode: state.mode, clicks: state.clicks });
}

function togglePause() {
  if (!recorder) return;
  if (phase === 'recording') {
    tick();
    recorder.pause();
    phase = 'paused';
    status('En pausa.');
  } else if (phase === 'paused') {
    lastTick = performance.now();
    recorder.resume();
    phase = 'recording';
    status('Grabando.');
  }
  render();
}

function stopRecording() {
  if (!live()) return;
  tick();
  phase = 'saving';
  status('Guardando…');
  render();
  recorder.stop(); // finishRecording runs after the last piece arrives
}

function releaseStreams() {
  if (compositor) { compositor.stop(); compositor = null; }
  ownedStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  ownedStreams = [];
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}

async function finishRecording() {
  clearInterval(timerId);
  releaseStreams();
  recorder = null;
  await pending;
  status('Convirtiendo a MP4…');
  const res = await window.api.recFinish({ durationSec: elapsedMs / 1000 });
  phase = 'idle';
  lastResult = res;
  if (res.ok) {
    status(`Guardado: ${res.name}`);
    settle(waiters.finished, (w) => w.resolve(res));
  } else {
    lastError = res.error;
    status(`No se pudo convertir a MP4. El video quedó en WebM: ${res.webm}`);
    console.error(res.error);
    settle(waiters.finished, (w) => w.resolve(res));
  }
  render();
}

// ---------- UI ----------

function render() {
  const isBusy = busy();
  $('record').disabled = isBusy;
  $('record').textContent = isBusy ? (phase === 'saving' ? 'Guardando…' : 'Grabando…') : 'Grabar';
  $('pause').disabled = !live();
  $('pause').textContent = phase === 'paused' ? 'Reanudar' : 'Pausar';
  $('stop').disabled = !live();
  $('timer').classList.toggle('live', phase === 'recording');
  for (const b of $('mode').querySelectorAll('button')) b.disabled = isBusy;
  for (const b of $('screens').querySelectorAll('button')) b.disabled = isBusy;
  for (const b of $('windows').querySelectorAll('button')) b.disabled = isBusy;
  $('refreshScreens').disabled = isBusy;
  $('refreshWindows').disabled = isBusy;
  $('mic').disabled = isBusy;
  $('systemAudio').disabled = isBusy;
  // The camera can change mid-recording, except in camera-only mode, where it is the video itself.
  $('camera').disabled = isBusy && state.mode === 'camera';
  reportRecState();
}

$('mode').addEventListener('click', (e) => { const m = e.target.dataset.mode; if (m && !busy()) setMode(m); });
$('bubbleSize').addEventListener('click', (e) => { const s = e.target.dataset.size; if (s) setBubble(s); });
$('background').addEventListener('click', (e) => {
  const bg = e.target.dataset.bg;
  if (!bg) return;
  if (bg === 'image' && !state.effects.bgImage) { applyEffects({ pickingImage: true }); pickImage(); return; }
  applyEffects({ background: bg });
});
$('bgColor').addEventListener('input', (e) => applyEffects({ bgColor: e.target.value }));
$('pickImage').addEventListener('click', pickImage);
$('border').addEventListener('change', (e) => applyEffects({ border: e.target.checked }));
$('borderColor').addEventListener('input', (e) => applyEffects({ borderColor: e.target.value }));
for (const b of $('swatches').querySelectorAll('button')) {
  b.style.background = b.dataset.color;
  b.addEventListener('click', () => applyEffects({ borderColor: b.dataset.color }));
}
$('camera').addEventListener('change', (e) => setCamera(e.target.value));
$('mic').addEventListener('change', (e) => { state.micId = e.target.value; save(); });
$('systemAudio').addEventListener('change', (e) => {
  state.systemAudio = e.target.checked;
  save();
  window.api.setSystemAudio(state.systemAudio);
});
$('clicks').addEventListener('change', (e) => setClicks(e.target.checked));
$('refreshScreens').addEventListener('click', loadScreens);
$('refreshWindows').addEventListener('click', loadWindows);
$('refreshDevices').addEventListener('click', loadDevices);
$('record').addEventListener('click', startRecording);
$('pause').addEventListener('click', togglePause);
$('stop').addEventListener('click', stopRecording);
$('openFolder').addEventListener('click', () => window.api.openFolder());
const showOutputDir = (dir) => { $('outputDir').textContent = dir; };
$('chooseFolder').addEventListener('click', async () => showOutputDir(await window.api.chooseOutputDir()));
$('resetFolder').addEventListener('click', async () => showOutputDir(await window.api.resetOutputDir()));
window.api.onOutputDir(showOutputDir); // changed from drec
window.api.getOutputDir().then(showOutputDir);
navigator.mediaDevices.addEventListener('devicechange', loadDevices);

window.api.onShortcut((key) => {
  if (key === 'toggle') busy() ? stopRecording() : startRecording();
  if (key === 'pause') togglePause();
});
window.api.onConvertProgress((p) => status(`Convirtiendo a MP4… ${Math.round(p * 100)}%`));
window.api.onBubbleSizeChanged(rememberBubble); // size changed from the bubble's own toolbar

// ---------- What the drec CLI calls (through the main process) ----------

function publicStatus() {
  const fx = { ...state.effects };
  delete fx.bgImage; // the image data is large; its name says enough
  return {
    phase,
    time: $('timer').textContent,
    mode: state.mode,
    screen: state.sourceId,
    window: state.windowName || null,
    camera: $('camera').selectedOptions[0]?.textContent || null,
    mic: $('mic').selectedOptions[0]?.textContent || null,
    systemAudio: state.systemAudio,
    bubble: state.bubble,
    clicks: state.clicks,
    effects: fx,
    lastFile: lastResult && lastResult.ok ? lastResult.file : null,
    lastError,
  };
}

// Finds a camera or mic by exact id, or by a piece of its name ("OBS", "Web Camera").
function findDevice(list, wanted) {
  const w = String(wanted).toLowerCase();
  return list.find((d) => d.id === wanted) || list.find((d) => d.label.toLowerCase().includes(w));
}

async function applySettings(s) {
  const lockedWhileBusy = ['mode', 'screen', 'window', 'mic', 'systemAudio'];
  if (busy() && lockedWhileBusy.some((k) => s[k] !== undefined)) {
    throw new Error(`Can't change ${lockedWhileBusy.filter((k) => s[k] !== undefined).join(', ')} while recording.`);
  }
  if (s.mode !== undefined) {
    if (!['screen', 'window', 'camera'].includes(s.mode)) throw new Error('mode: use screen, window or camera.');
    await setMode(s.mode);
  }
  if (s.screen !== undefined) { await chooseScreen(s.screen); await loadScreens(); }
  if (s.window !== undefined) { await chooseWindow(s.window); if (state.mode === 'window') await loadWindows(); }
  const { cameras, mics } = await devices();
  if (s.camera !== undefined) {
    const cam = s.camera === 'none' ? null : findDevice(cameras, s.camera);
    if (s.camera !== 'none' && !cam) throw new Error(`No camera matches "${s.camera}". Cameras: ${cameras.map((c) => c.label).join(', ')}`);
    setCamera(cam ? cam.id : null);
  }
  if (s.mic !== undefined) {
    const mic = s.mic === 'none' ? null : findDevice(mics, s.mic);
    if (s.mic !== 'none' && !mic) throw new Error(`No microphone matches "${s.mic}". Microphones: ${mics.map((m) => m.label).join(', ')}`);
    state.micId = mic ? mic.id : 'none';
    $('mic').value = state.micId;
    save();
  }
  if (s.systemAudio !== undefined) {
    state.systemAudio = Boolean(s.systemAudio);
    $('systemAudio').checked = state.systemAudio;
    save();
    window.api.setSystemAudio(state.systemAudio);
  }
  if (s.bubble !== undefined) {
    if (!['small', 'medium', 'full', 'hidden'].includes(s.bubble)) throw new Error('bubble: use small, medium, full or hidden.');
    setBubble(s.bubble);
  }
  if (s.clicks !== undefined) setClicks(s.clicks);
  const fxKeys = ['background', 'bgColor', 'bgImage', 'bgImageName', 'border', 'borderColor'];
  const fx = Object.fromEntries(fxKeys.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
  if (fx.background !== undefined && !['none', 'blur', 'color', 'image'].includes(fx.background)) throw new Error('background: use none, blur, color or image.');
  if (Object.keys(fx).length) applyEffects(fx);
  render();
  return publicStatus();
}

const commands = {
  status: async () => publicStatus(),
  devices,
  apply: applySettings,
  start: () => new Promise((resolve, reject) => {
    if (busy()) { reject(new Error('A recording is already running.')); return; }
    waiters.started.push({ resolve: () => resolve(publicStatus()), reject });
    startRecording();
  }),
  pause: async () => {
    if (phase !== 'recording') throw new Error('Nothing is recording, so there is nothing to pause.');
    togglePause();
    return publicStatus();
  },
  resume: async () => {
    if (phase !== 'paused') throw new Error('The recording is not paused.');
    togglePause();
    return publicStatus();
  },
  stop: () => new Promise((resolve, reject) => {
    if (!live()) { reject(new Error('Nothing is recording, so there is nothing to stop.')); return; }
    waiters.finished.push({ resolve: (res) => (res.ok ? resolve({ ...publicStatus(), file: res.file }) : reject(new Error(`The MP4 conversion failed. The WebM was kept at ${res.webm}. ${res.error}`))), reject });
    stopRecording();
  }),
};

// Every call answers { ok, data } or { ok: false, error }, so errors arrive as readable text.
window.drec = {
  async call(name, args) {
    try {
      if (!commands[name]) throw new Error(`Unknown command: ${name}`);
      return { ok: true, data: await commands[name](args || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
};

(async function init() {
  $('systemAudio').checked = state.systemAudio;
  window.api.setSystemAudio(state.systemAudio);
  $('clicks').checked = state.clicks;
  setBubble(state.bubble);
  applyEffects();
  await unlockLabels();
  await loadScreens();
  await loadDevices();
  await setMode(state.mode);
  render();
  window.drecReady = true;
})();
