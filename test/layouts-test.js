// Checks the Layout rules without any window: editing the list of Layout points, and where the screen and the
// Bubble are at any moment, transitions included. Run: node test/layouts-test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const L = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'layouts.mjs')).href);
  const look = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'look.mjs')).href);
  const { editLayouts, layoutPoints, layoutShapes, frameAt, needsFrames, bubbleOf, LAYOUT } = L;
  const checks = {};
  const run = (name, fn) => { try { fn(); checks[name] = true; } catch (err) { checks[name] = false; console.error(`${name}: ${err.message}`); } };
  const fullMs = 10000;
  const refused = (points, edit, hasCamera = true) => { try { editLayouts(points, edit, { fullMs, hasCamera }); } catch (err) { return err.message; } return 'accepted'; };

  // ---- The list
  run('a Project with no Layout points has one Card point at 0', () => {
    assert.deepStrictEqual(layoutPoints({}), [{ at: 0, kind: 'card' }]);
    assert.deepStrictEqual(layoutPoints({ layouts: { version: 1, points: [{ at: 0, kind: 'screen' }, { at: 3000, kind: 'card' }] } }), [{ at: 0, kind: 'screen' }, { at: 3000, kind: 'card' }]);
    assert.strictEqual(needsFrames(layoutPoints({})), false);
    assert.strictEqual(needsFrames([{ at: 0, kind: 'screen' }]), true);
  });

  const base = layoutPoints({});
  run('add puts a point in time order and says its number', () => {
    let r = editLayouts(base, { action: 'add', at: 4000, kind: 'screen' }, { fullMs });
    assert.deepStrictEqual(r, { points: [{ at: 0, kind: 'card' }, { at: 4000, kind: 'screen' }], number: 2 });
    r = editLayouts(r.points, { action: 'add', at: 2000.4, kind: 'card' }, { fullMs });
    assert.deepStrictEqual(r.points.map((p) => p.at), [0, 2000, 4000]);
    assert.strictEqual(r.number, 2);
    assert.strictEqual(base.length, 1, 'the old list is left alone');
  });

  const two = [{ at: 0, kind: 'card' }, { at: 4000, kind: 'screen' }];
  run('change sets the kind; the first point can change kind', () => {
    assert.deepStrictEqual(editLayouts(two, { action: 'change', number: 1, kind: 'screen' }, { fullMs }).points[0], { at: 0, kind: 'screen' });
    assert.deepStrictEqual(editLayouts(two, { action: 'change', number: 2, kind: 'card' }, { fullMs }).points[1], { at: 4000, kind: 'card' });
  });

  run('move sets the time and keeps the order', () => {
    const r = editLayouts([...two, { at: 6000, kind: 'card' }], { action: 'move', number: 3, at: 1500 }, { fullMs });
    assert.deepStrictEqual(r.points.map((p) => p.at), [0, 1500, 4000]);
    assert.strictEqual(r.number, 2);
  });

  run('delete takes a point out; the first point stays', () => {
    assert.deepStrictEqual(editLayouts(two, { action: 'delete', number: 2 }, { fullMs }), { points: [{ at: 0, kind: 'card' }], number: 0 });
  });

  run('wrong edits are refused and say what to fix', () => {
    assert.match(refused(two, { action: 'add', at: 4000, kind: 'banana' }), /kind: use card, screen, camera or split/);
    assert.match(refused(two, { action: 'add', at: 12000, kind: 'card' }), /inside the recording, from 0 to 10\.0 s/);
    assert.match(refused(two, { action: 'add', at: 0, kind: 'card' }), /The first Layout point is at 0 s: change its kind instead/);
    assert.match(refused(two, { action: 'add', at: 4100, kind: 'card' }), /at least 0\.3 s apart/);
    assert.match(refused(two, { action: 'move', number: 1, at: 2000 }), /The first Layout point stays at 0 s/);
    assert.match(refused(two, { action: 'delete', number: 1 }), /The first Layout point stays/);
    assert.match(refused(two, { action: 'delete', number: 3 }), /Layout point 3 does not exist: use a number from 1 to 2/);
    assert.match(refused(two, { action: 'spin' }), /Unknown Layout change: spin/);
  });

  run('Full camera needs a camera: refused with the reason when the Project has none', () => {
    assert.strictEqual(editLayouts(two, { action: 'add', at: 6000, kind: 'camera' }, { fullMs, hasCamera: true }).points[2].kind, 'camera');
    const why = /Full camera needs a camera, and this Project was recorded without one/;
    assert.match(refused(two, { action: 'add', at: 6000, kind: 'camera' }, false), why);
    assert.match(refused(two, { action: 'change', number: 1, kind: 'camera' }, false), why);
    assert.strictEqual(editLayouts(two, { action: 'add', at: 6000, kind: 'screen' }, { fullMs, hasCamera: false }).number, 3, 'other kinds still work');
    assert.match(refused(two, { action: 'add', at: 6000, kind: 'split' }, false), /Split needs a camera, and this Project was recorded without one\. Use card or screen/);
  });

  run('Split can be swapped: saved only on Split points, and only as a yes or no', () => {
    let r = editLayouts(two, { action: 'add', at: 6000, kind: 'split', swap: true }, { fullMs, hasCamera: true });
    assert.deepStrictEqual(r.points[2], { at: 6000, kind: 'split', swap: true });
    assert.deepStrictEqual(editLayouts(two, { action: 'add', at: 6000, kind: 'split' }, { fullMs, hasCamera: true }).points[2], { at: 6000, kind: 'split' }, 'not swapped: nothing extra saved');
    r = editLayouts(r.points, { action: 'change', number: 3, swap: false }, { fullMs, hasCamera: true });
    assert.deepStrictEqual(r.points[2], { at: 6000, kind: 'split' }, 'change can turn swap off and keep the kind');
    r = editLayouts(r.points, { action: 'change', number: 3, swap: true }, { fullMs, hasCamera: true });
    assert.deepStrictEqual(editLayouts(r.points, { action: 'change', number: 3, kind: 'card' }, { fullMs, hasCamera: true }).points[2], { at: 6000, kind: 'card' }, 'leaving Split drops the swap');
    assert.deepStrictEqual(editLayouts(r.points, { action: 'move', number: 3, at: 7000 }, { fullMs, hasCamera: true }).points[2], { at: 7000, kind: 'split', swap: true }, 'a move keeps it');
    assert.match(refused(two, { action: 'add', at: 6000, kind: 'screen', swap: true }), /swap: only a Split point can be swapped/);
    assert.match(refused(two, { action: 'change', number: 2, swap: true }), /swap: only a Split point can be swapped/);
    assert.match(refused(two, { action: 'add', at: 6000, kind: 'split', swap: 'yes' }), /swap: use on or off/);
    assert.deepStrictEqual(layoutPoints({ layouts: { version: 1, points: [{ at: 0, kind: 'split', swap: true }] } }), [{ at: 0, kind: 'split', swap: true }], 'read back from the Project');
  });

  // ---- Geometry
  const canvas = look.ASPECTS['16:9'];
  const source = { w: 1920, h: 1080 };
  const lookFor = { ...look.DEFAULT_LOOK, bubblePlace: 'outside', bubbleCorner: 'bottom-left' };
  const lay = look.layout({ canvas, source, hasCamera: true, bubbleSize: 'small', look: lookFor });
  const shapes = layoutShapes({ canvas, source, lay, look: lookFor });

  const bubbleAsRegion = (b) => ({ x: b.x, y: b.y, w: b.d, h: b.d, r: b.r, a: 1, ring: 1 });
  run('Card is today\'s layout; Full screen fills the canvas with square corners and keeps the Bubble in its corner', () => {
    assert.deepStrictEqual(shapes.card, { card: { ...lay.card, s: 1, a: 1 }, camera: bubbleAsRegion(lay.bubble) });
    assert.deepStrictEqual(shapes.screen.card, { x: 0, y: 0, w: 1920, h: 1080, r: 0, s: 0, a: 1 }, 'square corners, no shadow');
    const b = shapes.screen.camera;
    assert.strictEqual(b.w, lay.bubble.d, 'same size');
    assert(b.r === b.w / 2 && b.ring === 1, 'still a round Bubble with its ring');
    assert(b.x < 960 && b.y > 540 && b.x >= 0 && b.y + b.h <= 1080, `bottom left, inside: ${JSON.stringify(b)}`);
  });

  run('Full camera fills the canvas in 16:9 and 9:16, with no ring, and the screen is not shown', () => {
    for (const aspect of ['16:9', '9:16']) {
      const c = look.ASPECTS[aspect];
      const l = look.layout({ canvas: c, source, hasCamera: true, bubbleSize: 'small', look: lookFor });
      const cam = layoutShapes({ canvas: c, source, lay: l, look: lookFor }).camera;
      assert.deepStrictEqual(cam.camera, { x: 0, y: 0, w: c.w, h: c.h, r: 0, a: 1, ring: 0 }, aspect);
      assert(cam.card.a === 0 && cam.card.s === 0, `${aspect}: the screen is hidden ${JSON.stringify(cam.card)}`);
    }
  });

  // Split: in 16:9 the screen on the left 60 % and the camera on the right 40 %; in 9:16 the screen on top and
  // the camera below, half and half. Swapped, each part takes the other's place.
  const splitOf = (aspect, swap) => {
    const c = look.ASPECTS[aspect];
    const l = look.layout({ canvas: c, source, hasCamera: true, bubbleSize: 'small', look: lookFor });
    const s = layoutShapes({ canvas: c, source, lay: l, look: lookFor });
    return { c, l, shape: swap ? s['split-swap'] : s.split };
  };
  const inside = (r, box) => r.x >= box.x && r.y >= box.y && r.x + r.w <= box.x + box.w && r.y + r.h <= box.y + box.h;
  run('Split: exactly 60/40 in 16:9 and 50/50 in 9:16; the camera fills its part, the screen is a Card fitted to its own', () => {
    const halves = {
      '16:9': { screen: { x: 0, y: 0, w: 1152, h: 1080 }, camera: { x: 1152, y: 0, w: 768, h: 1080 } },
      '9:16': { screen: { x: 0, y: 0, w: 1080, h: 960 }, camera: { x: 0, y: 960, w: 1080, h: 960 } },
    };
    for (const aspect of ['16:9', '9:16']) {
      const { l, shape } = splitOf(aspect, false);
      const want = halves[aspect];
      assert.deepStrictEqual(shape.camera, { ...want.camera, r: 0, a: 1, ring: 0 }, `${aspect}: the camera covers its part, no Bubble, no ring`);
      const card = shape.card;
      assert(inside(card, want.screen), `${aspect}: the screen stays in its part ${JSON.stringify(card)}`);
      assert(Math.abs(card.w / card.h - 16 / 9) < 0.01, `${aspect}: the screen keeps its shape`);
      const margin = Math.round(0.05 * 1080);
      assert(Math.abs(card.x - want.screen.x - (want.screen.w - card.w) / 2) <= 2 && Math.abs(card.y - want.screen.y - (want.screen.h - card.h) / 2) <= 2, `${aspect}: centred in its part`);
      assert(Math.min(card.x - want.screen.x, want.screen.x + want.screen.w - card.x - card.w) >= margin - 2, `${aspect}: the usual margin around it`);
      assert(card.r === l.card.r && card.s === 1 && card.a === 1, `${aspect}: a Card, with its corners and shadow ${JSON.stringify(card)}`);
    }
  });

  run('Split swapped is the mirror image: in 16:9 left and right, in 9:16 top and bottom', () => {
    for (const aspect of ['16:9', '9:16']) {
      const { c, shape } = splitOf(aspect, false);
      const swapped = splitOf(aspect, true).shape;
      const mirror = (r) => (aspect === '16:9' ? { ...r, x: c.w - r.x - r.w } : { ...r, y: c.h - r.y - r.h });
      assert.deepStrictEqual(swapped.camera, mirror(shape.camera), `${aspect} camera`);
      assert.deepStrictEqual(swapped.card, mirror(shape.card), `${aspect} screen`);
    }
  });

  run('into Split the Bubble grows into the camera part and the Card moves to its part, with no jump; and back', () => {
    for (const aspect of ['16:9', '9:16']) {
      const c = look.ASPECTS[aspect];
      const l = look.layout({ canvas: c, source, hasCamera: true, bubbleSize: 'small', look: lookFor });
      const s = layoutShapes({ canvas: c, source, lay: l, look: lookFor });
      const plan = { points: [{ at: 0, kind: 'card' }, { at: 1000, kind: 'split' }, { at: 3000, kind: 'split', swap: true }, { at: 5000, kind: 'card' }], shapes: s };
      assert.deepStrictEqual(frameAt(plan, 2000), s.split);
      assert.deepStrictEqual(frameAt(plan, 4000), s['split-swap']);
      assert.deepStrictEqual(frameAt(plan, 6000), s.card);
      const mid = frameAt(plan, 1050).camera;
      assert(mid.w > l.bubble.d && mid.ring > 0 && mid.ring < 1, `${aspect}: growing ${JSON.stringify(mid)}`);
      for (const at of [1000, 3000, 5000]) {
        for (const [name, keys] of [['camera', ['x', 'y', 'w', 'h', 'r', 'a', 'ring']], ['card', ['x', 'y', 'w', 'h', 'r', 'a', 's']]]) {
          for (const k of keys) {
            let maxStep = 0;
            for (let t = at - 5; t < at + LAYOUT.moveMs + 5; t++) maxStep = Math.max(maxStep, Math.abs(frameAt(plan, t + 1)[name][k] - frameAt(plan, t)[name][k]));
            const limit = ['a', 'ring', 's'].includes(k) ? 0.03 : 1920 * 0.03;
            assert(maxStep < limit, `${aspect} ${name}.${k} steps ${maxStep} at ${at}`);
          }
        }
      }
      assert.strictEqual(bubbleOf(frameAt(plan, 2000)), null, 'no Bubble to drag in Split');
    }
  });

  run('Split to and from Full camera and Full screen: no jump, the screen fades where it is', () => {
    for (const aspect of ['16:9', '9:16']) {
      const c = look.ASPECTS[aspect];
      const l = look.layout({ canvas: c, source, hasCamera: true, bubbleSize: 'small', look: lookFor });
      const s = layoutShapes({ canvas: c, source, lay: l, look: lookFor });
      const plan = { points: [{ at: 0, kind: 'screen' }, { at: 1000, kind: 'split' }, { at: 2000, kind: 'camera' }, { at: 3000, kind: 'split', swap: true }, { at: 4000, kind: 'screen' }], shapes: s };
      for (const at of [1000, 2000, 3000, 4000]) {
        for (const [name, keys] of [['camera', ['x', 'y', 'w', 'h', 'r', 'a', 'ring']], ['card', ['x', 'y', 'w', 'h', 'r', 'a', 's']]]) {
          for (const k of keys) {
            let maxStep = 0;
            for (let t = at - 5; t < at + LAYOUT.moveMs + 5; t++) {
              const [p, q] = [frameAt(plan, t)[name], frameAt(plan, t + 1)[name]];
              if (p.a < 1e-3 && q.a < 1e-3) continue; // where a region is not shown (or 1/1000 shown) does not matter
              maxStep = Math.max(maxStep, Math.abs(q[k] - p[k]));
            }
            const limit = ['a', 'ring', 's'].includes(k) ? 0.03 : 1920 * 0.03;
            assert(maxStep < limit, `${aspect} ${name}.${k} steps ${maxStep} at ${at}`);
          }
        }
      }
      // Into Full camera the Split's screen fades in its own place, a little smaller, not sliding.
      const fading = frameAt(plan, 2050).card;
      const from = s.split.card;
      const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
      assert(fading.a > 0 && fading.a < 1 && fading.w < from.w && Math.hypot(...centre(fading).map((v, i) => v - centre(from)[i])) < 1, `${aspect}: ${JSON.stringify(fading)}`);
      assert.deepStrictEqual(frameAt(plan, 3500), s['split-swap'], `${aspect}: settles in the swapped Split`);
    }
  });

  run('a Project with no camera has no camera region, and nothing to grow', () => {
    const noCam = look.layout({ canvas, source, hasCamera: false, bubbleSize: 'small', look: lookFor });
    const s = layoutShapes({ canvas, source, lay: noCam, look: lookFor });
    assert(s.card.camera === null && s.screen.camera === null, JSON.stringify(s));
  });

  run('Full screen in 9:16 keeps the screen\'s shape, centred on the Background', () => {
    const tall = look.ASPECTS['9:16'];
    const tallLay = look.layout({ canvas: tall, source, hasCamera: true, bubbleSize: 'small', look: lookFor });
    const tallShapes = layoutShapes({ canvas: tall, source, lay: tallLay, look: lookFor }).screen;
    const s = tallShapes.card;
    assert.strictEqual(s.w, 1080);
    assert(Math.abs(s.w / s.h - 16 / 9) < 0.01 && Math.abs(s.y * 2 + s.h - 1920) <= 2, JSON.stringify(s));
    const b = tallShapes.camera; // in the corner of the video, not of the screen band
    assert(b.x < 540 && b.y + b.h > 1800, `bottom left of the video: ${JSON.stringify(b)}`);
  });

  const plan = { points: [{ at: 0, kind: 'screen' }, { at: 5000, kind: 'card' }], shapes };
  run('frameAt: before a point it is the old Layout, after the move it is the new one', () => {
    assert.deepStrictEqual(frameAt(plan, 1000), shapes.screen);
    assert.deepStrictEqual(frameAt(plan, 4999), shapes.screen);
    assert.deepStrictEqual(frameAt(plan, 5000 + LAYOUT.moveMs), shapes.card);
    assert.deepStrictEqual(frameAt(plan, 9000), shapes.card);
  });

  run('the move takes 0.3 s with a strong ease-out: most of it in the first 0.1 s, never a jump', () => {
    assert.strictEqual(LAYOUT.moveMs, 300);
    const wAt = (t) => frameAt(plan, t).card.w;
    const total = shapes.screen.card.w - shapes.card.card.w;
    const done = (shapes.screen.card.w - wAt(5100)) / total;
    assert(done > 0.75 && done < 0.95, `${done.toFixed(2)} of the move after 0.1 s`);
    let maxStep = 0;
    for (let t = 4990; t < 5310; t++) maxStep = Math.max(maxStep, Math.abs(wAt(t + 1) - wAt(t)));
    assert(maxStep < total * 0.03, `step ${maxStep} of ${total}`);
    const mid = frameAt(plan, 5050);
    assert(mid.card.r > 0 && mid.card.r < shapes.card.card.r && mid.camera.y !== shapes.card.camera.y, JSON.stringify(mid));
  });

  // Card -> Full camera at 2 s -> Card at 6 s.
  const cam = { points: [{ at: 0, kind: 'card' }, { at: 2000, kind: 'camera' }, { at: 6000, kind: 'card' }], shapes };
  run('the Bubble grows into the full camera and shrinks back, with no jump', () => {
    assert.deepStrictEqual(frameAt(cam, 2000).camera, shapes.card.camera, 'starts as the Bubble');
    assert.deepStrictEqual(frameAt(cam, 2000 + LAYOUT.moveMs).camera, shapes.camera.camera, 'ends filling the canvas');
    assert.deepStrictEqual(frameAt(cam, 6000).camera, shapes.camera.camera, 'starts back from full');
    assert.deepStrictEqual(frameAt(cam, 6000 + LAYOUT.moveMs).camera, shapes.card.camera, 'ends as the Bubble again');
    // Every value of both regions, 1 ms apart: places and sizes move less than 3 % of the width, opacity, ring
    // and shadow less than 3 % of their range.
    const regions = { camera: ['x', 'y', 'w', 'h', 'r', 'a', 'ring'], card: ['x', 'y', 'w', 'h', 'r', 'a', 's'] };
    for (const at of [2000, 6000]) {
      for (const [name, keys] of Object.entries(regions)) {
        for (const k of keys) {
          let maxStep = 0;
          for (let t = at - 10; t < at + LAYOUT.moveMs + 10; t++) maxStep = Math.max(maxStep, Math.abs(frameAt(cam, t + 1)[name][k] - frameAt(cam, t)[name][k]));
          const limit = ['a', 'ring', 's'].includes(k) ? 0.03 : 1920 * 0.03;
          assert(maxStep < limit, `${name}.${k} steps ${maxStep} at ${at}`);
        }
      }
    }
    const mid = frameAt(cam, 2050).camera;
    assert(mid.w > lay.bubble.d && mid.w < 1920 && mid.ring > 0 && mid.ring < 1 && mid.r < lay.bubble.d / 2, JSON.stringify(mid));
  });

  run('the screen fades out with a small scale where it is, and comes back the same way', () => {
    const c = shapes.card.card;
    const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];
    const mid = frameAt(cam, 2050).card;
    assert(mid.a > 0 && mid.a < 1 && mid.w < c.w && mid.w > c.w * 0.9, `fading and a little smaller: ${JSON.stringify(mid)}`);
    assert(Math.hypot(...centre(mid).map((v, i) => v - centre(c)[i])) < 1, 'it does not slide');
    assert.strictEqual(frameAt(cam, 4000).card.a, 0, 'hidden in Full camera');
    const back = frameAt(cam, 6050).card;
    assert(back.a > 0 && back.a < 1 && back.w < c.w, `coming back: ${JSON.stringify(back)}`);
    assert.deepStrictEqual(frameAt(cam, 6000 + LAYOUT.moveMs).card, c);
  });

  run('a rounded Bubble keeps its corners in the Card and Full screen, and eases them away into Full camera', () => {
    const roundedLook = { ...lookFor, bubbleShape: 'rounded' };
    const rl = look.layout({ canvas, source, hasCamera: true, bubbleSize: 'small', look: roundedLook });
    const rs = layoutShapes({ canvas, source, lay: rl, look: roundedLook });
    assert(rl.bubble.r > 0 && rl.bubble.r < rl.bubble.d / 2, JSON.stringify(rl.bubble));
    assert.strictEqual(rs.card.camera.r, rl.bubble.r);
    assert.strictEqual(rs.screen.camera.r, rl.bubble.r, 'the same corners in Full screen');
    const grow = { points: cam.points, shapes: rs };
    let last = frameAt(grow, 1990).camera.r;
    for (let t = 1991; t <= 2400; t++) {
      const r = frameAt(grow, t).camera.r;
      assert(r <= last + 1e-9 && last - r < 2, `corner ${last} -> ${r} at ${t}`);
      last = r;
    }
    assert.strictEqual(last, 0, 'square corners in Full camera');
    assert.deepStrictEqual(bubbleOf(frameAt(grow, 1000)), rl.bubble, 'the Editor can still drag it');
  });

  run('a hidden region stays hidden and still from one Full camera point to the next', () => {
    const twice = { points: [{ at: 0, kind: 'card' }, { at: 1000, kind: 'camera' }, { at: 2000, kind: 'camera' }], shapes };
    for (const t of [1999, 2000, 2100, 2300, 3000]) assert.deepStrictEqual(frameAt(twice, t).card, shapes.camera.card, `at ${t}`);
  });

  run('the Editor can drag the Bubble only while it is a settled Bubble', () => {
    assert.deepStrictEqual(bubbleOf(frameAt(cam, 1000)), lay.bubble);
    assert.strictEqual(bubbleOf(frameAt(cam, 2050)), null, 'mid-grow');
    assert.strictEqual(bubbleOf(frameAt(cam, 4000)), null, 'full camera');
    const moving = bubbleOf(frameAt(plan, 5050)); // between Full screen and Card it stays a Bubble
    assert(moving && moving.d === lay.bubble.d, JSON.stringify(moving));
  });

  run('a point that comes during a move starts from where the view is, with no jump', () => {
    const quick = { points: [{ at: 0, kind: 'card' }, { at: 1000, kind: 'screen' }, { at: 1350, kind: 'card' }], shapes };
    const before = frameAt(quick, 1349.9).card.w;
    const after = frameAt(quick, 1350).card.w;
    assert(Math.abs(after - before) < 2, `${before} -> ${after}`);
  });

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(JSON.stringify(checks, null, 2));
  console.log(failed.length ? `FAIL: ${failed.length} of ${Object.keys(checks).length}` : `OK: ${Object.keys(checks).length} of ${Object.keys(checks).length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
