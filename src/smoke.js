// Smoke test, run with DR_SMOKE=1 (see README.md). It drives the real app with simulated clicks and
// the same calls the drec CLI uses, prints one "SMOKE {...}" line with every check, and quits.
// Checks read the app's state, not its texts, so they hold in every interface language.
const fs = require('fs');
const path = require('path');
const { screen } = require('electron');
const windowTracker = require('./window-tracker');
const { makeCli } = require('./smoke-cli');
const captureSmoke = require('./smoke-capture');

async function run({ app, bubble, clickOverlay, panelWin, listWindows, log, outputDir, setLanguage }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (name) => log(`SMOKE-STEP ${name}`);
  const panel = (js) => panelWin().webContents.executeJavaScript(js);
  const drec = (name, args = {}) => panel(`window.drec.call(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
  const phase = async () => (await drec('status')).data.phase;
  const panelSize = () => panel(`document.querySelector('#bubbleSize .on')?.dataset.size`);
  const checks = {};

  step('start');
  for (let i = 0; i < 40 && !(await panel('Boolean(window.drecReady)')); i++) await wait(500);
  await wait(1500);
  step('read the panel');
  const devices = await panel(`({
    screens: document.querySelectorAll('#screens .screen').length,
    cameras: [...document.querySelectorAll('#camera option')].map((o) => o.textContent),
    mics: document.querySelectorAll('#mic option').length - 1,
  })`);

  step('languages');
  // English by default; Spanish and Portuguese reach the panel, the bubble toolbar and the pill.
  const { toolbar: bar, pill, bubble: bubbleWc } = bubble.contents();
  const texts = async () => ({
    lang: await panel('document.documentElement.lang'),
    record: await panel(`document.getElementById('record').textContent`),
    what: await panel(`document.querySelector('[data-i18n="what.title"]').textContent`),
    empty: await panel(`[...document.querySelectorAll('[data-i18n]')].filter((e) => !e.textContent.trim()).length`),
    pill: await pill.executeJavaScript(`document.getElementById('main').title`),
    toolbar: await bar.executeJavaScript(`document.querySelector('[data-action="small"]').title`),
    screen: await panel(`document.querySelector('#screens .screen span')?.textContent || ''`),
  });
  const en = await texts();
  // The screen names come back from the main process with fresh thumbnails, which can take more than a
  // second and a half, so each language waits for them (up to 6 s) instead of for a fixed time.
  const switchTo = async (lang, screenStart) => {
    setLanguage(lang);
    await wait(1500);
    for (let i = 0; i < 18 && !(await texts()).screen.startsWith(screenStart); i++) await wait(250);
    return texts();
  };
  const es = await switchTo('es', 'Pantalla');
  const pt = await switchTo('pt', 'Tela');
  const back = await switchTo('en', 'Screen');
  Object.assign(checks, {
    'english by default': en.lang === 'en' && en.record === 'Record' && en.what === 'What to record' && en.screen.startsWith('Screen'),
    'spanish everywhere': es.record === 'Grabar' && es.what === 'Qué grabar' && es.pill.startsWith('Grabar') && es.toolbar === 'Pequeña' && es.screen.startsWith('Pantalla'),
    'portuguese everywhere': pt.record === 'Gravar' && pt.what === 'O que gravar' && pt.pill.startsWith('Gravar') && pt.toolbar === 'Pequena' && pt.screen.startsWith('Tela'),
    'back to english': back.lang === 'en' && back.record === 'Record' && back.toolbar === 'Small',
    'no text left empty': en.empty === 0 && es.empty === 0 && pt.empty === 0,
  });
  log(`languages: ${JSON.stringify({ en, es, pt })}`);

  step('sizes');
  const startSmall = bubble.snapshot().bounds;
  bubble.setSize('medium');
  await wait(400);
  const medium = { ...bubble.snapshot(), panel: await panelSize() };
  bubble.setSize('full');
  await wait(400);
  bubble.showToolbar();
  const full = { ...bubble.snapshot(), area: bubble.area(), panel: await panelSize() };
  bubble.setSize('medium'); // leaving full screen goes back to the size before it
  bubble.setSize('small');
  await wait(400);
  bubble.showToolbar();
  const small = bubble.snapshot();
  bubble.hideToolbar();

  // Mouse events into a window, at the centre of the element the selector finds.
  // holdMs keeps the button pressed like a person does (a click takes about 100 to 300 ms),
  // long enough for the recording timer to update the pill between press and release.
  const clickIn = async (wc, selector, holdMs = 0) => {
    const r = await wc.executeJavaScript(`(() => { const b = document.querySelector('${selector}').getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    wc.sendInputEvent({ type: 'mouseMove', ...r });
    wc.sendInputEvent({ type: 'mouseDown', ...r, button: 'left', clickCount: 1 });
    if (holdMs) await wait(holdMs);
    wc.sendInputEvent({ type: 'mouseUp', ...r, button: 'left', clickCount: 1 });
  };
  const HUMAN_CLICK_MS = 400;
  const pillIcon = () => pill.executeJavaScript(`document.getElementById('main').dataset.icon`);

  step('toolbar click');
  bubble.setSize('medium');
  await wait(300);
  bubble.showToolbar();
  await wait(300);
  await clickIn(bar, '[data-action="small"]');
  await wait(500);
  const afterClick = bubble.snapshot();
  const b = afterClick.bounds;
  const p = afterClick.pillBounds;
  await clickIn(bar, '[data-action="close"]');
  await wait(400);
  const closed = bubble.snapshot();
  bubble.setSize('small');
  await wait(400);
  const reopened = bubble.snapshot();

  Object.assign(checks, {
    'toolbar Small click': afterClick.bounds.width === 200,
    'pill visible': afterClick.pillVisible,
    'pill beside the bubble': p.x + p.width <= b.x || p.x >= b.x + b.width,
    'X closes bubble and pill': !closed.visible && !closed.pillVisible,
    'both return with a size': reopened.visible && reopened.pillVisible,
    'medium is 400': medium.bounds.width === 400 && medium.bounds.height === 400,
    'panel stays in sync': medium.panel === 'medium' && full.panel === 'full',
    'full covers the screen': JSON.stringify(full.bounds) === JSON.stringify(full.area),
    'toolbar inside in full': full.toolbarBounds.y + full.toolbarBounds.height <= full.area.y + full.area.height,
    'back to small (200)': small.bounds.width === 200,
    'back near where it was': Math.abs(small.bounds.x - startSmall.x) <= 100 && Math.abs(small.bounds.y - startSmall.y) <= 100,
    'toolbar centred under the bubble': Math.abs((small.toolbarBounds.x + small.toolbarBounds.width / 2) - (small.bounds.x + small.bounds.width / 2)) <= 1,
  });
  // The measurements behind the size checks, so a failure shows what the bubble actually did.
  log(`sizes: start ${JSON.stringify(startSmall)} medium ${JSON.stringify(medium.bounds)} full ${JSON.stringify(full.bounds)} area ${JSON.stringify(full.area)} small ${JSON.stringify(small.bounds)}`);

  step('record from the pill');
  await drec('apply', { mode: 'screen', systemAudio: true });
  checks['pill shows record'] = (await pillIcon()) === 'record';
  await clickIn(pill, '#main', HUMAN_CLICK_MS);
  await wait(3500 + 2000); // countdown, then 2 seconds of recording
  checks['pill shows stop while recording'] = (await pillIcon()) === 'stop';
  await clickIn(pill, '#pause', HUMAN_CLICK_MS);
  await wait(1000);
  checks['one click pauses'] = (await phase()) === 'paused';
  await clickIn(pill, '#pause', HUMAN_CLICK_MS);
  await wait(2000);
  checks['one click resumes'] = (await phase()) === 'recording';
  await clickIn(pill, '#main', HUMAN_CLICK_MS);
  await wait(500);
  checks['one click stops'] = (await pillIcon()) !== 'stop';
  let saved = null;
  for (let i = 0; i < 60; i++) {
    const s = (await drec('status')).data;
    if (s.phase === 'idle') { saved = s.lastFile; break; }
    await wait(1000);
  }
  checks['screen MP4 saved'] = Boolean(saved) && fs.existsSync(saved);
  checks['file named in the language'] = Boolean(saved) && path.basename(saved).startsWith('Recording ');

  step('click highlights');
  // The overlay must cover the recorded screen while recording and draw a circle for a click.
  await drec('apply', { mode: 'screen', clicks: true, systemAudio: false });
  const clickStart = await drec('start');
  await wait(800);
  const ov = clickOverlay.snapshot();
  const displays = screen.getAllDisplays();
  const recorded = displays.find((d) => JSON.stringify(d.bounds) === JSON.stringify(ov.bounds));
  ov.contents.send('click-at', { x: 200, y: 200 });
  await wait(150);
  const ripples = await ov.contents.executeJavaScript('window.rippleCount()');
  const clickStop = await drec('stop');
  await wait(300);
  checks['click overlay over the recorded screen'] = clickStart.ok && ov.visible && Boolean(recorded);
  checks['click hook running'] = ov.hookRunning && !ov.hookError;
  checks['click circle drawn'] = ripples > 0;
  checks['overlay removed on stop'] = clickStop.ok && !clickOverlay.snapshot().visible && !clickOverlay.snapshot().hookRunning;
  if (ov.hookError) log(`clicks: ${ov.hookError}`);
  await drec('apply', { clicks: false });

  step('effects');
  await drec('apply', { background: 'blur', border: true, borderColor: '#e5383b' });
  let fx = {};
  for (let i = 0; i < 40; i++) {
    fx = await bubbleWc.executeJavaScript('window.bubbleStatus()');
    if (fx.effectReady || fx.error) break;
    await wait(500);
  }
  const ring = await bubbleWc.executeJavaScript(`getComputedStyle(document.getElementById('bubble')).borderTopColor`);
  checks['blur loads in the bubble'] = Boolean(fx.effectReady) && !fx.error;
  checks['red ring on the bubble'] = ring === 'rgb(229, 56, 59)';

  step('record a window');
  const wins = await listWindows(false);
  checks['windows to record'] = wins.length > 0;
  if (wins.length) {
    await drec('apply', { mode: 'window', window: { id: wins[0].id, name: wins[0].name }, systemAudio: false, clicks: true });
    const started = await drec('start');
    // The window's position comes from a PowerShell helper that takes a moment to start.
    let rect = null;
    for (let i = 0; i < 60 && !(rect = clickOverlay.snapshot().windowRect); i++) await wait(250); // up to 15 s on a busy PC
    const winSnap = clickOverlay.snapshot();
    if (rect) clickOverlay.simulateClick(Math.round((rect.left + rect.right) / 2), Math.round((rect.top + rect.bottom) / 2));
    await wait(150);
    const windowRipples = await panel('window.clickRippleCount()');
    // The bubble just inside the window's top-left corner must give a camera spot near the top-left
    // of the window's video, whatever screen the window is on (the case a user hit with a window
    // on the second screen). The panel reads it through the same call the compositor uses.
    let cameraSpot = null;
    const INSET = 40; // physical pixels from the window's corner
    if (rect) {
      const target = screen.screenToDipRect(null, { x: rect.left + INSET, y: rect.top + INSET, width: 1, height: 1 });
      bubble.moveTo(target.x, target.y);
      await wait(200);
      cameraSpot = await panel('window.api.bubblePlacement()');
    }
    const expected = rect ? { x: INSET / (rect.right - rect.left), y: INSET / (rect.bottom - rect.top) } : null;
    await wait(1500);
    const stopped = await drec('stop');
    checks['records a window'] = started.ok && stopped.ok && fs.existsSync(stopped.data.file);
    checks['follows the window position'] = Boolean(rect) && winSnap.mode === 'window' && !winSnap.visible;
    checks['click inside the window is in the video'] = windowRipples > 0;
    const CLOSE = 0.02; // within 2% of the window's size
    checks['camera where the bubble covers the window'] = Boolean(cameraSpot) && Math.abs(cameraSpot.x - expected.x) < CLOSE && Math.abs(cameraSpot.y - expected.y) < CLOSE;
    log(`camera in window: expected ${JSON.stringify(expected)} got ${JSON.stringify(cameraSpot)} window ${JSON.stringify(rect)}`);
    if (!stopped.ok) log(`window: ${stopped.error || started.error}`);
    await drec('apply', { clicks: false });
  }

  // A user's case: a window on the right half of the second screen. A made-up window position
  // there, and the bubble placed just inside its top-left corner.
  const second = screen.getAllDisplays().find((d) => d.id !== screen.getPrimaryDisplay().id);
  if (second) {
    const half = { x: second.bounds.x + second.bounds.width / 2, y: second.bounds.y, width: second.bounds.width / 2, height: second.bounds.height };
    const phys = screen.dipToScreenRect(null, half);
    const fakeWindow = { left: phys.x, top: phys.y, right: phys.x + phys.width, bottom: phys.y + phys.height };
    bubble.moveTo(half.x + 40, half.y + 40);
    await wait(200);
    const spot = bubble.placement(fakeWindow);
    const scale = second.scaleFactor;
    checks['camera right in a window on the second screen'] = Boolean(spot)
      && Math.abs(spot.x - (40 * scale) / phys.width) < 0.02 && Math.abs(spot.y - (40 * scale) / phys.height) < 0.02;
    log(`second screen: window ${JSON.stringify(fakeWindow)} camera ${JSON.stringify(spot)}`);
    bubble.placeOn(screen.getPrimaryDisplay().id);
  }

  step('camera only with blur');
  await drec('apply', { mode: 'camera' });
  await wait(1500);
  const camStart = await drec('start');
  await wait(3000);
  const camStop = await drec('stop');
  checks['records camera only with the effect'] = camStart.ok && camStop.ok && fs.existsSync(camStop.data.file);
  if (!camStop.ok) log(`camera: ${camStop.error || camStart.error}`);

  step('drec cli');
  const cli = makeCli(app);
  const cliScreens = await cli(['screens']);
  const cliWindows = await cli(['windows']);
  const cliSet = await cli(['set', '--mode', 'screen', '--screen', '1', '--bubble', 'small', '--clicks', 'off']);
  const cliStart = await cli(['start']);
  await wait(1500);
  const cliPause = await cli(['pause']);
  const cliResume = await cli(['resume']);
  await wait(1000);
  const cliStop = await cli(['stop']);
  const cliVersion = await cli(['version']);
  const cliDoctor = await cli(['doctor']);
  const probedDoctor = await cli(['doctor', '--probe-cursor', 'on']); // moves the mouse for about 30 s
  const cornerSet = await cli(['set', '--screen', '1', '--bubble-corner', 'bottom-right']);
  await wait(300);
  const cornerBounds = bubble.snapshot().bounds;
  const area1 = screen.getDisplayMatching(cornerBounds); // the screen the bubble ended up on
  const otherDir = path.join(outputDir(), 'cli-folder');
  const dirSet = await cli(['set', '--output-dir', otherDir]);
  const dirReset = await cli(['set', '--output-dir', 'default']);
  const badCorner = await cli(['set', '--bubble-corner', 'middle-ish']);
  checks['drec version'] = cliVersion.code === 0 && String(cliVersion.data).startsWith(app.getVersion()) && /\((dev|built \d{4}-\d\d-\d\d \d\d:\d\d)\)$/.test(cliVersion.data);
  checks['drec doctor checks everything'] = Array.isArray(cliDoctor.data?.checks) && cliDoctor.data.checks.length === 8 && cliDoctor.data.checks[0].ok;
  // The probe tells what each kind of capture does with the cursor (the settings folder is reused, so a
  // plain doctor may already know the answer from an earlier run).
  const cursorLine = (d) => d?.checks?.find((c) => c.name === 'cursor capture')?.detail || '';
  checks['doctor has a cursor capture line'] = cursorLine(cliDoctor.data).length > 0;
  checks['doctor --probe-cursor reports screen and window'] = probedDoctor.code === 0
    && /^screen .+; window .+ \(tested \d{4}-\d\d-\d\d\)$/.test(cursorLine(probedDoctor.data))
    && !/could not be tested/.test(cursorLine(probedDoctor.data));
  log(`cursor capture: ${cursorLine(probedDoctor.data)}`);
  checks['drec bubble-corner bottom-right'] = cornerSet.code === 0
    && Math.abs(cornerBounds.x + cornerBounds.width - (area1.workArea.x + area1.workArea.width - 40)) <= 2
    && Math.abs(cornerBounds.y + cornerBounds.height - (area1.workArea.y + area1.workArea.height - 40)) <= 2;
  checks['drec output-dir changes the folder'] = dirSet.code === 0 && dirSet.data.outputDir === otherDir && fs.existsSync(otherDir);
  checks['drec output-dir default restores it'] = dirReset.code === 0 && dirReset.data.outputDir !== otherDir;
  checks['drec rejects a bad corner'] = badCorner.code === 1 && /bubble-corner/.test(badCorner.err);
  const langEs = await cli(['set', '--language', 'es']);
  await wait(800);
  const recordEs = await panel(`document.getElementById('record').textContent`);
  const langEn = await cli(['set', '--language', 'en']);
  const badLang = await cli(['set', '--language', 'klingon']);
  checks['drec language switches the app'] = langEs.code === 0 && langEs.data.language === 'es' && recordEs === 'Grabar' && langEn.data?.language === 'en';
  checks['drec rejects an unknown language'] = badLang.code === 1 && /language/.test(badLang.err);

  // In window mode the corner is the window's own (an agent found it landed in the screen's corner).
  if (wins.length) {
    const winCorner = await cli(['set', '--window', wins[0].name, '--bubble-corner', 'bottom-right']);
    const winRect = await windowTracker.readOnce(wins[0].id);
    await wait(300);
    const bb = screen.dipToScreenRect(null, bubble.snapshot().bounds); // physical, like winRect
    const work = screen.dipToScreenRect(null, screen.getDisplayMatching(bubble.snapshot().bounds).workArea);
    const SLACK = 40; // the 24 px gap at any scaling, plus rounding
    const nearRight = Math.abs(bb.x + bb.width - Math.min(winRect ? winRect.right : 0, work.x + work.width)) <= SLACK;
    const nearBottom = Math.abs(bb.y + bb.height - Math.min(winRect ? winRect.bottom : 0, work.y + work.height)) <= SLACK;
    checks['drec bubble-corner uses the window corner'] = winCorner.code === 0 && Boolean(winRect) && nearRight && nearBottom;
    log(`window corner: window ${JSON.stringify(winRect)} bubble ${JSON.stringify(bb)}`);
  }
  if (cliDoctor.data) log(`doctor: ${cliDoctor.data.checks.map((c) => `${c.name}=${c.ok}`).join(' ')}`);
  const badToken = await cli(['status'], { DREC_TOKEN_FILE: path.join(__dirname, 'no-such-token') });
  const badValue = await cli(['set', '--bubble', 'giant']);
  checks['drec screens'] = cliScreens.code === 0 && Array.isArray(cliScreens.data) && cliScreens.data.length === screen.getAllDisplays().length;
  checks['drec windows'] = cliWindows.code === 0 && Array.isArray(cliWindows.data);
  checks['drec set'] = cliSet.code === 0 && cliSet.data.screenNumber === 1 && cliSet.data.mode === 'screen';
  checks['drec start records'] = cliStart.code === 0 && cliStart.data.phase === 'recording';
  checks['drec pause and resume'] = cliPause.data?.phase === 'paused' && cliResume.data?.phase === 'recording';
  checks['drec stop returns the MP4'] = cliStop.code === 0 && Boolean(cliStop.data?.file) && fs.existsSync(cliStop.data.file);
  checks['drec rejects a wrong token'] = badToken.code === 1 && /token/.test(badToken.err);
  checks['drec reports a bad value'] = badValue.code === 1 && /bubble/.test(badValue.err);
  for (const [name, r] of Object.entries({ cliScreens, cliSet, cliStart, cliStop })) if (r.code !== 0) log(`${name}: ${r.err}`);

  step('capture project');
  Object.assign(checks, await captureSmoke.steps({ app, bubble, clickOverlay, listWindows, log }));

  // Leaves the test's own settings as a fresh install has them.
  await drec('apply', { mode: 'screen', background: 'none', border: false, systemAudio: false });

  const files = fs.existsSync(outputDir()) ? fs.readdirSync(outputDir()) : [];
  log('SMOKE ' + JSON.stringify({ ...devices, displays: screen.getAllDisplays().length, windows: wins.length, checks, files }));
  app.quit();
}

module.exports = { run };
