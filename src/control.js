// Control panel: picks screen, camera and audio, and runs the recording.
// The recording is sent to the main process in 1-second pieces, which writes them to a temp file.
const $ = (id) => document.getElementById(id);

const prefs = load('prefs', { mode: 'screen', cameraId: null, micId: 'default', systemAudio: false, bubble: 'small' });
const state = { ...prefs, sourceId: null, displayId: null };

let phase = 'idle'; // idle | countdown | recording | paused | saving
let recorder = null;
let ownedStreams = []; // streams opened only for this recording, closed when it ends
let audioCtx = null;
let pending = Promise.resolve(); // keeps the pieces in order while they are converted to bytes
let elapsedMs = 0;
let lastTick = 0;
let timerId = null;
let previewStream = null;

function load(key, fallback) {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return fallback; }
}
function save() {
  const { mode, cameraId, micId, systemAudio, bubble } = state;
  try { localStorage.setItem('prefs', JSON.stringify({ mode, cameraId, micId, systemAudio, bubble })); } catch { /* prefs are a convenience */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (text) => { $('status').textContent = text; };

// ---------- Screens ----------

async function loadScreens() {
  const list = await window.api.listScreens();
  const box = $('screens');
  box.replaceChildren();
  if (!list.some((s) => s.id === state.sourceId)) {
    const pick = list.find((s) => s.primary) || list[0];
    if (pick) await chooseScreen(pick);
  }
  for (const s of list) {
    const b = document.createElement('button');
    b.className = 'screen' + (s.id === state.sourceId ? ' on' : '');
    const img = document.createElement('img');
    img.src = s.thumb;
    img.alt = s.name;
    const name = document.createElement('span');
    name.textContent = s.name;
    const size = document.createElement('small');
    size.textContent = s.size;
    b.append(img, name, size);
    b.onclick = async () => { await chooseScreen(s); loadScreens(); };
    box.append(b);
  }
}

async function chooseScreen(s) {
  state.sourceId = s.id;
  state.displayId = s.displayId;
  await window.api.selectScreen(s.id, s.displayId);
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

async function loadDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices.filter((d) => d.kind === 'videoinput');
  const mics = devices.filter((d) => d.kind === 'audioinput');

  fillSelect($('camera'), cams.map((d, i) => [d.deviceId, d.label || `Cámara ${i + 1}`]), 'No hay cámaras');
  if (!cams.some((d) => d.deviceId === state.cameraId)) state.cameraId = cams[0] ? cams[0].deviceId : null;
  $('camera').value = state.cameraId || '';

  fillSelect($('mic'), [['none', 'Sin micrófono'], ...mics.map((d, i) => [d.deviceId, d.label || `Micrófono ${i + 1}`])]);
  if (state.micId !== 'none' && !mics.some((d) => d.deviceId === state.micId)) state.micId = mics[0] ? mics[0].deviceId : 'none';
  $('mic').value = state.micId;

  window.api.setCamera(state.cameraId);
  if (state.mode === 'camera') startPreview();
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

function cameraConstraints() {
  return {
    deviceId: state.cameraId ? { exact: state.cameraId } : undefined,
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30 },
  };
}

async function startPreview() {
  stopPreview();
  if (!state.cameraId) return;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(), audio: false });
    $('preview').srcObject = previewStream;
  } catch (err) {
    status(`No se pudo abrir la cámara: ${err.message}`);
  }
}

function stopPreview() {
  if (previewStream) previewStream.getTracks().forEach((t) => t.stop());
  previewStream = null;
  $('preview').srcObject = null;
}

// ---------- Mode and bubble ----------

function setMode(mode) {
  state.mode = mode;
  save();
  const camOnly = mode === 'camera';
  $('screenSection').hidden = camOnly;
  $('bubbleSection').hidden = camOnly;
  $('systemAudioRow').hidden = camOnly;
  $('preview').hidden = !camOnly;
  // In camera-only mode the panel shows the camera, so the bubble lets go of it.
  window.api.setBubbleEnabled(!camOnly);
  if (camOnly) startPreview(); else stopPreview();
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

function markOn(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === value);
}

// ---------- Recording ----------

