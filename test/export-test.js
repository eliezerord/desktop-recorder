// Checks Export on a made-up Capture, with no app window open (only a hidden one that draws the fixed
// layers). The screen is solid green and the camera solid red, so every pixel can be told apart.
// Run: node_modules/electron/dist/electron.exe test/export-test.js
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ffmpegPath } = require('../src/convert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-export-'));
app.setPath('userData', path.join(dir, 'user'));
const SECONDS = 4;

function ffmpeg(args) {
  const r = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-600)}`);
}

// A Capture the way capture-project.js writes it.
function makeProject(name, { camera }) {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', `color=c=0x00ff00:s=1280x720:r=30:d=${SECONDS}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(p, 'screen.mp4')]);
  if (camera) ffmpeg(['-f', 'lavfi', '-i', `color=c=0xff0000:s=640x480:r=30:d=${SECONDS}`, '-c:v', 'libvpx', '-b:v', '1M', path.join(p, 'camera.webm')]);
  fs.writeFileSync(path.join(p, 'events.json'), JSON.stringify({ version: 1, cursor: [], clicks: [], windowRects: [] }));
  fs.writeFileSync(path.join(p, 'project.json'), JSON.stringify({
    version: 1, mode: 'screen', durationSec: SECONDS, screen: { file: 'screen.mp4' }, cursorInVideo: true,
    camera: camera ? { file: 'camera.webm', offsetMs: 0 } : null,
    look: { effects: { background: 'none', border: true, borderColor: '#ffffff' }, bubble: 'small' },
  }));
  return p;
}

// Four coloured quarters (red top-left, green top-right, blue bottom-left, yellow bottom-right) and one click
// in the red quarter, so a Zoom into it is easy to tell from the whole picture.
function makeZoomProject(name) {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=1280x720:r=30:d=7,drawbox=x=0:y=0:w=640:h=360:color=0xff0000:t=fill,drawbox=x=0:y=360:w=640:h=360:color=0x0000ff:t=fill,drawbox=x=640:y=360:w=640:h=360:color=0xffff00:t=fill',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(p, 'screen.mp4')]);
  fs.writeFileSync(path.join(p, 'events.json'), JSON.stringify({ version: 1, cursor: [], clicks: [{ t: 3000, x: 320, y: 180, button: 1 }], windowRects: [] }));
  fs.writeFileSync(path.join(p, 'project.json'), JSON.stringify({
    version: 1, mode: 'screen', durationSec: 7, screen: { file: 'screen.mp4' }, cursorInVideo: true, camera: null,
    source: { kind: 'screen', bounds: { x: 0, y: 0, width: 1280, height: 720 } }, look: { effects: {}, bubble: 'small' },
  }));
  return p;
}

// A solid green screen with a mouse that rests in the middle, moves to the top-left quarter's centre at 2 s and
// stays there, and one click there at 3 s. A window recording has no cursor in its video, a screen recording has.
function makePointerProject(name, { mode, clicksInVideo = false }) {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x00ff00:s=1280x720:r=30:d=7', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(p, 'screen.mp4')]);
  fs.writeFileSync(path.join(p, 'events.json'), JSON.stringify({
    version: 1,
    cursor: [[0, 640, 360], [2000, 640, 360], [2033, 320, 180], [7000, 320, 180]],
    clicks: [{ t: 3000, x: 320, y: 180, button: 1 }],
    windowRects: mode === 'window' ? [{ t: 0, left: 0, top: 0, right: 1280, bottom: 720 }] : [],
  }));
  fs.writeFileSync(path.join(p, 'project.json'), JSON.stringify({
    version: 1, mode, durationSec: 7, screen: { file: 'screen.mp4' }, cursorInVideo: mode === 'screen', clicksInVideo, camera: null,
    source: mode === 'window' ? { kind: 'window', name: 'x' } : { kind: 'screen', bounds: { x: 0, y: 0, width: 1280, height: 720 } },
    look: { effects: {}, bubble: 'small' },
  }));
  return p;
}

