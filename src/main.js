// Desktop Recorder, main process: control panel, screen choice, shortcuts and saving.
// The camera bubble and its toolbar live in bubble-windows.js.
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session, shell, globalShortcut, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { convertToMp4 } = require('./convert');
const bubble = require('./bubble-windows');
const clickOverlay = require('./click-overlay');
const cliServer = require('./cli-server');
const i18n = require('./i18n');
const windowTracker = require('./window-tracker');
const captureProject = require('./capture-project');
const { exportProject, readPicture } = require('./export');
const { projectSize, deleteRaw, formatBytes, RAW_DELETED_MESSAGE } = require('./project-storage');
const { createEditor } = require('./editor-window');
const { pathToFileURL } = require('url');
const { renderLayers } = require('./look-window');

// Where recordings are saved: the user's choice (panel or drec --output-dir), else their own
// Videos\Desktop Recorder. DR_OUTPUT_DIR lets the smoke test save somewhere disposable.
const DEFAULT_OUTPUT_DIR = () => path.join(app.getPath('videos'), 'Desktop Recorder');
const OUTPUT_DIR = () => settings.outputDir || process.env.DR_OUTPUT_DIR || DEFAULT_OUTPUT_DIR();

// Settings the main process owns, kept in the app's own folder (userData), one per Windows user.
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
let settings = {};

// The interface language: English unless the user picked Spanish or Portuguese in the panel.
const language = () => i18n.pick(settings.language);
const tr = (key, vars) => i18n.t(language(), key, vars);
function setLanguage(lang) {
  settings.language = i18n.pick(lang);
  saveSettings();
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('language', language());
}
// Every window learns the language as soon as it has loaded.
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('did-finish-load', () => win.webContents.send('language', language()));
});
function loadSettings() {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) || {}; } catch { settings = {}; }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// Checks the folder can be written before keeping it, so a recording never fails at the end.
// null goes back to the default folder.
function setOutputDir(dir) {
  if (dir) {
    const full = path.resolve(dir);
    fs.mkdirSync(full, { recursive: true });
    fs.accessSync(full, fs.constants.W_OK);
    settings.outputDir = full;
  } else {
    delete settings.outputDir;
  }
  saveSettings();
  toPanel('output-dir', OUTPUT_DIR());
  return OUTPUT_DIR();
}
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, '..', 'build', 'icon.png'); // drawn by build/make-icon.js
const APP_ID = 'com.eliezerord.desktoprecorder'; // same as build.appId in package.json

// The smoke test keeps its own settings folder, so it never changes the user's saved choices
// and can run while the app is open.
if (process.env.DR_SMOKE || process.env.DR_PROBE) {
  app.setPath('userData', path.join(os.tmpdir(), 'desktop-recorder-smoke'));
  // Its own CLI pipe and token too, so the test's drec calls reach the test app, not the user's.
  process.env.DREC_PIPE = `\\\\.\\pipe\\desktop-recorder-smoke-${process.pid}`;
  process.env.DREC_TOKEN_FILE = path.join(os.tmpdir(), 'desktop-recorder-smoke', 'cli-token');
}

// One copy of the app at a time: opening it again (or drec starting it) shows the open panel.
if (!process.env.DR_SMOKE && !process.env.DR_PROBE && !app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (controlWin && !controlWin.isDestroyed()) {
    if (controlWin.isMinimized()) controlWin.restore();
    controlWin.show();
    controlWin.focus();
  }
});

let controlWin = null;
const capture = { sourceId: null, displayId: null, systemAudio: false };
const recording = { stream: null, webmPath: null, name: null };

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

// Screens in the order Windows numbers them. withThumbs adds a small picture for the panel.
async function listScreens(withThumbs = true) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: withThumbs ? { width: 320, height: 180 } : { width: 0, height: 0 } });
  const primaryId = String(screen.getPrimaryDisplay().id);
  return sources.map((s, i) => {
    const d = displayById(s.display_id);
    return {
      number: i + 1,
      id: s.id,
      displayId: s.display_id,
      name: tr(String(d.id) === primaryId ? 'screen.primary' : 'screen.name', { n: i + 1 }),
      size: `${d.size.width} x ${d.size.height}`,
      primary: String(d.id) === primaryId,
      thumb: withThumbs ? s.thumbnail.toDataURL() : undefined,
    };
  });
}

// Open windows that can be recorded, leaving out this app's own windows.
async function listWindows(withThumbs = true) {
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: withThumbs ? { width: 320, height: 180 } : { width: 0, height: 0 } });
  return sources
    .filter((s) => s.name && !own.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, thumb: withThumbs ? s.thumbnail.toDataURL() : undefined }));
}

