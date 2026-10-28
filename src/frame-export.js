// Export by drawing every frame (docs/adr/0002-draw-moving-layouts-frame-by-frame.md), for Projects whose
// Layouts move. A hidden window draws each frame with the Editor preview's own drawFrame (preview.mjs), so the
// export looks exactly like the preview. ffmpeg decodes the screen and the camera in order and hands their
// frames to the window, and a third ffmpeg encodes the finished frames with the screen's sound.
// Any part that fails (a decoder, the encoder, the window) stops the whole export with its reason.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const { ffmpegPath } = require('./convert');

const FPS = 30;
const AHEAD = 4; // frames a decoder may run ahead of the drawing

// Frames of a video as RGBA, one at a time and in order. next() gives null once the video has no more, and
// fails if ffmpeg stopped with an error. Only one next() is ever waiting (the window asks for one at a time).
function frameReader(name, inputArgs, { w, h }) {
  const frameBytes = w * h * 4;
  const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...inputArgs, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  let failure = null;
  let finished = false; // ffmpeg has exited and all its output has arrived
  let waiter = null;
  const chunks = []; // bytes received and not handed out yet
  let have = 0;
  child.stderr.on('data', (d) => { errText += d; });
  const settle = () => {
    if (!waiter) return;
    const { resolve, reject } = waiter;
    if (failure) { waiter = null; reject(failure); return; }
    if (have >= frameBytes) { waiter = null; resolve(take()); return; }
    if (finished) { waiter = null; resolve(null); }
  };
  // One frame copied out of the chunks ffmpeg wrote, once.
  const take = () => {
    const frame = Buffer.allocUnsafe(frameBytes);
    let off = 0;
    while (off < frameBytes) {
      const c = chunks[0];
      const n = Math.min(c.length, frameBytes - off);
      c.copy(frame, off, 0, n);
      off += n;
      if (n === c.length) chunks.shift(); else chunks[0] = c.subarray(n);
    }
    have -= frameBytes;
    return frame;
  };
  child.stdout.on('data', (d) => {
    chunks.push(d);
    have += d.length;
    if (have > AHEAD * frameBytes) child.stdout.pause();
    settle();
  });
  child.on('error', (err) => { failure = new Error(`Could not start ffmpeg for the ${name}: ${err.message}`); settle(); });
  child.on('close', (code) => {
    if (code !== 0 && code !== null && !failure) failure = new Error(`ffmpeg could not read the ${name} (code ${code}): ${errText.slice(-400).trim()}`);
    finished = true;
    settle();
  });
  return {
    next() {
      if (have < AHEAD * frameBytes) child.stdout.resume();
      if (failure) return Promise.reject(failure);
      if (have >= frameBytes) return Promise.resolve(take());
      if (finished) return Promise.resolve(null);
      return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
    },
    stop() { if (!finished) child.kill(); },
  };
}

