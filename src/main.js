// Desktop Recorder, main process: control panel, screen choice, shortcuts and saving.
// The camera bubble and its toolbar live in bubble-windows.js.
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { convertToMp4 } = require('./convert');
const bubble = require('./bubble-windows');

// DR_OUTPUT_DIR lets the smoke test save somewhere disposable instead of the Videos folder.
const OUTPUT_DIR = () => process.env.DR_OUTPUT_DIR || path.join(app.getPath('videos'), 'Desktop Recorder');
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, '..', 'build', 'icon.png'); // drawn by build/make-icon.js
const APP_ID = 'com.eliezerord.desktoprecorder'; // same as build.appId in package.json

// The smoke test keeps its own settings folder, so it never changes the user's saved choices
// and can run while the app is open.
if (process.env.DR_SMOKE) app.setPath('userData', path.join(os.tmpdir(), 'desktop-recorder-smoke'));

let controlWin = null;
const capture = { sourceId: null, displayId: null, systemAudio: false };
const recording = { stream: null, webmPath: null };

// Diagnostic lines go to the terminal and, with DR_LOG=<file>, to that file too: on Windows the
// terminal output of a process that gets killed is lost, a file is not.
function log(line) {
  console.log(line);
  if (process.env.DR_LOG) fs.appendFileSync(process.env.DR_LOG, `${line}\n`);
}

// With DR_DEBUG=1 the windows' console messages show in the terminal that started the app.
function forwardConsole(win, label) {
  if (!process.env.DR_DEBUG) return;
  win.webContents.on('console-message', (e, _level, message) => log(`[${label}] ${e.message || message}`));
}

// Messages to the panel are skipped once it is closed, so quitting never trips over it.
function toPanel(channel, ...args) {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send(channel, ...args);
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 400,
    height: 720,
    minWidth: 360,
    title: 'Desktop Recorder',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, backgroundThrottling: false },
  });
  // Keeps the control panel out of the video. Windows 10 2004+ excludes it from capture.
  controlWin.setContentProtection(true);
  forwardConsole(controlWin, 'panel');
  controlWin.loadFile(path.join(__dirname, 'control.html'));
  controlWin.on('closed', () => app.quit());
}

function displayById(id) {
  return screen.getAllDisplays().find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function registerIpc() {
  ipcMain.handle('list-screens', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
    const primaryId = String(screen.getPrimaryDisplay().id);
    return sources.map((s, i) => {
      const d = displayById(s.display_id);
      return {
        id: s.id,
        displayId: s.display_id,
        name: `Pantalla ${i + 1}${String(d.id) === primaryId ? ' (principal)' : ''}`,
        size: `${d.size.width} x ${d.size.height}`,
        primary: String(d.id) === primaryId,
        thumb: s.thumbnail.toDataURL(),
      };
    });
  });

  ipcMain.handle('select-screen', (_e, sourceId, displayId) => {
    capture.sourceId = sourceId;
    capture.displayId = displayId;
    bubble.placeOn(displayId);
  });

  ipcMain.on('set-camera', (_e, deviceId) => bubble.setCamera(deviceId));
  ipcMain.on('set-bubble-size', (_e, size) => bubble.setSize(size));
  ipcMain.on('set-bubble-enabled', (_e, on) => bubble.setEnabled(on));

  // Read by the screen request handler, so it has to arrive before getDisplayMedia is called.
  ipcMain.on('set-system-audio', (_e, on) => { capture.systemAudio = Boolean(on); });

  ipcMain.handle('rec-begin', () => {
    recording.webmPath = path.join(os.tmpdir(), `desktop-recorder-${Date.now()}.webm`);
    recording.stream = fs.createWriteStream(recording.webmPath);
  });

  ipcMain.on('rec-chunk', (_e, chunk) => {
    if (recording.stream) recording.stream.write(Buffer.from(chunk));
  });

  ipcMain.handle('rec-finish', async (_e, info) => {
    const webm = recording.webmPath;
    if (!recording.stream || !webm) return { ok: false, error: 'No había ninguna grabación en curso.' };
    await new Promise((resolve) => recording.stream.end(resolve));
    recording.stream = null;
    recording.webmPath = null;

    const dir = OUTPUT_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const name = `Grabación ${timestamp()}.mp4`;
    const mp4 = path.join(dir, name);
    try {
      await convertToMp4(webm, mp4, (info && info.durationSec) || 0, (p) => {
        toPanel('convert-progress', p);
      });
      fs.unlinkSync(webm);
      if (!process.env.DR_SMOKE) shell.showItemInFolder(mp4);
      return { ok: true, name, file: mp4 };
    } catch (err) {
      // Keep the raw recording so nothing is lost when the conversion fails.
      const kept = path.join(dir, `Grabación ${timestamp()}.webm`);
      try { fs.renameSync(webm, kept); } catch { fs.copyFileSync(webm, kept); }
      return { ok: false, error: err.message, webm: kept };
    }
  });

  ipcMain.on('open-folder', () => {
    fs.mkdirSync(OUTPUT_DIR(), { recursive: true });
    shell.openPath(OUTPUT_DIR());
  });
}

