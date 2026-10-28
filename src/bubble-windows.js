// Camera bubble and the two small windows that go with it:
// - the bubble is dragged by code and clicks pass through its transparent corners;
// - a toolbar (close, small, medium, full screen) shows when the mouse is over the bubble;
// - a recording pill (record or stop, time, pause) stays next to the bubble.
// The toolbar and the pill are kept out of the recording, so they never appear in the video.
// Hover is watched from here by reading the cursor position, because mouse enter and leave
// events are unreliable across separate transparent windows.
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const path = require('path');

const SIZES = { small: 200, medium: 400 };
const MARGIN = 40; // gap to the screen edge when the bubble is placed on a screen
const TOOLBAR = { width: 152, height: 40, overlap: 14 }; // overlap: how far the bar sits over the bubble's bottom edge
const FULL_TOOLBAR_GAP = 24; // in full screen the bar sits this far above the bottom
const PILL = { width: 52, height: 148, gap: 12 }; // gap: space between the pill and the bubble
const HIDE_AFTER_STILL_MS = 1500; // the bar gets out of the way 1.5 s after the mouse stops
const HIDE_AFTER_LEAVE_MS = 400; // time to move the mouse from the bubble onto the bar
const POINTER_POLL_MS = 50; // 20 checks a second is enough to feel instant
const DRAG_TICK_MS = 16; // about 60 moves a second

let bubbleWin = null;
let toolbarWin = null;
let pillWin = null;
let onSizeChanged = () => {};
let onRecAction = () => {};
const state = { size: 'small', beforeFull: 'small', enabled: true, cameraId: null, displayId: null, normalBounds: null };
// Background effect and ring, set from the panel or the CLI and drawn by the bubble.
let effects = { background: 'none', bgColor: '#2f5bff', bgImage: null, border: false, borderColor: '#ffffff' };
const pointer = { last: null, overBubble: false, lastMoveAt: 0, leftAt: 0 };
let drag = null;
let lastRecState = { phase: 'idle', time: '00:00' };

const visible = () => state.enabled && state.size !== 'hidden';
// A closed window throws on any call, and a throw in the main process opens an error dialog
// that blocks the app from quitting. Everything that runs on a timer checks this first.
const alive = (win) => Boolean(win && !win.isDestroyed());
let pointerTimer = null;

function displayById(id) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) || null;
}

function create({ preload, forwardConsole, sizeChanged, recAction }) {
  onSizeChanged = sizeChanged || onSizeChanged;
  onRecAction = recAction || onRecAction;
  const common = {
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { preload, backgroundThrottling: false },
  };

  // Not focusable: grabbing the bubble never steals focus from the app being recorded.
  bubbleWin = new BrowserWindow({ ...common, focusable: false, width: SIZES.small, height: SIZES.small });
  bubbleWin.setAlwaysOnTop(true, 'pop-up-menu', 1); // above normal windows and most popups
  bubbleWin.setVisibleOnAllWorkspaces(true);
  forwardConsole(bubbleWin, 'burbuja');
  bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  bubbleWin.webContents.on('did-finish-load', () => {
    setInteractive(false);
    bubbleWin.webContents.send('bubble-effects', effects);
    apply();
  });

  // Focusable, so a click always lands on Windows.
  toolbarWin = new BrowserWindow({ ...common, width: TOOLBAR.width, height: TOOLBAR.height });
  pillWin = new BrowserWindow({ ...common, width: PILL.width, height: PILL.height });
  for (const [win, file, label] of [[toolbarWin, 'toolbar.html', 'barra'], [pillWin, 'recpill.html', 'pastilla']]) {
    win.setAlwaysOnTop(true, 'pop-up-menu', 2); // one step above the bubble
    win.setVisibleOnAllWorkspaces(true);
    win.setContentProtection(true); // out of the recording, like the control panel
    forwardConsole(win, label);
    win.loadFile(path.join(__dirname, file));
  }
  toolbarWin.webContents.on('did-finish-load', sendToolbarState);
  pillWin.webContents.on('did-finish-load', () => pillWin.webContents.send('rec-state', lastRecState));

  registerIpc();
  pointerTimer = setInterval(watchPointer, POINTER_POLL_MS);
  app.on('before-quit', stopTimers);
}

function stopTimers() {
  clearInterval(pointerTimer);
  pointerTimer = null;
  if (drag) clearInterval(drag.timer);
  drag = null;
}

