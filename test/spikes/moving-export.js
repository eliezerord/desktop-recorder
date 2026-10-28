// Spike behind docs/adr/0002: how to export a Card that moves (Full screen easing into the Card).
// Way A draws every frame with the Editor preview's own code in a hidden window and ffmpeg only encodes them.
// Way B extends the ffmpeg graph: the perspective filter moves and shrinks the screen and its rounded mask
// frame by frame. Both export the same 60 s 1080p Project, and today's static export is timed for reference.
// It prints time, CPU and the mean frame difference against the preview. Not part of the test suite.
// Run: node_modules/electron/dist/electron.exe test/spikes/moving-export.js [seconds]
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ffmpegPath } = require('../../src/convert');
const { exportProject, planExport } = require('../../src/export');
const { renderLayers } = require('../../src/look-window');

const SECONDS = Number(process.argv.find((a) => /^\d+$/.test(a)) || 60);
const FPS = 30;
const MOVE = { startMs: 10000, lengthMs: 600 }; // full screen, then the Card eases into place at 10 s
const SNAP = { w: 480, h: 270 };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-spike-'));
app.setPath('userData', path.join(dir, 'user'));
const ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];

function makeProject() {
  const p = path.join(dir, 'project');
  fs.mkdirSync(p);
  const r = spawnSync(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${SECONDS}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-c:a', 'aac', '-shortest', path.join(p, 'screen.mp4')]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  fs.writeFileSync(path.join(p, 'events.json'), JSON.stringify({ version: 1, cursor: [], clicks: [], windowRects: [] }));
  fs.writeFileSync(path.join(p, 'project.json'), JSON.stringify({
    version: 1, mode: 'screen', durationSec: SECONDS, screen: { file: 'screen.mp4' }, cursorInVideo: true, clicksInVideo: true, camera: null,
    source: { kind: 'screen', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, look: { effects: {}, bubble: 'small' }, plainMp4: null,
  }));
  return p;
}

// ffmpeg's own CPU time from its -benchmark line.
const benchOf = (text) => { const m = /bench: utime=([\d.]+)s stime=([\d.]+)s/.exec(text); return m ? Number(m[1]) + Number(m[2]) : null; };
function ffmpeg(args, feed) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-y', '-hide_banner', '-benchmark', ...args], { stdio: [feed ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ cpu: benchOf(err) }) : reject(new Error(err.slice(-800)))));
    if (feed) feed(child.stdin);
  });
}
// CPU seconds of every Electron process so far (main, GPU, renderers).
const electronCpu = () => app.getAppMetrics().reduce((s, m) => s + (m.cpu.cumulativeCPUUsage || 0), 0);