function selectScreen(sourceId, displayId) {
  capture.sourceId = sourceId;
  capture.displayId = displayId;
  bubble.placeOn(displayId);
}

function selectWindow(sourceId) {
  capture.sourceId = sourceId;
}

// A background picture for the camera, shrunk and kept as data so the panel can store it and
// the camera canvas can still be recorded (a canvas with an outside file in it cannot).
async function pickBackgroundImage() {
  const res = await dialog.showOpenDialog(controlWin, {
    title: tr('image.dialog'),
    properties: ['openFile'],
    filters: [{ name: tr('image.filter'), extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return imageAsData(res.filePaths[0]);
}

const BACKGROUND_MAX_WIDTH = 1920; // a camera frame is at most this wide, so more pixels add nothing
function imageAsData(file) {
  let img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw new Error(`Could not read the picture ${file}.`);
  if (img.getSize().width > BACKGROUND_MAX_WIDTH) img = img.resize({ width: BACKGROUND_MAX_WIDTH, quality: 'best' });
  return { name: path.basename(file), dataUrl: `data:image/jpeg;base64,${img.toJPEG(85).toString('base64')}` };
}

// Ends a screen or window recording: converts the stream to screen.mp4 inside the Project, puts the
// plain MP4 in the output folder as a hard link to it (same bytes, one copy on disk; a copy when the
// two folders are on different drives) and writes project.json.
async function finishProject(info) {
  const { dir, screenWebm } = await captureProject.close();
  const outDir = OUTPUT_DIR();
  fs.mkdirSync(outDir, { recursive: true });
  const screenMp4 = path.join(dir, 'screen.mp4');
  const plain = path.join(outDir, `${recording.name}.mp4`);
  const saved = { durationSec: info.durationSec, cameraOffsetMs: info.cameraOffsetMs };
  try {
    await convertToMp4(screenWebm, screenMp4, info.durationSec || 0, (p) => toPanel('convert-progress', p));
    fs.unlinkSync(screenWebm);
    try { fs.linkSync(screenMp4, plain); } catch { fs.copyFileSync(screenMp4, plain); }
    captureProject.save({ ...saved, screenFile: 'screen.mp4', plainFile: plain });
    if (!process.env.DR_SMOKE) shell.showItemInFolder(plain);
    return { ok: true, name: path.basename(plain), file: plain, project: dir };
  } catch (err) {
    // Keep the raw recording so nothing is lost when the conversion fails.
    const kept = path.join(outDir, `${recording.name}.webm`);
    try { fs.copyFileSync(screenWebm, kept); } catch { /* the Project still has it */ }
    captureProject.save({ ...saved, screenFile: 'screen.webm' });
    return { ok: false, error: err.message, webm: kept, project: dir };
  }
}

// ---------- Projects and Export (drec projects, drec export) ----------

const projectsDir = () => path.join(OUTPUT_DIR(), 'Projects');

// Newest first, so "drec export latest" and number 1 are the recording just made.
function listProjects() {
  let names = [];
  try { names = fs.readdirSync(projectsDir()); } catch { /* no Projects folder yet */ }
  return names
    .map((name) => {
      try {
        const dir = path.join(projectsDir(), name);
        const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
        const size = projectSize(dir);
        return {
          name, mode: p.mode, created: p.created, durationSec: Math.round(p.durationSec || 0), camera: Boolean(p.camera),
          sizeBytes: size.bytes, freeableBytes: size.freeable, rawDeleted: size.rawDeleted,
          look: p.exportLook || {}, // the Project's own look, set in the Editor
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))
    .map((p, i) => ({ number: i + 1, ...p }));
}

// "latest", its number in "drec projects", its exact name or a piece of the name that fits only one.
function findProject(ref) {
  const all = listProjects();
  if (!all.length) throw new Error('There are no Projects yet. Record a screen or a window first.');
  const wanted = String(ref === undefined ? 'latest' : ref);
  const hit = wanted === 'latest' ? all[0]
    : /^\d+$/.test(wanted) ? all[Number(wanted) - 1]
    : all.find((p) => p.name === wanted) || (all.filter((p) => p.name.toLowerCase().includes(wanted.toLowerCase())).length === 1 ? all.find((p) => p.name.toLowerCase().includes(wanted.toLowerCase())) : null);
  if (!hit) throw new Error(`No Project matches "${wanted}". Run "drec projects" to see them.`);
  return hit;
}

// "Delete raw material, keep MP4". Only on a click in the panel (after a confirmation) or on
// drec delete-raw --yes; never on its own. Refused while recording.
let exporting = 0; // exports running now; their Project's files must not go while they read them

async function deleteRawOf(ref) {
  if ((await panelCall('status')).phase !== 'idle') throw new Error('Stop recording before deleting raw material.');
  if (exporting) throw new Error('Wait for the export to finish before deleting raw material.');
  const project = findProject(ref);
  const done = deleteRaw(path.join(projectsDir(), project.name));
  return { project: project.name, removed: done.removed, freedBytes: done.freed };
}

async function deleteRawFromCli(a) {
  const project = findProject(a.project);
  if (project.rawDeleted) throw new Error(`The raw material of "${project.name}" was already deleted.`);
  if (!a.yes) {
    throw new Error(`This deletes the raw material of "${project.name}" (${formatBytes(project.freeableBytes)} freed) and keeps only its plain MP4; the Project cannot be exported again. Run it again with --yes to do it.`);
  }
  return deleteRawOf(project.name);
}

// The panel's button: a confirmation in the app's language, then the delete.
async function deleteRawFromPanel(name) {
  const project = findProject(name);
  const { response } = await dialog.showMessageBox(controlWin, {
    type: 'warning',
    buttons: [tr('storage.confirmDelete'), tr('storage.cancel')],
    defaultId: 1,
    cancelId: 1,
    title: tr('storage.deleteRaw'),
    message: tr('storage.confirmTitle', { name: project.name }),
    detail: tr('storage.confirmDetail', { size: formatBytes(project.freeableBytes) }),
  });
  if (response !== 0) return { canceled: true };
  return deleteRawOf(project.name);
}

async function exportFromCli(a, onProgress) {
  if ((await panelCall('status')).phase !== 'idle') throw new Error('Stop recording before exporting.');
  const project = findProject(a.project);
  const projectDir = path.join(projectsDir(), project.name);
  // The look is the saved default look (drec set --look-...), then the Project's own look (the Editor), then
  // whatever was asked for on this export.
  const asked = Object.fromEntries(Object.entries({
    background: a.background, bubblePlace: a.bubblePlace, bubbleCorner: a.bubbleCorner, bubbleShape: a.bubbleShape, aspect: a.aspect, margin: a.margin, cardCorners: a.cardCorners, bubbleSize: a.bubbleSize,
    zoom: a.zoom, cursor: a.cursor, clicks: a.clicks,
  }).filter(([, v]) => v !== undefined));
  // Choosing a built-in Background on purpose (and no picture) means that one, whatever picture the Project or the default look has.
  const wantsBuiltIn = a.background !== undefined && a.backgroundImage === undefined;
  const { resolveLook } = await import(pathToFileURL(path.join(__dirname, 'look.mjs')).href);
  const look = resolveLook({ defaults: settings.exportLook || {}, project: JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8')), asked });
  if (wantsBuiltIn) delete look.backgroundImage;
  const backgroundImage = a.backgroundImage === 'none' ? null : a.backgroundImage;
  // Seconds from the terminal; "end" means no end. Left out, the Project's saved trim stays.
  const cut = {};
  if (a.trimStart !== undefined) cut.start = a.trimStart === 'end' ? Infinity : Math.round(a.trimStart * 1000);
  if (a.trimEnd !== undefined) cut.end = a.trimEnd === 'end' ? null : Math.round(a.trimEnd * 1000);
  const trim = Object.keys(cut).length ? cut : undefined;
  let out = path.join(OUTPUT_DIR(), `${project.name} ${tr('file.styled')}.mp4`);
  for (let n = 2; fs.existsSync(out); n++) out = path.join(OUTPUT_DIR(), `${project.name} ${tr('file.styled')} ${n}.mp4`);
  fs.mkdirSync(OUTPUT_DIR(), { recursive: true });
  exporting++;
  let done;
  try {
    done = await exportProject({ projectDir, look, trim, backgroundImage, preferBuiltIn: wantsBuiltIn, outFile: out, renderLayers, onProgress });
  } finally { exporting--; }
  return { file: done.file, project: project.name, durationSec: Math.round(done.durationSec * 10) / 10, trim: done.trim, zooms: done.zooms, pointer: done.pointer, picture: done.picture, look: done.look, layouts: done.layouts, drawn: done.drawn };
}

// ---------- The Editor (editor-window.js), opened only when asked ----------

const editor = createEditor({
  projectDir: (name) => path.join(projectsDir(), findProject(name).name),
  defaults: () => settings.exportLook || {},
  exportFile: (name, onProgress) => exportFromCli({ project: name }, onProgress), // the same as drec export with no options
  preload: PRELOAD,
  tr,
});

async function openEditor(ref) {
  const project = findProject(ref);
  if (project.rawDeleted) throw new Error(RAW_DELETED_MESSAGE);
  await editor.open(project.name);
  return { project: project.name, opened: true };
}

// ---------- Zoom commands (drec zooms, zoom-add, zoom-strength, zoom-delete) ----------
// They read and edit the same list as the Editor's timeline (editZooms in zoom.mjs, through editor-window.js).
// An Editor open on the Project reloads, so its Zoom numbers never point at a Zoom that moved.

async function zoomsFromCli(ref, edit, messageFor) {
  const project = findProject(ref);
  // The list is worked out with the recording's length and clicks, which went with the raw material.
  if (project.rawDeleted) throw new Error(`${RAW_DELETED_MESSAGE} Its Zooms can no longer be listed or changed either.`);
  const plan = edit ? await editor.editZoom(project.name, edit) : await editor.load(project.name);
  if (edit) editor.refresh(project.name);
  const sec = (ms) => Math.round(ms / 100) / 10;
  // An edit while Zoom is off for this Project would not show in an export: say so.
  const off = edit && !plan.zoomOn ? ' Zoom is off for this Project, so exports leave the Zooms out: turn it on in the Editor, with drec set --look-zoom on, or once with drec export --zoom on.' : '';
  return {
    project: project.name,
    zoomOn: plan.zoomOn,
    edited: plan.edited || 0,
    message: messageFor ? `${messageFor(plan.edited, plan.zoomList[plan.edited - 1])}${off}` : undefined,
    zooms: plan.zoomList.map((z, i) => ({ number: i + 1, startSec: sec(z.start), lengthSec: sec(z.end - z.start), strength: z.strength, x: z.x, y: z.y, start: z.start, end: z.end })),
  };
}

const zoomCommands = {
  zooms: (a) => zoomsFromCli(a.project),
  'zoom-add': (a) => zoomsFromCli(a.project, {
    action: 'add',
    start: a.at === undefined ? undefined : Math.round(a.at * 1000),
    end: a.at === undefined || a.length === undefined ? undefined : Math.round((a.at + a.length) * 1000),
    strength: a.strength,
    x: a.aim && a.aim[0],
    y: a.aim && a.aim[1],
  }, (n) => `Added Zoom ${n}.`),
  'zoom-strength': (a) => zoomsFromCli(a.project, { action: 'change', number: a.number, strength: a.strength }, (n, z) => `Zoom ${n} now has strength ${z.strength}.`),
  'zoom-delete': (a) => zoomsFromCli(a.project, { action: 'delete', number: a.number }, () => `Deleted Zoom ${a.number}. The Zooms after it moved down one number.`),
};

// ---------- Layout commands (drec layouts, layout-add, layout-change, layout-move, layout-delete) ----------
// The same list the Editor's timeline, preview and Export follow (layouts.mjs, through editor-window.js). An
// Editor open on the Project reloads, so its point numbers never point at a point that moved.

async function layoutsFromCli(ref, edit, messageFor) {
  const project = findProject(ref);
  if (project.rawDeleted) throw new Error(`${RAW_DELETED_MESSAGE} Its Layouts can no longer be listed or changed either.`);
  const plan = edit ? await editor.editLayout(project.name, edit) : await editor.load(project.name);
  if (edit) editor.refresh(project.name);
  const points = plan.layouts.points;
  const sec = (ms) => Math.round(ms / 100) / 10;
  // messageFor(n, point): what to say about the edited point (its number now, after the list is sorted again).
  return {
    project: project.name,
    edited: plan.edited || 0,
    message: messageFor ? messageFor(plan.edited, points[plan.edited - 1], sec) : undefined,
    layouts: points.map((q, i) => ({ number: i + 1, atSec: sec(q.at), kind: q.kind, swap: q.swap === true, at: q.at })),
  };
}

const kindSaid = (p) => `${p.kind}${p.swap ? ' (swapped)' : ''}`;
const ms = (seconds) => Math.round(seconds * 1000); // the times drec takes in seconds, as the list keeps them
const layoutCommands = {
  layouts: (a) => layoutsFromCli(a.project),
  // At 0 s there is always a point already, so adding one there sets the Layout the video starts with.
  'layout-add': (a) => layoutsFromCli(a.project,
    a.at === 0 ? { action: 'change', number: 1, kind: a.kind, swap: a.swap ?? false } : { action: 'add', at: ms(a.at), kind: a.kind, swap: a.swap },
    (n, p, sec) => `Layout point ${n}: ${kindSaid(p)} from ${sec(p.at)} s.`),
  'layout-change': (a) => layoutsFromCli(a.project, { action: 'change', number: a.number, kind: a.kind, swap: a.swap },
    (n, p, sec) => `Changed Layout point ${n}: now ${kindSaid(p)} from ${sec(p.at)} s.`),
  'layout-move': (a) => layoutsFromCli(a.project, { action: 'move', number: a.number, at: ms(a.at) },
    (n, p, sec) => `Moved Layout point ${a.number} to ${sec(p.at)} s${n !== a.number ? `; it is now number ${n}` : ''} (${kindSaid(p)}).`),
  'layout-delete': (a) => layoutsFromCli(a.project, { action: 'delete', number: a.number }, () => `Deleted Layout point ${a.number}. The points after it moved down one number.`),
};

// ---------- The default look (drec set --look-...) ----------

// What each option of drec set is called in a look. They carry a "look-" prefix because drec set already has
// --background for the camera's background effect.
const LOOK_OPTIONS = {
  lookBackground: 'background', lookBubblePlace: 'bubblePlace', lookBubbleCorner: 'bubbleCorner', lookBubbleShape: 'bubbleShape', lookAspect: 'aspect',
  lookMargin: 'margin', lookCardCorners: 'cardCorners', lookBubbleSize: 'bubbleSize', lookZoom: 'zoom', lookCursor: 'cursor', lookClicks: 'clicks',
};
const LOOK_KEYS = [...Object.keys(LOOK_OPTIONS), 'lookBackgroundImage', 'lookReset'];

// Splits the options of drec set or start into those about the default look and the rest.
function splitLookOptions(a) {
  const look = {};
  const rest = {};
  for (const [k, v] of Object.entries(a)) (LOOK_KEYS.includes(k) ? look : rest)[k] = v;
  return { look, rest };
}

const defaultPictureDir = () => path.join(app.getPath('userData'), 'look');
function removeDefaultPicture() {
  try { for (const f of fs.readdirSync(defaultPictureDir())) fs.rmSync(path.join(defaultPictureDir(), f), { force: true }); } catch { /* no picture saved */ }
}

// Saves the options in settings.json. A wrong value is refused in words before anything is saved; a picture is
// checked, then copied into the app's own folder so moving the original does not break later exports.
async function applyLookDefaults(l) {
  if (!Object.keys(l).length) return;
  const { normalizeLook } = await import(pathToFileURL(path.join(__dirname, 'look.mjs')).href);
  const picture = l.lookBackgroundImage && l.lookBackgroundImage !== 'none' ? readPicture(l.lookBackgroundImage) : null;
  const saved = l.lookReset ? {} : { ...(settings.exportLook || {}) };
  for (const [option, key] of Object.entries(LOOK_OPTIONS)) if (l[option] !== undefined) saved[key] = l[option];
  normalizeLook(saved);
  if (l.lookReset || l.lookBackgroundImage !== undefined) { removeDefaultPicture(); if (!picture) delete saved.backgroundImage; }
  if (picture) {
    fs.mkdirSync(defaultPictureDir(), { recursive: true });
    saved.backgroundImage = path.join(defaultPictureDir(), `background.${picture.ext}`);
    fs.writeFileSync(saved.backgroundImage, picture.bytes);
  }
  if (Object.keys(saved).length) settings.exportLook = saved; else delete settings.exportLook;
  saveSettings();
}

function registerIpc() {
  ipcMain.handle('list-screens', () => listScreens());
  ipcMain.handle('list-windows', () => listWindows());
  ipcMain.handle('select-screen', (_e, sourceId, displayId) => selectScreen(sourceId, displayId));
  ipcMain.handle('select-window', (_e, sourceId) => selectWindow(sourceId));
  ipcMain.on('set-effects', (_e, fx) => bubble.setEffects(fx));
  ipcMain.handle('pick-bg-image', () => pickBackgroundImage());
  ipcMain.handle('bubble-placement', () => bubble.placement(String(capture.sourceId).startsWith('window:') ? windowTracker.current() : null));

  ipcMain.on('set-camera', (_e, deviceId) => bubble.setCamera(deviceId));
  ipcMain.on('set-bubble-size', (_e, size) => bubble.setSize(size));
  ipcMain.on('set-bubble-enabled', (_e, on) => bubble.setEnabled(on));

  // Read by the screen request handler, so it has to arrive before getDisplayMedia is called.
  ipcMain.on('set-system-audio', (_e, on) => { capture.systemAudio = Boolean(on); });

  ipcMain.handle('rec-begin', (_e, info = {}) => {
    // Screen and window recordings are saved as a Project (capture-project.js); camera-only
    // recordings still go to one temp file and straight to an MP4.
    if (info.mode === 'screen' || info.mode === 'window') {
      const base = `${tr('file.prefix')} ${timestamp()}`;
      let name = base;
      for (let n = 2; fs.existsSync(path.join(OUTPUT_DIR(), 'Projects', name)); n++) name = `${base} ${n}`;
      recording.name = name;
      captureProject.begin({ dir: path.join(OUTPUT_DIR(), 'Projects', name), info, displayId: capture.displayId, appVersion: app.getVersion() });
      return;
    }
    recording.webmPath = path.join(os.tmpdir(), `desktop-recorder-${Date.now()}.webm`);
    recording.stream = fs.createWriteStream(recording.webmPath);
  });

  ipcMain.on('rec-chunk', (_e, chunk) => {
    if (captureProject.active()) captureProject.screenChunk(chunk);
    else if (recording.stream) recording.stream.write(Buffer.from(chunk));
  });
  ipcMain.on('rec-camera-chunk', (_e, chunk) => captureProject.cameraChunk(chunk));

  ipcMain.handle('list-projects', () => listProjects().map((p) => ({ ...p, size: formatBytes(p.sizeBytes), freeable: formatBytes(p.freeableBytes) })));
  ipcMain.handle('open-editor', async (_e, name) => {
    try { return { ok: true, ...(await openEditor(name)) }; } catch (err) { return { ok: false, error: err.message }; }
  });
  editor.register(ipcMain);
  ipcMain.handle('delete-raw', async (_e, name) => {
    try { return { ok: true, ...(await deleteRawFromPanel(name)) }; } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('rec-finish', async (_e, info) => {
    if (captureProject.active()) return finishProject(info || {});
    const webm = recording.webmPath;
    if (!recording.stream || !webm) return { ok: false, error: 'No recording was running.' };
    await new Promise((resolve) => recording.stream.end(resolve));
    recording.stream = null;
    recording.webmPath = null;

    const dir = OUTPUT_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const name = `${tr('file.prefix')} ${timestamp()}.mp4`;
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
      const kept = path.join(dir, `${tr('file.prefix')} ${timestamp()}.webm`);
      try { fs.renameSync(webm, kept); } catch { fs.copyFileSync(webm, kept); }
      return { ok: false, error: err.message, webm: kept };
    }
  });

  ipcMain.on('open-folder', () => {
    fs.mkdirSync(OUTPUT_DIR(), { recursive: true });
    shell.openPath(OUTPUT_DIR());
  });
  ipcMain.handle('get-output-dir', () => OUTPUT_DIR());
  ipcMain.handle('choose-output-dir', async () => {
    const res = await dialog.showOpenDialog(controlWin, {
      title: tr('folder.dialog'),
      defaultPath: OUTPUT_DIR(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return OUTPUT_DIR();
    return setOutputDir(res.filePaths[0]);
  });
  ipcMain.handle('reset-output-dir', () => setOutputDir(null));
  ipcMain.handle('get-language', () => language());
  ipcMain.on('set-language', (_e, lang) => setLanguage(lang));
}

app.whenReady().then(() => {
  // Windows groups the taskbar button and picks its icon by this id.
  app.setAppUserModelId(APP_ID);
  loadSettings();

  // The control panel asks for the screen with getDisplayMedia; this answers with the chosen
  // screen and, when asked, the PC sound ('loopback' is Windows system audio).
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    // Only the kind needed and no thumbnails: listing every window with pictures takes seconds.
    const kind = String(capture.sourceId || '').startsWith('window:') ? 'window' : 'screen';
    const sources = await desktopCapturer.getSources({ types: [kind], thumbnailSize: { width: 0, height: 0 } });
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
  // In window recordings the panel draws the click circles into the video itself.
  clickOverlay.create({ preload: PRELOAD, forwardConsole, windowClick: (spot) => toPanel('window-click', spot), onClick: captureProject.click });
  ipcMain.on('rec-state', (_e, s) => {
    bubble.setRecState(s);
    const recording = ['countdown', 'recording', 'paused'].includes(s.phase);
    // Window recordings follow the window's position from the countdown on: the camera and the
    // click circles are placed relative to it, and the helper needs a moment to start.
    if (recording && s.mode === 'window') windowTracker.start(capture.sourceId);
    else windowTracker.stop();
    captureProject.phase(s.phase);
    // The mouse hook runs during every screen or window recording, because the Capture keeps the clicks;
    // the circles are drawn only when the user turned click highlights on.
    clickOverlay.update({ active: recording, showCircles: Boolean(s.clicks), recordMode: s.mode, displayId: capture.displayId });
  });
  app.on('before-quit', () => { clickOverlay.stop(); windowTracker.stop(); });

  globalShortcut.register('CommandOrControl+Shift+R', () => toPanel('shortcut', 'toggle'));
  globalShortcut.register('CommandOrControl+Shift+P', () => toPanel('shortcut', 'pause'));

  cliServer.start(cliHandlers(), log);
});

// ---------- drec CLI ----------

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs one of the panel's window.drec commands, once the panel has finished loading.
async function panelCall(name, args = {}) {
  for (let i = 0; i < 80; i++) {
    if (controlWin && !controlWin.isDestroyed() && await controlWin.webContents.executeJavaScript('Boolean(window.drecReady)').catch(() => false)) break;
    await wait(250);
  }
  const res = await controlWin.webContents.executeJavaScript(`window.drec.call(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

// Turns what a person or an agent types ("screen 2", "the window with Chrome in its title", a
// picture's path) into the exact sources the panel works with.
async function resolveSettings(args) {
  const s = { ...args };
  if (args.screen !== undefined) {
    const list = await listScreens(false);
    const pick = String(args.screen).toLowerCase() === 'primary' ? list.find((x) => x.primary) : list.find((x) => String(x.number) === String(args.screen));
    if (!pick) throw new Error(`No screen "${args.screen}". Screens: ${list.map((x) => `${x.number} ${x.name}`).join(', ')}`);
    s.screen = { id: pick.id, displayId: pick.displayId };
    if (s.mode === undefined) s.mode = 'screen';
  }
  if (args.window !== undefined) {
    const list = await listWindows(false);
    const n = Number(args.window);
    const text = String(args.window).toLowerCase();
    const pick = Number.isInteger(n) && n > 0 ? list[n - 1] : list.find((w) => w.name.toLowerCase().includes(text));
    if (!pick) throw new Error(`No window "${args.window}". Windows: ${list.map((w, i) => `${i + 1} ${w.name}`).join(' | ')}`);
    s.window = { id: pick.id, name: pick.name };
    if (s.mode === undefined) s.mode = 'window';
  }
  if (args.bgImage) {
    const img = imageAsData(args.bgImage);
    s.bgImage = img.dataUrl;
    s.bgImageName = img.name;
    if (s.background === undefined) s.background = 'image';
  }
  return s;
}

async function withScreenNumber(status) {
  const list = await listScreens(false);
  const screenInfo = list.find((x) => x.id === status.screen);
  return { ...status, screenNumber: screenInfo ? screenInfo.number : null };
}

// Settings the panel does not own: where the bubble sits and where recordings are saved.
async function applyAll(a) {
  const { bubbleCorner, outputDir, language: lang, ...panelSettings } = a;
  if (lang !== undefined && !i18n.LANGS.includes(lang)) throw new Error(`language: use ${i18n.LANGS.join(', ')}.`);
  if (lang !== undefined) setLanguage(lang);
  if (bubbleCorner !== undefined && !bubble.CORNERS.includes(bubbleCorner)) throw new Error(`bubble-corner: use ${bubble.CORNERS.join(', ')}.`);
  if (Object.keys(panelSettings).length) await panelCall('apply', await resolveSettings(panelSettings));
  if (bubbleCorner !== undefined) {
    // Window recordings: the corner of the window itself, so the camera lands in that corner of
    // the video. Screen recordings: the corner of the recorded screen.
    const mode = (await panelCall('status')).mode;
    const rect = mode === 'window' ? await windowTracker.readOnce(capture.sourceId) : null;
    const dipRect = rect ? screen.screenToDipRect(null, { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }) : null;
    bubble.placeCorner(bubbleCorner, capture.displayId, dipRect);
  }
  if (outputDir !== undefined) {
    try { setOutputDir(outputDir === 'default' ? null : outputDir); } catch (err) { throw new Error(`output-dir: cannot write to "${outputDir}" (${err.code || err.message}).`); }
  }
}

async function fullStatus(status) {
  return { ...(await withScreenNumber(status)), outputDir: OUTPUT_DIR(), language: language(), exportLook: settings.exportLook || {}, version: app.getVersion() };
}

// Version plus when this copy of the app was built, so two builds with the same version number
// can be told apart (a user once ran an older 1.1.0 build and its missing options looked like a bug).
// Installed, the build time is the app archive's date; in the source folder it is "dev".
function versionText() {
  if (!app.isPackaged) return `${app.getVersion()} (dev)`;
  const built = fs.statSync(app.getAppPath()).mtime;
  const p = (n) => String(n).padStart(2, '0');
  return `${app.getVersion()} (built ${built.getFullYear()}-${p(built.getMonth() + 1)}-${p(built.getDate())} ${p(built.getHours())}:${p(built.getMinutes())})`;
}

// drec doctor: what works and what does not, each failure with a hint on how to fix it.
async function doctor(a = {}) {
  if (a.probeCursor) {
    if ((await panelCall('status')).phase !== 'idle') throw new Error('Stop recording before testing the cursor.');
    // The probe points the capture at its own windows, so the panel's choice is put back after.
    const saved = { ...capture };
    try {
      const probe = require('./cursor-probe');
      const { verdict } = await probe.probe({ capture });
      settings.cursorCapture = { screen: verdict.screen, window: verdict.window, tested: timestamp().slice(0, 10) };
      saveSettings();
    } finally {
      Object.assign(capture, saved);
    }
  }
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push(ok ? { name, ok, detail } : { name, ok, detail, hint });
  add('app', true, `Desktop Recorder ${versionText()} is running`);
  const screens = await listScreens(false);
  add('screens', screens.length > 0, `${screens.length} screen(s)`, 'Windows reports no screens to record.');
  const dev = await panelCall('devices');
  add('camera', dev.cameras.length > 0, dev.cameras.map((c) => c.label).join(', ') || 'none found', 'Connect a camera, or record with --camera none.');
  add('microphone', dev.mics.length > 0, dev.mics.map((m) => m.label).join(', ') || 'none found', 'Connect a microphone, or record with --mic none.');
  const { ffmpegPath } = require('./convert');
  add('mp4 converter', fs.existsSync(ffmpegPath), ffmpegPath, 'ffmpeg is missing: reinstall Desktop Recorder.');
  let folderOk = true;
  try { fs.mkdirSync(OUTPUT_DIR(), { recursive: true }); fs.accessSync(OUTPUT_DIR(), fs.constants.W_OK); } catch { folderOk = false; }
  add('output folder', folderOk, OUTPUT_DIR(), 'Pick a folder you can write to with --output-dir.');
  let hookOk = true;
  try { require('uiohook-napi'); } catch { hookOk = false; }
  add('click highlight', hookOk, hookOk ? 'mouse hook available' : 'mouse hook did not load', 'Reinstall Desktop Recorder to restore click highlights.');
  // Information, not a pass or fail: which captures keep the system cursor on this PC.
  const cc = settings.cursorCapture;
  const { describe } = require('./cursor-probe');
  add('cursor capture', true, cc
    ? `screen ${describe(cc.screen)}; window ${describe(cc.window)} (tested ${cc.tested})`
    : 'not tested yet (run: drec doctor --probe-cursor on)');
  return { ok: checks.every((c) => c.ok), version: versionText(), checks };
}

function cliHandlers() {
  return {
    ping: async () => 'pong',
    version: async () => versionText(),
    doctor,
    projects: async () => listProjects(),
    export: exportFromCli,
    'delete-raw': deleteRawFromCli,
    edit: (a) => openEditor(a.project),
    ...zoomCommands,
    ...layoutCommands,
    status: async () => fullStatus(await panelCall('status')),
    screens: async () => (await listScreens(false)).map(({ number, name, size, primary }) => ({ number, name, size, primary })),
    windows: async () => (await listWindows(false)).map((w, i) => ({ number: i + 1, name: w.name })),
    devices: () => panelCall('devices'),
    set: async (a) => {
      const { look, rest } = splitLookOptions(a);
      await applyLookDefaults(look);
      await applyAll(rest);
      return fullStatus(await panelCall('status'));
    },
    start: async (a) => {
      const { rest } = splitLookOptions(a);
      if (Object.keys(rest).length) await applyAll(rest);
      return fullStatus(await panelCall('start'));
    },
    pause: () => panelCall('pause'),
    resume: () => panelCall('resume'),
    stop: () => panelCall('stop'),
    quit: async () => { setTimeout(() => app.quit(), 100); return 'Closing Desktop Recorder.'; },
  };
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  log('saliendo');
});

// DR_SNAPSHOT=<file.png> saves a picture of the panel once it has loaded, then quits (for checking
// the layout and for the README). DR_LANG picks the language for that picture.
if (process.env.DR_SNAPSHOT) {
  app.whenReady().then(async () => {
    if (process.env.DR_LANG) setLanguage(process.env.DR_LANG);
    for (let i = 0; i < 60; i++) {
      if (await controlWin.webContents.executeJavaScript('Boolean(window.drecReady)').catch(() => false)) break;
      await wait(250);
    }
    await wait(1500);
    const img = await controlWin.webContents.capturePage();
    fs.writeFileSync(process.env.DR_SNAPSHOT, img.toPNG());
    app.quit();
  });
}

// DR_PROBE=cursor runs the cursor probe in cursor-probe.js and quits. It takes over the first screen
// for a few seconds and moves the mouse, so leave the mouse alone while it runs.
if (process.env.DR_PROBE === 'cursor') {
  app.whenReady().then(() => require('./cursor-probe').run({ app, capture, log }));
}

// DR_SMOKE=1 runs the smoke test in smoke.js and quits. How to run it: README.md.
if (process.env.DR_SMOKE) {
  // DR_SMOKE=capture runs only the Capture checks (smoke-capture.js); any other value runs them all.
  const smokeFile = process.env.DR_SMOKE === 'capture' ? './smoke-capture' : './smoke';
  app.whenReady().then(() => require(smokeFile).run({ app, bubble, clickOverlay, panelWin: () => controlWin, listWindows, log, outputDir: OUTPUT_DIR, setLanguage }));
}