// The screen is red for 2 s and then green; the camera is red for 2 s and then blue (written like the app's
// MediaRecorder files, with no seek table). So the colour says which moment of the recording a frame is from.
function makeChangingProject(name) {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  ffmpeg(['-f', 'lavfi', '-i', "color=c=0xff0000:s=1280x720:r=30:d=6,drawbox=x=0:y=0:w=1280:h=720:color=0x00ff00:t=fill:enable='gte(t,2)'",
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(p, 'screen.mp4')]);
  ffmpeg(['-f', 'lavfi', '-i', "color=c=0xff0000:s=640x480:r=30:d=6,drawbox=x=0:y=0:w=640:h=480:color=0x0000ff:t=fill:enable='gte(t,2)'",
    '-c:v', 'libvpx', '-b:v', '1M', '-live', '1', path.join(p, 'camera.webm')]);
  fs.writeFileSync(path.join(p, 'events.json'), JSON.stringify({ version: 1, cursor: [], clicks: [], windowRects: [] }));
  fs.writeFileSync(path.join(p, 'project.json'), JSON.stringify({
    version: 1, mode: 'screen', durationSec: 6, screen: { file: 'screen.mp4' }, cursorInVideo: true, camera: { file: 'camera.webm', offsetMs: 0 },
    source: { kind: 'screen', bounds: { x: 0, y: 0, width: 1280, height: 720 } }, look: { effects: {}, bubble: 'small' },
  }));
  return p;
}