function meanDiff(a, b) {
  let d = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) { d += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; }
  return d / n;
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const projectDir = makeProject();
  const plan = await planExport({ projectDir, look: { background: 'ocean', margin: 5 } });
  const { canvas, lay, look } = plan;
  const screenPath = path.join(projectDir, 'screen.mp4');
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'moving-export.html'));
  const js = (code) => win.webContents.executeJavaScript(code);
  for (let i = 0; i < 50 && !(await js('Boolean(window.spikeReady)')); i++) await new Promise((r) => setTimeout(r, 100));
  const pagePlan = { canvas, card: lay.card, shadow: lay.shadow, bubble: null, look, zooms: [], pointer: null, startMs: 0, cameraOffsetMs: 0, move: MOVE, screenUrl: pathToFileURL(screenPath).href, screenSize: { w: 1920, h: 1080 }, readFrequently: Boolean(process.env.DR_SPIKE_CPU_CANVAS) };
  await js(`window.spike.setup(${JSON.stringify(pagePlan)})`);
  const frames = SECONDS * FPS;
  const results = {};

  // ---- Today's static export, for reference.
  {
    const c0 = electronCpu();
    const t0 = Date.now();
    await exportProject({ projectDir, look: { background: 'ocean', margin: 5, zoom: false, cursor: false, clicks: false }, outFile: path.join(dir, 'static.mp4'), renderLayers });
    results.static = { seconds: (Date.now() - t0) / 1000, electronCpu: electronCpu() - c0, note: 'ffmpeg CPU not measured here' };
  }

  // The encoder both drawing ways feed: the page sends a finished frame, main writes it to ffmpeg.
  let stdin = null;
  ipcMain.handle('spike-frame', (_e, px) => new Promise((resolve) => {
    if (stdin.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) resolve();
    else stdin.once('drain', resolve);
  }));
  const encodeFrames = (out) => ffmpeg(['-loglevel', 'info', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${canvas.w}x${canvas.h}`, '-framerate', String(FPS), '-i', 'pipe:0', '-i', screenPath,
    '-map', '0:v', '-map', '1:a?', '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', ...ENCODE, '-t', String(SECONDS), out], (s) => { stdin = s; });

  // ---- Way A2: the same drawing, with the screen decoded in order by ffmpeg and handed to the page.
  {
    const outA2 = path.join(dir, 'wayA2.mp4');
    const frameBytes = 1920 * 1080 * 4;
    const decoder = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-benchmark', '-i', screenPath, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let decErr = '';
    decoder.stderr.on('data', (d) => { decErr += d; });
    const chunks = [];
    let have = 0;
    let waiting = null;
    const take = () => {
      const all = Buffer.concat(chunks.splice(0));
      chunks.push(all.subarray(frameBytes));
      have -= frameBytes;
      return all.subarray(0, frameBytes);
    };
    decoder.stdout.on('data', (d) => {
      chunks.push(d);
      have += d.length;
      if (have > 4 * frameBytes) decoder.stdout.pause(); // keep only a few frames ahead
      if (waiting && have >= frameBytes) { const w = waiting; waiting = null; w(take()); }
    });
    ipcMain.handle('spike-next-screen', () => {
      if (have < 4 * frameBytes) decoder.stdout.resume();
      if (have >= frameBytes) return take();
      return new Promise((resolve) => { waiting = resolve; });
    });
    const c0 = electronCpu();
    const t0 = Date.now();
    const run = encodeFrames(outA2);
    const steps = await js(`window.spike.exportFromFrames(${frames})`);
    stdin.end();
    const done = await run;
    decoder.kill();
    results.wayA2 = { seconds: (Date.now() - t0) / 1000, ffmpegCpu: done.cpu, electronCpu: electronCpu() - c0, stepsMs: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, Math.round(v)])), file: outA2 };
  }

  // ---- Way A: frames drawn by the preview code, each found by seeking the <video>, piped to ffmpeg.
  if (!process.env.DR_SPIKE_SKIP_SEEK) {
    const outA = path.join(dir, 'wayA.mp4');
    const c0 = electronCpu();
    const t0 = Date.now();
    const run = encodeFrames(outA);
    const steps = await js(`window.spike.exportAll(${frames})`);
    stdin.end();
    const done = await run;
    results.wayA = { seconds: (Date.now() - t0) / 1000, ffmpegCpu: done.cpu, electronCpu: electronCpu() - c0, stepsMs: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, Math.round(v)])), file: outA };
  }

  // ---- Way B: the ffmpeg graph moves the screen and its mask with the perspective filter.
  {
    const outB = path.join(dir, 'wayB.mp4');
    const layers = await js('window.spike.layers()');
    const png = (name, dataUrl) => { const p = path.join(dir, `${name}.png`); fs.writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64')); return p; };
    const base = png('base', layers.base);
    const mask = png('mask', layers.mask);
    const T = '(in/30+1/60)'; // the middle of the frame, as Way A and the preview draw it
    const u = `((${T}*1000-${MOVE.startMs})/${MOVE.lengthMs})`;
    const e = `(clip(${u},0,1)*clip(${u},0,1)*(3-2*clip(${u},0,1)))`;
    const { card } = lay;
    const X0 = `(${card.x}*${e})`;
    const Y0 = `(${card.y}*${e})`;
    const X1 = `(${canvas.w}+(${card.x + card.w - canvas.w})*${e})`;
    const Y1 = `(${canvas.h}+(${card.y + card.h - canvas.h})*${e})`;
    const persp = `perspective=x0='${X0}':y0='${Y0}':x1='${X1}':y1='${Y0}':x2='${X0}':y2='${Y1}':x3='${X1}':y3='${Y1}':sense=destination:eval=frame:interpolation=cubic`;
    const filter = `[1:v]scale=${canvas.w}:${canvas.h}:flags=lanczos,format=rgba,${persp}[s];[2:v]format=gray,${persp}[m];[s][m]alphamerge[c];[0:v][c]overlay=0:0[b];[b]scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[out]`;
    fs.writeFileSync(path.join(dir, 'filterB.txt'), filter);
    const still = (p) => ['-loop', '1', '-framerate', String(FPS), '-i', p];
    const t0 = Date.now();
    const done = await ffmpeg(['-loglevel', 'info', ...still(base), '-i', screenPath, ...still(mask), '-filter_complex_script', path.join(dir, 'filterB.txt'), '-map', '[out]', '-map', '1:a?', ...ENCODE, '-t', String(SECONDS), outB]);
    results.wayB = { seconds: (Date.now() - t0) / 1000, ffmpegCpu: done.cpu, file: outB };
  }

  // ---- How close each export is to the preview, at moments before, during and after the move.
  const at = [0, 150, 299, 300, 303, 306, 309, 312, 315, 318, 330, 900, frames - 30].filter((n) => n < frames);
  for (const way of Object.keys(results).filter((k) => results[k].file)) {
    const url = pathToFileURL(results[way].file).href;
    const diffs = [];
    for (const n of at) {
      const p = Buffer.from(await js(`window.spike.preview(${n}, ${SNAP.w}, ${SNAP.h})`), 'base64');
      const x = Buffer.from(await js(`window.spike.exported(${JSON.stringify(url)}, ${n}, ${SNAP.w}, ${SNAP.h})`), 'base64');
      diffs.push([n, Math.round(meanDiff(p, x) * 100) / 100]);
    }
    results[way].frameDiff = diffs.map(([n, d]) => `${n}:${d}`).join(' ');
    results[way].sizeMB = Math.round(fs.statSync(results[way].file).size / 1e5) / 10;
  }
  console.log(`SPIKE ${JSON.stringify({ seconds: SECONDS, frames, cpus: os.cpus().length, cpu: os.cpus()[0].model, results }, null, 2)}`);
  win.destroy();
  if (!process.env.DR_SPIKE_KEEP) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } else console.log(`kept ${dir}`);
  app.exit(0);
}).catch((err) => { console.error(err); app.exit(1); });
