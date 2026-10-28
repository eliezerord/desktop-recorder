// Export: turns a Project into a styled MP4 (docs/adr/0001-record-raw-then-export.md).
// The fixed layers (Background with shadow, Card mask, Bubble mask and ring) are drawn once as PNGs by
// the caller's renderLayers; ffmpeg then puts the screen video, the camera and those layers together
// one frame at a time, so memory stays flat however long the Project is. The cursor and the click circles
// (pointer.mjs) are drawn as small pictures that this module streams to ffmpeg, which overlays them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { ffmpegPath } = require('./convert');
const { RAW_DELETED_MESSAGE } = require('./project-storage');

const FPS = 30;

const loadLook = () => import(pathToFileURL(path.join(__dirname, 'look.mjs')).href);
const loadZoom = () => import(pathToFileURL(path.join(__dirname, 'zoom.mjs')).href);
const loadPointer = () => import(pathToFileURL(path.join(__dirname, 'pointer.mjs')).href);
const loadLayouts = () => import(pathToFileURL(path.join(__dirname, 'layouts.mjs')).href);

// ffmpeg -i lists the streams on stderr and then complains that there is no output; that is fine.
function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true }, (_err, _out, text) => {
      const size = /Video: .*?\b(\d{3,5})x(\d{3,5})\b/.exec(text);
      if (!size) { reject(new Error(`Could not read the video ${path.basename(file)}.`)); return; }
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
      resolve({ w: Number(size[1]), h: Number(size[2]), seconds: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null });
    });
  });
}

