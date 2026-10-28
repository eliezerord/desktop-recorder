// A Capture saved as a Project (docs/adr/0001-record-raw-then-export.md). While a screen or window
// recording runs, this module owns the Project folder:
//   screen.webm  the recorded stream (screen or window, with the sound), converted to screen.mp4 at the end
//   camera.webm  the camera with its effect, recorded apart (only when there is a camera)
//   events.json  clicks and the cursor path, in milliseconds of video time (pauses are not counted)
//   project.json what was recorded and how, read by Export
// Positions are physical screen pixels, the same unit the mouse hook reports.
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');
const windowTracker = require('./window-tracker');

const CURSOR_MS = 33; // about 30 cursor samples a second
let cur = null;

function begin({ dir, info, displayId, appVersion }) {
  fs.mkdirSync(dir, { recursive: true });
  const display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  cur = {
    dir,
    info,
    appVersion,
    screenWebm: path.join(dir, 'screen.webm'),
    screenOut: fs.createWriteStream(path.join(dir, 'screen.webm')),
    cameraOut: info.camera ? fs.createWriteStream(path.join(dir, 'camera.webm')) : null,
    source: info.mode === 'window'
      ? { kind: 'window', name: info.windowName || '' }
      : { kind: 'screen', bounds: screen.dipToScreenRect(null, display.bounds) },
    events: { version: 1, cursor: [], clicks: [], windowRects: [] },
    startedAt: null, // first moment of recording, in Date.now() milliseconds
    pausedAt: null,
    pausedTotal: 0,
    timer: null,
    lastCursor: null,
    lastRect: null,
  };
  return cur.screenWebm;
}

const active = () => cur !== null;

// Video time in milliseconds, or null while counting down or paused.
function videoTime() {
  if (!cur || cur.startedAt === null || cur.pausedAt !== null) return null;
  return Date.now() - cur.startedAt - cur.pausedTotal;
}

function sampleCursor() {
  const t = videoTime();
  if (t === null) return;
  const p = screen.dipToScreenPoint(screen.getCursorScreenPoint());
  const last = cur.lastCursor;
  if (!last || last.x !== p.x || last.y !== p.y) {
    cur.events.cursor.push([Math.round(t), p.x, p.y]);
    cur.lastCursor = p;
  }
  const rect = windowTracker.current();
  const l = cur.lastRect;
  if (rect && (!l || l.left !== rect.left || l.top !== rect.top || l.right !== rect.right || l.bottom !== rect.bottom)) {
    cur.events.windowRects.push({ t: Math.round(t), ...rect });
    cur.lastRect = rect;
  }
}

// The panel's recording phase, as main.js receives it. Time starts at the first 'recording'.
function phase(name) {
  if (!cur) return;
  const now = Date.now();
  if (name === 'recording') {
    if (cur.startedAt === null) {
      cur.startedAt = now;
      cur.timer = setInterval(sampleCursor, CURSOR_MS);
    } else if (cur.pausedAt !== null) {
      cur.pausedTotal += now - cur.pausedAt;
      cur.pausedAt = null;
    }
  } else if (name === 'paused' && cur.startedAt !== null && cur.pausedAt === null) {
    cur.pausedAt = now;
  }
}

// A mouse press from the global hook, in physical pixels.
function click({ x, y, button }) {
  const t = videoTime();
  if (t === null) return;
  cur.events.clicks.push({ t: Math.round(t), x, y, button: button || 1 });
}

function screenChunk(chunk) {
  if (cur) cur.screenOut.write(Buffer.from(chunk));
}

function cameraChunk(chunk) {
  if (cur && cur.cameraOut) cur.cameraOut.write(Buffer.from(chunk));
}

const closed = (stream) => new Promise((resolve) => stream.end(resolve));

// Stops sampling and closes the files. Returns where the pieces are; the Project is still open
// until save() because the caller converts screen.webm first.
async function close() {
  if (!cur) return null;
  clearInterval(cur.timer);
  sampleCursor();
  await closed(cur.screenOut);
  if (cur.cameraOut) await closed(cur.cameraOut);
  fs.writeFileSync(path.join(cur.dir, 'events.json'), JSON.stringify(cur.events));
  return { dir: cur.dir, screenWebm: cur.screenWebm };
}

// Writes project.json and lets go of the Project. `screenFile` is the name of the video that holds the
// recording: screen.mp4, or screen.webm when the conversion failed.
function save({ screenFile, durationSec, cameraOffsetMs, plainFile }) {
  if (!cur) return null;
  const { info, source } = cur;
  const project = {
    version: 1,
    app: cur.appVersion,
    created: new Date().toISOString(),
    mode: info.mode,
    durationSec,
    screen: { file: screenFile },
    // Screen capture draws the system cursor into the video; window capture has none (docs, ticket 01).
    cursorInVideo: info.mode === 'screen',
    // True when the user had click highlights on, which draws the circles into screen.mp4; Export must not draw them again.
    clicksInVideo: Boolean(info.clicks),
    source,
    camera: cur.cameraOut ? { file: 'camera.webm', offsetMs: Math.round(cameraOffsetMs || 0) } : null,
    look: { effects: info.effects, bubble: info.bubble },
    plainMp4: plainFile || null,
  };
  fs.writeFileSync(path.join(cur.dir, 'project.json'), JSON.stringify(project, null, 2));
  const dir = cur.dir;
  cur = null;
  return dir;
}

module.exports = { begin, active, phase, click, screenChunk, cameraChunk, close, save };