// Seconds of the video stream and of the audio stream on their own (the container's length is the longer one).
function streamSeconds(file, kind) {
  const text = spawnSync(ffmpegPath, ['-hide_banner', '-i', file, '-map', `0:${kind}`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const all = [...text.matchAll(/time=(\d+):(\d+):([\d.]+)/g)];
  const last = all[all.length - 1];
  return last ? Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) : null;
}

const info = (file) => spawnSync(ffmpegPath, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
const frame = (file, at = 1.5) => execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
const pixel = (buf, x, y, w = 1920) => [buf[(y * w + x) * 3], buf[(y * w + x) * 3 + 1], buf[(y * w + x) * 3 + 2]];
const near = (c, want, tol = 40) => c.every((v, i) => Math.abs(v - want[i]) <= tol);
const GREEN = [0, 255, 0];
const RED = [255, 0, 0];
const redPixels = (buf) => { let n = 0; for (let i = 0; i < buf.length; i += 3 * 7) if (buf[i] > 200 && buf[i + 1] < 60 && buf[i + 2] < 60) n++; return n; };

// No window stays open between exports here, and Electron would quit when the last one closes.
app.on('window-all-closed', () => {});
process.on('uncaughtException', (e) => { console.error('uncaught', e.stack); app.exit(2); });
app.whenReady().then(async () => {
  const checks = {};
  try {
    const look = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'look.mjs')).href);
    const { exportProject } = require('../src/export');
    const { renderLayers } = require('../src/look-window');
    const withCamera = makeProject('with-camera', { camera: true });
    const noCamera = makeProject('no-camera', { camera: false });
    const bgStart = (id) => { const c = look.BACKGROUNDS.find((b) => b.id === id).stops[0][1]; return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); };
    const screenSize = { w: 1280, h: 720 };

    const cases = [
      { name: 'outside, bottom-left, ocean', project: withCamera, look: { background: 'ocean' }, camera: true },
      { name: 'inside, top-right, rose', project: withCamera, look: { background: 'rose', bubblePlace: 'inside', bubbleCorner: 'top-right' }, camera: true },
      { name: 'no camera', project: noCamera, look: { background: 'midnight' }, camera: false },
      { name: 'rounded Bubble, outside, bottom-right', project: withCamera, look: { background: 'ocean', bubbleCorner: 'bottom-right', bubbleShape: 'rounded' }, camera: true },
    ];
    for (const c of cases) {
      const out = path.join(dir, `${c.name.replace(/\W+/g, '-')}.mp4`);
      const done = await exportProject({ projectDir: c.project, look: c.look, outFile: out, renderLayers });
      const text = info(out);
      const full = look.normalizeLook(c.look);
      const lay = look.layout({ canvas: { w: 1920, h: 1080 }, source: screenSize, hasCamera: c.camera, bubbleSize: 'small', look: full });
      const buf = frame(out);
      const mid = (r) => pixel(buf, Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2));
      const seconds = (/Duration: 00:00:(\d+\.\d+)/.exec(text) || [])[1];
      checks[`${c.name}: 1920x1080 H.264 with sound, ${SECONDS} s`] = /Video: h264.*1920x1080/.test(text) && /Audio: aac/.test(text) && Math.abs(Number(seconds) - SECONDS) < 0.4 && done.file === out;
      checks[`${c.name}: the screen fills the Card`] = near(mid(lay.card), GREEN);
      checks[`${c.name}: the Card has rounded corners`] = !near(pixel(buf, lay.card.x + 2, lay.card.y + 2), GREEN, 60) && near(pixel(buf, lay.card.x + Math.round(lay.card.w / 2), lay.card.y + 4), GREEN);
      checks[`${c.name}: the Background is outside the Card`] = near(pixel(buf, 3, 3), bgStart(full.background), 30);
      if (c.camera) {
        checks[`${c.name}: the camera is in the Bubble`] = near(mid({ x: lay.bubble.x, y: lay.bubble.y, w: lay.bubble.d, h: lay.bubble.d }), RED);
        // A point 10 % into the Bubble on its diagonal is outside a circle but inside the rounded rectangle; its
        // very corner is outside both.
        const b = lay.bubble;
        const diagonal = near(pixel(buf, Math.round(b.x + 0.1 * b.d), Math.round(b.y + 0.1 * b.d)), RED);
        checks[`${c.name}: the corner of the Bubble's square is cut off`] = !near(pixel(buf, b.x + 2, b.y + 2), RED, 60);
        checks[`${c.name}: the Bubble is ${full.bubbleShape === 'rounded' ? 'a rounded rectangle' : 'round'}`] = full.bubbleShape === 'rounded' ? diagonal : !diagonal;
        if (full.bubblePlace === 'outside') checks[`${c.name}: the Bubble is not on the Card`] = !near(pixel(buf, Math.round(lay.bubble.x + lay.bubble.d / 2), lay.card.y + lay.card.h - 4), RED);
      } else {
        checks[`${c.name}: no Bubble without a camera`] = redPixels(buf) < 5;
      }
    }
    // ---- Zoom: the click is in the red quarter. The card point 70% across and 20% down is green in the
    // whole picture and red once the view has zoomed into the red quarter.
    const zoomProject = makeZoomProject('zoom');
    const zoomLayout = look.layout({ canvas: { w: 1920, h: 1080 }, source: screenSize, hasCamera: false, bubbleSize: 'small', look: look.normalizeLook({}) });
    const probe = (buf) => pixel(buf, Math.round(zoomLayout.card.x + 0.7 * zoomLayout.card.w), Math.round(zoomLayout.card.y + 0.2 * zoomLayout.card.h));
    const exportZoom = async (name, wanted) => { const out = path.join(dir, `${name}.mp4`); await exportProject({ projectDir: zoomProject, look: wanted, outFile: out, renderLayers }); return out; };
    const zoomed = await exportZoom('zoomed', {});
    checks['zoom: the whole picture before the click'] = near(probe(frame(zoomed, 0.5)), GREEN);
    checks['zoom: zoomed into the red quarter while holding'] = near(probe(frame(zoomed, 3.5)), RED);
    checks['zoom: back to the whole picture afterwards'] = near(probe(frame(zoomed, 6.2)), GREEN);
    const saved = JSON.parse(fs.readFileSync(path.join(zoomProject, 'project.json'), 'utf8'));
    checks['zoom: the list is stored in the Project'] = Boolean(saved.zoom) && saved.zoom.enabled === true && saved.zoom.zooms.length === 1 && saved.zoom.zooms[0].start === 2550 && saved.zoom.zooms[0].end === 4400;
    const off = await exportZoom('zoom-off', { zoom: false });
    checks['zoom: --zoom off keeps the whole picture'] = near(probe(frame(off, 3.5)), GREEN);
    saved.zoom.zooms = []; // an edited list wins over the clicks
    fs.writeFileSync(path.join(zoomProject, 'project.json'), JSON.stringify(saved));
    checks['zoom: the stored list is used, not the clicks'] = near(probe(frame(await exportZoom('zoom-edited', {}), 3.5)), GREEN);
    saved.zoom = { enabled: false, zooms: [{ start: 2550, end: 4400, strength: 1.6, x: 0.25, y: 0.25 }] };
    fs.writeFileSync(path.join(zoomProject, 'project.json'), JSON.stringify(saved));
    checks['zoom: a Project with Zoom switched off stays whole'] = near(probe(frame(await exportZoom('zoom-disabled', {}), 3.5)), GREEN);

    // ---- Cursor and click circles. Zoom is off except in the last check, so spots are where the fractions say.
    const ptrLayout = look.layout({ canvas: { w: 1920, h: 1080 }, source: screenSize, hasCamera: false, bubbleSize: 'small', look: look.normalizeLook({}) });
    const spot = (fx, fy, dx = 0, dy = 0) => [Math.round(ptrLayout.card.x + fx * ptrLayout.card.w + dx), Math.round(ptrLayout.card.y + fy * ptrLayout.card.h + dy)];
    const at = (buf, p) => pixel(buf, p[0], p[1]);
    const white = (c) => c.every((v) => v > 215);
    const exportPtr = async (name, project, wanted) => { const out = path.join(dir, `${name}.mp4`); const done = await exportProject({ projectDir: project, look: { zoom: false, ...wanted }, outFile: out, renderLayers }); return { out, done }; };
    const win = makePointerProject('pointer-window', { mode: 'window' });
    const scr = makePointerProject('pointer-screen', { mode: 'screen' });
    const burned = makePointerProject('pointer-burned', { mode: 'window', clicksInVideo: true });

    const w1 = await exportPtr('ptr-window', win, { clicks: false });
    checks['pointer: a window recording gets a drawn cursor'] = white(at(frame(w1.out, 1.0), spot(0.5, 0.5, 3, 8))) && w1.done.pointer.cursor === 'drawn';
    checks['pointer: the cursor glides to where the mouse went'] = white(at(frame(w1.out, 2.6), spot(0.25, 0.25, 3, 8))) && near(at(frame(w1.out, 2.6), spot(0.5, 0.5, 3, 8)), GREEN);
    checks['pointer: the arrow has a dark edge'] = at(frame(w1.out, 1.0), spot(0.5, 0.5, -1, 8)).every((v) => v < 70);
    const w2 = await exportPtr('ptr-window-off', win, { clicks: false, cursor: false });
    checks['pointer: --cursor off draws none'] = near(at(frame(w2.out, 1.0), spot(0.5, 0.5, 3, 8)), GREEN) && w2.done.pointer.cursor === 'off';
    const s1 = await exportPtr('ptr-screen', scr, { clicks: false });
    checks['pointer: a screen recording keeps its own cursor, no second one is drawn'] = near(at(frame(s1.out, 1.0), spot(0.5, 0.5, 3, 8)), GREEN) && s1.done.pointer.cursor === 'real';

    const c1 = await exportPtr('ptr-clicks', win, { cursor: false });
    const ring = (b) => at(b, spot(0.25, 0.25, 13, 0));
    checks['pointer: a click circle appears at the click'] = ring(frame(c1.out, 3.1))[0] > 120 && ring(frame(c1.out, 3.1))[2] < 90 && c1.done.pointer.clicks === 1;
    checks['pointer: and is gone before and after'] = near(ring(frame(c1.out, 2.5)), GREEN) && near(at(frame(c1.out, 3.9), spot(0.25, 0.25, 14, 0)), GREEN);
    const c2 = await exportPtr('ptr-clicks-off', win, { cursor: false, clicks: false });
    checks['pointer: --clicks off draws none'] = near(ring(frame(c2.out, 3.1)), GREEN) && c2.done.pointer.clicks === 0;
    const c3 = await exportPtr('ptr-clicks-burned', burned, { cursor: false });
    checks['pointer: circles already in the recording are not drawn twice'] = near(ring(frame(c3.out, 3.1)), GREEN) && c3.done.pointer.clicks === 0;
    const c4 = await exportPtr('ptr-screen-clicks', scr, { cursor: false });
    checks['pointer: a screen recording gets click circles too'] = ring(frame(c4.out, 3.1))[0] > 120;

    // With the Zoom on, the view at 3.6 s is zoomed into the top-left quarter: a point at 25%, 25% of the screen
    // is at 40% of the Card (the view cannot go past the screen's edge), and the cursor is drawn there.
    const z1 = path.join(dir, 'ptr-zoom.mp4');
    await exportProject({ projectDir: win, look: { clicks: false }, outFile: z1, renderLayers });
    const zb = frame(z1, 3.6);
    checks['pointer: with Zoom the cursor stays on the spot it points at'] = white(at(zb, spot(0.4, 0.4, 3, 8))) && near(at(zb, spot(0.25, 0.25, 3, 8)), GREEN);

    // ---- Vertical: 9:16 at 1080x1920. The Card fills the width; the Bubble goes above or below it.
    const TALL = look.ASPECTS['9:16'];
    for (const v of [
      { name: 'vertical, bottom-left, ocean', wanted: { aspect: '9:16', background: 'ocean' } },
      { name: 'vertical, top-right, rose', wanted: { aspect: '9:16', background: 'rose', bubbleCorner: 'top-right' } },
      { name: 'vertical, inside, slate', wanted: { aspect: '9:16', background: 'slate', bubblePlace: 'inside', bubbleCorner: 'top-left' } },
    ]) {
      const out = path.join(dir, `${v.name.replace(/\W+/g, '-')}.mp4`);
      await exportProject({ projectDir: withCamera, look: { zoom: false, ...v.wanted }, outFile: out, renderLayers });
      const text = info(out);
      const lay = look.layout({ canvas: TALL, source: screenSize, hasCamera: true, bubbleSize: 'small', look: look.normalizeLook(v.wanted) });
      const buf = frame(out);
      const px = (x, y) => pixel(buf, Math.round(x), Math.round(y), TALL.w);
      const seconds = (/Duration: 00:00:(\d+\.\d+)/.exec(text) || [])[1];
      checks[`${v.name}: 1080x1920 H.264 with sound, ${SECONDS} s`] = /Video: h264.*1080x1920/.test(text) && /Audio: aac/.test(text) && Math.abs(Number(seconds) - SECONDS) < 0.4;
      checks[`${v.name}: the screen fills the Card, which fills the width`] = near(px(lay.card.x + lay.card.w / 2, lay.card.y + lay.card.h / 2), GREEN) && near(px(lay.card.x + 6, lay.card.y + lay.card.h / 2), GREEN) && lay.card.w === TALL.w - 2 * 54;
      checks[`${v.name}: Background above and below the Card`] = near(px(3, 3), bgStart(v.wanted.background), 30) && !near(px(TALL.w / 2, lay.card.y - 20), GREEN) && !near(px(TALL.w / 2, lay.card.y + lay.card.h + 20), GREEN, 60);
      checks[`${v.name}: the camera is in the Bubble`] = near(px(lay.bubble.x + lay.bubble.d / 2, lay.bubble.y + lay.bubble.d / 2), RED);
      if (v.wanted.bubblePlace !== 'inside') checks[`${v.name}: the Bubble is off the Card, ${v.wanted.bubbleCorner && v.wanted.bubbleCorner.startsWith('top') ? 'above' : 'below'} it`] = (v.wanted.bubbleCorner === 'top-right' ? lay.bubble.y + lay.bubble.d < lay.card.y : lay.bubble.y > lay.card.y + lay.card.h) && near(px(lay.card.x + lay.card.w / 2, lay.card.y + 6), GREEN);
    }

    // ---- Trim: only the part between start and end is exported, with its sound, the camera, the Zoom and the pointer in step.
    const changing = makeChangingProject('changing');
    const exportTrim = async (name, project, wanted, trim) => { const out = path.join(dir, `${name}.mp4`); const done = await exportProject({ projectDir: project, look: { zoom: false, cursor: false, clicks: false, ...wanted }, trim, outFile: out, renderLayers }); return { out, done }; };
    const chLayout = look.layout({ canvas: { w: 1920, h: 1080 }, source: screenSize, hasCamera: true, bubbleSize: 'small', look: look.normalizeLook({}) });
    const cardMid = (b) => pixel(b, Math.round(chLayout.card.x + chLayout.card.w / 2), Math.round(chLayout.card.y + chLayout.card.h / 2));
    const bubbleMid = (b) => pixel(b, Math.round(chLayout.bubble.x + chLayout.bubble.d / 2), Math.round(chLayout.bubble.y + chLayout.bubble.d / 2));
    const t1 = await exportTrim('trim-middle', changing, {}, { start: 1500, end: 4500 });
    const v1 = streamSeconds(t1.out, 'v');
    const a1 = streamSeconds(t1.out, 'a');
    checks['trim: the video and the sound are both 3 s long'] = Math.abs(v1 - 3) < 0.15 && Math.abs(a1 - 3) < 0.15;
    checks['trim: it starts at the start (the screen is still red at 1.7 s, then turns green)'] = near(cardMid(frame(t1.out, 0.2)), RED) && near(cardMid(frame(t1.out, 1.0)), GREEN);
    checks['trim: the camera moves with it (red, then blue)'] = near(bubbleMid(frame(t1.out, 0.2)), RED) && near(bubbleMid(frame(t1.out, 1.0)), [0, 0, 255]);
    checks['trim: the result says what was cut'] = t1.done.trim.start === 1500 && t1.done.trim.end === 4500 && Math.abs(t1.done.durationSec - 3) < 0.01;
    const saved1 = JSON.parse(fs.readFileSync(path.join(changing, 'project.json'), 'utf8'));
    checks['trim: it is saved in the Project'] = saved1.trim && saved1.trim.start === 1500 && saved1.trim.end === 4500;
    const t2 = await exportTrim('trim-saved', changing, {}, undefined);
    checks['trim: the next export uses the saved trim'] = Math.abs(streamSeconds(t2.out, 'v') - 3) < 0.15 && near(cardMid(frame(t2.out, 0.2)), RED);
    const t3 = await exportTrim('trim-cleared', changing, {}, { start: 0, end: null });
    checks['trim: start 0 and no end clears it'] = Math.abs(streamSeconds(t3.out, 'v') - 6) < 0.15 && JSON.parse(fs.readFileSync(path.join(changing, 'project.json'), 'utf8')).trim.end === null;
    const t4 = await exportTrim('trim-end-only', changing, {}, { start: 0, end: 2500 });
    checks['trim: an end alone keeps the beginning'] = Math.abs(streamSeconds(t4.out, 'v') - 2.5) < 0.15 && near(cardMid(frame(t4.out, 0.2)), RED) && near(cardMid(frame(t4.out, 2.3)), GREEN);
    const t5 = await exportTrim('trim-start-only', changing, {}, { start: 3000, end: null });
    checks['trim: a start alone runs to the end'] = Math.abs(streamSeconds(t5.out, 'v') - 3) < 0.15 && near(cardMid(frame(t5.out, 0.3)), GREEN);
    const rejected = async (trim) => exportTrim('trim-bad', changing, {}, trim).then(() => null, (err) => err.message);
    const badOrder = await rejected({ start: 4000, end: 3000 });
    const pastEnd = await rejected({ start: 9000, end: null });
    checks['trim: a start after the end, or past the recording, is refused'] = /trim.*before/i.test(badOrder || '') && /trim.*past/i.test(pastEnd || '');
    saved1.trim = { start: 0, end: null };
    fs.writeFileSync(path.join(changing, 'project.json'), JSON.stringify(saved1));

    // The Zoom list is in video time: a trim that starts in the middle of the hold begins already zoomed in, one
    // that starts after it leaves the Zoom out, and the Zoom stays on the right moment of the picture.
    const zProject = makeZoomProject('trim-zoom');
    const zLayout = look.layout({ canvas: { w: 1920, h: 1080 }, source: screenSize, hasCamera: false, bubbleSize: 'small', look: look.normalizeLook({}) });
    const zProbe = (b) => pixel(b, Math.round(zLayout.card.x + 0.7 * zLayout.card.w), Math.round(zLayout.card.y + 0.2 * zLayout.card.h));
    const zt1 = await exportTrim('trim-zoom-mid', zProject, { zoom: true }, { start: 3200, end: 6000 });
    checks['trim with Zoom: it starts already zoomed in, and the Zoom ends on time'] = near(zProbe(frame(zt1.out, 0.1)), RED) && near(zProbe(frame(zt1.out, 2.2)), GREEN) && zt1.done.zooms === 1;
    const zt2 = await exportTrim('trim-zoom-after', zProject, { zoom: true }, { start: 5000, end: 7000 });
    checks['trim with Zoom: a Zoom outside the trimmed part is left out'] = zt2.done.zooms === 0 && near(zProbe(frame(zt2.out, 0.5)), GREEN);
    // The saved Zoom list is untouched by trimming.
    checks['trim with Zoom: the Zoom list is not changed by a trim'] = JSON.parse(fs.readFileSync(path.join(zProject, 'project.json'), 'utf8')).zoom.zooms.length === 1;

    // The cursor and the click circle keep their place in time: the circle is 0.18 of the way through its life at 3.1 s.
    const trimPointer = makePointerProject('trim-pointer', { mode: 'window' });
    const tp = await exportTrim('trim-pointer-out', trimPointer, { cursor: true, clicks: true }, { start: 2900, end: 5000 });
    const tpb = frame(tp.out, 0.2);
    checks['trim with pointer: the click circle is there at its moment'] = at(tpb, spot(0.25, 0.25, 13, 0))[0] > 120 && near(at(frame(tp.out, 1.0), spot(0.25, 0.25, 13, 0)), GREEN) && tp.done.pointer.clicks === 1;
    const tpNone = await exportTrim('trim-pointer-none', trimPointer, { cursor: false, clicks: true }, { start: 5000, end: 7000 });
    checks['trim with pointer: a click outside the exported part is not counted or drawn'] = tpNone.done.pointer.clicks === 0 && near(at(frame(tpNone.out, 0.5), spot(0.25, 0.25, 13, 0)), GREEN);
    // (the circle is over the arrow at 3.1 s, so the cursor is looked at once the circle has faded, at 4.4 s)
    checks['trim with pointer: the cursor has already glided to where it rests'] = white(at(frame(tp.out, 1.5), spot(0.25, 0.25, 3, 8)));

    // ---- A picture of your own as the Background: checked first, copied into the Project, kept there.
    const pic = makeProject('pic', { camera: false });
    const picLook = look.layout({ canvas: { w: 1920, h: 1080 }, source: screenSize, hasCamera: false, bubbleSize: 'small', look: look.normalizeLook({}) });
    const magenta = path.join(dir, 'magenta.png');
    const orange = path.join(dir, 'orange.jpg');
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff00ff:s=64x64:d=1', '-frames:v', '1', magenta]);
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff8000:s=64x64:d=1', '-frames:v', '1', orange]);
    const MAGENTA = [255, 0, 255];
    const ORANGE = [255, 128, 0];
    const exportPic = async (name, extra) => { const out = path.join(dir, `${name}.mp4`); const done = await exportProject({ projectDir: pic, outFile: out, renderLayers, ...extra, look: { zoom: false, cursor: false, clicks: false, ...(extra && extra.look) } }); return { out, done }; };
    const corner = (b, w = 1920) => pixel(b, 3, 3, w);
    const projectFiles = () => fs.readdirSync(pic).filter((n) => n.startsWith('background')).sort();
    const projectJson = () => JSON.parse(fs.readFileSync(path.join(pic, 'project.json'), 'utf8'));

    const p1 = await exportPic('pic-1', { backgroundImage: magenta });
    checks['picture: it fills the Background around the Card'] = near(corner(frame(p1.out)), MAGENTA) && near(pixel(frame(p1.out), 1900, 1070), MAGENTA);
    checks['picture: it is copied into the Project and the Project remembers it'] = projectFiles().join() === 'background.png' && projectJson().backgroundImage === 'background.png';
    checks['picture: the screen is still in the Card'] = near(pixel(frame(p1.out), Math.round(picLook.card.x + picLook.card.w / 2), Math.round(picLook.card.y + picLook.card.h / 2)), GREEN);
    fs.rmSync(magenta);
    const p2 = await exportPic('pic-2', {});
    checks['picture: the original can be deleted, the Project still has it'] = near(corner(frame(p2.out)), MAGENTA);
    const p3 = await exportPic('pic-3', { backgroundImage: orange });
    checks['picture: a new one replaces it, and only one is kept'] = near(corner(frame(p3.out)), ORANGE, 50) && projectFiles().join() === 'background.jpg' && projectJson().backgroundImage === 'background.jpg';
    const p4 = await exportPic('pic-4', { look: { background: 'rose' }, preferBuiltIn: true });
    checks['picture: a built-in Background chosen on purpose wins for that export only'] = near(corner(frame(p4.out)), bgStart('rose'), 30) && projectJson().backgroundImage === 'background.jpg';
    const p5 = await exportPic('pic-5', { backgroundImage: orange, look: { aspect: '9:16' } });
    checks['picture: it fills a vertical canvas too'] = near(corner(frame(p5.out), 1080), ORANGE, 50);
    const p6 = await exportPic('pic-6', { backgroundImage: null });
    checks['picture: "none" takes it out of the Project and goes back to a built-in'] = near(corner(frame(p6.out)), bgStart('ocean'), 30) && projectFiles().length === 0 && projectJson().backgroundImage === undefined;

    // A picture that comes from the default look is used from where it is and is not copied into the Project.
    ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xff00ff:s=64x64:d=1', '-frames:v', '1', magenta]);
    const p7 = await exportPic('pic-7', { look: { backgroundImage: magenta } });
    checks['picture: one from the default look is used and not copied into the Project'] = near(corner(frame(p7.out)), MAGENTA) && projectFiles().length === 0;

    // A margin from the look.
    const p8 = await exportPic('pic-8', { look: { margin: 10 } });
    // A 16:9 screen is held back by the height: with margin 5 the Card starts 54 px down, with margin 10 it starts 108 px down.
    checks['margin: 10 pushes the Card in from the edge'] = !near(pixel(frame(p8.out), 960, 80), GREEN) && near(pixel(frame(p8.out), 960, 130), GREEN);

    // A picture that cannot be used stops the export before it starts and leaves the Project as it was.
    fs.writeFileSync(path.join(dir, 'notes.png'), 'this is not a picture');
    fs.writeFileSync(path.join(dir, 'broken.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage that is not a png at all, only a start that looks like one')]));
    const before = fs.readFileSync(path.join(pic, 'project.json'), 'utf8');
    const refusal = async (name, file) => { const out = path.join(dir, `${name}.mp4`); const err = await exportProject({ projectDir: pic, look: { zoom: false }, backgroundImage: file, outFile: out, renderLayers }).then(() => null, (e) => e.message); return { err, made: fs.existsSync(out) || fs.existsSync(`${out}.part.mp4`) }; };
    const missing = await refusal('bad-missing', path.join(dir, 'nope.png'));
    const notPic = await refusal('bad-notes', path.join(dir, 'notes.png'));
    const broken = await refusal('bad-broken', path.join(dir, 'broken.png'));
    checks['picture: a missing file is refused clearly'] = /background-image.*nope\.png.*does not exist/.test(missing.err || '') && !missing.made;
    checks['picture: a file that is not a PNG, JPEG or WebP is refused clearly'] = /background-image.*notes\.png.*not a PNG, JPEG or WebP/.test(notPic.err || '') && !notPic.made;
    checks['picture: a damaged picture is refused clearly'] = /background-image.*broken\.png.*could not be opened/.test(broken.err || '') && !broken.made;
    checks['picture: a refused picture changes nothing in the Project'] = fs.readFileSync(path.join(pic, 'project.json'), 'utf8') === before && projectFiles().length === 0;

    await exportProject({ projectDir: withCamera, look: { background: 'nope' }, outFile: path.join(dir, 'bad.mp4'), renderLayers }).then(
      () => { checks['a wrong background is refused'] = false; },
      (err) => { checks['a wrong background is refused'] = /background.*ocean/s.test(err.message) && !fs.existsSync(path.join(dir, 'bad.mp4')); },
    );
  } catch (err) {
    console.error(err.stack);
    checks['no crash'] = false;
  }
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(JSON.stringify(checks, null, 2));
  console.log(failed.length ? `FAIL: ${failed.length} of ${Object.keys(checks).length}: ${failed.join(' | ')}` : `OK: ${Object.keys(checks).length} of ${Object.keys(checks).length}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
  app.exit(failed.length ? 1 : 0);
});