async function buildStream() {
  let video;
  const audioSources = [];

  if (state.mode === 'screen') {
    // The main process answers this with the chosen screen (and PC sound when asked).
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: state.systemAudio });
    ownedStreams.push(display);
    video = display.getVideoTracks()[0];
    if (display.getAudioTracks().length) audioSources.push(new MediaStream(display.getAudioTracks()));
  } else {
    if (!previewStream) await startPreview();
    if (!previewStream) throw new Error('No hay cámara disponible.');
    video = previewStream.getVideoTracks()[0];
  }
  video.addEventListener('ended', () => { if (phase === 'recording' || phase === 'paused') stopRecording(); });

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

async function startRecording() {
  if (phase !== 'idle') return;
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
      videoBitsPerSecond: state.mode === 'screen' ? 10_000_000 : 8_000_000,
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
  } catch (err) {
    releaseStreams();
    phase = 'idle';
    status(`No se pudo empezar: ${err.message}`);
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

// Keeps the recording pill next to the bubble in step with this panel.
function reportRecState(count) {
  window.api.reportRecState({ phase, time: $('timer').textContent, count });
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
  if (phase !== 'recording' && phase !== 'paused') return;
  tick();
  phase = 'saving';
  status('Guardando…');
  render();
  recorder.stop(); // finishRecording runs after the last piece arrives
}

function releaseStreams() {
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
  status(res.ok ? `Guardado: ${res.name}` : `No se pudo convertir a MP4. El video quedó en WebM: ${res.webm}`);
  if (!res.ok) console.error(res.error);
  render();
}

// ---------- UI ----------

function render() {
  const busy = phase !== 'idle';
  const live = phase === 'recording' || phase === 'paused';
  $('record').disabled = busy;
  $('record').textContent = busy ? (phase === 'saving' ? 'Guardando…' : 'Grabando…') : 'Grabar';
  $('pause').disabled = !live;
  $('pause').textContent = phase === 'paused' ? 'Reanudar' : 'Pausar';
  $('stop').disabled = !live;
  $('timer').classList.toggle('live', phase === 'recording');
  for (const b of $('mode').querySelectorAll('button')) b.disabled = busy;
  for (const b of $('screens').querySelectorAll('button')) b.disabled = busy;
  $('refreshScreens').disabled = busy;
  $('mic').disabled = busy;
  $('systemAudio').disabled = busy;
  // In screen mode the bubble is filmed as it is, so the camera can change mid-recording.
  $('camera').disabled = busy && state.mode === 'camera';
  reportRecState();
}

$('mode').addEventListener('click', (e) => { const m = e.target.dataset.mode; if (m && phase === 'idle') setMode(m); });
$('bubbleSize').addEventListener('click', (e) => { const s = e.target.dataset.size; if (s) setBubble(s); });
$('camera').addEventListener('change', (e) => {
  state.cameraId = e.target.value || null;
  save();
  window.api.setCamera(state.cameraId);
  if (state.mode === 'camera') startPreview();
});
$('mic').addEventListener('change', (e) => { state.micId = e.target.value; save(); });
$('systemAudio').addEventListener('change', (e) => {
  state.systemAudio = e.target.checked;
  save();
  window.api.setSystemAudio(state.systemAudio);
});
$('refreshScreens').addEventListener('click', loadScreens);
$('refreshDevices').addEventListener('click', loadDevices);
$('record').addEventListener('click', startRecording);
$('pause').addEventListener('click', togglePause);
$('stop').addEventListener('click', stopRecording);
$('openFolder').addEventListener('click', () => window.api.openFolder());
navigator.mediaDevices.addEventListener('devicechange', loadDevices);

window.api.onShortcut((key) => {
  if (key === 'toggle') phase === 'idle' ? startRecording() : stopRecording();
  if (key === 'pause') togglePause();
});
window.api.onConvertProgress((p) => status(`Convirtiendo a MP4… ${Math.round(p * 100)}%`));
window.api.onBubbleSizeChanged(rememberBubble); // size changed from the bubble's own toolbar

(async function init() {
  $('systemAudio').checked = state.systemAudio;
  window.api.setSystemAudio(state.systemAudio);
  setBubble(state.bubble);
  await unlockLabels();
  await loadScreens();
  await loadDevices();
  setMode(state.mode);
  render();
})();
