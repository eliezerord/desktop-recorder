// Checks the Zoom rules without any window: which clicks make a Zoom, how the view moves, and that the
// expressions given to ffmpeg compute the same numbers as the JavaScript. Run: node test/zoom-test.js
const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { ffmpegPath } = require('../src/convert');

const SCREEN = { kind: 'screen', bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const click = (t, fx, fy) => ({ t, x: Math.round(fx * 1920), y: Math.round(fy * 1080), button: 1 });

(async () => {
  const zoom = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'zoom.mjs')).href);
  const { computeZooms, zoomAt, zoomExpressions, ZOOM } = zoom;
  const checks = {};
  const run = (name, fn) => { try { fn(); checks[name] = true; } catch (err) { checks[name] = false; console.error(`${name}: ${err.message}`); } };
  const compute = (clicks, extra = {}) => computeZooms({ clicks, source: SCREEN, windowRects: [], ...extra });

  run('one click makes one Zoom that starts a little before it and holds after it', () => {
    const [z, ...rest] = compute([click(2000, 0.25, 0.75)]);
    assert.strictEqual(rest.length, 0);
    assert.strictEqual(z.start, 2000 - ZOOM.lead);
    assert.strictEqual(z.end, 2000 + ZOOM.hold);
    assert.strictEqual(z.strength, ZOOM.strength);
    assert(Math.abs(z.x - 0.25) < 0.002 && Math.abs(z.y - 0.75) < 0.002, `${z.x},${z.y}`);
  });

  run('a click right at the start does not begin before the video', () => {
    assert.strictEqual(compute([click(100, 0.5, 0.5)])[0].start, 0);
  });

  run('clicks close in time and place make one longer Zoom aimed between them', () => {
    const zs = compute([click(2000, 0.40, 0.50), click(2800, 0.50, 0.50)]);
    assert.strictEqual(zs.length, 1);
    assert.strictEqual(zs[0].end, 2800 + ZOOM.hold);
    assert(Math.abs(zs[0].x - 0.45) < 0.002, `${zs[0].x}`);
  });

  run('clicks far apart in time make separate Zooms', () => {
    const zs = compute([click(2000, 0.5, 0.5), click(9000, 0.5, 0.5)]);
    assert.strictEqual(zs.length, 2);
    assert(zs[1].start > zs[0].end);
  });

  run('a click close in time but far across the screen starts a new Zoom that overlaps the old one', () => {
    const zs = compute([click(2000, 0.1, 0.1), click(2700, 0.9, 0.9)]);
    assert.strictEqual(zs.length, 2);
    assert(zs[1].start < zs[0].end, 'overlap, so the view pans instead of dropping out');
  });

  run('clicks outside the recorded screen are ignored', () => {
    assert.strictEqual(compute([{ t: 1000, x: 2500, y: 400, button: 1 }, { t: 1500, x: -20, y: 10, button: 1 }]).length, 0);
  });

  run('a window recording aims at the window rectangle in force at the click', () => {
    const source = { kind: 'window', name: 'x' };
    const rects = [{ t: 0, left: 100, top: 100, right: 1100, bottom: 700 }, { t: 3000, left: 500, top: 200, right: 1500, bottom: 800 }];
    const zs = computeZooms({ source, windowRects: rects, clicks: [{ t: 1000, x: 600, y: 400, button: 1 }, { t: 6000, x: 1000, y: 500, button: 1 }, { t: 9000, x: 50, y: 50, button: 1 }] });
    assert.strictEqual(zs.length, 2, 'the click outside the window is ignored');
    assert(Math.abs(zs[0].x - 0.5) < 0.002 && Math.abs(zs[0].y - 0.5) < 0.002, `first ${zs[0].x},${zs[0].y}`);
    assert(Math.abs(zs[1].x - 0.5) < 0.002 && Math.abs(zs[1].y - 0.5) < 0.002, `second ${zs[1].x},${zs[1].y}`);
  });

  run('no clicks, no Zooms', () => assert.deepStrictEqual(compute([]), []));

  const one = compute([click(2000, 0.3, 0.6)]);
  run('the view is steady before, zoomed while holding, steady after', () => {
    assert.deepStrictEqual(zoomAt(one, 0), { scale: 1, cx: 0.5, cy: 0.5 });
    const hold = zoomAt(one, 2000);
    assert(Math.abs(hold.scale - ZOOM.strength) < 1e-9 && Math.abs(hold.cx - 0.3) < 0.002 && Math.abs(hold.cy - 0.6) < 0.002, JSON.stringify(hold));
    assert.strictEqual(zoomAt(one, one[0].end + 500).scale, 1);
  });

  run('the motion never jumps: at most a small step every millisecond, and it only grows then shrinks', () => {
    let maxStep = 0;
    let prev = zoomAt(one, 0).scale;
    for (let t = 1; t < 5000; t++) { const s = zoomAt(one, t).scale; maxStep = Math.max(maxStep, Math.abs(s - prev)); prev = s; }
    assert(maxStep < 0.003, `${maxStep}`);
    const half = zoomAt(one, one[0].start + ZOOM.ramp / 2).scale;
    assert(half > 1.2 && half < ZOOM.strength - 0.2, `mid ramp ${half}`); // an easing curve, not a step
  });

  run('overlapping Zooms pan: the centre moves smoothly from one to the other', () => {
    const zs = compute([click(2000, 0.1, 0.1), click(2700, 0.9, 0.9)]);
    let prev = zoomAt(zs, zs[0].start + 600).cx;
    let maxStep = 0;
    for (let t = zs[0].start + 601; t < zs[1].end - 600; t++) { const c = zoomAt(zs, t).cx; maxStep = Math.max(maxStep, Math.abs(c - prev)); prev = c; }
    assert(maxStep < 0.01, `${maxStep}`);
    assert(zoomAt(zs, 2000).cx < 0.4 && zoomAt(zs, 3300).cx > 0.6, 'goes from the first target to the second');
  });

  // The expressions given to ffmpeg must give the same numbers as zoomAt. geq writes them as pixel
  // values (luma 255*(z-1)/3, chroma 255*centre) in a tiny test video that is read back.
  run('the ffmpeg expressions match the JavaScript motion', () => {
    const zs = [...compute([click(1000, 0.2, 0.3), click(5000, 0.8, 0.7), click(5600, 0.2, 0.2), click(9000, 0.5, 0.5)])];
    assert(zs.length >= 4, `${zs.length}`);
    const { z, x, y } = zoomExpressions(zs, 'T');
    const fps = 50;
    const seconds = 11;
    const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `nullsrc=s=4x4:r=${fps}:d=${seconds}`,
      '-vf', `format=yuv444p,geq=lum='clip(255*((${z})-1)/3,0,255)':cb='clip(255*(${x}),0,255)':cr='clip(255*(${y}),0,255)'`,
      '-f', 'rawvideo', '-pix_fmt', 'yuv444p', 'pipe:1'], { maxBuffer: 64 * 1024 * 1024 });
    assert.strictEqual(r.status, 0, String(r.stderr).slice(-400));
    const frameBytes = 4 * 4 * 3;
    const frames = r.stdout.length / frameBytes;
    assert.strictEqual(frames, fps * seconds);
    let worst = { z: 0, c: 0 };
    for (let f = 0; f < frames; f++) {
      const t = (f / fps) * 1000;
      const want = zoomAt(zs, t);
      const got = { z: 1 + (3 * r.stdout[f * frameBytes]) / 255, cx: r.stdout[f * frameBytes + 16] / 255, cy: r.stdout[f * frameBytes + 32] / 255 };
      worst.z = Math.max(worst.z, Math.abs(got.z - want.scale));
      if (want.scale > 1.05) worst.c = Math.max(worst.c, Math.abs(got.cx - want.cx), Math.abs(got.cy - want.cy)); // the centre means nothing while the view is not zoomed
    }
    assert(worst.z < 0.02 && worst.c < 0.01, `worst difference ${JSON.stringify(worst)}`);
  });

  run('a long list stays a short, shallow expression', () => {
    const clicks = Array.from({ length: 400 }, (_, i) => click(1000 + i * 4000, (i % 7) / 7 + 0.05, (i % 5) / 5 + 0.05));
    const zs = compute(clicks);
    assert.strictEqual(zs.length, 400);
    const { z } = zoomExpressions(zs, 'on/30');
    let depth = 0;
    let deepest = 0;
    for (const ch of z) { if (ch === '(') deepest = Math.max(deepest, ++depth); else if (ch === ')') depth--; }
    assert(deepest < 60, `nesting ${deepest}`);
  });

  // ---- Edits to the list (the Editor's timeline, and drec later). Numbers count from 1, as people count.
  const { editZooms, ZOOM_EDIT } = zoom;
  const list = [
    { start: 1000, end: 3000, strength: 1.6, x: 0.2, y: 0.3 },
    { start: 5000, end: 7000, strength: 1.6, x: 0.8, y: 0.7 },
  ];
  const fullMs = 10000;
  const refused = (edit, from = list) => { try { editZooms(from, edit, { fullMs }); } catch (err) { return err.message; } return 'accepted'; };

  run('delete takes out the Zoom with that number and leaves the old list alone', () => {
    const next = editZooms(list, { action: 'delete', number: 1 }, { fullMs });
    assert.deepStrictEqual(next, { zooms: [list[1]], number: 0 });
    assert.strictEqual(list.length, 2);
  });

  run('change moves a Zoom in time and the list stays in time order', () => {
    const { zooms: next, number } = editZooms(list, { action: 'change', number: 2, start: 200, end: 900 }, { fullMs });
    assert.deepStrictEqual(next.map((z) => [z.start, z.end]), [[200, 900], [1000, 3000]]);
    assert.strictEqual(next[0].x, 0.8, 'the aim moves with it');
    assert.strictEqual(number, 1, 'it is Zoom 1 now');
  });

  run('change sets the length, strength and aim, rounded', () => {
    const [z] = editZooms(list, { action: 'change', number: 1, end: 4200.4, strength: 2.345, x: 0.123456, y: 0.9 }, { fullMs }).zooms;
    assert.deepStrictEqual(z, { start: 1000, end: 4200, strength: 2.35, x: 0.1235, y: 0.9 });
  });

  run('add puts a new Zoom at a moment with the usual length and strength, aimed at the middle', () => {
    const { zooms: next, number } = editZooms(list, { action: 'add', start: 3500 }, { fullMs });
    assert.strictEqual(next.length, 3);
    assert.strictEqual(number, 2);
    assert.deepStrictEqual(next[1], { start: 3500, end: 3500 + ZOOM_EDIT.addLength, strength: ZOOM.strength, x: 0.5, y: 0.5 });
  });

  run('add near the end still fits in the recording', () => {
    const next = editZooms([], { action: 'add', start: 9900, x: 0.25, y: 0.75 }, { fullMs }).zooms;
    assert.deepStrictEqual(next, [{ start: fullMs - ZOOM_EDIT.addLength, end: fullMs, strength: ZOOM.strength, x: 0.25, y: 0.75 }]);
  });

  run('wrong edits are refused and say what to fix', () => {
    assert.match(refused({ action: 'delete', number: 3 }), /Zoom 3 does not exist: use a number from 1 to 2\./);
    assert.match(refused({ action: 'delete', number: 1 }, []), /This Project has no Zooms/);
    assert.match(refused({ action: 'change', number: 1, end: 1200 }), /at least 0\.5 s/);
    assert.match(refused({ action: 'change', number: 1, start: -5 }), /inside the recording, from 0 to 10\.0 s/);
    assert.match(refused({ action: 'change', number: 1, end: 12000 }), /inside the recording, from 0 to 10\.0 s/);
    assert.match(refused({ action: 'change', number: 1, strength: 5 }), /strength: use a number from 1\.1 to 3/);
    assert.match(refused({ action: 'change', number: 1, x: 1.5 }), /aim: use numbers from 0 to 1/);
    assert.match(refused({ action: 'change', number: 1, start: 'soon' }), /inside the recording/);
    assert.match(refused({ action: 'spin' }), /Unknown Zoom change: spin/);
  });

  run('the edited list is what the motion follows', () => {
    const next = editZooms(list, { action: 'change', number: 1, strength: 2.5 }, { fullMs }).zooms;
    assert(Math.abs(zoomAt(next, 2000).scale - 2.5) < 1e-9);
    assert.strictEqual(zoomAt(editZooms(list, { action: 'delete', number: 1 }, { fullMs }).zooms, 2000).scale, 1);
  });

  run('a change that matches another Zoom still says which one it is', () => {
    const twins = [{ ...list[0] }, { ...list[0], strength: 2 }];
    const { zooms, number } = editZooms(twins, { action: 'change', number: 2, strength: 1.6 }, { fullMs });
    assert.strictEqual(zooms.length, 2);
    assert.strictEqual(zooms[number - 1], zooms[1], 'the changed one, not its twin');
  });

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(JSON.stringify(checks, null, 2));
  console.log(failed.length ? `FAIL: ${failed.length} of ${Object.keys(checks).length}` : `OK: ${Object.keys(checks).length} of ${Object.keys(checks).length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