// feed(stdin), when given, writes a raw video stream to ffmpeg's standard input (see feedSheet).
function runFfmpeg(args, seconds, onProgress, { cwd, feed } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true, cwd, stdio: [feed ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (feed) {
      child.stdin.on('error', () => { /* ffmpeg stopped early; its exit code tells why */ });
      feed(child.stdin).catch(reject);
    }
    let errText = '';
    let buffer = '';
    child.stderr.on('data', (d) => { errText += d; });
    child.stdout.on('data', (d) => {
      buffer += d;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line); // both are microseconds in ffmpeg
        if (m && seconds && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / seconds));
      }
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg stopped with code ${code}: ${errText.slice(-600)}`))));
  });
}

// The Project's Zoom list: { enabled, zooms }. Worked out from the recorded clicks the first time it is
// needed and then kept in project.json, so later edits (Editor, drec) are what Export uses.
function readEvents(projectDir) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, 'events.json'), 'utf8')); } catch { return {}; } // no events, no Zooms or pointer
}

function zoomSetting(projectDir, project, events, { computeZooms }) {
  if (project.zoom) return project.zoom;
  const source = project.source || { kind: project.mode === 'window' ? 'window' : 'screen' };
  const usable = source.kind === 'window' || Boolean(source.bounds);
  project.zoom = { enabled: true, zooms: usable ? computeZooms({ clicks: events.clicks || [], source, windowRects: events.windowRects || [] }) : [] };
  const file = path.join(projectDir, 'project.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(project, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return project.zoom;
}

// Writes project.json (the trim, the Zoom list and the Background picture live there).
function writeProject(projectDir, project) {
  const file = path.join(projectDir, 'project.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(project, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// ---- A picture of your own as the Background. It is checked before anything else starts, and when it is
// given on an export it is copied into the Project (background.png, .jpg or .webp) so the Project stays whole.
const PICTURES = [
  { ext: 'png', mime: 'image/png', is: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mime: 'image/jpeg', is: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', is: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
const MAX_PICTURE_BYTES = 30 * 1024 * 1024;

function readPicture(file) {
  const abs = path.resolve(String(file));
  let stat = null;
  try { stat = fs.statSync(abs); } catch { /* reported below */ }
  if (!stat || !stat.isFile()) throw new Error(`background-image: "${abs}" does not exist.`);
  const name = path.basename(abs);
  if (stat.size === 0) throw new Error(`background-image: "${name}" is empty.`);
  if (stat.size > MAX_PICTURE_BYTES) throw new Error(`background-image: "${name}" is too big (more than 30 MB).`);
  const bytes = fs.readFileSync(abs);
  const type = PICTURES.find((t) => t.is(bytes));
  if (!type) throw new Error(`background-image: "${name}" is not a PNG, JPEG or WebP picture.`);
  return { name, ext: type.ext, mime: type.mime, bytes, dataUrl: `data:${type.mime};base64,${bytes.toString('base64')}` };
}

const isProjectPicture = (name) => /^background\.(png|jpg|webp)$/.test(name);
function removeProjectPictures(projectDir) {
  for (const name of fs.readdirSync(projectDir)) if (isProjectPicture(name)) fs.rmSync(path.join(projectDir, name), { force: true });
}

// What the cursor and the click circles do on every frame, in Card pixels, plus a summary for the caller.
// The cursor is drawn only for window recordings (a screen recording already has the real one in its
// video); click circles are drawn unless the recording already burned them in.
// `startMs` is where the exported part begins in the recording; `frames` counts the exported frames. Times
// (Zoom, circles) are in recording time, and the cursor's smoothing runs from the very start of the recording.
function planPointer({ project, events, look, zooms, card, frames, startMs, endMs, mods }) {
  const { zoomAt, clickFractions } = mods.zoom;
  const { cursorPath, trackCursor, ripplesAt, toCard, RIPPLE } = mods.pointer;
  const source = project.source || { kind: project.mode };
  const windowRects = events.windowRects || [];
  const usable = source.kind === 'window' || Boolean(source.bounds);
  const wholeView = { scale: 1, cx: 0.5, cy: 0.5 };
  const first = Math.round((startMs * FPS) / 1000); // index of the first exported frame in the recording

  const track = look.cursor && usable && !project.cursorInVideo && (events.cursor || []).length
    ? trackCursor({ path: cursorPath({ cursor: events.cursor, source, windowRects }), frames: first + frames, fps: FPS })
    : null;
  const clicks = look.clicks && usable && !project.clicksInVideo ? clickFractions({ clicks: events.clicks || [], source, windowRects }) : [];
  // Only the clicks whose circle can show in the exported part count.
  const shown = clicks.filter((c) => c.t >= startMs - RIPPLE.ms && c.t < endMs);
  const summary = {
    cursor: !look.cursor ? 'off' : project.cursorInVideo ? 'real' : track && track.some((f) => f.visible) ? 'drawn' : 'none',
    clicks: shown.length,
  };
  if (summary.cursor !== 'drawn' && !shown.length) return { summary, states: null };

  const room = 120; // a spot this far outside the Card cannot reach it
  const inside = (p) => p.x > -room && p.y > -room && p.x < card.w + room && p.y < card.h + room;
  const states = [];
  for (let i = 0; i < frames; i++) {
    const t = startMs + (i * 1000) / FPS;
    const view = zooms.length ? zoomAt(zooms, t) : wholeView;
    let cursor = null;
    if (track && track[first + i].visible) {
      const p = toCard(view, track[first + i].fx, track[first + i].fy, card);
      if (inside(p)) cursor = p;
    }
    const ripples = ripplesAt(clicks, t).map((r) => ({ ...toCard(view, r.fx, r.fy, card), age: r.age })).filter(inside);
    states.push({ cursor, ripples });
  }
  return { summary, states };
}

// ffmpeg moves each tile with commands read from a file, one line when a position changes.
const TILE_NAMES = ['overlay@ovc', 'overlay@ov0', 'overlay@ov1', 'overlay@ov2'];
function pointerCommands(states, tileSpots) {
  const lines = [];
  const last = [];
  states.forEach((state, i) => {
    const at = (Math.floor((i / FPS) * 10000) / 10000).toFixed(4); // never later than the frame it is for
    const parts = [];
    tileSpots(state).forEach((spot, k) => {
      if (!last[k] || last[k].x !== spot.x || last[k].y !== spot.y) { parts.push(`${TILE_NAMES[k]} x ${spot.x}, ${TILE_NAMES[k]} y ${spot.y}`); last[k] = spot; }
    });
    if (parts.length) lines.push(`${at} ${parts.join(', ')};`);
  });
  return lines.join('\n');
}

// Waits until the pipe can take more, or ends if it closed; takes its listeners off either way.
function drained(stream) {
  return new Promise((resolve) => {
    const done = () => { stream.off('drain', done); stream.off('close', done); resolve(); };
    stream.once('drain', done);
    stream.once('close', done);
  });
}

async function feedSheet(stdin, states, { SHEET, drawSheet }, opts) {
  const buf = new Uint8Array(SHEET.w * SHEET.h * 4);
  for (const state of states) {
    if (stdin.destroyed) return;
    drawSheet(buf, state, opts);
    if (!stdin.write(Buffer.from(buf))) await drained(stdin);
  }
  stdin.end();
}

// projectDir: the Project folder. look: any of the look settings (the rest take their defaults).
// trim: { start, end } in milliseconds of the recording (end null: to the end); a field left out keeps the
// Project's saved trim, and a trim that is given is saved in the Project once the export has worked.
// backgroundImage: the path of a picture to use as the Background and keep in the Project, or null to take the
// Project's picture out; left out, the Project's own picture is used if it has one, else the look's (the default look's).
// preferBuiltIn: ignore any picture and use the look's built-in Background this once (a Background was chosen on purpose).
// outFile: where the MP4 goes. renderLayers: draws the PNG layers (look-window.js in the app).
// Everything an export of these settings will show, worked out without drawing anything: Export runs ffmpeg
// from it and the Editor draws its preview from it, so the two cannot disagree.
async function planExport({ projectDir, look: wanted, trim, backgroundImage, preferBuiltIn }) {
  const { normalizeLook, layout, ASPECTS } = await loadLook();
  const zoomModule = await loadZoom();
  const pointerModule = await loadPointer();
  const layoutModule = await loadLayouts();
  const look = normalizeLook(wanted); // refuses a wrong value before any work starts
  const project = JSON.parse(fs.readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  if (project.rawDeleted) throw new Error(RAW_DELETED_MESSAGE);
  const screenPath = path.join(projectDir, project.screen.file);
  if (!fs.existsSync(screenPath)) throw new Error('This Project has no screen video left (screen.mp4 is missing from its folder).');
  const cameraPath = project.camera ? path.join(projectDir, project.camera.file) : null;
  const hasCamera = Boolean(cameraPath) && fs.existsSync(cameraPath);

  // Which picture, if any, is the Background; a picture that cannot be used stops the export here.
  const savedName = project.backgroundImage && fs.existsSync(path.join(projectDir, project.backgroundImage)) ? project.backgroundImage : null;
  let picture = null;
  let pictureFrom = null;
  if (typeof backgroundImage === 'string') { picture = readPicture(backgroundImage); pictureFrom = 'new'; }
  else if (backgroundImage !== null && !preferBuiltIn && savedName) { picture = readPicture(path.join(projectDir, savedName)); pictureFrom = 'project'; }
  else if (!preferBuiltIn && typeof look.backgroundImage === 'string') { picture = readPicture(look.backgroundImage); pictureFrom = 'default'; }

  const source = await probe(screenPath);
  const events = readEvents(projectDir);
  const zoom = zoomSetting(projectDir, project, events, zoomModule);
  const canvas = ASPECTS[look.aspect];

  // The part of the recording that is exported.
  const fullMs = Math.round((project.durationSec || source.seconds) * 1000);
  const savedTrim = project.trim || { start: 0, end: null };
  const given = trim || {};
  const startMs = Math.round(given.start !== undefined ? given.start || 0 : savedTrim.start || 0);
  const wantedEnd = given.end !== undefined ? given.end : savedTrim.end;
  const endMs = Math.min(wantedEnd == null ? fullMs : Math.round(wantedEnd), fullMs);
  if (startMs < 0) throw new Error('trim: the start cannot be negative.');
  if (startMs >= fullMs) throw new Error(`trim: the start is past the end of the recording (${(fullMs / 1000).toFixed(1)} s).`);
  if (endMs <= startMs) throw new Error('trim: the start must be before the end.');
  const startSec = startMs / 1000;
  const seconds = (endMs - startMs) / 1000;

  // Zooms are in recording time; one wholly outside the exported part does nothing.
  const zooms = look.zoom && zoom.enabled ? zoom.zooms.filter((z) => z.end > startMs && z.start < endMs) : [];
  const lay = layout({ canvas, source: { w: source.w, h: source.h }, hasCamera, bubbleSize: project.look && project.look.bubble, look });
  // The Layout points (one Card point when the Project has none) and where each Layout puts the screen and the Bubble.
  const layouts = { points: layoutModule.layoutPoints(project), shapes: layoutModule.layoutShapes({ canvas, source: { w: source.w, h: source.h }, lay, look }) };
  const effects = (project.look && project.look.effects) || {};
  const frames = Math.ceil(seconds * FPS) + 2;
  const pointer = planPointer({ project, events, look, zooms, card: lay.card, frames, startMs, endMs, mods: { zoom: zoomModule, pointer: pointerModule } });
  // How big the cursor and the click circles are drawn on this Card.
  const pointerSize = { cursorHeight: Math.round((pointerModule.POINTER.cursorHeightOfCard * lay.card.w * 9) / 16), scale: lay.card.w / 1920 };
  return {
    project, look, picture, pictureFrom, screenPath, cameraPath: hasCamera ? cameraPath : null, source, canvas, fullMs, startMs, endMs, wantedEnd,
    startSec, seconds, zooms, lay, layouts, moving: layoutModule.needsFrames(layouts.points), effects, pointer, pointerSize, ringColor: effects.border ? effects.borderColor : null, pointerModule, zoomModule,
  };
}

// The export worked: now the Project keeps what was given (a trim, a new picture, or the picture taken out).
function keepGiven({ projectDir, project, trim, startMs, endMs, wantedEnd, incoming, picture, backgroundImage }) {
  let changed = false;
  if (trim !== undefined) { project.trim = { start: startMs, end: wantedEnd == null ? null : endMs }; changed = true; }
  if (incoming) {
    removeProjectPictures(projectDir);
    fs.renameSync(incoming, path.join(projectDir, `background.${picture.ext}`));
    project.backgroundImage = `background.${picture.ext}`;
    changed = true;
  } else if (backgroundImage === null && (project.backgroundImage || fs.readdirSync(projectDir).some(isProjectPicture))) {
    removeProjectPictures(projectDir);
    delete project.backgroundImage;
    changed = true;
  }
  if (changed) writeProject(projectDir, project);
}

async function exportProject({ projectDir, look: wanted, trim, backgroundImage, preferBuiltIn, outFile, renderLayers, onProgress }) {
  const plan = await planExport({ projectDir, look: wanted, trim, backgroundImage, preferBuiltIn });
  const { project, look, picture, pictureFrom, screenPath, cameraPath, canvas, startMs, endMs, wantedEnd, startSec, seconds, zooms, lay, pointer, pointerSize, ringColor, pointerModule, zoomModule } = plan;
  // An unreadable picture is found when it is drawn, by either drawing way; it is reported in plain words.
  const unreadable = (err) => (picture && /unreadable-background-image/.test(err.message) ? new Error(`background-image: "${picture.name}" could not be opened as a picture.`) : err);
  // Layouts that move are drawn frame by frame with the preview's code (docs/adr/0002); the rest keeps the
  // ffmpeg path, which composes fixed layers drawn once.
  let layers = null;
  if (!plan.moving) {
    try {
      layers = await renderLayers({
        canvas, backgroundId: look.background, backgroundImage: picture ? picture.dataUrl : null, card: lay.card, shadow: lay.shadow, bubble: lay.bubble,
        ringColor,
      });
    } catch (err) { throw unreadable(err); }
  }
  // A new picture waits next to the Project's own until the export has worked.
  const incoming = pictureFrom === 'new' ? path.join(projectDir, `background-new.${picture.ext}`) : null;
  if (incoming) fs.writeFileSync(incoming, picture.bytes);

  const temp = plan.moving ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'dr-layers-'));
  const part = `${outFile}.part.mp4`;
  try {
    if (plan.moving) {
      const { renderFrames } = require('./frame-export');
      const cameraSize = cameraPath ? await probe(cameraPath) : null;
      try { await renderFrames({ plan, cameraSize, outFile: part, onProgress }); } catch (err) { throw unreadable(err); }
    } else {
      const file = (name) => { const p = path.join(temp, `${name}.png`); fs.writeFileSync(p, layers[name]); return p; };
      const still = (p) => ['-loop', '1', '-framerate', String(FPS), '-i', p];
      const { card, bubble } = lay;
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
        ...still(file('base')), ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []), '-i', screenPath, ...still(file('cardMask'))]; // inputs 0, 1, 2
      let inputs = 3;
      let cameraInputs = '';
      if (bubble) {
        // The camera is mirrored like the bubble the user saw while recording.
        // The camera file starts offsetMs after the screen file. Seek into it by what is left of the trim start, or, if the
        // trim starts before the camera did, delay it by the difference.
        const seek = startSec - (project.camera.offsetMs || 0) / 1000;
        args.push(...(seek > 0 ? ['-ss', seek.toFixed(3)] : ['-itsoffset', (-seek).toFixed(3)]), '-i', cameraPath, ...still(file('bubbleMask'))); // inputs 3, 4
        inputs = 5;
        cameraInputs = `;[3:v]hflip,crop='min(iw,ih)':'min(iw,ih)',scale=${bubble.d}:${bubble.d}:flags=lanczos,format=rgba[cam];[4:v]format=gray[bm];[cam][bm]alphamerge[bub]`;
        if (layers.ring) { args.push(...still(file('ring'))); inputs = 6; } // input 5
      }
      const { SHEET, TILE, drawSheet, tileSpots } = pointerModule;
      const sheetInput = inputs;
      if (pointer.states) {
        args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${SHEET.w}x${SHEET.h}`, '-framerate', String(FPS), '-i', 'pipe:0');
        fs.writeFileSync(path.join(temp, 'cmds.txt'), pointerCommands(pointer.states, tileSpots));
      }

      // The screen is drawn at twice the Card's size and zoompan crops and shrinks it, which keeps the move smooth.
      // With no Zoom the screen is simply scaled to the Card.
      const screenOut = pointer.states ? 'sc0' : 'sc';
      let screenChain = `[1:v]scale=${card.w}:${card.h}:flags=lanczos,format=rgba[${screenOut}]`;
      if (zooms.length) {
        const e = zoomModule.zoomExpressions(zooms, `${startSec.toFixed(3)}+on/30`);
        screenChain = `[1:v]scale=${card.w * 2}:${card.h * 2}:flags=lanczos,zoompan=z='${e.z}':x='clip((${e.x})*iw-iw/zoom/2,0,iw-iw/zoom)':y='clip((${e.y})*ih-ih/zoom/2,0,ih-ih/zoom)':d=1:s=${card.w}x${card.h}:fps=${FPS},format=rgba[${screenOut}]`;
      }
      if (pointer.states) {
        // The sheet holds the cursor and three click circles side by side; each tile is cut out and overlaid
        // where cmds.txt says (sendcmd), on the screen before the Card's rounded mask is applied.
        const cut = (name, x, size) => `[${name}]crop=${size}:${size}:${x}:0`;
        const spot = (name) => `overlay@${name}=x=-1000:y=-1000:format=auto`;
        screenChain += `;[sc0]sendcmd=f=cmds.txt[sp];[${sheetInput}:v]split=4[s0][s1][s2][s3];${cut('s0', 0, TILE.cursor)}[cur];${cut('s1', TILE.cursor, TILE.ripple)}[r0];${cut('s2', TILE.cursor + TILE.ripple, TILE.ripple)}[r1];${cut('s3', TILE.cursor + 2 * TILE.ripple, TILE.ripple)}[r2];[sp][cur]${spot('ovc')}[pa];[pa][r0]${spot('ov0')}[pb];[pb][r1]${spot('ov1')}[pc];[pc][r2]${spot('ov2')}[sc]`;
      }
      let filter = `${screenChain};[2:v]format=gray[cm];[sc][cm]alphamerge[card];[0:v][card]overlay=${card.x}:${card.y}[b1]${cameraInputs}`;
      let last = 'b1';
      if (bubble) {
        filter += `;[${last}][bub]overlay=${bubble.x}:${bubble.y}[b2]`;
        last = 'b2';
        if (layers.ring) {
          filter += `;[${last}][5:v]overlay=${bubble.x}:${bubble.y}[b3]`;
          last = 'b3';
        }
      }
      // HD video is shown as BT.709 by players and browsers, so convert with that matrix and say so in the file
      // (untagged, players guessed BT.709 while ffmpeg had used BT.601, and every colour came out a little off).
      filter += `;[${last}]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[out]`;
      // The filter can be long (a Zoom list), so it goes in a file instead of the command line.
      const filterFile = path.join(temp, 'filter.txt');
      fs.writeFileSync(filterFile, filter);
      args.push('-filter_complex_script', filterFile, '-map', '[out]', '-map', '1:a?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
        '-c:a', 'aac', '-b:a', '160k',
        '-t', String(seconds), '-movflags', '+faststart', part);
      const run = pointer.states
        ? { cwd: temp, feed: (stdin) => feedSheet(stdin, pointer.states, { SHEET, drawSheet }, pointerSize) }
        : { cwd: temp };
      await runFfmpeg(args, seconds, onProgress, run);
    }
    fs.renameSync(part, outFile);

    keepGiven({ projectDir, project, trim, startMs, endMs, wantedEnd, incoming, picture, backgroundImage });
  } finally {
    if (incoming) fs.rmSync(incoming, { force: true });
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(part, { force: true });
  }
  return { file: outFile, durationSec: seconds, trim: { start: startMs, end: endMs }, look, layout: lay, zooms: zooms.length, pointer: pointer.summary, picture: pictureFrom, layouts: plan.layouts.points.length, drawn: plan.moving ? 'frames' : 'ffmpeg' };
}

module.exports = { exportProject, planExport, readPicture, writeProject, removeProjectPictures };
