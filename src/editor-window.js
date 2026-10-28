// The Editor (ticket 09): a window that previews a Project and changes its own look. It opens only when asked
// (the panel's Edit button or drec edit), one window per Project. The preview draws from the same plan as
// Export (planExport in export.js) with the same drawing functions (look.mjs, zoom.mjs, pointer.mjs), and the
// settings it changes are the Project's own look in project.json (exportLook), which drec export uses too.
const { BrowserWindow, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { planExport, readPicture, writeProject, removeProjectPictures } = require('./export');

const loadLook = () => import(pathToFileURL(path.join(__dirname, 'look.mjs')).href);
const loadZoom = () => import(pathToFileURL(path.join(__dirname, 'zoom.mjs')).href);
const loadLayouts = () => import(pathToFileURL(path.join(__dirname, 'layouts.mjs')).href);
const TRIM_MIN = 500; // the shortest video a trim in the Editor leaves, in ms
const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));

// projectDir(name): the folder of a Project. defaults(): the saved default look. exportFile(name, onProgress):
// exports a Project exactly as drec export does with no options. preload: the windows' preload script.
// tr(key): a text in the app's language (dialog titles).
function createEditor({ projectDir, defaults, exportFile, preload = path.join(__dirname, 'preload.js'), tr = (k) => k }) {
  const windows = new Map(); // Project name -> its Editor window
  const nameOf = (webContents) => [...windows].find(([, w]) => !w.isDestroyed() && w.webContents === webContents)?.[0];

  // Everything the preview needs to draw any moment of the Project, as plain data.
  // The plan drec export would follow now (with `trim`, a trim to check instead of the saved one).
  async function planOf(name, trim) {
    const dir = projectDir(name);
    const { resolveLook } = await loadLook();
    return planExport({ projectDir: dir, look: resolveLook({ defaults: defaults(), project: readProject(dir), asked: {} }), trim });
  }

  async function load(name) {
    const { BACKGROUNDS, MARGIN_RANGE, CARD_CORNERS_RANGE, BUBBLE_SIZE_RANGE } = await loadLook();
    const { ZOOM_EDIT } = await loadZoom();
    const plan = await planOf(name);
    return {
      name,
      look: plan.look,
      canvas: plan.canvas,
      card: plan.lay.card,
      bubble: plan.lay.bubble,
      shadow: plan.lay.shadow,
      picture: plan.picture ? plan.picture.dataUrl : null,
      pictureFrom: plan.pictureFrom,
      ringColor: plan.ringColor,
      zooms: plan.zooms, // the ones the export uses: none when Zoom is off
      layouts: plan.layouts, // Layout points and where each Layout puts the screen and the Bubble
      zoomList: plan.project.zoom.zooms, // every Zoom of the Project, for the timeline
      zoomOn: plan.look.zoom && plan.project.zoom.enabled !== false, // what Export does (export.js planExport)
      zoomRanges: { strength: ZOOM_EDIT.strength, minLength: ZOOM_EDIT.minLength },
      startMs: plan.startMs,
      endMs: plan.endMs,
      fullMs: plan.fullMs,
      screenUrl: pathToFileURL(plan.screenPath).href,
      cameraUrl: plan.cameraPath ? pathToFileURL(plan.cameraPath).href : null,
      cameraOffsetMs: (plan.project.camera && plan.project.camera.offsetMs) || 0,
      pointer: plan.pointer.states ? { states: plan.pointer.states, ...plan.pointerSize } : null,
      backgrounds: BACKGROUNDS.map((b) => b.id),
      ranges: { margin: MARGIN_RANGE, cardCorners: CARD_CORNERS_RANGE, bubbleSize: BUBBLE_SIZE_RANGE, trimMin: TRIM_MIN },
    };
  }

  // Merges `partial` into the Project's own look after checking the whole look; a wrong value is refused
  // and nothing is saved. Choosing a built-in Background means that one: the Project's picture goes, and a
  // picture in the default look is not used for this Project either.
  async function set(name, partial) {
    const dir = projectDir(name);
    const { normalizeLook, resolveLook, PROJECT_LOOK_KEYS } = await loadLook();
    const unknown = Object.keys(partial).filter((k) => !PROJECT_LOOK_KEYS.includes(k) || k === 'backgroundImage');
    if (unknown.length) throw new Error(`The Editor cannot change ${unknown.join(', ')}.`);
    const project = readProject(dir);
    const own = { ...(project.exportLook || {}), ...partial };
    if (partial.background !== undefined) own.backgroundImage = null;
    normalizeLook(resolveLook({ defaults: defaults(), project: { exportLook: own } }));
    project.exportLook = own;
    if (partial.background !== undefined) { removeProjectPictures(dir); delete project.backgroundImage; }
    if (partial.zoom === true && project.zoom) project.zoom.enabled = true; // the Zoom switch turns on whatever had turned it off
    writeProject(dir, project);
    return load(name);
  }

  // One edit to the Project's Zoom list (zoom.mjs editZooms: add, change, delete), checked and saved in
  // project.json, where drec export reads it. Loading first makes sure the list exists (worked out from the
  // clicks the first time) and gives the recording's length. The new plan says which Zoom was edited
  // (`edited`, its number, 0 after a delete), so the timeline keeps it picked.
  async function editZoom(name, edit) {
    const dir = projectDir(name);
    const { fullMs } = await load(name);
    const { editZooms } = await loadZoom();
    const project = readProject(dir);
    const { zooms, number } = editZooms(project.zoom.zooms, edit, { fullMs });
    project.zoom = { ...project.zoom, zooms };
    writeProject(dir, project);
    return { ...(await load(name)), edited: number };
  }

  // One edit to the Project's Layout points (layouts.mjs editLayouts), checked and saved in project.json
  // (layouts: { version, points }), where Export reads them. The new plan says which point was edited.
  // Full camera is refused when the Project has no camera recording (drec goes through here too).
  async function editLayout(name, edit) {
    const dir = projectDir(name);
    const { fullMs, cameraUrl } = await load(name);
    const { layoutPoints, editLayouts } = await loadLayouts();
    const project = readProject(dir);
    const { points, number } = editLayouts(layoutPoints(project), edit, { fullMs, hasCamera: Boolean(cameraUrl) });
    project.layouts = { version: 1, points };
    writeProject(dir, project);
    return { ...(await load(name)), edited: number };
  }

  // The trim, in milliseconds of the recording: checked by the same rules as an export, then saved in the
  // Project (end null when it reaches the end, so a longer recording is not cut).
  // A side left out keeps what is saved, like drec export --trim-start alone.
  async function setTrim(name, { start, end }) {
    const time = (n) => n === undefined || Number.isFinite(n);
    if (!time(start) || !(end === null || time(end))) throw new Error('trim: use times in milliseconds of the recording.');
    const { fullMs } = await planOf(name);
    const plan = await planOf(name, { start, end: end === undefined ? undefined : end === null || end >= fullMs ? null : end });
    if (plan.endMs - plan.startMs < TRIM_MIN) throw new Error(`trim: keep at least ${TRIM_MIN / 1000} s between the start and the end.`);
    const dir = projectDir(name);
    const project = readProject(dir);
    project.trim = { start: plan.startMs, end: plan.wantedEnd == null ? null : plan.endMs };
    writeProject(dir, project);
    return load(name);
  }

  // A picture of the user's as the Background: checked, then copied into the Project (background.<ext>).
  async function setPicture(name, file) {
    const dir = projectDir(name);
    const picture = readPicture(file);
    const project = readProject(dir);
    removeProjectPictures(dir);
    fs.writeFileSync(path.join(dir, `background.${picture.ext}`), picture.bytes);
    project.backgroundImage = `background.${picture.ext}`;
    if (project.exportLook) delete project.exportLook.backgroundImage;
    writeProject(dir, project);
    return load(name);
  }

  async function open(name, { show = true } = {}) {
    const existing = windows.get(name);
    if (existing && !existing.isDestroyed()) {
      if (show) { if (existing.isMinimized()) existing.restore(); existing.show(); existing.focus(); }
      return existing;
    }
    const win = new BrowserWindow({
      width: 1280, height: 820, minWidth: 900, minHeight: 600, show, title: `${tr('editor.title')}: ${name}`,
      autoHideMenuBar: true, webPreferences: { preload, backgroundThrottling: false },
    });
    windows.set(name, win);
    win.on('closed', () => { if (windows.get(name) === win) windows.delete(name); });
    try {
      await win.loadFile(path.join(__dirname, 'editor.html'));
    } catch (err) {
      windows.delete(name); // a window that did not load is not kept for the next open
      win.destroy();
      throw err;
    }
    return win;
  }

  function register(ipcMain) {
    const named = (fn) => async (e, ...args) => {
      const name = nameOf(e.sender);
      if (!name) throw new Error('This window is not an Editor.');
      return fn(name, e, ...args);
    };
    ipcMain.handle('editor-load', named((name) => load(name)));
    ipcMain.handle('editor-set', named((name, _e, partial) => set(name, partial || {})));
    ipcMain.handle('editor-trim', named((name, _e, trim) => setTrim(name, trim || {})));
    ipcMain.handle('editor-zoom', named((name, _e, edit) => editZoom(name, edit || {})));
    ipcMain.handle('editor-layout', named((name, _e, edit) => editLayout(name, edit || {})));
    ipcMain.handle('editor-pick-picture', named(async (name, e) => {
      const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
        title: tr('image.dialog'), properties: ['openFile'], filters: [{ name: tr('image.filter'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (res.canceled || !res.filePaths[0]) return null;
      return setPicture(name, res.filePaths[0]);
    }));
    ipcMain.handle('editor-export', named((name, e) => exportFile(name, (p) => { if (!e.sender.isDestroyed()) e.sender.send('editor-progress', p); })));
  }

  // Tells an Editor open on this Project to load it again, after something else (drec) changed it.
  function refresh(name) {
    const win = windows.get(name);
    if (win && !win.isDestroyed()) win.webContents.send('editor-refresh');
  }

  return { open, load, set, setPicture, editZoom, editLayout, setTrim, refresh, register };
}

module.exports = { createEditor };
