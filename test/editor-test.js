// Checks the Editor on made-up Projects: its real window (hidden) previews a frame, and the same frame of an
// export with the same settings must look the same; settings changed in the Editor land in project.json,
// and a picture chosen there is copied into the Project. Run: node_modules/electron/dist/electron.exe test/editor-test.js
const { app, ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ffmpegPath } = require('../src/convert');
const { exportProject } = require('../src/export');
const { renderLayers } = require('../src/look-window');
const { createEditor } = require('../src/editor-window');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-editor-'));
app.setPath('userData', path.join(dir, 'user'));
const SNAP = { w: 480, h: 270 }; // frames are compared at this size, a quarter of 1920x1080

function ffmpeg(args) {
  const r = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr).slice(-600)}`);
  return r.stdout;
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Four coloured quarters and a click in the red one at 3 s, so a Zoom shows; a mouse path for a drawn cursor.
function makeProject(name, { mode = 'screen', camera = false, cameraNoIndex = false } = {}) {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=1280x720:r=30:d=6,drawbox=x=0:y=0:w=640:h=360:color=0xff0000:t=fill,drawbox=x=0:y=360:w=640:h=360:color=0x0000ff:t=fill,drawbox=x=640:y=360:w=640:h=360:color=0xffff00:t=fill',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', // tagged like the app's own screen.mp4 (convert.js)
    '-c:a', 'aac', '-shortest', path.join(p, 'screen.mp4')]);
  if (camera) {
    // Red for 2 s, then white: the colour says which moment of the camera a frame shows.
    const cam = "color=c=0xff0000:s=640x480:r=30:d=6,drawbox=x=0:y=0:w=640:h=480:color=0xffffff:t=fill:enable='gte(t,2)'";
    ffmpeg(['-f', 'lavfi', '-i', cam, '-c:v', 'libvpx', '-b:v', '1M', ...(cameraNoIndex ? ['-cues_to_front', '0', '-reserve_index_space', '0', '-dash', '1'] : []), path.join(p, 'camera.webm')]);
  }
  fs.writeFileSync(path.join(p, 'events.json'), JSON.stringify({
    version: 1,
    cursor: [[0, 960, 540], [1500, 960, 540], [1533, 300, 200], [6000, 300, 200]],
    clicks: [{ t: 3000, x: 320, y: 180, button: 1 }],
    windowRects: mode === 'window' ? [{ t: 0, left: 0, top: 0, right: 1280, bottom: 720 }] : [],
  }));
  fs.writeFileSync(path.join(p, 'project.json'), JSON.stringify({
    version: 1, mode, durationSec: 6, screen: { file: 'screen.mp4' }, cursorInVideo: mode === 'screen', clicksInVideo: false,
    camera: camera ? { file: 'camera.webm', offsetMs: 0 } : null,
    source: mode === 'window' ? { kind: 'window', name: 'x' } : { kind: 'screen', bounds: { x: 0, y: 0, width: 1280, height: 720 } },
    look: { effects: { background: 'none', border: true, borderColor: '#ffffff' }, bubble: 'small' },
    plainMp4: null,
  }));
  return p;
}

// One frame of an exported MP4 (by its number), shrunk to SNAP, as RGBA, decoded the way a player shows it:
// by Chromium, in a hidden window, like the Editor decodes the Capture.
const READER = `<!doctype html><meta charset="utf-8"><video id="v" muted></video><script>
window.frame = async (src, sec, w, h) => {
  const v = document.getElementById('v');
  if (v.dataset.src !== src) { v.dataset.src = src; v.src = src; await new Promise((r) => { v.onloadeddata = r; }); }
  v.currentTime = sec; await new Promise((r) => { v.onseeked = r; });
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(v, 0, 0, w, h);
  const px = x.getImageData(0, 0, w, h).data; let bin = '';
  for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000));
  return btoa(bin);
};
</script>`;
let reader = null;
async function frameOf(file, n) {
  if (!reader) {
    fs.writeFileSync(path.join(dir, 'reader.html'), READER);
    reader = new BrowserWindow({ show: false });
    await reader.loadFile(path.join(dir, 'reader.html'));
  }
  const sec = (n + 0.5) / 30; // the middle of the frame
  return Buffer.from(await reader.webContents.executeJavaScript(`window.frame(${JSON.stringify(pathToFileURL(file).href)}, ${sec}, ${SNAP.w}, ${SNAP.h})`), 'base64');
}
// Mean difference per colour channel, 0..255, over the whole frame.
function meanDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) { d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
  return d / n;
}

app.on('window-all-closed', () => {}); // the windows open and close one by one; the app stays until the end

app.whenReady().then(async () => {
  const checks = {};
  const notes = [];
  const projects = {
    zoom: makeProject('zoom'),
    pointer: makeProject('pointer', { mode: 'window' }),
    camera: makeProject('camera', { camera: true }),
    raw: makeProject('raw', { camera: true, cameraNoIndex: true }),
  };
  const editor = createEditor({ projectDir: (name) => projects[name], defaults: () => ({}), exportFile: async () => { throw new Error('not in this test'); } });
  editor.register(ipcMain);
  ipcMain.handle('get-language', () => 'en'); // the app's main process answers this; here English

  // What `drec export` does with no options: the Project's own look over the defaults.
  const exportNow = async (name, file) => {
    const { resolveLook } = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'look.mjs')).href);
    const project = readJson(path.join(projects[name], 'project.json'));
    return exportProject({ projectDir: projects[name], look: resolveLook({ defaults: {}, project, asked: {} }), outFile: path.join(dir, file), renderLayers });
  };
  const preview = async (win, ms) => Buffer.from(await win.webContents.executeJavaScript(`window.editor.snapshot(${ms}, ${SNAP.w}, ${SNAP.h})`), 'base64');
  const run = async (name, fn) => { try { await fn(); checks[name] = true; } catch (err) { checks[name] = false; console.error(`${name}: ${err.message}`); } };
  const assert = (ok, why) => { if (!ok) throw new Error(why); };

  // A preview frame and the exported frame for the same moment, for the look set through the Editor itself.
  async function compare(key, look, frame, label) {
    const win = await editor.open(key, { show: false });
    await win.webContents.executeJavaScript('window.editor.ready');
    await win.webContents.executeJavaScript(`window.editor.set(${JSON.stringify(look)})`);
    const done = await exportNow(key, `${key}.mp4`);
    const shot = await preview(win, (frame * 1000) / 30);
    const real = await frameOf(done.file, frame);
    const d = meanDiff(shot, real);
    notes.push(`${label}: ${d.toFixed(2)}`);
    if (process.env.DR_EDITOR_DUMP) { // writes both frames as PNGs to look at a difference
      for (const [tag, px] of [['preview', shot], ['export', real]]) {
        const raw = path.join(process.env.DR_EDITOR_DUMP, `${key}-${tag}.rgba`);
        fs.writeFileSync(raw, px);
        ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${SNAP.w}x${SNAP.h}`, '-i', raw, path.join(process.env.DR_EDITOR_DUMP, `${key}-${tag}.png`)]);
        fs.rmSync(raw);
      }
    }
    return { win, d, shot, done };
  }

  let zoomCase;
  await run('a zoomed frame with the Editor\'s Background, margin and corners matches the export', async () => {
    zoomCase = await compare('zoom', { background: 'dusk', margin: 8, cardCorners: 4 }, 90, 'zoom 3.0 s');
    assert(zoomCase.done.zooms === 1, 'no Zoom in the export');
    assert(zoomCase.d < 4, `differs by ${zoomCase.d.toFixed(2)}`);
  });

  await run('the export\'s colours are what a player shows: the red quarter stays red', async () => {
    const px = await frameOf(zoomCase.done.file, 90);
    const at = (x, y) => [...px.subarray((y * SNAP.w + x) * 4, (y * SNAP.w + x) * 4 + 3)];
    const red = at(Math.round(SNAP.w * 0.3), Math.round(SNAP.h * 0.3)); // inside the zoomed red quarter
    notes.push(`red in a player ${red}`);
    assert(red[0] > 235 && red[1] < 20 && red[2] < 20, `red is ${red}`);
  });

  await run('the comparison can tell: another moment differs clearly', async () => {
    const other = await preview(zoomCase.win, 0); // not zoomed yet
    const d = meanDiff(other, await frameOf(zoomCase.done.file, 90));
    notes.push(`zoom: 0 s against 3.0 s ${d.toFixed(2)}`);
    assert(d > 3 * Math.max(1, zoomCase.d), `only ${d.toFixed(2)}`);
    zoomCase.win.destroy();
  });

  await run('a vertical frame with the drawn cursor and a click circle matches the export', async () => {
    const c = await compare('pointer', { aspect: '9:16', background: 'mint' }, 93, 'pointer 9:16 3.1 s');
    assert(c.done.pointer.cursor === 'drawn' && c.done.pointer.clicks === 1, JSON.stringify(c.done.pointer));
    assert(c.d < 4, `differs by ${c.d.toFixed(2)}`);
    c.win.destroy();
  });

  await run('a frame with the camera Bubble and its ring matches the export', async () => {
    const c = await compare('camera', { bubblePlace: 'outside', bubbleCorner: 'top-right', background: 'midnight' }, 75, 'camera 2.5 s');
    assert(c.d < 4, `differs by ${c.d.toFixed(2)}`);
    c.win.destroy();
  });

  await run('a camera file with no seek index still shows the right moment', async () => {
    const c = await compare('raw', { bubblePlace: 'inside' }, 105, 'camera without index 3.5 s');
    assert(c.d < 4, `differs by ${c.d.toFixed(2)}`);
    c.win.destroy();
  });

  // ---- Settings: saved in the Project, refused when wrong, and the picture copied in.
  const pic = path.join(dir, 'wall.png');
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff00ff:s=64x64:d=1', '-frames:v', '1', pic]);

  await run('a setting changed in the Editor is saved in the Project', async () => {
    const win = await editor.open('camera', { show: false });
    await win.webContents.executeJavaScript('window.editor.ready');
    await win.webContents.executeJavaScript(`window.editor.set({ margin: 9, aspect: '9:16' })`);
    const look = readJson(path.join(projects.camera, 'project.json')).exportLook;
    assert(look.margin === 9 && look.aspect === '9:16' && look.background === 'midnight', JSON.stringify(look));
    const wrong = await win.webContents.executeJavaScript(`window.editor.set({ margin: 40 }).then(() => 'saved', (e) => e.message)`);
    assert(/margin: use a number from 0 to 15/.test(wrong), wrong);
    assert(readJson(path.join(projects.camera, 'project.json')).exportLook.margin === 9, 'a wrong value was saved');
    win.destroy();
  });

  await run('a picture chosen in the Editor is copied into the Project and shows in the preview', async () => {
    const win = await editor.open('camera', { show: false });
    await win.webContents.executeJavaScript('window.editor.ready');
    await editor.setPicture('camera', pic);
    await win.webContents.executeJavaScript('window.editor.reload()');
    const project = readJson(path.join(projects.camera, 'project.json'));
    assert(project.backgroundImage === 'background.png' && fs.existsSync(path.join(projects.camera, 'background.png')), JSON.stringify(project));
    fs.rmSync(pic);
    const corner = (await preview(win, 1000)).subarray(0, 3);
    assert(corner[0] > 200 && corner[1] < 60 && corner[2] > 200, `corner ${[...corner]}`);
    win.destroy();
  });

  await run('choosing a built-in Background takes the picture out again', async () => {
    const win = await editor.open('camera', { show: false });
    await win.webContents.executeJavaScript('window.editor.ready');
    await win.webContents.executeJavaScript(`window.editor.set({ background: 'rose' })`);
    const project = readJson(path.join(projects.camera, 'project.json'));
    assert(project.backgroundImage === undefined && !fs.existsSync(path.join(projects.camera, 'background.png')), JSON.stringify(project));
    assert(project.exportLook.background === 'rose' && project.exportLook.backgroundImage === null, JSON.stringify(project.exportLook));
    win.destroy();
  });

  await run('the preview plays and pauses, also when pressed many times in a row', async () => {
    // A hidden window gets almost no video frames from Chromium, so this one is shown, off the screen.
    const win = await editor.open('pointer', { show: false });
    win.setPosition(-5000, 0);
    win.showInactive();
    await win.webContents.executeJavaScript('window.editor.ready');
    await win.webContents.executeJavaScript('window.editor.renderAt(0)');
    // Draws are counted by wrapping the canvas's drawImage; a second drawing loop would double the count.
    const result = await win.webContents.executeJavaScript(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const play = document.getElementById('play');
      for (let i = 0; i < 7; i++) { play.click(); await wait(30); } // ends playing
      const ctx = document.getElementById('preview').getContext('2d');
      let draws = 0;
      const orig = ctx.drawImage.bind(ctx);
      ctx.drawImage = (...a) => { if (a[0] instanceof HTMLVideoElement) draws++; return orig(...a); };
      const t0 = document.getElementById('time').textContent;
      await wait(1000);
      const t1 = document.getElementById('time').textContent;
      const whilePlaying = { width: play.offsetWidth, label: play.getAttribute('aria-label'), icon: play.classList.contains('playing') };
      play.click(); // pause
      await wait(300);
      const t2 = document.getElementById('time').textContent;
      await wait(300);
      const whilePaused = { width: play.offsetWidth, label: play.getAttribute('aria-label'), icon: play.classList.contains('playing') };
      return { t0, t1, t2, t3: document.getElementById('time').textContent, draws, whilePlaying, whilePaused };
    })()`);
    notes.push(`playback ${JSON.stringify(result)}`);
    assert(result.t1 !== result.t0, 'the time did not move while playing');
    assert(result.t3 === result.t2, 'the time moved after pausing');
    assert(result.draws > 10 && result.draws <= 40, `${result.draws} frames drawn in 1 s at 30 fps`);
    // The play button keeps its size, shows the pause icon while playing and names what a press does.
    const { whilePlaying: on, whilePaused: off } = result;
    assert(on.width === off.width && on.width > 0, `play button ${on.width} px playing, ${off.width} px paused`);
    assert(on.icon && on.label === 'Pause' && !off.icon && off.label === 'Play', `play button ${JSON.stringify([on, off])}`);
    win.destroy();
  });

  await run('one Editor window per Project: opening it again brings the same window', async () => {
    const a = await editor.open('zoom', { show: false });
    const b = await editor.open('zoom', { show: false });
    assert(a === b, 'two windows');
    a.destroy();
  });

  // ---- The Zoom timeline (ticket 10), on a fresh Project with one Zoom from its click at 3 s.
  projects.timeline = makeProject('timeline');
  const zoomsOf = () => readJson(path.join(projects.timeline, 'project.json')).zoom.zooms;
  const js = (win, code) => win.webContents.executeJavaScript(code);

  await run('the timeline shows every Zoom, and its buttons and drags change the saved list', async () => {
    const win = await editor.open('timeline', { show: false });
    await js(win, 'window.editor.ready');
    assert(await js(win, `document.querySelectorAll('#timeline .zoom').length`) === 1, 'the click\'s Zoom is not on the timeline');
    // Add at the playhead, with the button.
    await js(win, 'window.editor.renderAt(4500)');
    await js(win, `window.editor.whenSaved(() => document.getElementById('zoomAdd').click())`);
    let list = zoomsOf();
    assert(list.length === 2 && list[1].start === 4000 && list[1].end === 6000, `after add ${JSON.stringify(list)}`); // moved back so it fits the 6 s recording
    assert(await js(win, `document.querySelectorAll('#timeline .zoom').length`) === 2, 'the timeline did not update');
    // Strength of the selected one (the new one), with its slider.
    await js(win, `window.editor.whenSaved(() => { const s = document.getElementById('zoomStrength'); s.value = '2.4'; s.dispatchEvent(new Event('change')); })`);
    assert(zoomsOf()[1].strength === 2.4, `strength ${JSON.stringify(zoomsOf())}`);
    // Aim it by clicking the preview at a moment with no Zoom: the yellow quarter, bottom right of the Card.
    await js(win, 'window.editor.renderAt(1000)');
    await js(win, `window.editor.whenSaved(() => window.editor.aimAt(0.75, 0.75))`);
    list = zoomsOf();
    assert(Math.abs(list[1].x - 0.75) < 0.02 && Math.abs(list[1].y - 0.75) < 0.02, `aim ${JSON.stringify(list[1])}`);
    // Move the first by dragging its middle, and make it longer by dragging its right edge.
    const drag = (selector, dxFraction) => js(win, `window.editor.whenSaved(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const track = document.getElementById('timeline').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2, dx = track.width * ${dxFraction};
      const ev = (type, cx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: cx, clientY: y, pointerId: 1, button: 0 }));
      ev('pointerdown', x); ev('pointermove', x + dx / 2); ev('pointermove', x + dx); ev('pointerup', x + dx);
    })`);
    const before = zoomsOf()[0];
    await drag('#timeline .zoom[data-number="1"]', -0.1); // 0.6 s earlier on a 6 s timeline
    const moved = zoomsOf()[0];
    assert(Math.abs(moved.start - (before.start - 600)) <= 40 && moved.end - moved.start === before.end - before.start, `move ${JSON.stringify([before, moved])}`);
    await drag('#timeline .zoom[data-number="1"] .handle.end', 0.05); // 0.3 s longer
    const longer = zoomsOf()[0];
    assert(longer.start === moved.start && Math.abs(longer.end - (moved.end + 300)) <= 40, `resize ${JSON.stringify([moved, longer])}`);
    // Delete the selected one with its button.
    await js(win, `window.editor.whenSaved(() => document.getElementById('zoomDelete').click())`);
    assert(zoomsOf().length === 1, `after delete ${JSON.stringify(zoomsOf())}`);
    assert(await js(win, `document.querySelectorAll('#timeline .zoom').length`) === 1, 'the timeline still shows a deleted Zoom');
    win.destroy();
  });

  await run('an export after editing uses exactly the edited list, and its frame matches the preview', async () => {
    const win = await editor.open('timeline', { show: false });
    await js(win, 'window.editor.ready');
    await js(win, `window.editor.editZoom({ action: 'add', start: 4000, end: 6000, strength: 2.2, x: 0.75, y: 0.75 })`);
    await js(win, `window.editor.editZoom({ action: 'change', number: 1, strength: 1.3 })`);
    const list = zoomsOf();
    const done = await exportNow('timeline', 'timeline.mp4');
    assert(done.zooms === 2, `${done.zooms} Zooms in the export`);
    for (const [frame, label] of [[90, 'edited strength 3.0 s'], [150, 'added Zoom 5.0 s']]) {
      const d = meanDiff(await preview(win, (frame * 1000) / 30), await frameOf(done.file, frame));
      notes.push(`timeline ${label}: ${d.toFixed(2)}`);
      assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
    }
    // The added Zoom aims at the yellow quarter: at 5 s the middle of the Card is yellow.
    const px = await frameOf(done.file, 150);
    const mid = [...px.subarray(((SNAP.h / 2) * SNAP.w + SNAP.w / 2) * 4, ((SNAP.h / 2) * SNAP.w + SNAP.w / 2) * 4 + 3)];
    assert(mid[0] > 200 && mid[1] > 200 && mid[2] < 60, `middle at 5 s is ${mid}`);
    assert(JSON.stringify(zoomsOf()) === JSON.stringify(list), 'the export changed the list');
    win.destroy();
  });

  await run('the Zoom switch turns all Zoom off and on, and keeps the list', async () => {
    const win = await editor.open('timeline', { show: false });
    await js(win, 'window.editor.ready');
    const list = zoomsOf();
    await js(win, `window.editor.whenSaved(() => document.getElementById('zoomOn').click())`);
    const project = readJson(path.join(projects.timeline, 'project.json'));
    assert(project.exportLook.zoom === false && JSON.stringify(project.zoom.zooms) === JSON.stringify(list), JSON.stringify(project));
    const off = await exportNow('timeline', 'timeline-off.mp4');
    assert(off.zooms === 0, `${off.zooms} Zooms with Zoom off`);
    const d = meanDiff(await preview(win, 5000), await frameOf(off.file, 150));
    notes.push(`timeline Zoom off: ${d.toFixed(2)}`);
    assert(d < 4, `Zoom off differs by ${d.toFixed(2)}`);
    await js(win, `window.editor.whenSaved(() => document.getElementById('zoomOn').click())`);
    assert(readJson(path.join(projects.timeline, 'project.json')).exportLook.zoom === true, 'not back on');
    const refused = await js(win, `window.editor.editZoom({ action: 'change', number: 1, strength: 9 }).then(() => 'saved', (e) => e.message)`);
    assert(/strength: use a number from 1.1 to 3/.test(refused), refused);
    win.destroy();
  });

  await run('the arrow keys and Delete edit the focused Zoom, and the switch also clears an old "off" in the list', async () => {
    const file = path.join(projects.timeline, 'project.json');
    const project = readJson(file);
    project.zoom.enabled = false; // an older way to switch Zoom off; Export still reads it
    fs.writeFileSync(file, JSON.stringify(project, null, 2));
    const win = await editor.open('timeline', { show: false });
    await js(win, 'window.editor.ready');
    assert(await js(win, `document.getElementById('zoomOn').checked`) === false, 'the switch shows on while Export has Zoom off');
    await js(win, `window.editor.whenSaved(() => document.getElementById('zoomOn').click())`);
    assert(readJson(file).zoom.enabled === true, 'still off in the list');
    const key = (k, extra = {}) => js(win, `window.editor.whenSaved(() => {
      const el = document.querySelector('#timeline .zoom[data-number="1"]'); el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(extra)} }));
    })`);
    const a = zoomsOf()[0];
    await key('ArrowRight'); // it already ends where the recording ends: it stays
    assert(JSON.stringify(zoomsOf()[0]) === JSON.stringify(a), `moved past the end ${JSON.stringify(zoomsOf()[0])}`);
    await key('ArrowLeft');
    const b = zoomsOf()[0];
    assert(b.start === a.start - 100 && b.end === a.end - 100, `move ${JSON.stringify([a, b])}`);
    assert(await js(win, `document.activeElement.dataset.number`) === '1', 'focus left the Zoom');
    await key('ArrowLeft', { shiftKey: true, ctrlKey: true });
    const c = zoomsOf()[0];
    assert(c.start === b.start && c.end === b.end - 1000, `length ${JSON.stringify([b, c])}`);
    const count = zoomsOf().length;
    await key('Delete');
    assert(zoomsOf().length === count - 1, 'Delete did not remove it');
    assert(await js(win, `document.activeElement.classList.contains('zoom')`), 'focus was lost after Delete');
    win.destroy();
  });

  await run('an open Editor shows Zoom changes made elsewhere (drec) and drops its pick', async () => {
    const win = await editor.open('timeline', { show: false });
    await js(win, 'window.editor.ready');
    await js(win, `window.editor.whenSaved(() => document.querySelector('#timeline .zoom[data-number="1"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })))`);
    await js(win, `window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))`);
    const before = await js(win, `document.querySelectorAll('#timeline .zoom').length`);
    await editor.editZoom('timeline', { action: 'add', start: 200, end: 1200 }); // what drec zoom-add does
    editor.refresh('timeline');
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) { await new Promise((r) => setTimeout(r, 50)); after = await js(win, `document.querySelectorAll('#timeline .zoom').length`); }
    assert(after === before + 1, `${before} -> ${after} blocks`);
    assert(await js(win, `document.getElementById('zoomSelected').hidden`), 'a Zoom is still picked');
    win.destroy();
  });

  // ---- Bubble and trim (ticket 11), on a Project with a camera.
  projects.bubble = makeProject('bubble', { camera: true });
  const projectOf = (name) => readJson(path.join(projects[name], 'project.json'));
  // A drag on the preview, in canvas pixels (the export's pixels), with made-up pointer events.
  const dragCanvas = (win, from, to) => js(win, `window.editor.whenSaved(() => {
    const c = document.getElementById('preview');
    const r = c.getBoundingClientRect();
    const at = (p) => ({ clientX: r.left + (p.x / c.width) * r.width, clientY: r.top + (p.y / c.height) * r.height });
    const ev = (type, p, target) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, ...at(p) }));
    const from = ${JSON.stringify(from)}, to = ${JSON.stringify(to)};
    ev('pointerdown', from, c);
    ev('pointermove', { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, c);
    ev('pointermove', to, c);
    ev('pointerup', to, c);
  })`);
  const planIn = (win) => js(win, 'window.editor.plan()');

  await run('the Bubble is dragged across the Card\'s edge and resized in the preview, and that is saved', async () => {
    const win = await editor.open('bubble', { show: false });
    await js(win, 'window.editor.ready');
    let p = await planIn(win);
    assert(p.bubble && p.look.bubblePlace === 'outside' && p.look.bubbleCorner === 'bottom-left', JSON.stringify(p.look));
    const mid = (b) => ({ x: b.x + b.d / 2, y: b.y + b.d / 2 });
    // Onto the Card, its top right quarter: inside, top-right.
    await dragCanvas(win, mid(p.bubble), { x: p.card.x + p.card.w * 0.8, y: p.card.y + p.card.h * 0.25 });
    let look = projectOf('bubble').exportLook;
    assert(look.bubblePlace === 'inside' && look.bubbleCorner === 'top-right', `after the first drag ${JSON.stringify(look)}`);
    // Back off the Card, below it on the left: outside, bottom-left.
    p = await planIn(win);
    await dragCanvas(win, mid(p.bubble), { x: p.card.x + 40, y: p.card.y + p.card.h + 30 });
    look = projectOf('bubble').exportLook;
    assert(look.bubblePlace === 'outside' && look.bubbleCorner === 'bottom-left', `after the second drag ${JSON.stringify(look)}`);
    // Resize: pull its right edge 100 px further out on a 1080 px tall canvas, about 9 percent more.
    p = await planIn(win);
    const before = p.bubble.d;
    await dragCanvas(win, { x: p.bubble.x + p.bubble.d - 3, y: p.bubble.y + p.bubble.d / 2 }, { x: p.bubble.x + p.bubble.d + 97, y: p.bubble.y + p.bubble.d / 2 });
    look = projectOf('bubble').exportLook;
    p = await planIn(win);
    assert(typeof look.bubbleSize === 'number' && Math.abs(p.bubble.d - (before + 100)) <= 4, `size ${look.bubbleSize}, ${before} -> ${p.bubble.d}`);
    assert(look.bubblePlace === 'outside' && look.bubbleCorner === 'bottom-left', `the resize moved it ${JSON.stringify(look)}`);
    // Without a mouse: the corner buttons and the place buttons.
    await js(win, `window.editor.whenSaved(() => document.querySelector('#bubbleCorner [data-corner="top-right"]').click())`);
    await js(win, `window.editor.whenSaved(() => document.querySelector('#bubblePlace [data-place="inside"]').click())`);
    look = projectOf('bubble').exportLook;
    assert(look.bubblePlace === 'inside' && look.bubbleCorner === 'top-right', `buttons ${JSON.stringify(look)}`);
    assert(await js(win, `document.querySelector('#bubbleCorner [data-corner="top-right"]').getAttribute('aria-label')`) === 'Top right', 'corner button label');
    win.destroy();
  });

  await run('trim handles on the timeline set the start and the end, and the preview stays inside them', async () => {
    const win = await editor.open('bubble', { show: false });
    await js(win, 'window.editor.ready');
    const dragHandle = (side, toFraction) => js(win, `window.editor.whenSaved(() => {
      const el = document.querySelector('#timeline .trim.${side}');
      const track = document.getElementById('timeline').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2, to = track.left + track.width * ${toFraction};
      const ev = (type, cx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: cx, clientY: y, pointerId: 1, button: 0 }));
      ev('pointerdown', x); ev('pointermove', (x + to) / 2); ev('pointermove', to); ev('pointerup', to);
    })`);
    await dragHandle('start', 1 / 6); // 1 s of 6
    await dragHandle('end', 5 / 6); // 5 s
    const trim = projectOf('bubble').trim;
    assert(Math.abs(trim.start - 1000) <= 40 && Math.abs(trim.end - 5000) <= 40, `trim ${JSON.stringify(trim)}`);
    const p = await planIn(win);
    assert(p.startMs === trim.start && p.endMs === trim.end, `the plan's span ${p.startMs}..${p.endMs}`);
    const shown = await js(win, `window.editor.renderAt(0).then(() => [document.getElementById('time').textContent, Number(document.getElementById('scrub').value)])`);
    assert(shown[1] === trim.start && shown[0] === '0:00.0', `before the start the preview shows ${shown}`);
    // To the very end: saved as "no end", so a re-made screen video of another length is not cut.
    await dragHandle('end', 1.2);
    assert(projectOf('bubble').trim.end === null, `end ${JSON.stringify(projectOf('bubble').trim)}`);
    await js(win, `window.editor.whenSaved(() => window.editor.trim({ start: 1000, end: 5000 }))`);
    const wrong = await js(win, `window.editor.trim({ start: 4000, end: 3000 }).then(() => 'saved', (e) => e.message)`);
    assert(/trim: the start must be before the end/.test(wrong), wrong);
    const tooShort = await js(win, `window.editor.trim({ start: 3000, end: 3200 }).then(() => 'saved', (e) => e.message)`);
    assert(/trim: keep at least 0.5 s/.test(tooShort), tooShort);
    // Three quick arrow presses on the start handle add up, even before the first is saved.
    await js(win, `(async () => {
      const h = document.getElementById('trimStart'); h.focus();
      for (let i = 0; i < 3; i++) h.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await window.editor.whenSaved(() => {});
    })()`);
    assert(projectOf('bubble').trim.start === 1300 && projectOf('bubble').trim.end === 5000, `keys ${JSON.stringify(projectOf('bubble').trim)}`);
    // Only the start: the saved end stays.
    await js(win, `window.editor.whenSaved(() => window.editor.trim({ start: 1000 }))`);
    assert(projectOf('bubble').trim.start === 1000 && projectOf('bubble').trim.end === 5000, `start only ${JSON.stringify(projectOf('bubble').trim)}`);
    win.destroy();
  });

  await run('an export after the Bubble and trim edits matches the preview', async () => {
    const win = await editor.open('bubble', { show: false });
    await js(win, 'window.editor.ready');
    await js(win, `window.editor.set({ bubblePlace: 'inside', bubbleCorner: 'top-right', bubbleSize: 30 })`);
    const done = await exportNow('bubble', 'bubble.mp4');
    assert(Math.abs(done.durationSec - 4) < 0.05 && done.trim.start === 1000, `export ${done.durationSec} s from ${done.trim.start}`);
    assert(done.layout.bubble.d === 324, `bubble ${done.layout.bubble.d}`);
    for (const [frame, label] of [[15, 'trim 0.5 s in (camera red)'], [75, 'trim 2.5 s in (camera white)']]) {
      const d = meanDiff(await preview(win, 1000 + (frame * 1000) / 30), await frameOf(done.file, frame));
      notes.push(`bubble ${label}: ${d.toFixed(2)}`);
      assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
    }
    win.destroy();
  });

  // ---- Layouts (layouts ticket 02): Full screen until 2 s, then the Card; exported frame by frame.
  projects.layout = makeProject('layout', { camera: true });
  await run('a Full screen Layout eases into the Card, and the export matches the preview before, during and after', async () => {
    await editor.editLayout('layout', { action: 'change', number: 1, kind: 'screen' });
    const r = await editor.editLayout('layout', { action: 'add', at: 2000, kind: 'card' });
    assert(r.edited === 2 && JSON.stringify(projectOf('layout').layouts) === JSON.stringify({ version: 1, points: [{ at: 0, kind: 'screen' }, { at: 2000, kind: 'card' }] }), JSON.stringify(projectOf('layout').layouts));
    const win = await editor.open('layout', { show: false });
    await js(win, 'window.editor.ready');
    const done = await exportNow('layout', 'layout.mp4');
    assert(done.drawn === 'frames' && Math.abs(done.durationSec - 6) < 0.05, JSON.stringify({ drawn: done.drawn, s: done.durationSec }));
    for (const [frame, label] of [[30, 'Full screen 1.0 s'], [61, 'moving 2.03 s'], [63, 'moving 2.1 s'], [66, 'moving 2.2 s'], [75, 'Card 2.5 s'], [150, 'Card 5.0 s']]) {
      const d = meanDiff(await preview(win, (frame * 1000) / 30), await frameOf(done.file, frame));
      notes.push(`layout ${label}: ${d.toFixed(2)}`);
      assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
    }
    // Full screen: the screen reaches the corner of the video (its red quarter); in the Card the Background does.
    const corner = async (frame) => [...(await frameOf(done.file, frame)).subarray(SNAP.w * 4 * 2 + 8, SNAP.w * 4 * 2 + 11)];
    const full = await corner(30);
    const card = await corner(150);
    assert(full[0] > 200 && full[1] < 50 && full[2] < 50, `corner at 1 s is ${full}`);
    assert(!(card[0] > 200 && card[1] < 50 && card[2] < 50), `corner at 5 s is ${card}`);
    win.destroy();
  });

  // The same check with everything else on: a window recording (drawn cursor), its Zoom at the 3 s click, a
  // trim from 0.5 s, a picture as the Background, and both directions: Card, Full screen at 1.5 s, Card at 4 s.
  projects.layoutAll = makeProject('layoutAll', { mode: 'window', camera: true });
  await run('frame by frame matches the preview with the cursor, Zoom, trim and a picture, both ways', async () => {
    const wall = path.join(dir, 'wall2.png');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x8040c0:s=320x180:d=1', '-frames:v', '1', wall]);
    await editor.setPicture('layoutAll', wall);
    await editor.setTrim('layoutAll', { start: 500, end: 5500 });
    await editor.editLayout('layoutAll', { action: 'add', at: 1500, kind: 'screen' });
    await editor.editLayout('layoutAll', { action: 'add', at: 4000, kind: 'card' });
    const win = await editor.open('layoutAll', { show: false });
    await js(win, 'window.editor.ready');
    const done = await exportNow('layoutAll', 'layout-all.mp4');
    assert(done.drawn === 'frames' && done.picture === 'project' && done.zooms === 1 && done.pointer.cursor === 'drawn', JSON.stringify({ drawn: done.drawn, picture: done.picture, zooms: done.zooms, pointer: done.pointer }));
    // Export frame n shows the recording at 0.5 s + n / 30.
    for (const [frame, label] of [[15, 'Card 1.0 s'], [31, 'moving 1.53 s'], [45, 'Full screen 2.0 s'], [75, 'Full screen zoomed 3.0 s'], [106, 'moving back 4.03 s'], [120, 'Card 4.5 s']]) {
      const d = meanDiff(await preview(win, 500 + (frame * 1000) / 30), await frameOf(done.file, frame));
      notes.push(`layout+all ${label}: ${d.toFixed(2)}`);
      assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
    }
    const corner = [...(await frameOf(done.file, 15)).subarray(0, 3)]; // the picture shows around the Card
    assert(Math.abs(corner[0] - 0x80) < 30 && Math.abs(corner[1] - 0x40) < 30 && Math.abs(corner[2] - 0xc0) < 30, `corner ${corner}`);
    win.destroy();
  });

  // ---- Full camera (layouts ticket 03): Card, Full camera at 1 s, Card at 4 s, in 16:9 and 9:16. The camera is
  // red until 2 s and white after; the screen has no red in its bottom half and no white anywhere.
  const colourAt = (buf, fx, fy) => {
    const i = (Math.round(fy * (SNAP.h - 1)) * SNAP.w + Math.round(fx * (SNAP.w - 1))) * 4;
    return [buf[i], buf[i + 1], buf[i + 2]];
  };
  const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
  const isWhite = ([r, g, b]) => r > 215 && g > 215 && b > 215;
  const SPOTS = [[0.02, 0.03], [0.98, 0.03], [0.5, 0.5], [0.02, 0.97], [0.98, 0.97]]; // corners and middle
  for (const aspect of ['16:9', '9:16']) {
    const name = aspect === '16:9' ? 'fullCamWide' : 'fullCamTall';
    projects[name] = makeProject(name, { camera: true });
    await run(`${aspect}: the Bubble grows into Full camera and back, and the export matches the preview`, async () => {
      if (aspect !== '16:9') await editor.set(name, { aspect });
      await editor.editLayout(name, { action: 'add', at: 1000, kind: 'camera' });
      const r = await editor.editLayout(name, { action: 'add', at: 4000, kind: 'card' });
      const kinds = r.layouts.points.map((p) => p.kind).join(' ');
      assert(kinds === 'card camera card', kinds);
      const win = await editor.open(name, { show: false });
      await js(win, 'window.editor.ready');
      const done = await exportNow(name, `${name}.mp4`);
      assert(done.drawn === 'frames' && done.zooms === 1, JSON.stringify({ drawn: done.drawn, zooms: done.zooms }));
      for (const [frame, label] of [[15, 'Card 0.5 s'], [31, 'growing 1.03 s'], [33, 'growing 1.1 s'], [45, 'Full camera 1.5 s'], [90, 'Full camera at the Zoom 3.0 s'], [121, 'shrinking 4.03 s'], [135, 'Card 4.5 s']]) {
        const d = meanDiff(await preview(win, (frame * 1000) / 30), await frameOf(done.file, frame));
        notes.push(`${name} ${label}: ${d.toFixed(2)}`);
        assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
      }
      // Full camera fills the video: red everywhere before 2 s, white everywhere after, even at the 3 s Zoom.
      const red = await frameOf(done.file, 45);
      const white = await frameOf(done.file, 90);
      for (const [fx, fy] of SPOTS) {
        assert(isRed(colourAt(red, fx, fy)), `${fx},${fy} at 1.5 s is ${colourAt(red, fx, fy)}`);
        assert(isWhite(colourAt(white, fx, fy)), `${fx},${fy} at 3.0 s is ${colourAt(white, fx, fy)}`);
      }
      // In the Card the camera is only in the Bubble: the middle of the video is the screen, not the camera.
      const card = await frameOf(done.file, 150);
      assert(!isWhite(colourAt(card, 0.5, 0.5)) && !isWhite(colourAt(card, 0.02, 0.03)), `Card at 5 s: ${colourAt(card, 0.5, 0.5)}`);
      // Growing, read from the export's pixels: more of the video is camera than in the Card, not all of it yet.
      const redSpots = async (frame) => { const b = await frameOf(done.file, frame); return SPOTS.filter(([fx, fy]) => isRed(colourAt(b, fx, fy))).length; };
      const [inCard, growing] = [await redSpots(15), await redSpots(31)];
      notes.push(`${name} red spots: Card ${inCard}, growing ${growing} of ${SPOTS.length}`);
      assert(growing > inCard && growing < SPOTS.length, `red spots: Card ${inCard}, growing ${growing}`);
      win.destroy();
    });
  }

  // ---- Camera shape (layouts ticket 09): the Square button, then the same frames from the preview and from both
  // export ways. A point 10 % into the Bubble on its diagonal shows the camera only when the Bubble is square.
  projects.shape = makeProject('shape', { camera: true });
  await run('the Square button makes the Bubble a rounded square, and the export matches the preview both ways', async () => {
    let win = await editor.open('shape', { show: false });
    await js(win, 'window.editor.ready');
    await js(win, `window.editor.whenSaved(() => document.querySelector('#bubbleShape [data-shape="rounded"]').click())`);
    const saved = projectOf('shape').exportLook || {};
    const pressed = await js(win, `document.querySelector('#bubbleShape [data-shape="rounded"]').getAttribute('aria-pressed')`);
    assert(saved.bubbleShape === 'rounded' && pressed === 'true', `saved ${JSON.stringify(saved)}, pressed ${pressed}`);
    const { bubble: b, canvas } = await editor.load('shape');
    assert(b.r > 0 && b.r < b.d / 2, JSON.stringify(b));
    const diagonal = async (file, frame) => isRed(colourAt(await frameOf(file, frame), (b.x + 0.1 * b.d) / (canvas.w - 1), (b.y + 0.1 * b.d) / (canvas.h - 1)));

    const still = await exportNow('shape', 'shape.mp4');
    assert(still.drawn === 'ffmpeg', still.drawn);
    const d1 = meanDiff(await preview(win, 1500), await frameOf(still.file, 45));
    notes.push(`square Bubble 1.5 s: ${d1.toFixed(2)}`);
    assert(d1 < 4, `square Bubble differs by ${d1.toFixed(2)}`);
    assert(await diagonal(still.file, 45), 'the corner of the square Bubble shows no camera');

    win.destroy();
    await editor.editLayout('shape', { action: 'add', at: 2500, kind: 'camera' });
    win = await editor.open('shape', { show: false });
    await js(win, 'window.editor.ready');
    const moving = await exportNow('shape', 'shape-moving.mp4');
    assert(moving.drawn === 'frames', moving.drawn);
    for (const [frame, label] of [[45, 'square Bubble, frame by frame 1.5 s'], [76, 'square growing 2.53 s'], [78, 'square growing 2.6 s']]) {
      const d = meanDiff(await preview(win, (frame * 1000) / 30), await frameOf(moving.file, frame));
      notes.push(`${label}: ${d.toFixed(2)}`);
      assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
    }
    assert(await diagonal(moving.file, 45), 'frame by frame: the corner of the square Bubble shows no camera');
    win.destroy();
  });

  await run('the round Bubble leaves that corner point without camera', async () => {
    const { bubble: b, canvas } = await editor.load('camera'); // a Project an earlier check made 9:16
    assert(b.r === b.d / 2, JSON.stringify(b));
    const done = await exportNow('camera', 'camera-round.mp4');
    const c = colourAt(await frameOf(done.file, 45), (b.x + 0.1 * b.d) / (canvas.w - 1), (b.y + 0.1 * b.d) / (canvas.h - 1));
    assert(!isRed(c), `the round Bubble shows camera in its corner: ${c} at ${JSON.stringify(b)}`);
    const inside = colourAt(await frameOf(done.file, 45), (b.x + 0.5 * b.d) / (canvas.w - 1), (b.y + 0.5 * b.d) / (canvas.h - 1));
    assert(isRed(inside), `the middle of the round Bubble is ${inside}: the check reads the wrong spot`);
  });

  // ---- Split (layouts ticket 04): Card, Split at 2 s, Split swapped at 3.5 s, Card at 5 s, in both aspects. The
  // camera is white after 2 s; the screen's top left quarter is red, and the 3 s click zooms into it.
  for (const aspect of ['16:9', '9:16']) {
    const name = aspect === '16:9' ? 'splitWide' : 'splitTall';
    projects[name] = makeProject(name, { camera: true });
    await run(`${aspect}: Split puts the screen and the camera in their parts, swaps them, and the export matches the preview`, async () => {
      if (aspect !== '16:9') await editor.set(name, { aspect });
      await editor.editLayout(name, { action: 'add', at: 2000, kind: 'split' });
      await editor.editLayout(name, { action: 'add', at: 3500, kind: 'split', swap: true });
      const r = await editor.editLayout(name, { action: 'add', at: 5000, kind: 'card' });
      const saved = JSON.stringify(projectOf(name).layouts.points);
      assert(saved === JSON.stringify([{ at: 0, kind: 'card' }, { at: 2000, kind: 'split' }, { at: 3500, kind: 'split', swap: true }, { at: 5000, kind: 'card' }]), saved);
      const { canvas, layouts: { shapes } } = r;
      const win = await editor.open(name, { show: false });
      await js(win, 'window.editor.ready');
      // The Split drawing (on the panel and the timeline) is the one for this Format.
      const drawn = await js(win, `[...document.querySelectorAll('#layoutKind [data-kind="split"] svg:not([hidden]), #timeline .layout-point[data-kind="split"] svg')].map((s) => s.dataset.aspect).join(' ')`);
      assert(drawn === `${aspect} ${aspect} ${aspect}`, `Split drawings: ${drawn}`);
      const done = await exportNow(name, `${name}.mp4`);
      assert(done.drawn === 'frames' && done.zooms === 1, JSON.stringify({ drawn: done.drawn, zooms: done.zooms }));
      for (const [frame, label] of [[45, 'Card 1.5 s'], [61, 'into Split 2.03 s'], [63, 'into Split 2.1 s'], [90, 'Split at the Zoom 3.0 s'], [106, 'swapping 3.53 s'], [130, 'Split swapped 4.33 s'], [151, 'back to the Card 5.03 s'], [170, 'Card 5.67 s']]) {
        const d = meanDiff(await preview(win, (frame * 1000) / 30), await frameOf(done.file, frame));
        notes.push(`${name} ${label}: ${d.toFixed(2)}`);
        assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
      }
      // Colour regions, read from the export at a settled moment of each Split.
      const at = (buf, x, y) => colourAt(buf, x / (canvas.w - 1), y / (canvas.h - 1));
      for (const [frame, key] of [[90, 'split'], [130, 'split-swap']]) {
        const buf = await frameOf(done.file, frame);
        const { card, camera } = shapes[key];
        for (const [fx, fy] of [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) {
          const c = at(buf, camera.x + fx * camera.w, camera.y + fy * camera.h);
          assert(isWhite(c), `${key}: the camera's part at ${fx},${fy} is ${c}`);
        }
        const red = at(buf, card.x + card.w * 0.2, card.y + card.h * 0.2);
        assert(isRed(red), `${key}: the screen's red quarter is ${red}`);
        const around = at(buf, card.x + card.w / 2, card.y - 25);
        assert(!isWhite(around) && !isRed(around), `${key}: the Background around the screen is ${around}`);
      }
      // The Zoom at the 3 s click still acts on the screen, in both Splits: the middle of the screen is then in
      // the red quarter (without the Zoom it is where the four colours meet).
      for (const [frame, key] of [[90, 'split'], [117, 'split-swap']]) {
        const { card } = shapes[key];
        const mid = at(await frameOf(done.file, frame), card.x + card.w / 2, card.y + card.h / 2);
        assert(isRed(mid), `${key}: the zoomed screen's middle is ${mid}`);
      }
      // During the move into Split (2.1 s, most of the move done) the grown Bubble already covers the middle of
      // the camera's part, read from the export's pixels.
      const cam = shapes.split.camera;
      const camMid = at(await frameOf(done.file, 63), cam.x + cam.w / 2, cam.y + cam.h / 2);
      notes.push(`${name} camera middle at 2.1 s: ${camMid}`);
      assert(isWhite(camMid), `during the move the middle of the camera's part is ${camMid}`);
      win.destroy();
    });
  }

  // ---- The Layout track (layouts ticket 05): every edit through the Editor's own controls.
  projects.layoutUi = makeProject('layoutUi', { camera: true });
  const pointsOf = (name) => (projectOf(name).layouts || { points: [{ at: 0, kind: 'card' }] }).points;
  const layoutEditor = await (async () => { const w = await editor.open('layoutUi', { show: false }); await js(w, 'window.editor.ready'); return w; })();
  const seg = (n) => `#timeline .layout-point[data-number="${n}"]`;
  const pick = (n) => js(layoutEditor, `window.editor.whenSaved(() => {
    document.querySelector(${JSON.stringify(seg(n))}).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })`);
  const press = (selector) => js(layoutEditor, `window.editor.whenSaved(() => document.querySelector(${JSON.stringify(selector)}).click())`);
  const layoutKey = (n, k, extra = {}) => js(layoutEditor, `window.editor.whenSaved(() => {
    const el = document.querySelector(${JSON.stringify(seg(n))}); el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ...${JSON.stringify(extra)} }));
  })`);

  await run('the Layout track adds a point at the playhead, and the panel changes its kind and swaps a Split', async () => {
    assert(await js(layoutEditor, `document.querySelectorAll('#timeline .layout-point').length`) === 1, 'one Card segment to start');
    await js(layoutEditor, 'window.editor.renderAt(2000)');
    await press('#layoutAdd');
    let points = JSON.stringify(pointsOf('layoutUi'));
    assert(points === JSON.stringify([{ at: 0, kind: 'card' }, { at: 2000, kind: 'screen' }]), `after add ${points}`);
    assert(await js(layoutEditor, `document.querySelector(${JSON.stringify(seg(2))}).getAttribute('aria-pressed')`) === 'true', 'the new point is not picked');
    assert(await js(layoutEditor, `document.querySelector('#layoutKind [data-kind="screen"]').getAttribute('aria-pressed')`) === 'true', 'the panel does not show its kind');
    assert(await js(layoutEditor, `document.getElementById('layoutSwap').hidden`) === true, 'Swap shows for a Full screen point');
    await press('#layoutKind [data-kind="split"]');
    assert(pointsOf('layoutUi')[1].kind === 'split', JSON.stringify(pointsOf('layoutUi')));
    assert(await js(layoutEditor, `document.getElementById('layoutSwap').hidden`) === false, 'no Swap for a Split point');
    await press('#layoutSwap');
    points = JSON.stringify(pointsOf('layoutUi'));
    assert(points === JSON.stringify([{ at: 0, kind: 'card' }, { at: 2000, kind: 'split', swap: true }]), `after swap ${points}`);
    assert(await js(layoutEditor, `document.getElementById('layoutSwap').getAttribute('aria-pressed')`) === 'true', 'Swap does not show it is on');
    assert(await js(layoutEditor, `document.querySelector(${JSON.stringify(seg(2))}).dataset.kind`) === 'split', 'the segment did not follow');
  });

  await run('the Layout track moves a point by dragging its start, and by the arrow keys', async () => {
    await js(layoutEditor, `window.editor.whenSaved(() => {
      const el = document.querySelector(${JSON.stringify(`${seg(2)} .handle.start`)});
      const track = document.getElementById('timeline').getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2, dx = track.width * 0.1;
      const ev = (type, cx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: cx, clientY: y, pointerId: 1, button: 0 }));
      ev('pointerdown', x); ev('pointermove', x + dx / 2); ev('pointermove', x + dx); ev('pointerup', x + dx);
    })`);
    const dragged = pointsOf('layoutUi')[1];
    assert(Math.abs(dragged.at - 2600) <= 40 && dragged.kind === 'split' && dragged.swap === true, `drag ${JSON.stringify(dragged)}`); // 0.6 s on a 6 s timeline
    await layoutKey(2, 'ArrowRight');
    assert(pointsOf('layoutUi')[1].at === dragged.at + 100, `arrow ${JSON.stringify(pointsOf('layoutUi'))}`);
    await layoutKey(2, 'ArrowLeft', { ctrlKey: true });
    assert(pointsOf('layoutUi')[1].at === dragged.at - 900, `ctrl arrow ${JSON.stringify(pointsOf('layoutUi'))}`);
    assert(await js(layoutEditor, `document.activeElement.dataset.number`) === '2', 'focus left the segment');
    // Three quick presses, before any is saved, move it three steps.
    const quick = pointsOf('layoutUi')[1].at;
    await js(layoutEditor, `window.editor.whenSaved(() => {
      const el = document.querySelector(${JSON.stringify(seg(2))}); el.focus();
      for (let i = 0; i < 3; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    })`);
    assert(pointsOf('layoutUi')[1].at === quick + 300, `quick presses ${quick} -> ${pointsOf('layoutUi')[1].at}`);
  });

  await run('the first Layout point stays at 0: no handle, no Delete, the keys leave it, but its kind changes', async () => {
    await pick(1);
    const before = JSON.stringify(pointsOf('layoutUi'));
    assert(await js(layoutEditor, `document.querySelector(${JSON.stringify(`${seg(1)} .handle`)}) === null`), 'the first point has a handle');
    assert(await js(layoutEditor, `document.getElementById('layoutDelete').disabled`) === true, 'the first point can be deleted');
    await layoutKey(1, 'ArrowRight');
    await layoutKey(1, 'Delete');
    assert(JSON.stringify(pointsOf('layoutUi')) === before, `the first point changed ${JSON.stringify(pointsOf('layoutUi'))}`);
    await press('#layoutKind [data-kind="screen"]');
    assert(pointsOf('layoutUi')[0].kind === 'screen' && pointsOf('layoutUi')[0].at === 0, JSON.stringify(pointsOf('layoutUi')));
  });

  await run('Delete removes a Layout point, with its button and with the key', async () => {
    await js(layoutEditor, 'window.editor.renderAt(4500)');
    await press('#layoutAdd');
    assert(pointsOf('layoutUi').length === 3 && pointsOf('layoutUi')[2].at === 4500, JSON.stringify(pointsOf('layoutUi')));
    await press('#layoutDelete');
    assert(pointsOf('layoutUi').length === 2, `button ${JSON.stringify(pointsOf('layoutUi'))}`);
    assert(await js(layoutEditor, `document.activeElement.id`) === 'layoutAdd', 'focus was lost after the Delete button');
    await js(layoutEditor, 'window.editor.renderAt(4500)');
    await press('#layoutAdd');
    await layoutKey(3, 'Delete');
    assert(pointsOf('layoutUi').length === 2, `key ${JSON.stringify(pointsOf('layoutUi'))}`);
    assert(await js(layoutEditor, `document.activeElement.classList.contains('layout-point')`), 'focus was lost after Delete');
  });

  await run('after Layout edits in the Editor, the export matches the preview', async () => {
    await js(layoutEditor, 'window.editor.renderAt(4000)');
    await press('#layoutAdd'); // back to the Card at 4 s (the point before is a Split)
    const kinds = pointsOf('layoutUi').map((p) => p.kind).join(' ');
    assert(kinds === 'screen split card', kinds);
    const done = await exportNow('layoutUi', 'layout-ui.mp4');
    assert(done.drawn === 'frames' && done.layouts === 3, JSON.stringify({ drawn: done.drawn, layouts: done.layouts }));
    const at = pointsOf('layoutUi')[1].at;
    for (const [ms, label] of [[1000, 'Full screen'], [at + 50, 'into the swapped Split'], [3000, 'swapped Split'], [4100, 'back to the Card'], [5500, 'Card']]) {
      const frame = Math.round((ms * 30) / 1000);
      const d = meanDiff(await preview(layoutEditor, (frame * 1000) / 30), await frameOf(done.file, frame));
      notes.push(`layout track ${label}: ${d.toFixed(2)}`);
      assert(d < 4, `${label} differs by ${d.toFixed(2)}`);
    }
  });

  await run('an open Editor shows Layout changes made elsewhere (drec) and drops its pick', async () => {
    await pick(2);
    const before = await js(layoutEditor, `document.querySelectorAll('#timeline .layout-point').length`);
    await editor.editLayout('layoutUi', { action: 'add', at: 5000, kind: 'screen' }); // what drec layout-add does
    editor.refresh('layoutUi');
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) { await new Promise((r) => setTimeout(r, 50)); after = await js(layoutEditor, `document.querySelectorAll('#timeline .layout-point').length`); }
    assert(after === before + 1, `${before} -> ${after} segments`);
    assert(await js(layoutEditor, `document.getElementById('layoutSelected').hidden`), 'a Layout point is still picked');
    layoutEditor.destroy();
  });

  await run('without a camera the Full camera and Split buttons are off, and say why', async () => {
    const win = await editor.open('zoom', { show: false });
    await js(win, 'window.editor.ready');
    await js(win, `window.editor.whenSaved(() => {
      document.querySelector('#timeline .layout-point[data-number="1"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
    })`);
    const state = await js(win, `[...document.querySelectorAll('#layoutKind button')].map((b) => b.dataset.kind + ':' + b.disabled).join(' ')`);
    assert(state === 'card:false screen:false camera:true split:true', state);
    assert(await js(win, `document.querySelector('#layoutKind [data-kind="split"]').getAttribute('aria-describedby')`) === 'layoutHint', 'the reason is not linked to the button');
    const hint = await js(win, `document.getElementById('layoutHint').textContent`);
    assert(/camera/i.test(hint), `hint: ${hint}`);
    win.destroy();
  });

  await run('Split is refused for a Project with no camera, and nothing is saved', async () => {
    const before = JSON.stringify(projectOf('zoom').layouts);
    const why = await editor.editLayout('zoom', { action: 'add', at: 1000, kind: 'split' }).then(() => 'saved', (e) => e.message);
    assert(/Split needs a camera, and this Project was recorded without one/.test(why), why);
    assert(JSON.stringify(projectOf('zoom').layouts) === before, 'the Layout points changed');
  });

  await run('Full camera is refused for a Project with no camera, and nothing is saved', async () => {
    const before = JSON.stringify(projectOf('zoom').layouts);
    const why = await editor.editLayout('zoom', { action: 'add', at: 1000, kind: 'camera' }).then(() => 'saved', (e) => e.message);
    assert(/Full camera needs a camera, and this Project was recorded without one/.test(why), why);
    assert(JSON.stringify(projectOf('zoom').layouts) === before, 'the Layout points changed');
  });

  // ffmpeg reads what it can of a damaged file and may finish without error (then there is no camera), as on the
  // ffmpeg path; either way the export ends and leaves no part file behind.
  await run('a damaged camera file never leaves a frame-by-frame export hanging', async () => {
    projects.broken = makeProject('broken', { camera: true });
    await editor.editLayout('broken', { action: 'change', number: 1, kind: 'screen' });
    const cam = path.join(projects.broken, 'camera.webm');
    const good = fs.readFileSync(cam);
    fs.writeFileSync(cam, Buffer.concat([good.subarray(0, 4096), Buffer.alloc(200000, 7)])); // a header, then garbage
    const outcome = await Promise.race([
      exportNow('broken', 'broken.mp4').then(() => 'finished', (e) => `failed: ${e.message}`),
      new Promise((r) => setTimeout(() => r('hung'), 60000)),
    ]);
    notes.push(`broken camera: ${outcome.slice(0, 120)}`);
    assert(outcome.startsWith('failed') || outcome === 'finished', outcome);
    assert(!fs.existsSync(path.join(dir, 'broken.mp4.part.mp4')), 'the part file stayed behind');
  });

  await run('a Project with no Layout points still exports the ffmpeg way', async () => {
    const done = await exportNow('zoom', 'zoom-again.mp4');
    assert(done.drawn === 'ffmpeg' && done.layouts === 1, JSON.stringify({ drawn: done.drawn, layouts: done.layouts }));
  });

  if (reader) reader.destroy();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a closing window may still hold a file; the OS cleans temp */ }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(JSON.stringify(checks, null, 2));
  console.log(`differences: ${notes.join(', ')}`);
  console.log(failed.length ? `FAIL: ${failed.length} of ${Object.keys(checks).length}` : `OK: ${Object.keys(checks).length} of ${Object.keys(checks).length}`);
  app.exit(failed.length ? 1 : 0);
}).catch((err) => { console.error(err); app.exit(1); });
