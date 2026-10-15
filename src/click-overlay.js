// Click highlights. Windows does not tell an app about clicks in other apps, so a global mouse hook
// (uiohook-napi) listens while a recording with highlights is running, and only then.
// - Screen recordings: a see-through window over the recorded screen draws a soft circle at each
//   click. Unlike the toolbar and the pill, it is meant to be in the video.
// - Window recordings: that overlay is not part of a window capture, so the click's spot inside
//   the window is sent to the panel, which draws the circle into the video itself.
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const windowTracker = require('./window-tracker');

let win = null;
let hook = null;
let hookRunning = false;
let hookError = null;
let mode = null;
let display = null;
let onWindowClick = () => {};

const alive = () => Boolean(win && !win.isDestroyed());

function create({ preload, forwardConsole, windowClick }) {
  onWindowClick = windowClick || onWindowClick;
  win = new BrowserWindow({
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: { preload, backgroundThrottling: false },
  });
  win.setIgnoreMouseEvents(true); // every click goes to the app underneath
  win.setAlwaysOnTop(true, 'screen-saver', 3); // above everything, so the circle is never hidden
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  forwardConsole(win, 'clics');
  win.loadFile(path.join(__dirname, 'clicks.html'));
}

// The hook reports physical pixels.
function onMouseDown(e) {
  if (mode === 'window') {
    const spot = windowTracker.locate(e.x, e.y);
    if (spot) onWindowClick(spot);
    return;
  }
  if (!alive() || !display) return;
  const p = screen.screenToDipPoint({ x: e.x, y: e.y }); // the overlay is placed in scaled (DIP) pixels
  const b = display.bounds;
  if (p.x < b.x || p.y < b.y || p.x >= b.x + b.width || p.y >= b.y + b.height) return; // a click on another screen
  win.webContents.send('click-at', { x: p.x - b.x, y: p.y - b.y });
}

function startHook() {
  if (hookRunning) return;
  try {
    if (!hook) {
      hook = require('uiohook-napi').uIOhook;
      hook.on('mousedown', onMouseDown);
    }
    hook.start();
    hookRunning = true;
    hookError = null;
  } catch (err) {
    hookError = err.message;
    console.error(`No se pudo vigilar los clics: ${err.message}`);
  }
}

function stopHook() {
  if (!hookRunning) return;
  try { hook.stop(); } catch { /* already stopped */ }
  hookRunning = false;
}

function hideOverlay() {
  if (alive() && win.isVisible()) win.hide();
}

// Called on every recording state change; does nothing when nothing changed.
// In window recordings the window's position comes from window-tracker, which main.js runs.
function update({ active, recordMode, displayId }) {
  if (!active || (recordMode !== 'screen' && recordMode !== 'window')) {
    mode = null;
    stopHook();
    hideOverlay();
    return;
  }
  mode = recordMode;
  if (mode === 'window') {
    hideOverlay();
  } else {
    if (!alive()) return;
    display = screen.getAllDisplays().find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
    win.setBounds(display.bounds);
    if (!win.isVisible()) win.showInactive();
  }
  startHook();
}

function stop() {
  stopHook();
}

// For the smoke test.
function snapshot() {
  return {
    mode,
    visible: alive() && win.isVisible(),
    bounds: alive() ? win.getBounds() : null,
    hookRunning,
    hookError,
    windowRect: windowTracker.current(),
    contents: alive() ? win.webContents : null,
  };
}

// For the smoke test: a click as the hook would report it, in physical pixels.
function simulateClick(x, y) {
  onMouseDown({ x, y });
}

module.exports = { create, update, stop, snapshot, simulateClick };
