// Checks the cursor and click circles without ffmpeg or any window: where the cursor is, how it is
// smoothed, which clicks are alive at a moment, where everything lands on the Card (also while the view is
// zoomed), and what the little pictures look like. Run: node test/pointer-test.js
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

const SCREEN = { kind: 'screen', bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const CARD = { x: 0, y: 0, w: 1296, h: 728 };

(async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'pointer.mjs')).href);
  const { cursorPath, trackCursor, ripplesAt, toCard, drawSheet, SHEET, TILE, SLOTS, RIPPLE, POINTER, CURSOR_PAD } = mod;
  const checks = {};
  const run = (name, fn) => { try { fn(); checks[name] = true; } catch (err) { checks[name] = false; console.error(`${name}: ${err.message}`); } };
  const alphaAt = (buf, x, y) => buf[(Math.round(y) * SHEET.w + Math.round(x)) * 4 + 3];
  const rgbAt = (buf, x, y) => [0, 1, 2].map((i) => buf[(Math.round(y) * SHEET.w + Math.round(x)) * 4 + i]);

  run('a screen path maps to fractions and hides what is off the recorded screen', () => {
    const p = cursorPath({ cursor: [[0, 960, 540], [33, 2500, 100]], source: SCREEN, windowRects: [] });
    assert.deepStrictEqual([p[0].fx, p[0].fy, p[0].inside], [0.5, 0.5, true]);
    assert.strictEqual(p[1].inside, false);
  });

  run('a window path uses the rectangle in force and hides the cursor outside the window', () => {
    const rects = [{ t: 0, left: 100, top: 100, right: 1100, bottom: 700 }, { t: 1000, left: 500, top: 200, right: 1500, bottom: 800 }];
    const p = cursorPath({ cursor: [[500, 600, 400], [1500, 1000, 500], [2000, 50, 50]], source: { kind: 'window' }, windowRects: rects });
    assert.deepStrictEqual([p[0].fx, p[0].fy], [0.5, 0.5]);
    assert.deepStrictEqual([p[1].fx, p[1].fy], [0.5, 0.5]);
    assert.strictEqual(p[2].inside, false);
  });

  const steady = trackCursor({ path: [{ t: 0, fx: 0.3, fy: 0.4, inside: true }], frames: 30, fps: 30 });
  run('a cursor that does not move stays exactly where it is', () => {
    assert(steady.every((f) => f.visible && f.fx === 0.3 && f.fy === 0.4));
  });

  run('a jump is followed smoothly: lags, never overshoots, then arrives', () => {
    const path_ = [{ t: 0, fx: 0.2, fy: 0.2, inside: true }, { t: 1000, fx: 0.2, fy: 0.2, inside: true }, { t: 1033, fx: 0.8, fy: 0.8, inside: true }];
    const t = trackCursor({ path: path_, frames: 90, fps: 30 });
    const xs = t.map((f) => f.fx);
    assert(Math.max(...xs) <= 0.8 + 1e-9, 'overshoot');
    assert(xs.every((x, i) => i === 0 || x >= xs[i - 1] - 1e-9), 'goes back');
    assert(xs[32] > 0.2 && xs[32] < 0.7, `still on the way at 1.07 s: ${xs[32]}`);
    assert(xs[89] > 0.79, `arrived: ${xs[89]}`);
  });

  run('a cursor that leaves the window disappears and comes back without sliding in from the old spot', () => {
    const path_ = [{ t: 0, fx: 0.2, fy: 0.2, inside: true }, { t: 100, fx: 0.2, fy: 0.2, inside: false }, { t: 600, fx: 0.9, fy: 0.9, inside: true }];
    const t = trackCursor({ path: path_, frames: 30, fps: 30 });
    assert.strictEqual(t[0].visible, true);
    assert.strictEqual(t[6].visible, false);
    const back = t.find((f, i) => i > 6 && f.visible);
    assert(Math.abs(back.fx - 0.9) < 0.02, `${back.fx}`);
  });

  run('a long pause is held still, not slid across', () => {
    const t = trackCursor({ path: [{ t: 0, fx: 0.2, fy: 0.2, inside: true }, { t: 2000, fx: 0.8, fy: 0.8, inside: true }], frames: 80, fps: 30 });
    assert(t[30].fx < 0.25, `${t[30].fx}`);
  });

  run('click circles live for their lifetime, with an age from 0 to 1, newest slots first', () => {
    const clicks = [{ t: 1000, fx: 0.25, fy: 0.5 }];
    assert.deepStrictEqual(ripplesAt(clicks, 900), []);
    assert.strictEqual(ripplesAt(clicks, 1000)[0].age, 0);
    assert(Math.abs(ripplesAt(clicks, 1000 + RIPPLE.ms / 2)[0].age - 0.5) < 1e-9);
    assert.deepStrictEqual(ripplesAt(clicks, 1000 + RIPPLE.ms + 1), []);
    const many = [1000, 1100, 1200, 1300, 1400].map((t) => ({ t, fx: 0.5, fy: 0.5 }));
    const live = ripplesAt(many, 1450);
    assert.strictEqual(live.length, SLOTS);
    assert.deepStrictEqual(live.map((r) => r.t), [1400, 1300, 1200], 'the newest are kept');
  });

  run('on the Card: whole view maps by fraction, a zoomed view moves and enlarges', () => {
    const whole = toCard({ scale: 1, cx: 0.5, cy: 0.5 }, 0.25, 0.5, CARD);
    assert.deepStrictEqual(whole, { x: 324, y: 364 });
    const centred = toCard({ scale: 1.6, cx: 0.5, cy: 0.5 }, 0.5, 0.5, CARD);
    assert(Math.abs(centred.x - 648) < 1e-6 && Math.abs(centred.y - 364) < 1e-6, JSON.stringify(centred));
    const clamped = toCard({ scale: 1.6, cx: 0.25, cy: 0.25 }, 0.25, 0.25, CARD); // the view cannot go past the screen's edge
    assert(Math.abs(clamped.x - 0.4 * 1296) < 1e-6 && Math.abs(clamped.y - 0.4 * 728) < 1e-6, JSON.stringify(clamped));
  });

  const buf = new Uint8Array(SHEET.w * SHEET.h * 4);
  const origin = (slot) => (slot < 0 ? 0 : TILE.cursor + slot * TILE.ripple);

  run('the cursor arrow has its tip at the hot spot, a white body and a dark edge, and is clear around it', () => {
    drawSheet(buf, { cursor: { x: 100, y: 100 }, ripples: [] }, { cursorHeight: 28, scale: 1 });
    const tip = CURSOR_PAD; // the hot spot is at (pad, pad) when the position has no fraction
    assert(alphaAt(buf, tip + 3, tip + 9) === 255, 'body is solid');
    assert(rgbAt(buf, tip + 3, tip + 9).every((v) => v > 240), 'body is white');
    assert(alphaAt(buf, tip - 3, tip - 3) === 0, 'clear above and left of the tip');
    assert(alphaAt(buf, tip + 30, tip + 30) === 0, 'clear far away');
    let dark = 0;
    for (let y = 0; y < TILE.cursor; y++) for (let x = 0; x < TILE.cursor; x++) if (alphaAt(buf, x, y) > 200 && rgbAt(buf, x, y).every((v) => v < 80)) dark++;
    assert(dark > 20, `edge pixels ${dark}`);
  });

  run('a fraction of a pixel moves the arrow by about that much', () => {
    const centroid = (frac) => {
      drawSheet(buf, { cursor: { x: 100 + frac, y: 100 }, ripples: [] }, { cursorHeight: 28, scale: 1 });
      let sum = 0; let weight = 0;
      for (let y = 0; y < TILE.cursor; y++) for (let x = 0; x < TILE.cursor; x++) { const a = alphaAt(buf, x, y); sum += a * x; weight += a; }
      return sum / weight;
    };
    assert(Math.abs((centroid(0.5) - centroid(0)) - 0.5) < 0.12, `${centroid(0.5) - centroid(0)}`);
  });

  run('a click circle: faint disc and a strong ring that grows and fades', () => {
    const slot = 0;
    const at = (age) => {
      drawSheet(buf, { cursor: null, ripples: [{ x: 500, y: 300, age }] }, { cursorHeight: 28, scale: 1 });
      const ox = origin(slot) + TILE.ripple / 2;
      const oy = TILE.ripple / 2;
      const r = RIPPLE.r0 + (RIPPLE.r1 - RIPPLE.r0) * age;
      return { disc: alphaAt(buf, ox, oy), ring: alphaAt(buf, ox + r, oy), outside: alphaAt(buf, ox + r + 8, oy), r };
    };
    const young = at(0.1);
    const old = at(0.9);
    assert(young.ring > 150 && young.outside === 0, JSON.stringify(young));
    assert(young.disc > 20 && young.disc < young.ring, JSON.stringify(young));
    assert(old.ring < young.ring && old.ring > 0, 'fades');
    assert(old.r > young.r, 'grows');
  });

  run('the ring is yellow, like the circles drawn while recording', () => {
    drawSheet(buf, { cursor: null, ripples: [{ x: 500, y: 300, age: 0.1 }] }, { cursorHeight: 28, scale: 1 });
    const r = RIPPLE.r0 + (RIPPLE.r1 - RIPPLE.r0) * 0.1;
    assert.deepStrictEqual(rgbAt(buf, TILE.cursor + TILE.ripple / 2 + r, TILE.ripple / 2), [255, 214, 10]);
  });

  run('what is drawn is described: the positions to give the overlays', () => {
    const d = drawSheet(buf, { cursor: { x: 100.6, y: 50.2 }, ripples: [{ x: 700.5, y: 400.5, age: 0.2 }] }, { cursorHeight: 28, scale: 1 });
    assert.deepStrictEqual(d[0], { x: 100 - CURSOR_PAD, y: 50 - CURSOR_PAD });
    assert.deepStrictEqual(d[1], { x: 700 - TILE.ripple / 2, y: 400 - TILE.ripple / 2 });
    assert(d[2].x < 0 && d[3].x < 0, 'unused slots are put out of sight');
    const hidden = drawSheet(buf, { cursor: null, ripples: [] }, { cursorHeight: 28, scale: 1 });
    assert(hidden.every((p) => p.x < 0));
    assert.strictEqual(buf.reduce((a, b) => a + b, 0), 0, 'and the sheet is empty');
  });

  run('sizes the overlays rely on', () => {
    assert.strictEqual(SHEET.w, TILE.cursor + SLOTS * TILE.ripple);
    assert.strictEqual(SHEET.h, Math.max(TILE.cursor, TILE.ripple));
    assert(POINTER.cursorHeightOfCard > 0.02 && POINTER.cursorHeightOfCard < 0.06);
  });

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(JSON.stringify(checks, null, 2));
  console.log(failed.length ? `FAIL: ${failed.length} of ${Object.keys(checks).length}` : `OK: ${Object.keys(checks).length} of ${Object.keys(checks).length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