// While false, clicks go to whatever is under the bubble.
let interactive = null;
function setInteractive(on) {
  if (!bubbleWin || interactive === on) return;
  interactive = on;
  bubbleWin.setIgnoreMouseEvents(!on);
}

function currentArea() {
  const chosen = displayById(state.displayId);
  return (chosen || screen.getDisplayMatching(bubbleWin.getBounds())).workArea;
}

function clampInto(bounds, area) {
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - bounds.width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - bounds.height),
  };
}

const inside = (p, r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
function insideBubble(p, b) {
  if (state.size === 'full') return inside(p, b);
  const r = b.width / 2;
  return (p.x - (b.x + r)) ** 2 + (p.y - (b.y + r)) ** 2 <= r * r;
}

// New size around the same centre, kept inside its screen.
function resizeAround(size) {
  const old = bubbleWin.getBounds();
  const area = screen.getDisplayMatching(old).workArea;
  const next = {
    x: Math.round(old.x + old.width / 2 - size / 2),
    y: Math.round(old.y + old.height / 2 - size / 2),
    width: size,
    height: size,
  };
  bubbleWin.setBounds(clampInto(next, area));
}

function apply() {
  if (!alive(bubbleWin)) return;
  const full = state.size === 'full';
  if (!visible()) {
    setEscape(false);
    bubbleWin.hide();
    hideToolbar();
  } else if (full) {
    if (!state.normalBounds) state.normalBounds = bubbleWin.getBounds();
    bubbleWin.setBounds(currentArea());
    setEscape(true);
    bubbleWin.showInactive();
  } else {
    setEscape(false);
    if (state.normalBounds) {
      bubbleWin.setBounds(state.normalBounds);
      state.normalBounds = null;
    }
    resizeAround(SIZES[state.size]);
    bubbleWin.showInactive();
  }
  bubbleWin.webContents.send('bubble-camera', visible() ? state.cameraId : null);
  bubbleWin.webContents.send('bubble-mode', { full });
  sendToolbarState();
  if (toolbarWin && toolbarWin.isVisible()) placeToolbar();
  updatePill();
  onSizeChanged(state.size);
}

// Esc leaves full screen. It is only taken while the camera covers the screen.
let escapeTaken = false;
function setEscape(on) {
  if (on && !escapeTaken) escapeTaken = globalShortcut.register('Escape', () => setSize(state.beforeFull));
  if (!on && escapeTaken) {
    globalShortcut.unregister('Escape');
    escapeTaken = false;
  }
}

function setSize(size) {
  if (size === 'full' && state.size !== 'full') state.beforeFull = SIZES[state.size] ? state.size : 'small';
  state.size = size;
  apply();
}

function sendToolbarState() {
  if (alive(toolbarWin)) toolbarWin.webContents.send('toolbar-state', { size: state.size });
}

// ---------- Toolbar ----------

function placeToolbar() {
  if (!alive(toolbarWin) || !alive(bubbleWin)) return;
  const b = bubbleWin.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const y = state.size === 'full'
    ? b.y + b.height - TOOLBAR.height - FULL_TOOLBAR_GAP
    : b.y + b.height - TOOLBAR.overlap;
  const bounds = { x: Math.round(b.x + (b.width - TOOLBAR.width) / 2), y, width: TOOLBAR.width, height: TOOLBAR.height };
  toolbarWin.setBounds(clampInto(bounds, area));
}

function showToolbar() {
  if (!alive(toolbarWin) || !visible() || drag) return;
  placeToolbar();
  if (!toolbarWin.isVisible()) toolbarWin.showInactive();
}

function hideToolbar() {
  if (alive(toolbarWin) && toolbarWin.isVisible()) toolbarWin.hide();
}

// ---------- Recording pill ----------

// Beside the bubble: on the left, or on the right when there is no room. In full screen, at the left edge.
function placePill() {
  if (!alive(pillWin) || !alive(bubbleWin)) return;
  const b = bubbleWin.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  let x;
  let y;
  if (state.size === 'full') {
    x = area.x + PILL.gap;
    y = area.y + Math.round((area.height - PILL.height) / 2);
  } else {
    x = b.x - PILL.width - PILL.gap;
    if (x < area.x) x = b.x + b.width + PILL.gap;
    y = b.y + Math.round((b.height - PILL.height) / 2);
  }
  pillWin.setBounds(clampInto({ x, y, width: PILL.width, height: PILL.height }, area));
}

// Goes with the bubble: closing the bubble closes the pill too. Without a bubble, and in
// camera-only mode, recording is controlled from the panel or the shortcuts.
function updatePill() {
  if (!alive(pillWin)) return;
  if (!visible()) { pillWin.hide(); return; }
  placePill();
  if (!pillWin.isVisible()) pillWin.showInactive();
}

// While a screen recording runs, the bubble is kept out of the capture like the toolbar and the pill:
// the camera is recorded apart and Export puts it back. (A window capture never contains it.)
let bubbleHidden = false;
function setRecState(s) {
  lastRecState = s;
  if (alive(pillWin)) pillWin.webContents.send('rec-state', s);
  const hide = s.mode === 'screen' && ['countdown', 'recording', 'paused'].includes(s.phase);
  if (hide !== bubbleHidden && alive(bubbleWin)) {
    bubbleHidden = hide;
    bubbleWin.setContentProtection(hide);
  }
}

// ---------- Pointer watcher ----------

// Shows the bar while the mouse moves over the bubble or rests on the bar, hides it 1.5 s after
// the mouse stops on the bubble or soon after it leaves both, and switches the click-through.
function watchPointer() {
  if (!alive(bubbleWin) || !alive(toolbarWin) || drag) return;
  if (!visible()) { setInteractive(false); return; }
  const p = screen.getCursorScreenPoint();
  const overBubble = insideBubble(p, bubbleWin.getBounds());
  const overBar = toolbarWin.isVisible() && inside(p, toolbarWin.getBounds());
  setInteractive(overBubble);

  const moved = !pointer.last || p.x !== pointer.last.x || p.y !== pointer.last.y;
  pointer.last = p;
  const now = Date.now();

  if (overBar) {
    pointer.leftAt = 0;
    pointer.lastMoveAt = now;
  } else if (overBubble) {
    pointer.leftAt = 0;
    if (moved) {
      pointer.lastMoveAt = now;
      showToolbar();
    } else if (now - pointer.lastMoveAt > HIDE_AFTER_STILL_MS) {
      hideToolbar();
    }
  } else {
    if (!pointer.leftAt) pointer.leftAt = now;
    if (now - pointer.leftAt > HIDE_AFTER_LEAVE_MS) hideToolbar();
  }
}

// ---------- Dragging ----------

function startDrag() {
  if (!bubbleWin || drag || state.size === 'full') return;
  const c = screen.getCursorScreenPoint();
  const b = bubbleWin.getBounds();
  drag = { dx: c.x - b.x, dy: c.y - b.y, width: b.width, height: b.height };
  hideToolbar();
  drag.timer = setInterval(() => {
    if (!alive(bubbleWin)) { stopTimers(); return; }
    const p = screen.getCursorScreenPoint();
    // setBounds with the size keeps the bubble from growing when it crosses screens with different scaling.
    bubbleWin.setBounds({ x: p.x - drag.dx, y: p.y - drag.dy, width: drag.width, height: drag.height });
    placePill();
  }, DRAG_TICK_MS);
}

function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  const b = bubbleWin.getBounds();
  bubbleWin.setBounds(clampInto(b, screen.getDisplayMatching(b).workArea));
  placePill();
}

