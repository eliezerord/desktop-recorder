// Checks where the Card and the Bubble go, without ffmpeg or any window. Run: node test/look-test.js
// The same layout function places things in the preview and in Export (src/look.mjs).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SCREEN = { w: 1920, h: 1080 };
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectOf = (b) => ({ x: b.x, y: b.y, w: b.d, h: b.d });

(async () => {
  const look = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'look.mjs')).href);
  const { layout, BACKGROUNDS, DEFAULT_LOOK, ASPECTS } = look;
  const base = { canvas: SCREEN, source: SCREEN, hasCamera: true, bubbleSize: 'small' };
  const checks = {};
  const run = (name, fn) => { try { fn(); checks[name] = true; } catch (err) { checks[name] = false; console.error(`${name}: ${err.message}`); } };

  run('inside: card keeps the source shape, inside the margins, centred', () => {
    const { card } = layout({ ...base, hasCamera: false, look: { ...DEFAULT_LOOK, bubblePlace: 'inside' } });
    assert(Math.abs(card.w / card.h - 16 / 9) < 0.01, 'aspect');
    assert(card.x > 0 && card.y > 0 && card.x + card.w < SCREEN.w && card.y + card.h < SCREEN.h, 'margins');
    assert.strictEqual(card.x * 2 + card.w, SCREEN.w, 'centred across');
    assert.strictEqual(card.y * 2 + card.h, SCREEN.h, 'centred down');
    assert([card.x, card.y, card.w, card.h].every((n) => n % 2 === 0), 'even numbers');
    assert(card.r > 0, 'rounded corners');
  });

  run('inside: the bubble sits inside the card, in the chosen corner', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      const { card, bubble } = layout({ ...base, look: { ...DEFAULT_LOOK, bubblePlace: 'inside', bubbleCorner: corner } });
      assert(bubble.x >= card.x && bubble.y >= card.y && bubble.x + bubble.d <= card.x + card.w && bubble.y + bubble.d <= card.y + card.h, `${corner} inside`);
      assert.strictEqual(bubble.x < card.x + card.w / 2, corner.endsWith('left'), `${corner} side`);
      assert.strictEqual(bubble.y < card.y + card.h / 2, corner.startsWith('top'), `${corner} height`);
    }
  });

  run('outside: the bubble is on the background and never touches the card', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      for (const size of ['small', 'medium']) {
        const { card, bubble } = layout({ ...base, bubbleSize: size, look: { ...DEFAULT_LOOK, bubblePlace: 'outside', bubbleCorner: corner } });
        assert(!intersects(card, rectOf(bubble)), `${corner} ${size} overlaps`);
        assert(bubble.x > 0 && bubble.y > 0 && bubble.x + bubble.d < SCREEN.w && bubble.y + bubble.d < SCREEN.h, `${corner} ${size} on canvas`);
        assert(card.x >= 0 && card.y >= 0 && card.x + card.w <= SCREEN.w && card.y + card.h <= SCREEN.h, `${corner} ${size} card on canvas`);
        assert.strictEqual(bubble.x < SCREEN.w / 2, corner.endsWith('left'), `${corner} side`);
        assert.strictEqual(bubble.y < SCREEN.h / 2, corner.startsWith('top'), `${corner} height`);
      }
    }
  });

  run('outside: the card shrinks to make room, and no camera gives the room back', () => {
    const outside = layout({ ...base, look: { ...DEFAULT_LOOK, bubblePlace: 'outside' } }).card;
    const noCamera = layout({ ...base, hasCamera: false, look: { ...DEFAULT_LOOK, bubblePlace: 'outside' } });
    assert(outside.w < noCamera.card.w, 'smaller with a bubble');
    assert.strictEqual(noCamera.bubble, null, 'no bubble without a camera');
  });

  run('odd source sizes still give even card sizes', () => {
    const { card } = layout({ ...base, source: { w: 1281, h: 721 }, look: DEFAULT_LOOK });
    assert([card.x, card.y, card.w, card.h].every((n) => n % 2 === 0), `${JSON.stringify(card)}`);
    assert(Math.abs(card.w / card.h - 1281 / 721) < 0.02, 'aspect');
  });

  run('a tall source fits the height', () => {
    const { card } = layout({ ...base, source: { w: 1080, h: 1920 }, hasCamera: false, look: DEFAULT_LOOK });
    assert(card.h < SCREEN.h && card.w < card.h, JSON.stringify(card));
  });

  run('a canvas that is neither 16:9 nor 9:16 is refused', () => {
    assert.throws(() => layout({ ...base, canvas: { w: 1440, h: 1080 }, look: DEFAULT_LOOK }), /16:9 or 9:16/);
  });

  run('the two canvases', () => {
    assert.deepStrictEqual(ASPECTS['16:9'], { w: 1920, h: 1080 });
    assert.deepStrictEqual(ASPECTS['9:16'], { w: 1080, h: 1920 });
  });

  // ---- Vertical (9:16): the Card fills the width, the rest of the canvas is Background.
  const TALL = ASPECTS['9:16'];
  const vertical = { ...base, canvas: TALL };
  const margin = 54; // 5% of the shorter side, the same as in 16:9

  run('vertical: the Card fills the width with the usual margin and sits in the middle', () => {
    const { card } = layout({ ...vertical, hasCamera: false, look: DEFAULT_LOOK });
    assert.strictEqual(card.x, margin);
    assert.strictEqual(card.w, TALL.w - 2 * margin);
    assert(Math.abs(card.w / card.h - 16 / 9) < 0.01, 'keeps the source shape');
    assert(Math.abs(card.y * 2 + card.h - TALL.h) <= 2, 'centred down');
    assert(card.r > 0 && card.r < 40, `corner ${card.r} is the same size as in 16:9`);
  });

  run('vertical: an outside Bubble goes above or below the Card, in its corner, and never touches it', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      for (const size of ['small', 'medium']) {
        const { card, bubble } = layout({ ...vertical, bubbleSize: size, look: { ...DEFAULT_LOOK, bubblePlace: 'outside', bubbleCorner: corner } });
        assert(!intersects(card, rectOf(bubble)), `${corner} ${size} overlaps`);
        assert(bubble.x >= margin && bubble.x + bubble.d <= TALL.w - margin && bubble.y >= margin && bubble.y + bubble.d <= TALL.h - margin, `${corner} ${size} on canvas`);
        assert.strictEqual(bubble.x < TALL.w / 2, corner.endsWith('left'), `${corner} side`);
        assert.strictEqual(bubble.y < card.y, corner.startsWith('top'), `${corner} above or below`);
        const topSpace = Math.min(card.y, bubble.y);
        const bottomSpace = TALL.h - Math.max(card.y + card.h, bubble.y + bubble.d);
        assert(Math.abs(topSpace - bottomSpace) <= 2, `${corner} ${size}: Card and Bubble sit as one block in the middle (${topSpace} above, ${bottomSpace} below)`);
      }
    }
  });

  run('vertical: an inside Bubble sits in the Card', () => {
    const { card, bubble } = layout({ ...vertical, look: { ...DEFAULT_LOOK, bubblePlace: 'inside', bubbleCorner: 'top-right' } });
    assert(bubble.x >= card.x && bubble.y >= card.y && bubble.x + bubble.d <= card.x + card.w && bubble.y + bubble.d <= card.y + card.h);
  });

  run('vertical: the Bubble is as big as in 16:9, not stretched by the taller canvas', () => {
    const wide = layout({ ...base, look: DEFAULT_LOOK }).bubble.d;
    assert.strictEqual(layout({ ...vertical, look: DEFAULT_LOOK }).bubble.d, wide);
  });

  run('vertical: a phone-shaped source fills the height it is given', () => {
    const { card } = layout({ ...vertical, source: { w: 1080, h: 1920 }, hasCamera: false, look: DEFAULT_LOOK });
    assert(card.h > 1700 && card.w <= TALL.w - 2 * margin, JSON.stringify(card));
  });

  run('8 to 10 built-in backgrounds, each drawable', () => {
    assert(BACKGROUNDS.length >= 8 && BACKGROUNDS.length <= 10, `${BACKGROUNDS.length}`);
    assert.strictEqual(new Set(BACKGROUNDS.map((b) => b.id)).size, BACKGROUNDS.length, 'unique ids');
    assert(BACKGROUNDS.every((b) => /^#[0-9a-f]{6}$/i.test(b.stops[0][1]) && b.stops.length >= 2), 'two or more colour stops');
    assert(BACKGROUNDS.some((b) => b.id === DEFAULT_LOOK.background), 'the default exists');
  });

  run('normalizeLook fills the defaults and explains a wrong value', () => {
    const { normalizeLook } = look;
    assert.deepStrictEqual(normalizeLook({}), DEFAULT_LOOK);
    assert.strictEqual(normalizeLook({ background: 'rose' }).background, 'rose');
    assert.throws(() => normalizeLook({ background: 'nope' }), /background.*ocean/s);
    assert.throws(() => normalizeLook({ bubblePlace: 'middle' }), /inside or outside/);
    assert.throws(() => normalizeLook({ bubbleCorner: 'centre' }), /top-left/);
    assert.strictEqual(normalizeLook({ aspect: '9:16' }).aspect, '9:16');
    assert.throws(() => normalizeLook({ aspect: '4:3' }), /16:9 or 9:16/);
    assert.strictEqual(DEFAULT_LOOK.zoom, true);
    assert.strictEqual(DEFAULT_LOOK.cursor, true);
    assert.strictEqual(DEFAULT_LOOK.clicks, true);
    assert.strictEqual(normalizeLook({ cursor: false, clicks: false }).cursor, false);
    assert.throws(() => normalizeLook({ cursor: 'x' }), /cursor: use on or off/);
    assert.throws(() => normalizeLook({ clicks: 1 }), /clicks: use on or off/);
    assert.strictEqual(normalizeLook({ zoom: false }).zoom, false);
    assert.throws(() => normalizeLook({ zoom: 'maybe' }), /zoom: use on or off/);
  });

  run('margin: a number from 0 to 15 percent of the shorter side, 5 by default', () => {
    assert.strictEqual(DEFAULT_LOOK.margin, 5);
    const { normalizeLook } = look;
    assert.strictEqual(normalizeLook({ margin: 0 }).margin, 0);
    assert.strictEqual(normalizeLook({ margin: 12.5 }).margin, 12.5);
    for (const bad of [-1, 16, 'wide', NaN]) assert.throws(() => normalizeLook({ margin: bad }), /margin: use a number from 0 to 15/, String(bad));
  });

  run('margin moves the Card: 0 fills the canvas, 10 leaves twice the space of 5', () => {
    const at = (margin) => layout({ ...base, hasCamera: false, look: { ...DEFAULT_LOOK, margin } }).card;
    assert.deepStrictEqual([at(0).x, at(0).y, at(0).w, at(0).h], [0, 0, 1920, 1080]);
    // a 16:9 screen in a 16:9 canvas is held back by the height, so the margin shows above and below it
    assert.strictEqual(at(5).y, 54);
    assert.strictEqual(at(10).y, 108);
    assert(at(10).w < at(5).w && at(5).w < at(0).w);
    // in 9:16 the width holds it back, so the same margin shows at the sides
    const tall = layout({ ...vertical, hasCamera: false, look: { ...DEFAULT_LOOK, margin: 10 } }).card;
    assert.strictEqual(tall.x, 108, 'the same margin in 9:16');
  });

  run('a margin keeps an outside Bubble clear of the Card', () => {
    for (const margin of [0, 2, 10, 15]) {
      for (const canvas of [SCREEN, ASPECTS['9:16']]) {
        const { card, bubble } = layout({ ...base, canvas, look: { ...DEFAULT_LOOK, margin, bubblePlace: 'outside' } });
        assert(!intersects(card, rectOf(bubble)), `margin ${margin} on ${canvas.w}x${canvas.h}`);
        assert(bubble.x >= 0 && bubble.y >= 0 && bubble.x + bubble.d <= canvas.w && bubble.y + bubble.d <= canvas.h, `margin ${margin} on canvas`);
      }
    }
  });

  run('a Background picture is a path, or nothing', () => {
    const { normalizeLook } = look;
    assert.strictEqual(normalizeLook({}).backgroundImage, undefined);
    assert.strictEqual(normalizeLook({ backgroundImage: null }).backgroundImage, null);
    assert.strictEqual(normalizeLook({ backgroundImage: 'C:/a.png' }).backgroundImage, 'C:/a.png');
    assert.throws(() => normalizeLook({ backgroundImage: 5 }), /background-image: use the path of a picture/);
  });

  run('card corners: 0 to 6 percent of the shorter side, the old 2.2 by default, and the Card follows', () => {
    assert.strictEqual(DEFAULT_LOOK.cardCorners, 2.2);
    assert.strictEqual(layout({ ...base, look: DEFAULT_LOOK }).card.r, 24); // what Export drew before ticket 09
    assert.strictEqual(layout({ ...base, look: { ...DEFAULT_LOOK, cardCorners: 0 } }).card.r, 0);
    assert.strictEqual(layout({ ...base, look: { ...DEFAULT_LOOK, cardCorners: 5 } }).card.r, 54);
    assert.throws(() => look.normalizeLook({ cardCorners: 7 }), /card-corners: use a number from 0 to 6/);
    assert.throws(() => look.normalizeLook({ cardCorners: 'round' }), /card-corners/);
  });

  run('resolveLook: the default look, then the Project\'s own look, then what is asked now', () => {
    const r = look.resolveLook({
      defaults: { background: 'dusk', margin: 8, aspect: '9:16', backgroundImage: 'C:/default.png' },
      project: { exportLook: { margin: 3, backgroundImage: null } },
      asked: { aspect: '16:9' },
    });
    assert.deepStrictEqual([r.background, r.margin, r.aspect, r.backgroundImage], ['dusk', 3, '16:9', null]);
    assert.deepStrictEqual(look.resolveLook({ defaults: {}, project: {}, asked: {} }), {});
    assert.deepStrictEqual([...look.PROJECT_LOOK_KEYS].sort(), ['aspect', 'background', 'backgroundImage', 'bubbleCorner', 'bubblePlace', 'bubbleShape', 'bubbleSize', 'cardCorners', 'clicks', 'cursor', 'margin', 'zoom']);
  });

  run('bubble shape: a circle by default, or a rounded rectangle of the same size and place', () => {
    const { normalizeLook, BUBBLE_SHAPES } = look;
    assert.deepStrictEqual(BUBBLE_SHAPES, ['circle', 'rounded']);
    assert.strictEqual(DEFAULT_LOOK.bubbleShape, 'circle');
    assert.strictEqual(normalizeLook({}).bubbleShape, 'circle', 'older Projects stay round');
    assert.throws(() => normalizeLook({ bubbleShape: 'square' }), /bubble-shape: use circle or rounded/);
    for (const canvas of [ASPECTS['16:9'], ASPECTS['9:16']]) {
      for (const place of ['inside', 'outside']) {
        const round = layout({ ...base, canvas, look: { ...DEFAULT_LOOK, bubblePlace: place } }).bubble;
        const rounded = layout({ ...base, canvas, look: { ...DEFAULT_LOOK, bubblePlace: place, bubbleShape: 'rounded' } }).bubble;
        assert.strictEqual(round.r, round.d / 2, 'a circle');
        assert.deepStrictEqual([rounded.x, rounded.y, rounded.d], [round.x, round.y, round.d], `${place} ${canvas.w}: same size and place`);
        assert(rounded.r > 0 && rounded.r < rounded.d / 4, `${place} ${canvas.w}: rounded corners ${rounded.r} of ${rounded.d}`);
      }
    }
  });

  run('bubble size: left out it is the recorded size; set, it is that percent of the shorter side', () => {
    assert.strictEqual(DEFAULT_LOOK.bubbleSize, undefined);
    assert.strictEqual(layout({ ...base, look: DEFAULT_LOOK }).bubble.d, 216); // small, as recorded
    for (const place of ['inside', 'outside']) {
      for (const canvas of [ASPECTS['16:9'], ASPECTS['9:16']]) {
        const { bubble, card } = layout({ ...base, canvas, look: { ...DEFAULT_LOOK, bubblePlace: place, bubbleSize: 30 } });
        assert.strictEqual(bubble.d, 324, `${place} ${canvas.w}`);
        if (place === 'outside') assert(!intersects(rectOf(bubble), card), `${place} ${canvas.w} touches the Card`);
        assert(bubble.x >= 0 && bubble.y >= 0 && bubble.x + bubble.d <= canvas.w && bubble.y + bubble.d <= canvas.h, `${place} ${canvas.w} off the canvas`);
      }
    }
    const { normalizeLook, BUBBLE_SIZE_RANGE } = look;
    assert.deepStrictEqual(BUBBLE_SIZE_RANGE, { min: 10, max: 40 });
    assert.strictEqual(normalizeLook({ bubbleSize: null }).bubbleSize, null);
    assert.throws(() => normalizeLook({ bubbleSize: 60 }), /bubble-size: use a number from 10 to 40/);
    assert.throws(() => normalizeLook({ bubbleSize: 'big' }), /bubble-size/);
  });

  run('bubbleSpot: where a dragged Bubble lands, from the spot it is dropped on', () => {
    const { bubbleSpot } = look;
    for (const canvas of [ASPECTS['16:9'], ASPECTS['9:16']]) {
      const { card } = layout({ ...base, canvas, look: { ...DEFAULT_LOOK, bubblePlace: 'inside' } });
      const at = (fx, fy) => bubbleSpot({ canvas, card, x: card.x + fx * card.w, y: card.y + fy * card.h });
      assert.deepStrictEqual(at(0.2, 0.2), { bubblePlace: 'inside', bubbleCorner: 'top-left' }, `${canvas.w} top-left`);
      assert.deepStrictEqual(at(0.8, 0.9), { bubblePlace: 'inside', bubbleCorner: 'bottom-right' }, `${canvas.w} bottom-right`);
      // Just past the Card's edge, on the Background: outside, on that side.
      assert.deepStrictEqual(bubbleSpot({ canvas, card, x: card.x + 0.1 * card.w, y: card.y + card.h + 5 }), { bubblePlace: 'outside', bubbleCorner: 'bottom-left' }, `${canvas.w} below`);
      assert.deepStrictEqual(bubbleSpot({ canvas, card, x: card.x + 0.9 * card.w, y: card.y - 5 }), { bubblePlace: 'outside', bubbleCorner: 'top-right' }, `${canvas.w} above`);
    }
  });

  run('drec help lists the card corners option', () => {
    const help = fs.readFileSync(path.join(__dirname, '..', 'cli', 'drec.js'), 'utf8');
    assert(/--card-corners PERCENT/.test(help) && /--look-card-corners/.test(help) && /\bedit \[project\]/.test(help));
    assert(/--bubble-size PERCENT/.test(help) && /--look-bubble-size/.test(help), 'the bubble size options');
  });

  run('drec help lists the default-look options and the picture options', () => {
    const help = fs.readFileSync(path.join(__dirname, '..', 'cli', 'drec.js'), 'utf8');
    for (const word of ['--bubble-shape circle|rounded', '--look-bubble-shape', '--look-background', '--look-background-image', '--look-bubble-place', '--look-bubble-corner', '--look-aspect', '--look-margin', '--look-zoom', '--look-cursor', '--look-clicks', '--look-reset', '--background-image', '--margin']) assert(help.includes(word), `${word} is missing from the help text`);
  });

  run('drec help lists both aspects and the trim options', () => {
    const help = fs.readFileSync(path.join(__dirname, '..', 'cli', 'drec.js'), 'utf8');
    for (const word of ['--aspect', '16:9|9:16', '--trim-start', '--trim-end']) assert(help.includes(word), `${word} is missing from the help text`);
  });

  run('drec help lists the Zoom commands', () => {
    const help = fs.readFileSync(path.join(__dirname, '..', 'cli', 'drec.js'), 'utf8');
    for (const word of ['zooms [project]', 'zoom-add <project> --at SECONDS', 'zoom-strength <project> <number> <strength>', 'zoom-delete <project> <number>', '--aim X,Y', 'layouts [project]', 'layout-add <project> --at SECONDS --kind card|screen|camera|split [--swap on]', 'layout-change <project> <number> [--kind', '[--swap on|off]', 'layout-move <project> <number> --at SECONDS', 'layout-delete <project> <number>']) assert(help.includes(word), `${word} is missing from the help text`);
  });

  run('drec help lists every background', () => {
    const help = fs.readFileSync(path.join(__dirname, '..', 'cli', 'drec.js'), 'utf8');
    for (const b of BACKGROUNDS) assert(help.includes(b.id), `${b.id} is missing from the help text`);
  });

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
  console.log(JSON.stringify(checks, null, 2));
  console.log(failed.length ? `FAIL: ${failed.length} of ${Object.keys(checks).length}` : `OK: ${Object.keys(checks).length} of ${Object.keys(checks).length}`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err.message); process.exit(1); });