app.whenReady().then(() => {
  // Windows groups the taskbar button and picks its icon by this id.
  app.setAppUserModelId(APP_ID);

  // The control panel asks for the screen with getDisplayMedia; this answers with the chosen
  // screen and, when asked, the PC sound ('loopback' is Windows system audio).
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const source = sources.find((s) => s.id === capture.sourceId) || sources[0];
    callback(capture.systemAudio ? { video: source, audio: 'loopback' } : { video: source });
  });

  registerIpc();
  createControlWindow();
  bubble.create({
    preload: PRELOAD,
    forwardConsole,
    // Keeps the panel's size buttons in step when the size changes from the bubble's toolbar.
    sizeChanged: (size) => toPanel('bubble-size-changed', size),
    // The recording pill's buttons do what the keyboard shortcuts do.
    recAction: (action) => toPanel('shortcut', action),
  });
  ipcMain.on('rec-state', (_e, s) => bubble.setRecState(s));

  globalShortcut.register('CommandOrControl+Shift+R', () => toPanel('shortcut', 'toggle'));
  globalShortcut.register('CommandOrControl+Shift+P', () => toPanel('shortcut', 'pause'));
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  log('saliendo');
});

// DR_SMOKE=1: checks the bubble sizes, full screen and toolbar placement, then records 5 seconds
// with mic and PC sound, waits for the MP4, prints a report and quits. How to run it: README.md.
if (process.env.DR_SMOKE) {
  app.whenReady().then(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = (name) => log(`SMOKE-STEP ${name}`);
    const panel = (js) => controlWin.webContents.executeJavaScript(js);
    const panelSize = () => panel(`document.querySelector('#bubbleSize .on')?.dataset.size`);
    step('arranque');
    await wait(6000);
    step('leyendo el panel');
    const devices = await panel(`({
      screens: document.querySelectorAll('.screen').length,
      cameras: [...document.querySelectorAll('#camera option')].map((o) => o.textContent),
      mics: document.querySelectorAll('#mic option').length - 1,
    })`);

    step('tamaños');
    const startSmall = bubble.snapshot().bounds;
    bubble.setSize('medium');
    await wait(400);
    const medium = { ...bubble.snapshot(), panel: await panelSize() };
    bubble.setSize('full');
    await wait(400);
    bubble.showToolbar();
    const full = { ...bubble.snapshot(), area: bubble.area(), panel: await panelSize() };
    bubble.setSize('medium'); // leaving full screen goes back to the size before it
    bubble.setSize('small');
    await wait(400);
    bubble.showToolbar();
    const small = bubble.snapshot();
    bubble.hideToolbar();

    // Mouse events into a window, at the centre of the element the selector finds.
    // holdMs keeps the button pressed like a person does (a click takes about 100 to 300 ms),
    // long enough for the recording timer to update the pill between press and release.
    const clickIn = async (wc, selector, holdMs = 0) => {
      const r = await wc.executeJavaScript(`(() => { const b = document.querySelector('${selector}').getBoundingClientRect();
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
      wc.sendInputEvent({ type: 'mouseMove', ...r });
      wc.sendInputEvent({ type: 'mouseDown', ...r, button: 'left', clickCount: 1 });
      if (holdMs) await wait(holdMs);
      wc.sendInputEvent({ type: 'mouseUp', ...r, button: 'left', clickCount: 1 });
    };
    const HUMAN_CLICK_MS = 400;
    const { toolbar: bar, pill } = bubble.contents();
    const pillMain = () => pill.executeJavaScript(`document.getElementById('main').title`);

    step('clic en la barra');
    // A click on the bar's "Pequeña" button must shrink the bubble.
    bubble.setSize('medium');
    await wait(300);
    bubble.showToolbar();
    await wait(300);
    await clickIn(bar, '[data-action="small"]');
    await wait(500);
    const afterClick = bubble.snapshot();
    const b = afterClick.bounds;
    const p = afterClick.pillBounds;

    // The bar's X closes the bubble and the pill with it; choosing a size brings both back.
    await clickIn(bar, '[data-action="close"]');
    await wait(400);
    const closed = bubble.snapshot();
    bubble.setSize('small');
    await wait(400);
    const reopened = bubble.snapshot();

    const checks = {
      'clic en Pequeña de la barra': afterClick.bounds.width === 200,
      'pastilla visible': afterClick.pillVisible,
      'pastilla al lado, sin tapar la burbuja': p.x + p.width <= b.x || p.x >= b.x + b.width,
      'la X cierra burbuja y pastilla': !closed.visible && !closed.pillVisible,
      'vuelven al elegir tamaño': reopened.visible && reopened.pillVisible,
      'Pequeña cambia el tamaño': afterClick.bounds.width === 200,
      'mediana mide 400': medium.bounds.width === 400 && medium.bounds.height === 400,
      'el panel se sincroniza': medium.panel === 'medium' && full.panel === 'full',
      'completa cubre la pantalla': JSON.stringify(full.bounds) === JSON.stringify(full.area),
      'barra dentro en completa': full.toolbarBounds.y + full.toolbarBounds.height <= full.area.y + full.area.height,
      'vuelve a pequeña (200)': small.bounds.width === 200,
      'vuelve cerca de donde estaba': Math.abs(small.bounds.x - startSmall.x) <= 100 && Math.abs(small.bounds.y - startSmall.y) <= 100,
      'barra centrada bajo la burbuja': Math.abs((small.toolbarBounds.x + small.toolbarBounds.width / 2) - (small.bounds.x + small.bounds.width / 2)) <= 1,
    };

    step('grabación desde la pastilla');
    // The whole recording is driven from the pill: record, pause, resume, stop.
    await panel(`document.getElementById('systemAudio').checked = true;
      document.getElementById('systemAudio').dispatchEvent(new Event('change'));`);
    checks['pastilla dice Grabar'] = (await pillMain()).startsWith('Grabar');
    await clickIn(pill, '#main', HUMAN_CLICK_MS);
    await wait(3500 + 2000); // countdown, then 2 seconds of recording
    checks['pastilla dice Parar al grabar'] = (await pillMain()).startsWith('Parar');
    await clickIn(pill, '#pause', HUMAN_CLICK_MS);
    await wait(1000);
    checks['pausa con un toque'] = (await panel(`document.getElementById('status').textContent`)) === 'En pausa.';
    await clickIn(pill, '#pause', HUMAN_CLICK_MS);
    await wait(2000);
    checks['reanuda con un toque'] = (await panel(`document.getElementById('status').textContent`)) === 'Grabando.';
    await clickIn(pill, '#main', HUMAN_CLICK_MS);
    await wait(500);
    checks['para con un toque'] = !(await pillMain()).startsWith('Parar');
    step('esperando el MP4');
    let status = '';
    for (let i = 0; i < 60 && !/Guardado|No se pudo/.test(status); i++) {
      await wait(1000);
      status = await panel(`document.getElementById('status').textContent`);
    }
    const files = fs.existsSync(OUTPUT_DIR()) ? fs.readdirSync(OUTPUT_DIR()) : [];
    log('SMOKE ' + JSON.stringify({ ...devices, displays: screen.getAllDisplays().length, checks, status, files }));
    app.quit();
  });
}