// ---------- Messages from the windows ----------

function registerIpc() {
  ipcMain.on('bubble-drag-start', startDrag);
  ipcMain.on('bubble-drag-end', endDrag);
  ipcMain.on('toolbar-action', (_e, action) => {
    if (action === 'close') setSize('hidden');
    else if (action === 'full') setSize(state.size === 'full' ? state.beforeFull : 'full');
    else if (SIZES[action]) setSize(action);
  });
  ipcMain.on('rec-action', (_e, action) => onRecAction(action));
}

// ---------- Called by the main process ----------

function setEffects(next) {
  effects = { ...effects, ...next };
  if (alive(bubbleWin)) bubbleWin.webContents.send('bubble-effects', effects);
}

// Where the bubble sits and how big it is, for window recordings: the bubble window is not in that
// capture, so the panel draws the camera into the video at this spot. Given the recorded window's
// position (physical pixels, from window-tracker), the answer is relative to that window, so the
// camera lands in the video right where the bubble covers the window on screen; a bubble outside
// the window ends up at the nearest edge. Without it (the first moment of a recording), it falls
// back to the bubble's spot on its own screen.
function placement(windowRect) {
  if (!alive(bubbleWin) || !visible()) return null;
  const b = bubbleWin.getBounds();
  if (state.size === 'full') return { full: true };
  if (windowRect) {
    const p = screen.dipToScreenRect(bubbleWin, b); // to physical pixels, like the window's position
    const w = windowRect.right - windowRect.left;
    const h = windowRect.bottom - windowRect.top;
    return { full: false, x: (p.x - windowRect.left) / w, y: (p.y - windowRect.top) / h, size: p.height / h };
  }
  const d = screen.getDisplayMatching(b).bounds;
  return { full: false, x: (b.x - d.x) / d.width, y: (b.y - d.y) / d.height, size: b.height / d.height };
}