// The encoder: finished frames in, the MP4 out, with the screen's sound for the same part.
function frameWriter({ canvas, screenPath, startSec, seconds, outFile }) {
  const child = spawn(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${canvas.w}x${canvas.h}`, '-framerate', String(FPS), '-i', 'pipe:0',
    ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []), '-i', screenPath,
    '-map', '0:v', '-map', '1:a?',
    // HD video is shown as BT.709, as in Export's ffmpeg path (export.js).
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-r', String(FPS), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', '160k', '-t', String(seconds), '-movflags', '+faststart', outFile], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let errText = '';
  child.stderr.on('data', (d) => { errText += d; });
  child.stdin.on('error', () => { /* ffmpeg stopped early; `done` says why */ });
  const done = new Promise((resolve, reject) => {
    child.on('error', (err) => reject(new Error(`Could not start ffmpeg to encode: ${err.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg stopped encoding with code ${code}: ${errText.slice(-600).trim()}`))));
  });
  done.catch(() => {}); // a failure is reported by write() or end(), never as an unhandled rejection
  return {
    // Resolves once ffmpeg can take more; fails if it stopped meanwhile (it never sends 'drain' then).
    write: (px) => {
      if (child.stdin.destroyed) return done.then(() => { throw new Error('ffmpeg stopped encoding before the video was finished.'); });
      if (child.stdin.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))) return Promise.resolve();
      return Promise.race([new Promise((resolve) => child.stdin.once('drain', resolve)), done.then(() => { throw new Error('ffmpeg stopped encoding before the video was finished.'); })]);
    },
    end() { child.stdin.end(); return done; },
    stop() { child.kill(); },
  };
}

// Each drawing window asks for its frames through these, found by the window that asks.
const sessions = new Map();
let registered = false;
function register() {
  if (registered) return;
  registered = true;
  const sessionOf = (e) => { const s = sessions.get(e.sender.id); if (!s) throw new Error('No export is running for this window.'); return s; };
  ipcMain.handle('fx-screen', (e) => sessionOf(e).screen.next());
  ipcMain.handle('fx-camera', (e) => (sessionOf(e).camera ? sessionOf(e).camera.next() : null));
  ipcMain.handle('fx-frame', async (e, px) => {
    const s = sessionOf(e);
    await s.writer.write(px);
    s.written++;
    if (s.onProgress) s.onProgress(Math.min(0.99, s.written / s.frames)); // 1 once the encoder has finished
  });
}

// plan: export.js planExport's result. cameraSize: { w, h } of the camera file, or null.
async function renderFrames({ plan, cameraSize, outFile, onProgress }) {
  register();
  const { canvas, startMs, startSec, seconds, source, screenPath, cameraPath, project } = plan;
  const frames = Math.round(seconds * FPS);
  const screen = frameReader('screen video', [...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []), '-i', screenPath, '-t', String(seconds), '-vf', `fps=${FPS}`], source);
  // The camera file starts offsetMs after the screen. Seek into it by what is left of the trim start; when the
  // trim starts before the camera did, the window asks for the first camera frame only once the camera starts.
  const offsetMs = (project.camera && project.camera.offsetMs) || 0;
  const camSeek = startSec - offsetMs / 1000;
  const camera = cameraPath && cameraSize
    ? frameReader('camera video', [...(camSeek > 0 ? ['-ss', camSeek.toFixed(3)] : []), '-i', cameraPath, '-t', String(seconds + 1), '-vf', `fps=${FPS}`], cameraSize) : null;
  const writer = frameWriter({ canvas, screenPath, startSec, seconds, outFile });
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { preload: path.join(__dirname, 'frame-export-preload.js'), backgroundThrottling: false } });
  sessions.set(win.webContents.id, { screen, camera, writer, frames, written: 0, onProgress });
  // A drawing window that crashes or hangs stops the export instead of leaving it waiting.
  const gone = new Promise((_resolve, reject) => {
    win.webContents.once('render-process-gone', (_e, d) => reject(new Error(`The export's drawing window stopped (${d.reason}).`)));
    win.once('unresponsive', () => reject(new Error("The export's drawing window stopped responding.")));
  });
  gone.catch(() => {});
  try {
    await Promise.race([win.loadFile(path.join(__dirname, 'frame-export.html')), gone]);
    const page = {
      canvas, card: plan.lay.card, bubble: plan.lay.bubble, shadow: plan.lay.shadow, look: { background: plan.look.background },
      layouts: plan.layouts, zooms: plan.zooms, startMs, cameraOffsetMs: offsetMs, ringColor: plan.ringColor,
      pointer: plan.pointer.states ? { states: plan.pointer.states, ...plan.pointerSize } : null,
      picture: plan.picture ? plan.picture.dataUrl : null, frames, screenSize: { w: source.w, h: source.h }, cameraSize: camera ? cameraSize : null,
    };
    await Promise.race([win.webContents.executeJavaScript(`window.runExport(${JSON.stringify(page)})`), gone]);
    await writer.end();
    if (onProgress) onProgress(1);
  } catch (err) {
    writer.stop();
    throw err;
  } finally {
    sessions.delete(win.webContents.id);
    screen.stop();
    if (camera) camera.stop();
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { renderFrames };
