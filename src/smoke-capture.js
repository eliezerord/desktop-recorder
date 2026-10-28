// Smoke test for the Capture (the Project a recording leaves). It records a screen and a
// window with the real app and the real drec CLI, then looks at what was saved: the Project folder,
// the event record, the camera file, the plain MP4, and that the camera Bubble is not in that MP4.
// DR_SMOKE=capture runs only this; the full smoke test (DR_SMOKE=1) runs it as its last step.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { BrowserWindow, screen } = require('electron');
const { ffmpegPath } = require('./convert');
const { wiggle } = require('./cursor-probe');
const { makeCli } = require('./smoke-cli');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BLUE = { r: 30, g: 144, b: 255 };

// ffmpeg -i lists the streams on stderr and then complains that there is no output; that is fine.
const info = (file) => new Promise((resolve) => {
  execFile(ffmpegPath, ['-hide_banner', '-i', file], { windowsHide: true }, (_e, _out, err) => resolve(String(err)));
});
const durationOf = (text) => {
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};
const sizeOf = (text) => {
  const m = /Video: .*?\b(\d{3,5})x(\d{3,5})\b/.exec(text);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
};

// Share of pixels in a box of one video frame that are not the solid blue.
function offBlueShare(file, atSec, box) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file,
      '-vf', `crop=${box.width}:${box.height}:${box.x}:${box.y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
    execFile(ffmpegPath, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, windowsHide: true }, (err, out) => {
      if (err || !out.length) { resolve(null); return; }
      let off = 0;
      for (let i = 0; i + 2 < out.length; i += 3) {
        if (Math.abs(out[i] - BLUE.r) > 30 || Math.abs(out[i + 1] - BLUE.g) > 30 || Math.abs(out[i + 2] - BLUE.b) > 30) off++;
      }
      resolve(off / (out.length / 3));
    });
  });
}

// A small grey picture of one moment of a video, to compare moments with each other.
function greyFrame(file, atSec, vf = 'scale=192:108') {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file, '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true }, (err, out) => resolve(err || out.length !== 192 * 108 ? null : out));
  });
}
// The same box of two videos at one moment, as grey bytes, so a small change inside it can be measured.
function boxFrame(file, atSec, box) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file, '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024, windowsHide: true }, (err, out) => resolve(err || out.length !== box.w * box.h ? null : out));
  });
}
const meanDiff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };

// The colour of one pixel of a video at one moment, as [r, g, b].
function pixelOf(file, atSec, x, y) {
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file, '-vf', `crop=4:4:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], // 4x4: a 1x1 crop gives no frame in this format
      { encoding: 'buffer', windowsHide: true }, (err, out) => resolve(err || out.length < 3 ? null : [out[0], out[1], out[2]]));
  });
}
const sameObject = (a, b) => JSON.stringify(a, Object.keys(a || {}).sort()) === JSON.stringify(b, Object.keys(b).sort());
const close = (c, want, tol = 40) => Boolean(c) && c.every((v, i) => Math.abs(v - want[i]) <= tol);
const makePicture = (file, colour) => new Promise((resolve) => execFile(ffmpegPath, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${colour}:s=64x64:d=1`, '-frames:v', '1', file], { windowsHide: true }, resolve));

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sorted = (list) => list.every((v, i) => i === 0 || v >= list[i - 1]);

async function steps({ app, bubble, clickOverlay, listWindows, log }) {
  const cli = makeCli(app);
  const checks = {};

  // ---- Screen: three clicks and a moving mouse over a solid blue window that sits under the Bubble.
  await cli(['set', '--mode', 'screen', '--screen', '1', '--bubble', 'small', '--clicks', 'off', '--system-audio', 'off']);
  await wait(600);
  const bubbleBounds = bubble.snapshot().bounds;
  const display = screen.getDisplayMatching(bubbleBounds); // the Bubble follows the recorded screen
  const phys = screen.dipToScreenRect(null, display.bounds);
  const blue = new BrowserWindow({ ...display.bounds, frame: false, show: false, skipTaskbar: true, focusable: false, backgroundColor: '#1e90ff' });
  blue.setAlwaysOnTop(true, 'floating'); // under the Bubble, which sits at pop-up-menu
  // Eight vertical stripes, the first one blue where the Bubble sits, so a Zoom changes what the video shows. No yellow:
  // the click circles are yellow and would not show on it.
  const stripes = ['#1e90ff', '#ff6a1f', '#00c853', '#6d4c41', '#d500f9', '#00e5ff', '#ff1744', '#ffffff'].map((c, i) => `${c} ${i * 12.5}% ${(i + 1) * 12.5}%`).join(',');
  blue.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:linear-gradient(90deg,${stripes})"></body>`)}`);
  blue.showInactive();
  await wait(800);

  const started = await cli(['start']);
  const mid = { x: phys.x + phys.width / 2, y: phys.y + phys.height / 2 };
  const mover = await wiggle(mid.x, mid.y, 4500);
  for (const [dx, dy] of [[-200, -100], [0, 0], [200, 100]]) {
    clickOverlay.simulateClick(Math.round(mid.x + dx), Math.round(mid.y + dy));
    await wait(900);
  }
  await mover.done;
  const stopped = await cli(['stop']);
  const status = (await cli(['status'])).data || {};
  blue.destroy();

  const dir = status.lastProject;
  const plain = stopped.data && stopped.data.file;
  const events = dir && readJson(path.join(dir, 'events.json'));
  const project = dir && readJson(path.join(dir, 'project.json'));
  const screenMp4 = dir && path.join(dir, 'screen.mp4');
  const video = screenMp4 && fs.existsSync(screenMp4) ? await info(screenMp4) : '';
  const seconds = durationOf(video);
  const cameraFile = dir && path.join(dir, 'camera.webm');
  const cameraText = cameraFile && fs.existsSync(cameraFile) ? await info(cameraFile) : '';
  const clicks = (events && events.clicks) || [];
  const cursor = (events && events.cursor) || [];

  Object.assign(checks, {
    'capture: recording started and stopped': started.code === 0 && stopped.code === 0 && Boolean(plain),
    'capture: Project folder with all files': Boolean(dir) && ['project.json', 'events.json', 'screen.mp4', 'camera.webm'].every((f) => fs.existsSync(path.join(dir, f))),
    'capture: plain MP4 is the Project screen video': Boolean(plain) && fs.existsSync(plain) && Boolean(screenMp4) && fs.existsSync(screenMp4) && fs.statSync(plain).size === fs.statSync(screenMp4).size,
    'capture: screen video is H.264 and longer than 3 s': Boolean(video) && /Video: h264/.test(video) && seconds > 3,
    'capture: three clicks recorded in order': clicks.length === 3 && sorted(clicks.map((c) => c.t)) && clicks[0].t >= 0,
    'capture: clicks fall inside the video': seconds !== null && clicks.length > 0 && clicks[clicks.length - 1].t / 1000 <= seconds + 0.5,
    'capture: cursor path recorded': cursor.length >= 10 && sorted(cursor.map((c) => c[0])),
    'capture: Project describes a screen capture': Boolean(project) && project.mode === 'screen' && project.cursorInVideo === true && project.camera && project.camera.file === 'camera.webm',
    'capture: camera saved apart': fs.existsSync(cameraFile || '') && /Video: /.test(cameraText),
  });

  // The Bubble covers part of the blue window; it must not show in the plain MP4.
  const box = {
    x: Math.max(0, Math.round(screen.dipToScreenRect(null, bubbleBounds).x - phys.x)),
    y: Math.max(0, Math.round(screen.dipToScreenRect(null, bubbleBounds).y - phys.y)),
    width: Math.round(screen.dipToScreenRect(null, bubbleBounds).width),
    height: Math.round(screen.dipToScreenRect(null, bubbleBounds).height),
  };
  const dims = sizeOf(video);
  const off = dims && dims.width === phys.width && dims.height === phys.height ? await offBlueShare(plain, 1.5, box) : null;
  checks['capture: Bubble is not in the plain MP4'] = off !== null && off < 0.02;
  log(`capture: bubble box ${JSON.stringify(box)} video ${JSON.stringify(dims)} display ${phys.width}x${phys.height} off-blue ${off}`);

  // ---- Export through drec: list the Project, export it, refuse a wrong Project or look.
  const listed = await cli(['projects']);
  const projectName = dir ? path.basename(dir) : '';
  const exported = await cli(['export', projectName, '--background', 'sunset']);
  const styled = exported.data && exported.data.file;
  const styledInfo = styled && fs.existsSync(styled) ? await info(styled) : '';
  const noProject = await cli(['export', 'no-such-project']);
  const badLook = await cli(['export', projectName, '--background', 'nope']);
  Object.assign(checks, {
    'export: drec projects lists the new Project': listed.code === 0 && Array.isArray(listed.data) && listed.data.some((p) => p.name === projectName && p.mode === 'screen'),
    'export: drec export writes a styled 1920x1080 MP4': exported.code === 0 && /Video: h264.*1920x1080/.test(styledInfo) && Math.abs(durationOf(styledInfo) - seconds) < 0.5,
    'export: it is a new file next to the plain MP4': Boolean(styled) && styled !== plain && path.dirname(styled) === path.dirname(plain),
    'export: an unknown Project is refused': noProject.code === 1 && /No Project matches/.test(noProject.err),
    'export: a wrong background is refused and listed': badLook.code === 1 && /background.*ocean/s.test(badLook.err),
  });
  if (exported.code !== 0) log(`export: ${exported.err}`);

  // ---- Zoom on a real capture: the clicks became a Zoom list, and the video moves with it.
  const { ZOOM } = await import(pathToFileURL(path.join(__dirname, 'zoom.mjs')).href);
  const stored = (readJson(path.join(dir || '', 'project.json')) || {}).zoom || {};
  const zooms = stored.zooms || [];
  const exportedOff = await cli(['export', projectName, '--zoom', 'off']);
  const plainStyled = exportedOff.data && exportedOff.data.file;
  const hold = zooms.length ? (clicks[0].t + 400) / 1000 : 2;
  const [onHold, offHold, offEarly] = plainStyled && styled ? await Promise.all([greyFrame(styled, hold), greyFrame(plainStyled, hold), greyFrame(plainStyled, 0.05)]) : [null, null, null];
  const zoomedLooksDifferent = onHold && offHold && meanDiff(onHold, offHold) > 8;
  const staticWithoutZoom = offHold && offEarly && meanDiff(offHold, offEarly) < 3;
  Object.assign(checks, {
    'zoom: the clicks became a stored Zoom list': zooms.length >= 1 && stored.enabled === true && zooms[0].start === Math.max(0, clicks[0].t - ZOOM.lead) && zooms.every((z) => z.end > z.start && z.x >= 0 && z.x <= 1 && z.y >= 0 && z.y <= 1),
    'zoom: --zoom off exports too': exportedOff.code === 0 && Boolean(plainStyled) && plainStyled !== styled,
    'zoom: the video is zoomed at a click and not with --zoom off': Boolean(zoomedLooksDifferent),
    'zoom: without Zoom the picture stays put': Boolean(staticWithoutZoom),
  });

  // ---- Click circles on a real capture: the clicks are drawn on the screen, and a screen keeps its real cursor.
  // The circles are where the first click was, a moment after it; with --clicks off the same spot is plain.
  const { layout } = await import(pathToFileURL(path.join(__dirname, 'look.mjs')).href);
  const lay = layout({ canvas: { w: 1920, h: 1080 }, source: { w: 1920, h: 1080 }, hasCamera: true, bubbleSize: 'small', look: { bubblePlace: 'outside', bubbleCorner: 'bottom-left' } });
  const exportedBare = await cli(['export', projectName, '--zoom', 'off', '--clicks', 'off']);
  const bareFile = exportedBare.data && exportedBare.data.file;
  const firstClick = clicks[0] || { t: 0, x: 0, y: 0 };
  const circleBox = { w: 100, h: 100, x: Math.round(lay.card.x + (firstClick.x / phys.width) * lay.card.w - 50), y: Math.round(lay.card.y + (firstClick.y / phys.height) * lay.card.h - 50) };
  const [withCircle, withoutCircle] = plainStyled && bareFile ? await Promise.all([boxFrame(plainStyled, (firstClick.t + 120) / 1000, circleBox), boxFrame(bareFile, (firstClick.t + 120) / 1000, circleBox)]) : [null, null];
  Object.assign(checks, {
    'pointer: a screen capture keeps its real cursor and gets click circles': exportedOff.code === 0 && exportedOff.data.pointer.cursor === 'real' && exportedOff.data.pointer.clicks === clicks.length,
    'pointer: --clicks off removes them': exportedBare.code === 0 && exportedBare.data.pointer.clicks === 0 && exportedBare.data.pointer.cursor === 'real',
    'pointer: a circle shows around the click and not without it': Boolean(withCircle && withoutCircle) && meanDiff(withCircle, withoutCircle) > 1, // the circle covers a few hundred of the box's 10000 pixels; two identical exports differ by exactly 0
    'pointer: the Project says the circles are not in the video': project.clicksInVideo === false && project.cursorInVideo === true,
  });
  // ---- Vertical and trimmed, through drec: 1080x1920, the part between 1 s and 3 s, and the trim kept in the Project.
  const exportedTall = await cli(['export', projectName, '--aspect', '9:16', '--trim-start', '1', '--trim-end', '3']);
  const tallFile = exportedTall.data && exportedTall.data.file;
  const tallInfo = tallFile && fs.existsSync(tallFile) ? await info(tallFile) : '';
  const keptTrim = (readJson(path.join(dir || '', 'project.json')) || {}).trim;
  const tallAgain = await cli(['export', projectName, '--aspect', '9:16']); // no trim given: the saved one is used
  const tallAgainInfo = tallAgain.data && tallAgain.data.file && fs.existsSync(tallAgain.data.file) ? await info(tallAgain.data.file) : '';
  const cleared = await cli(['export', projectName, '--trim-start', '0', '--trim-end', 'end', '--zoom', 'off', '--clicks', 'off']);
  const clearedInfo = cleared.data && cleared.data.file && fs.existsSync(cleared.data.file) ? await info(cleared.data.file) : '';
  const badAspect = await cli(['export', projectName, '--aspect', '4:3']);
  const badTrim = await cli(['export', projectName, '--trim-start', '99']);
  Object.assign(checks, {
    'trim: drec export --aspect 9:16 makes 1080x1920': exportedTall.code === 0 && /Video: h264.*1080x1920/.test(tallInfo),
    'trim: --trim-start and --trim-end cut it to the 2 s asked': Math.abs(durationOf(tallInfo) - 2) < 0.3 && exportedTall.data.trim.start === 1000 && exportedTall.data.trim.end === 3000,
    'trim: the trim is kept in the Project and the next export uses it': keptTrim && keptTrim.start === 1000 && keptTrim.end === 3000 && Math.abs(durationOf(tallAgainInfo) - 2) < 0.3,
    'trim: --trim-start 0 --trim-end end brings the whole recording back': cleared.code === 0 && Math.abs(durationOf(clearedInfo) - seconds) < 0.5,
    'trim: a wrong aspect or a trim past the end is refused': badAspect.code === 1 && /16:9 or 9:16/.test(badAspect.err) && badTrim.code === 1 && /past the end/.test(badTrim.err),
  });
  // ---- The default look through drec: saved with drec set, used by drec export, overridden on purpose,
  // and a picture of your own (kept in the Project, or in the app's folder when it is the default).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-look-'));
  const magentaPng = path.join(scratch, 'magenta.png');
  const orangePng = path.join(scratch, 'orange.png');
  const notAPicture = path.join(scratch, 'notes.png');
  await makePicture(magentaPng, '0xff00ff');
  await makePicture(orangePng, '0xff8000');
  fs.writeFileSync(notAPicture, 'this is not a picture');
  await cli(['set', '--look-reset', 'on']);
  const setLook = await cli(['set', '--look-background', 'rose', '--look-aspect', '9:16', '--look-zoom', 'off', '--look-margin', '8']);
  const afterSet = (await cli(['status'])).data || {};
  const asDefault = await cli(['export', projectName]);
  const asDefaultInfo = asDefault.data && fs.existsSync(asDefault.data.file) ? await info(asDefault.data.file) : '';
  const overridden = await cli(['export', projectName, '--background', 'sunset', '--aspect', '16:9', '--zoom', 'on']);
  const overriddenInfo = overridden.data && fs.existsSync(overridden.data.file) ? await info(overridden.data.file) : '';
  const wrongLook = await cli(['set', '--look-aspect', '4:3']);
  const afterWrong = (await cli(['status'])).data || {};
  Object.assign(checks, {
    'look: drec set saves a default look and status shows it': setLook.code === 0 && sameObject(afterSet.exportLook, { background: 'rose', aspect: '9:16', zoom: false, margin: 8 }),
    'look: drec export uses it when nothing is said': asDefault.code === 0 && asDefault.data.look.background === 'rose' && asDefault.data.look.aspect === '9:16' && asDefault.data.look.margin === 8 && asDefault.data.zooms === 0 && /Video: h264.*1080x1920/.test(asDefaultInfo),
    'look: what is asked on the export wins, the rest stays default': overridden.code === 0 && overridden.data.look.background === 'sunset' && overridden.data.look.aspect === '16:9' && overridden.data.look.margin === 8 && /Video: h264.*1920x1080/.test(overriddenInfo),
    'look: a wrong value is refused and nothing is saved': wrongLook.code === 1 && /16:9 or 9:16/.test(wrongLook.err) && afterWrong.exportLook.aspect === '9:16',
  });

  // A picture in the default look: kept in the app's folder, so the original can go.
  const setPicture = await cli(['set', '--look-background-image', magentaPng]);
  fs.rmSync(magentaPng);
  const withDefaultPicture = await cli(['export', projectName, '--aspect', '16:9']);
  const defaultCorner = withDefaultPicture.data ? await pixelOf(withDefaultPicture.data.file, 0.3, 3, 3) : null;
  // A picture given on an export: copied into the Project, used again by its next exports (even over the default),
  // and taken out with none, which brings the default back.
  const givenNow = await cli(['export', projectName, '--aspect', '16:9', '--background-image', orangePng]);
  const kept = readJson(path.join(dir || '', 'project.json')) || {};
  const copyInProject = fs.existsSync(path.join(dir || '', 'background.png')); // measured now: a later "none" takes it out
  fs.rmSync(orangePng);
  const givenCorner = givenNow.data ? await pixelOf(givenNow.data.file, 0.3, 3, 3) : null;
  const again = await cli(['export', projectName, '--aspect', '16:9']);
  const againCorner = again.data ? await pixelOf(again.data.file, 0.3, 3, 3) : null;
  const onPurpose = await cli(['export', projectName, '--aspect', '16:9', '--background', 'sunset']);
  const onPurposeCorner = onPurpose.data ? await pixelOf(onPurpose.data.file, 0.3, 3, 3) : null;
  const taken = await cli(['export', projectName, '--aspect', '16:9', '--background-image', 'none']);
  const takenCorner = taken.data ? await pixelOf(taken.data.file, 0.3, 3, 3) : null;
  const afterTake = readJson(path.join(dir || '', 'project.json')) || {};
  Object.assign(checks, {
    'look: a default picture fills the Background, and the original can be deleted': setPicture.code === 0 && withDefaultPicture.code === 0 && withDefaultPicture.data.picture === 'default' && close(defaultCorner, [255, 0, 255]),
    'look: a picture given on an export is copied into the Project': givenNow.code === 0 && givenNow.data.picture === 'new' && close(givenCorner, [255, 128, 0], 60) && kept.backgroundImage === 'background.png' && copyInProject,
    'look: the Project keeps it, even over the default and with the original gone': again.code === 0 && again.data.picture === 'project' && close(againCorner, [255, 128, 0], 60),
    'look: a built-in Background chosen on purpose wins for that export': onPurpose.code === 0 && onPurpose.data.picture === null && Boolean(onPurposeCorner) && !close(onPurposeCorner, [255, 128, 0], 60) && !close(onPurposeCorner, [255, 0, 255]),
    'look: "none" takes the picture out of the Project and the default comes back': taken.code === 0 && taken.data.picture === 'default' && close(takenCorner, [255, 0, 255]) && afterTake.backgroundImage === undefined && !fs.existsSync(path.join(dir || '', 'background.png')),
  });

  // A picture that cannot be used: a clear error, nothing is made and nothing is saved.
  const styledCount = () => fs.readdirSync(path.dirname(plain)).filter((n) => n.includes('styled')).length;
  const before = styledCount();
  const wrongPicture = await cli(['export', projectName, '--background-image', notAPicture]);
  const missingPicture = await cli(['export', projectName, '--background-image', path.join(scratch, 'nope.png')]);
  const wrongDefault = await cli(['set', '--look-background-image', notAPicture]);
  const afterBad = (await cli(['status'])).data || {};
  Object.assign(checks, {
    'look: a file that is not a picture is refused and no video is started': wrongPicture.code === 1 && /not a PNG, JPEG or WebP/.test(wrongPicture.err) && missingPicture.code === 1 && /does not exist/.test(missingPicture.err) && styledCount() === before,
    'look: a default picture that cannot be used is refused and the default stays': wrongDefault.code === 1 && /not a PNG, JPEG or WebP/.test(wrongDefault.err) && Boolean(afterBad.exportLook.backgroundImage),
  });
  // ---- Camera shape (layouts ticket 09): a default through drec set, overridden on one export; the corner of the
  // Bubble's square shows the camera only when it is rounded.
  const shapeSet = await cli(['set', '--look-bubble-shape', 'rounded']);
  const shapeStatus = ((await cli(['status'])).data || {}).exportLook || {};
  const sameLook = ['--aspect', '16:9', '--background', 'ocean', '--bubble-place', 'outside', '--bubble-corner', 'bottom-left', '--zoom', 'off', '--clicks', 'off'];
  const asRounded = await cli(['export', projectName, ...sameLook]);
  const asCircle = await cli(['export', projectName, ...sameLook, '--bubble-shape', 'circle']);
  const badShape = await cli(['export', projectName, '--bubble-shape', 'square']);
  const badDefaultShape = await cli(['set', '--look-bubble-shape', 'oval']);
  const cornerBox = { x: lay.bubble.x, y: lay.bubble.y, w: Math.round(lay.bubble.d * 0.25), h: Math.round(lay.bubble.d * 0.25) };
  const [roundedCorner, circleCorner] = asRounded.data && asCircle.data ? await Promise.all([boxFrame(asRounded.data.file, 1.5, cornerBox), boxFrame(asCircle.data.file, 1.5, cornerBox)]) : [null, null];
  Object.assign(checks, {
    'shape: drec set --look-bubble-shape saves it and drec export uses it': shapeSet.code === 0 && shapeStatus.bubbleShape === 'rounded' && asRounded.code === 0 && asRounded.data.look.bubbleShape === 'rounded',
    'shape: --bubble-shape on an export wins, and the corner of the Bubble differs': asCircle.code === 0 && asCircle.data.look.bubbleShape === 'circle' && Boolean(roundedCorner && circleCorner) && meanDiff(roundedCorner, circleCorner) > 1, // two identical exports differ by exactly 0; a dark real camera on a dark Background differs by about 2
    'shape: a wrong shape is refused and says which work': badShape.code === 1 && /bubble-shape: use circle or rounded/.test(badShape.err) && badDefaultShape.code === 1 && /bubble-shape: use circle or rounded/.test(badDefaultShape.err),
  });
  log(`shape: rounded vs circle corner ${roundedCorner && circleCorner ? meanDiff(roundedCorner, circleCorner).toFixed(1) : 'n/a'}`);

  const reset = await cli(['set', '--look-reset', 'on']);
  const afterReset = (await cli(['status'])).data || {};
  checks['look: --look-reset forgets the default look'] = reset.code === 0 && Object.keys(afterReset.exportLook).length === 0;

  // ---- The Editor (ticket 09): only on request; its changes are the Project's look, which drec uses.
  const editorWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && /editor\.html$/.test(w.webContents.getURL()));
  const noneBefore = editorWindows().length === 0; // several recordings have finished by now
  const opened = await cli(['edit', projectName]);
  let edWin = null;
  for (let i = 0; i < 40 && !(edWin = editorWindows()[0]); i++) await wait(250);
  let edLook = null;
  let edExport = null;
  if (edWin) {
    await edWin.webContents.executeJavaScript('window.editor.ready');
    edLook = await edWin.webContents.executeJavaScript(`window.editor.set({ margin: 7, cardCorners: 3, background: 'forest' }).then((p) => p.look)`);
    edExport = await edWin.webContents.executeJavaScript('window.api.editorExport().then((d) => d, (e) => ({ error: e.message }))');
  }
  const listedLook = (((await cli(['projects'])).data || []).find((p) => p.name === projectName) || {}).look || {};
  const viaDrec = await cli(['export', projectName]);
  const edBox = { x: 640, y: 360, w: 640, h: 360 };
  const [edFrame, drecFrame] = edExport && edExport.file && viaDrec.data
    ? await Promise.all([boxFrame(edExport.file, 1, edBox), boxFrame(viaDrec.data.file, 1, edBox)]) : [null, null];
  const sameFrames = edFrame && drecFrame ? meanDiff(edFrame, drecFrame) : null;
  Object.assign(checks, {
    'editor: never opens on its own after a recording': noneBefore,
    'editor: drec edit opens it on the Project': opened.code === 0 && Boolean(edWin) && opened.data.project === projectName,
    'editor: a change is saved in the Project and drec projects shows it': Boolean(edLook) && edLook.margin === 7 && listedLook.margin === 7 && listedLook.cardCorners === 3 && listedLook.background === 'forest',
    'editor: drec export uses the Project\'s look': viaDrec.code === 0 && viaDrec.data.look.margin === 7 && viaDrec.data.look.cardCorners === 3 && viaDrec.data.look.background === 'forest',
    'editor: its Export makes the same video as drec export': Boolean(edExport && edExport.file) && sameFrames !== null && sameFrames < 1,
  });
  log(`editor: ${JSON.stringify({ opened: opened.data || opened.err, look: listedLook, export: edExport, sameFrames })}`);
  if (edWin) edWin.destroy();
  if (dir) { // leave the Project's look as it was for the checks after this
    const p = readJson(path.join(dir, 'project.json'));
    delete p.exportLook;
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2));
  }
  fs.rmSync(scratch, { recursive: true, force: true });

  // ---- Zoom commands (ticket 12): list, add, change strength and delete through drec, on the same list the
  // Editor uses. Then every Zoom from the clicks goes and one is added away from them: an export is zoomed
  // there and not at the click any more.
  const zoomsIn = (d) => ((readJson(path.join(d || '', 'project.json')) || {}).zoom || {}).zooms || [];
  const zList = await cli(['zooms', projectName]);
  const listedZooms = (zList.data && zList.data.zooms) || [];
  const fromClicks = zoomsIn(dir);
  const recordedMs = Math.round(seconds * 1000);
  const clickAt = clicks[0] ? clicks[0].t : 0;
  const addAt = clickAt < recordedMs / 2 ? Math.max(clickAt + 1800, recordedMs - 1600) : 200; // away from the click's Zoom
  const added = await cli(['zoom-add', projectName, '--at', String(addAt / 1000), '--length', '1.2', '--strength', '2.2', '--aim', '0.25,0.75']);
  const afterAdd = zoomsIn(dir);
  const strengthened = await cli(['zoom-strength', projectName, '1', '2.5']);
  const afterStrength = zoomsIn(dir);
  const zBadNumber = await cli(['zoom-delete', projectName, '99']);
  const zNoNumber = await cli(['zoom-delete', projectName]);
  const zBadStrength = await cli(['zoom-strength', projectName, '1', '9']);
  const zNoProject = await cli(['zooms', 'no-such-project']);
  const addedNumber = added.data && added.data.edited;
  // Delete every Zoom but the added one, from the last number down so the numbers stay right.
  for (let n = afterAdd.length; n >= 1; n--) if (n !== addedNumber) await cli(['zoom-delete', projectName, String(n)]);
  const onlyAdded = zoomsIn(dir);
  const zOn = await cli(['export', projectName, '--aspect', '16:9', '--zoom', 'on']);
  const zOff = await cli(['export', projectName, '--aspect', '16:9', '--zoom', 'off']);
  const midAdded = (addAt + 600) / 1000;
  const atClick = (clickAt + 400) / 1000;
  const [onAdded, offAdded, onClick, offClick] = zOn.data && zOff.data
    ? await Promise.all([greyFrame(zOn.data.file, midAdded), greyFrame(zOff.data.file, midAdded), greyFrame(zOn.data.file, atClick), greyFrame(zOff.data.file, atClick)]) : [];
  Object.assign(checks, {
    'zoom commands: drec zooms lists the Project\'s Zooms with number, time, length and strength': zList.code === 0 && listedZooms.length === fromClicks.length && listedZooms.length >= 1
      && listedZooms.every((z, i) => z.number === i + 1 && z.startSec === Math.round(fromClicks[i].start / 100) / 10 && z.lengthSec > 0 && z.strength === fromClicks[i].strength) && zList.data.zoomOn === true,
    'zoom commands: zoom-add adds one where it was asked': added.code === 0 && afterAdd.length === fromClicks.length + 1 && afterAdd.some((z) => z.start === addAt && z.end === addAt + 1200 && z.strength === 2.2 && z.x === 0.25 && z.y === 0.75),
    'zoom commands: zoom-strength changes one': strengthened.code === 0 && afterStrength[0].strength === 2.5,
    'zoom commands: wrong numbers, strengths and Projects are refused and say what to fix': zBadNumber.code === 1 && /Zoom 99 does not exist: use a number from 1 to \d+/.test(zBadNumber.err)
      && zNoNumber.code === 1 && /zoom-delete needs the Zoom's number/.test(zNoNumber.err) && zBadStrength.code === 1 && /strength: use a number from 1\.1 to 3/.test(zBadStrength.err)
      && zNoProject.code === 1 && /No Project matches/.test(zNoProject.err),
    'zoom commands: zoom-delete removes them, and drec export uses the edited list': onlyAdded.length === 1 && onlyAdded[0].start === addAt && zOn.code === 0 && zOn.data.zooms === 1
      && Boolean(onAdded && offAdded && onClick && offClick) && meanDiff(onAdded, offAdded) > 8 && meanDiff(onClick, offClick) < 3,
  });
  log(`zoom commands: listed ${listedZooms.length}, added ${JSON.stringify(added.data ? added.data.edited : added.err)}, on/off at the added Zoom ${onAdded && offAdded ? meanDiff(onAdded, offAdded).toFixed(1) : 'n/a'}, at the old click ${onClick && offClick ? meanDiff(onClick, offClick).toFixed(1) : 'n/a'}`);

  // ---- Layouts (layouts ticket 02): the video starts Full screen and eases into the Card at 1.5 s, set through
  // drec. While Full screen the styled video looks like the plain recording; once in the Card it does not.
  const lDefault = await cli(['layouts', projectName]);
  const lStart = await cli(['layout-add', projectName, '--at', '0', '--kind', 'screen']);
  const lCard = await cli(['layout-add', projectName, '--at', '1.5', '--kind', 'card']);
  const lBad = await cli(['layout-add', projectName, '--at', '1.6', '--kind', 'pip']);
  const lSaved = (readJson(path.join(dir || '', 'project.json')) || {}).layouts;
  const lExport = await cli(['export', projectName, '--aspect', '16:9', '--zoom', 'off', '--clicks', 'off']);
  const [lFull, lPlainFull, lInCard, lPlainCard] = lExport.data
    ? await Promise.all([greyFrame(lExport.data.file, 0.5), greyFrame(plain, 0.5), greyFrame(lExport.data.file, 2.5), greyFrame(plain, 2.5)]) : [];
  Object.assign(checks, {
    'layouts: drec layouts lists one Card point until one is added': lDefault.code === 0 && lDefault.data.layouts.length === 1 && lDefault.data.layouts[0].kind === 'card',
    'layouts: drec layout-add sets the start and adds a point, saved in the Project': lStart.code === 0 && lCard.code === 0 && lCard.data.edited === 2
      && JSON.stringify(lSaved) === JSON.stringify({ version: 1, points: [{ at: 0, kind: 'screen' }, { at: 1500, kind: 'card' }] }),
    'layouts: a Layout that does not exist yet is refused and says which do': lBad.code === 1 && /kind: use card, screen, camera or split/.test(lBad.err),
    'layouts: the export is drawn frame by frame, Full screen first, then the Card': lExport.code === 0 && lExport.data.drawn === 'frames'
      // Full screen is close to the plain recording (only the camera Bubble sits on it; a screen of another shape
      // also shows the Background around it); the Card is far from it.
      && Boolean(lFull && lPlainFull && lInCard && lPlainCard) && meanDiff(lInCard, lPlainCard) > 8
      && (Math.abs(phys.width / phys.height - 16 / 9) > 0.02 || meanDiff(lFull, lPlainFull) * 3 < meanDiff(lInCard, lPlainCard)),
  });
  log(`layouts: full vs plain ${lFull && lPlainFull ? meanDiff(lFull, lPlainFull).toFixed(1) : 'n/a'}, card vs plain ${lInCard && lPlainCard ? meanDiff(lInCard, lPlainCard).toFixed(1) : 'n/a'}, ${JSON.stringify(lExport.data ? { drawn: lExport.data.drawn, s: lExport.data.durationSec } : lExport.err)}`);

  // Full camera (layouts ticket 03) from 3 s: at 4 s the styled video is the camera, mirrored and cropped to
  // cover the video, and no longer the screen.
  const lCam = await cli(['layout-add', projectName, '--at', '3', '--kind', 'camera']);
  const lCamExport = await cli(['export', projectName, '--aspect', '16:9', '--zoom', 'off', '--clicks', 'off']);
  const camOffset = ((project && project.camera && project.camera.offsetMs) || 0) / 1000;
  const [inCam, camAlone, plainAtCam] = lCamExport.data && cameraFile
    ? await Promise.all([greyFrame(lCamExport.data.file, 4), greyFrame(cameraFile, 4 - camOffset, 'hflip,scale=192:108:force_original_aspect_ratio=increase,crop=192:108'), greyFrame(plain, 4)]) : [];
  checks['layouts: drec layout-add --kind camera, and the export fills the video with the camera'] = lCam.code === 0 && lCam.data.edited === 3
    && lCamExport.code === 0 && lCamExport.data.drawn === 'frames' && Boolean(inCam && camAlone && plainAtCam)
    && meanDiff(inCam, camAlone) * 2 < meanDiff(inCam, plainAtCam);
  log(`layouts: full camera vs camera ${inCam && camAlone ? meanDiff(inCam, camAlone).toFixed(1) : 'n/a'}, vs plain screen ${inCam && plainAtCam ? meanDiff(inCam, plainAtCam).toFixed(1) : 'n/a'}${lCam.err ? `, ${lCam.err}` : ''}`);

  // Split swapped (layouts ticket 04) from 4 s: in 16:9 the camera then fills the left 40 % (768 px), so that
  // part of the styled video at 4.7 s is the camera, mirrored and cropped around its middle, not the screen.
  const lSplit = await cli(['layout-add', projectName, '--at', '4', '--kind', 'split', '--swap', 'on']);
  const lSplitList = await cli(['layouts', projectName]);
  const lSplitExport = await cli(['export', projectName, '--aspect', '16:9', '--zoom', 'off', '--clicks', 'off']);
  const part = 'crop=768:1080:0:0,scale=192:108';
  const [splitPart, camPart, screenPart] = lSplitExport.data && cameraFile
    ? await Promise.all([greyFrame(lSplitExport.data.file, 4.7, part), greyFrame(cameraFile, 4.7 - camOffset, 'hflip,scale=768:1080:force_original_aspect_ratio=increase,crop=768:1080,scale=192:108'), greyFrame(plain, 4.7, 'scale=192:108')]) : [];
  checks['layouts: drec layout-add --kind split --swap on, and the camera fills its part of the export'] = lSplit.code === 0 && lSplit.data.edited === 4
    && /split \(swapped\)/.test(lSplit.data.message || '') && lSplitList.code === 0 && lSplitList.data.layouts[3].swap === true
    && lSplitExport.code === 0 && lSplitExport.data.drawn === 'frames' && Boolean(splitPart && camPart && screenPart)
    && meanDiff(splitPart, camPart) * 2 < meanDiff(splitPart, screenPart);
  log(`layouts: split camera part vs camera ${splitPart && camPart ? meanDiff(splitPart, camPart).toFixed(1) : 'n/a'}, vs plain screen ${splitPart && screenPart ? meanDiff(splitPart, screenPart).toFixed(1) : 'n/a'}${lSplit.err ? `, ${lSplit.err}` : ''}`);

  // The other Layout commands (layouts ticket 06), on the list above (Full screen 0, Card 1.5, Full camera 3, Split
  // swapped 4): swap off, Full camera into Split, moved to 2.5 s, the last point deleted. Then the export uses
  // that list: at 3.5 s the camera fills the right 40 % (Split, not swapped).
  const lUnswap = await cli(['layout-change', projectName, '4', '--swap', 'off']);
  const lToSplit = await cli(['layout-change', projectName, '3', '--kind', 'split']);
  const lMoved = await cli(['layout-move', projectName, '3', '--at', '2.5']);
  const lDeleted = await cli(['layout-delete', projectName, '4']);
  const lEdited = (readJson(path.join(dir || '', 'project.json')) || {}).layouts;
  const lErrors = {
    noNumber: await cli(['layout-delete', projectName]),
    noProject: await cli(['layout-move']),
    badNumber: await cli(['layout-delete', projectName, '9']),
    nothingToChange: await cli(['layout-change', projectName, '2']),
    swapOnCard: await cli(['layout-change', projectName, '2', '--swap', 'on']),
    firstStays: await cli(['layout-move', projectName, '1', '--at', '2']),
    firstNotDeleted: await cli(['layout-delete', projectName, '1']),
    pastTheEnd: await cli(['layout-move', projectName, '2', '--at', '99']),
    noAt: await cli(['layout-move', projectName, '2']),
  };
  const lEditedExport = await cli(['export', projectName, '--aspect', '16:9', '--zoom', 'off', '--clicks', 'off']);
  const cover = (w) => `hflip,scale=${w}:1080:force_original_aspect_ratio=increase,crop=${w}:1080`; // the camera as it covers a part that wide
  const [rightPart, camRight, screenRight, leftPart, camLeft] = lEditedExport.data && cameraFile
    ? await Promise.all([greyFrame(lEditedExport.data.file, 3.5, 'crop=768:1080:1152:0,scale=192:108'), greyFrame(cameraFile, 3.5 - camOffset, `${cover(768)},scale=192:108`), greyFrame(plain, 3.5, 'scale=192:108'),
      greyFrame(lEditedExport.data.file, 3.5, 'crop=1152:1080:0:0,scale=192:108'), greyFrame(cameraFile, 3.5 - camOffset, `${cover(1920)},crop=1152:1080:0:0,scale=192:108`)]) : [];
  const refusedWith = (r, re) => r.code === 1 && re.test(r.err || '');
  Object.assign(checks, {
    'layout commands: change kind and swap, move and delete, saved in the Project': lUnswap.code === 0 && /Changed Layout point 4: now split from 4 s/.test(lUnswap.data.message || '') && /Moved Layout point 3 to 2\.5 s/.test(lMoved.data && lMoved.data.message || '')
      && lToSplit.code === 0 && lMoved.code === 0 && lMoved.data.edited === 3 && lDeleted.code === 0 && /Deleted Layout point 4/.test(lDeleted.data.message || '')
      && JSON.stringify(lEdited) === JSON.stringify({ version: 1, points: [{ at: 0, kind: 'screen' }, { at: 1500, kind: 'card' }, { at: 2500, kind: 'split' }] }),
    'layout commands: wrong edits are refused and say what to fix': refusedWith(lErrors.noNumber, /layout-delete needs the Layout point's number from "drec layouts", like 2/)
      && refusedWith(lErrors.noProject, /layout-move needs a Project/) && refusedWith(lErrors.badNumber, /Layout point 9 does not exist: use a number from 1 to 3/)
      && refusedWith(lErrors.nothingToChange, /layout-change needs --kind .*or --swap on\|off/) && refusedWith(lErrors.swapOnCard, /only a Split point can be swapped/)
      && refusedWith(lErrors.firstStays, /The first Layout point stays at 0 s/) && refusedWith(lErrors.firstNotDeleted, /The first Layout point stays/)
      && refusedWith(lErrors.pastTheEnd, /inside the recording/) && refusedWith(lErrors.noAt, /layout-move needs --at SECONDS/),
    // Before the edits 3.5 s was Full camera, where the left 60 % is camera too; now it is the screen's part.
    'layout commands: drec export uses the edited list': lEditedExport.code === 0 && lEditedExport.data.layouts === 3 && Boolean(rightPart && camRight && screenRight && leftPart && camLeft)
      && meanDiff(rightPart, camRight) * 2 < meanDiff(rightPart, screenRight) && meanDiff(leftPart, camLeft) > 3 * Math.max(1, meanDiff(rightPart, camRight)),
  });
  const failedErrors = Object.entries(lErrors).filter(([, r]) => r.code !== 1).map(([k]) => k);
  log(`layout commands: left part vs camera ${leftPart && camLeft ? meanDiff(leftPart, camLeft).toFixed(1) : 'n/a'}, right part vs camera ${rightPart && camRight ? meanDiff(rightPart, camRight).toFixed(1) : 'n/a'}, vs screen ${rightPart && screenRight ? meanDiff(rightPart, screenRight).toFixed(1) : 'n/a'}; errors not refused: ${failedErrors.join(', ') || 'none'}; ${JSON.stringify(Object.fromEntries(Object.entries(lErrors).map(([k, r]) => [k, (r.err || '').slice(0, 80)])))}`);
  if (dir) { const p = readJson(path.join(dir, 'project.json')); delete p.layouts; fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2)); }

  log(`pointer: screen export ${JSON.stringify(exportedOff.data && exportedOff.data.pointer)}, circle diff ${withCircle && withoutCircle ? meanDiff(withCircle, withoutCircle).toFixed(1) : 'n/a'}`);

  log(`zoom: ${zooms.length} Zooms, first ${JSON.stringify(zooms[0])}, diff on/off at ${hold}s ${onHold && offHold ? meanDiff(onHold, offHold).toFixed(1) : 'n/a'}, off early/hold ${offHold && offEarly ? meanDiff(offHold, offEarly).toFixed(1) : 'n/a'}`);

  // ---- Pause: a click before and a click after a 2.5 s pause are close together in video time.
  const cameraLabel = (((await cli(['devices'])).data || {}).cameras || [])[0]?.label;
  await cli(['set', '--mode', 'screen', '--camera', 'none']);
  await cli(['start']);
  await wait(1000);
  clickOverlay.simulateClick(Math.round(mid.x), Math.round(mid.y));
  await cli(['pause']);
  await wait(2500);
  await cli(['resume']);
  await wait(300);
  clickOverlay.simulateClick(Math.round(mid.x), Math.round(mid.y));
  await wait(500);
  await cli(['stop']);
  const pDir = ((await cli(['status'])).data || {}).lastProject;
  const pEvents = pDir && readJson(path.join(pDir, 'events.json'));
  const pProject = pDir && readJson(path.join(pDir, 'project.json'));
  const gap = pEvents && pEvents.clicks.length === 2 ? pEvents.clicks[1].t - pEvents.clicks[0].t : null;
  checks['capture: a pause is not counted in video time'] = gap !== null && gap < 1200;
  checks['capture: no camera, no camera file'] = Boolean(pProject) && pProject.camera === null && !fs.existsSync(path.join(pDir || '', 'camera.webm'));
  log(`capture: click gap across a 2.5 s pause ${gap} ms`);

  // ---- Storage (ticket 08), on this throwaway Project: its size, and "delete raw material, keep MP4".
  const pName = pDir ? path.basename(pDir) : '';
  const noCam = await cli(['layout-add', pName, '--at', '1', '--kind', 'camera']);
  const noCamSplit = await cli(['layout-add', pName, '--at', '1', '--kind', 'split']);
  checks['layouts: Full camera and Split are refused for a Project with no camera, with the reason'] = noCam.code === 1 && /Full camera needs a camera, and this Project was recorded without one/.test(noCam.err)
    && noCamSplit.code === 1 && /Split needs a camera, and this Project was recorded without one/.test(noCamSplit.err);
  const pPlain = pProject && pProject.plainMp4;
  const folderBytes = pDir ? fs.readdirSync(pDir).reduce((n, f) => n + fs.statSync(path.join(pDir, f)).size, 0) : 0;
  const sized = ((await cli(['projects'])).data || []).find((p) => p.name === pName);
  const askOnly = await cli(['delete-raw', pName]);
  const keptAfterAsk = Boolean(pDir) && fs.existsSync(path.join(pDir, 'screen.mp4')) && fs.existsSync(path.join(pDir, 'events.json'));
  const deleted = await cli(['delete-raw', pName, '--yes']);
  const leftFiles = pDir ? fs.readdirSync(pDir) : [];
  const plainInfo = pPlain && fs.existsSync(pPlain) ? await info(pPlain) : '';
  const after = ((await cli(['projects'])).data || []).find((p) => p.name === pName);
  const noExport = await cli(['export', pName]);
  const deleteAgain = await cli(['delete-raw', pName, '--yes']);
  const noZooms = await cli(['zooms', pName]);
  Object.assign(checks, {
    'storage: drec projects shows the size of each Project': Boolean(sized) && sized.sizeBytes === folderBytes && sized.sizeBytes > 0 && sized.rawDeleted === false,
    'storage: the video shared with the plain MP4 is not counted as freed': Boolean(sized) && sized.freeableBytes < sized.sizeBytes,
    'storage: without --yes nothing is deleted': askOnly.code === 1 && /--yes/.test(askOnly.err) && keptAfterAsk,
    'storage: delete-raw keeps only project.json and the plain MP4 still plays': deleted.code === 0 && leftFiles.join() === 'project.json' && Math.abs(durationOf(plainInfo) - (pProject.durationSec || 0)) < 0.6,
    'storage: the Project then says its raw material is gone': Boolean(after) && after.rawDeleted === true && after.freeableBytes === 0,
    'storage: it can no longer be exported, and says so': noExport.code === 1 && /raw material was deleted/.test(noExport.err),
    'storage: a second delete is refused': deleteAgain.code === 1 && /already deleted/.test(deleteAgain.err),
    'storage: its Zooms can no longer be edited, and drec says why': noZooms.code === 1 && /raw material was deleted/.test(noZooms.err),
  });
  log(`storage: ${sized ? `${sized.sizeBytes} bytes, ${sized.freeableBytes} freeable` : 'not listed'}, deleted ${JSON.stringify(deleted.data || deleted.err)}`);
  if (cameraLabel) await cli(['set', '--camera', cameraLabel]);

  // ---- Window: the window's own rectangle is kept with the clicks.
  const wins = await listWindows(false);
  if (wins.length) {
    await cli(['set', '--mode', 'window', '--window', wins[0].name, '--bubble', 'small', '--clicks', 'off', '--system-audio', 'off']);
    const wStart = await cli(['start']);
    let rect = null;
    for (let i = 0; i < 60 && !(rect = clickOverlay.snapshot().windowRect); i++) await wait(250); // the helper takes a while to start
    if (rect) clickOverlay.simulateClick(Math.round((rect.left + rect.right) / 2), Math.round((rect.top + rect.bottom) / 2));
    await wait(1500);
    const wStop = await cli(['stop']);
    const wDir = ((await cli(['status'])).data || {}).lastProject;
    const wEvents = wDir && readJson(path.join(wDir, 'events.json'));
    const wProject = wDir && readJson(path.join(wDir, 'project.json'));
    Object.assign(checks, {
      'capture window: recorded': wStart.code === 0 && wStop.code === 0 && Boolean(wDir) && wDir !== dir,
      'capture window: Project files': Boolean(wDir) && ['project.json', 'events.json', 'screen.mp4', 'camera.webm'].every((f) => fs.existsSync(path.join(wDir, f))),
      'capture window: no cursor in the video': Boolean(wProject) && wProject.mode === 'window' && wProject.cursorInVideo === false,
      'capture window: window rectangle kept': Boolean(wEvents) && Array.isArray(wEvents.windowRects) && wEvents.windowRects.length >= 1,
      'capture window: click inside the window kept': Boolean(wEvents) && wEvents.clicks.length === 1,
    });
    // A window recording has no cursor in its video, so Export draws one (when the mouse was over the window).
    const wExport = wDir ? await cli(['export', path.basename(wDir), '--zoom', 'off']) : { code: 1, data: null };
    checks['capture window: export draws its own cursor path and the click'] = wExport.code === 0 && wExport.data.pointer.clicks === 1 && ['drawn', 'none'].includes(wExport.data.pointer.cursor);
    log(`pointer: window export ${JSON.stringify(wExport.data && wExport.data.pointer)} ${wExport.err || ''}`);
    if (wStop.code !== 0) log(`capture window: ${wStop.err}`);
  }

  await cli(['set', '--mode', 'screen']);
  return checks;
}

// DR_SMOKE=capture: wait for the panel, run the steps, print one SMOKE line and quit.
async function run({ app, bubble, clickOverlay, panelWin, listWindows, log }) {
  for (let i = 0; i < 40 && !(await panelWin().webContents.executeJavaScript('Boolean(window.drecReady)')); i++) await wait(500);
  await wait(1500);
  const checks = await steps({ app, bubble, clickOverlay, listWindows, log });
  log('SMOKE ' + JSON.stringify({ checks }));
  app.quit();
}

module.exports = { steps, run, offBlueShare };