function setCamera(deviceId) {
  state.cameraId = deviceId;
  apply();
}

function setEnabled(on) {
  state.enabled = on;
  apply();
}

// Moves the bubble to the bottom-left corner of the screen being recorded.
function placeOn(displayId) {
  state.displayId = displayId;
  if (!bubbleWin) return;
  if (state.size === 'full') { apply(); return; }
  const display = displayById(displayId) || screen.getPrimaryDisplay();
  const size = SIZES[state.size] || SIZES[state.beforeFull] || SIZES.small;
  const { x, y, height } = display.workArea;
  bubbleWin.setBounds({ x: x + MARGIN, y: y + height - size - MARGIN, width: size, height: size });
  if (toolbarWin && toolbarWin.isVisible()) placeToolbar();
  updatePill();
}

function snapshot() {
  return {
    size: state.size,
    visible: Boolean(bubbleWin && bubbleWin.isVisible()),
    bounds: bubbleWin && bubbleWin.getBounds(),
    toolbarVisible: Boolean(toolbarWin && toolbarWin.isVisible()),
    toolbarBounds: toolbarWin && toolbarWin.getBounds(),
    pillVisible: Boolean(pillWin && pillWin.isVisible()),
    pillBounds: pillWin && pillWin.getBounds(),
  };
}

// Puts the bubble in a corner (or the centre) for agents that cannot drag it: of a screen, or of
// the recorded window when its position (DIP) is given, so the camera lands in that corner of a
// window recording. A window corner is checked against the screen so the bubble stays visible.
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
const WINDOW_MARGIN = 24; // windows are smaller than screens, so a tighter gap to their edge
function placeCorner(corner, displayId, windowRect = null) {
  if (!CORNERS.includes(corner)) throw new Error(`bubble-corner: use ${CORNERS.join(', ')}.`);
  if (!alive(bubbleWin)) return;
  if (state.size === 'full') setSize(state.beforeFull);
  const display = windowRect ? screen.getDisplayMatching(windowRect) : (displayById(displayId) || screen.getDisplayMatching(bubbleWin.getBounds()));
  const a = windowRect || display.workArea;
  const gap = windowRect ? WINDOW_MARGIN : MARGIN;
  const b = bubbleWin.getBounds();
  const left = corner.endsWith('left') ? a.x + gap : corner.endsWith('right') ? a.x + a.width - b.width - gap : a.x + (a.width - b.width) / 2;
  const top = corner.startsWith('top') ? a.y + gap : corner.startsWith('bottom') ? a.y + a.height - b.height - gap : a.y + (a.height - b.height) / 2;
  bubbleWin.setBounds(clampInto({ x: Math.round(left), y: Math.round(top), width: b.width, height: b.height }, display.workArea));
  placePill();
  if (alive(toolbarWin) && toolbarWin.isVisible()) placeToolbar();
}

// For the smoke test: puts the bubble's top-left corner at a screen point (DIP), keeping its size.
function moveTo(x, y) {
  if (!alive(bubbleWin)) return;
  const b = bubbleWin.getBounds();
  bubbleWin.setBounds({ x: Math.round(x), y: Math.round(y), width: b.width, height: b.height });
  placePill();
}

// For the smoke test: lets it send real mouse events into the windows.
function contents() {
  return {
    bubble: bubbleWin && bubbleWin.webContents,
    toolbar: toolbarWin && toolbarWin.webContents,
    pill: pillWin && pillWin.webContents,
  };
}

module.exports = {
  create, setCamera, setSize, setEnabled, placeOn, setRecState, setEffects, placement,
  snapshot, showToolbar, hideToolbar, area: currentArea, contents, moveTo, placeCorner, CORNERS,
};
