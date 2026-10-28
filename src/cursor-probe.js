// Cursor probe, run with DR_PROBE=cursor or with "drec doctor --probe-cursor on". It answers one question for this PC:
// can the screen and a single window be captured WITHOUT the system cursor?
// It shows a solid-colour window, keeps the real cursor moving in the middle of it, captures a frame
// with the cursor allowed (the control: it must show) and in several ways of refusing it, and
// counts pixels that are not the solid colour around the cursor. Prints one "PROBE {...}" line.
// Window capture only draws the cursor while it moves, which is why the cursor is wiggled.
const { BrowserWindow, desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const COLOR = { r: 30, g: 144, b: 255 };
const TITLE = 'dr-cursor-probe';
const SEEN = 20; // pixels that differ from the solid colour before we call it a cursor
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Moves the real cursor in a small circle around a physical screen position for a while. The
// helper marks itself DPI aware first, so the numbers are the real pixels Electron's
// screen.dipToScreenRect gives. Resolves when the helper has started moving.
function wiggle(x, y, ms) {
  const script = `Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' -Name W -Namespace N; [N.W]::SetProcessDPIAware() | Out-Null; Write-Host ready; $end = (Get-Date).AddMilliseconds(${ms}); $i = 0; while ((Get-Date) -lt $end) { $i++; [N.W]::SetCursorPos([int](${Math.round(x)} + 6 * [math]::Cos($i / 2)), [int](${Math.round(y)} + 6 * [math]::Sin($i / 2))) | Out-Null; Start-Sleep -Milliseconds 20 }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const ready = new Promise((resolve) => { child.stdout.on('data', () => resolve()); child.on('close', resolve); });
  const done = new Promise((resolve) => child.on('close', resolve));
  return ready.then(() => ({ done }));
}

// Runs in the hidden page: one capture with the given way of asking, then counts the pixels near
// the middle of the frame that differ from the solid colour.
const GRAB = (call, color) => `(async () => {
  const stream = await ${call};
  const track = stream.getVideoTracks()[0];
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  await new Promise((r) => setTimeout(r, 400));
  const w = video.videoWidth;
  const h = video.videoHeight;
  const size = 80;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let best = 0;
  for (let n = 0; n < 20; n++) {
    ctx.drawImage(video, Math.round(w / 2 - size / 2), Math.round(h / 2 - size / 2), size, size, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    let odd = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i] - ${color.r}) > 24 || Math.abs(px[i + 1] - ${color.g}) > 24 || Math.abs(px[i + 2] - ${color.b}) > 24) odd++;
    }
    best = Math.max(best, odd);
    await new Promise((r) => setTimeout(r, 50));
  }
  const settings = track.getSettings();
  stream.getTracks().forEach((t) => t.stop());
  return { frame: w + 'x' + h, cursorSetting: settings.cursor || null, oddPixels: best };
})()`;

const display = (extra) => `navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30, ${extra} } })`;
// The ways of asking. "always" is the control; the others try to refuse the cursor.
const VARIANTS = (sourceId) => ({
  always: display("cursor: 'always'"),
  never: display("cursor: 'never'"),
  neverExact: display("cursor: { exact: 'never' }"),
  legacy: `navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)} } } })`,
});

async function measureAll(page, centre, sourceId) {
  const out = {};
  for (const [name, call] of Object.entries(VARIANTS(sourceId))) {
    const mover = await wiggle(centre.x, centre.y, 2500);
    try {
      out[name] = await page.webContents.executeJavaScript(GRAB(call, COLOR));
    } catch (err) {
      out[name] = { error: err.message };
    }
    await mover.done;
  }
  return out;
}

// no-cursor-in-video: even the control shows no cursor, so this kind of capture never has one.
// works: the control shows a cursor and some way of refusing it removes it.
// cursor-stays: the control shows a cursor and every way of refusing it keeps it.
function verdict(r) {
  if (!r.always || r.always.error) return 'error';
  if (r.always.oddPixels < SEEN) return 'no-cursor-in-video';
  const refusals = ['never', 'neverExact', 'legacy'].filter((k) => r[k] && !r[k].error && r[k].oddPixels < SEEN);
  return refusals.length ? 'works' : 'cursor-stays';
}

// What drec doctor says for each verdict.
const PHRASE = {
  works: 'can hide the cursor',
  'cursor-stays': 'keeps the system cursor in the video',
  'no-cursor-in-video': 'has no cursor in the video',
  error: 'could not be tested',
};
const describe = (v) => PHRASE[v] || 'could not be tested';

// Takes over the first screen for about 30 seconds and moves the mouse. It changes capture.sourceId,
// so a caller that is in the middle of something should save and restore it.
async function probe({ capture }) {
  const primary = screen.getPrimaryDisplay();
  const solid = (bounds) => {
    const win = new BrowserWindow({
      ...bounds, title: TITLE, frame: false, resizable: false, skipTaskbar: true, show: false, alwaysOnTop: true,
      backgroundColor: `rgb(${COLOR.r},${COLOR.g},${COLOR.b})`, webPreferences: { backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadURL('data:text/html,<body style="margin:0;background:rgb(30,144,255);cursor:default"></body>');
    return win;
  };
  // A real file, not a data: URL, because only secure pages get getDisplayMedia.
  const page = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await page.loadFile(path.join(__dirname, 'cursor-probe.html'));
  const centreOf = (rectDip) => {
    const p = screen.dipToScreenRect(null, rectDip);
    return { x: p.x + p.width / 2, y: p.y + p.height / 2 };
  };
  capture.systemAudio = false;
  const result = { screen: {}, window: {} };

  // Screen: a full-screen solid window on the primary display.
  const full = solid(primary.bounds);
  full.show();
  await wait(1200);
  const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  capture.sourceId = (screens.find((s) => String(s.display_id) === String(primary.id)) || screens[0]).id;
  result.screen = await measureAll(page, centreOf(primary.bounds), capture.sourceId);
  full.destroy();

  // Window: a 900x600 solid window in the middle of the primary display.
  const pb = primary.bounds;
  const small = solid({ x: Math.round(pb.x + pb.width / 2 - 450), y: Math.round(pb.y + pb.height / 2 - 300), width: 900, height: 600 });
  small.show();
  await wait(1200);
  const windows = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
  const target = windows.find((s) => s.name === TITLE);
  if (target) {
    capture.sourceId = target.id;
    result.window = await measureAll(page, centreOf(small.getBounds()), target.id);
  } else {
    result.window = { error: 'the probe window was not listed as a capture source' };
  }
  small.destroy();
  page.destroy();

  result.verdict = { screen: verdict(result.screen), window: verdict(result.window) };
  return result;
}

// DR_PROBE=cursor: run once, print the measurements and quit.
async function run({ app, capture, log }) {
  log('PROBE ' + JSON.stringify(await probe({ capture })));
  app.quit();
}

module.exports = { probe, run, verdict, describe, wiggle };
