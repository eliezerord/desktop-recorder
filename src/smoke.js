// Smoke test, run with DR_SMOKE=1 (see README.md). It drives the real app with simulated clicks and
// the same calls the drec CLI uses, prints one "SMOKE {...}" line with every check, and quits.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { screen } = require('electron');
const windowTracker = require('./window-tracker');

async function run({ app, bubble, clickOverlay, panelWin, listWindows, log, outputDir }) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const step = (name) => log(`SMOKE-STEP ${name}`);
  const panel = (js) => panelWin().webContents.executeJavaScript(js);
  const drec = (name, args = {}) => panel(`window.drec.call(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
  const panelSize = () => panel(`document.querySelector('#bubbleSize .on')?.dataset.size`);
  const checks = {};

  step('arranque');
  for (let i = 0; i < 40 && !(await panel('Boolean(window.drecReady)')); i++) await wait(500);
  await wait(1500);
  step('leyendo el panel');
  const devices = await panel(`({
    screens: document.querySelectorAll('#screens .screen').length,
    cameras: [...document.querySelectorAll('#camera option')].map((o) => o.textContent),
    mics: document.querySelectorAll('#mic option').length - 1,
  })`);

  step('tamaños');
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
  const { toolbar: bar, pill, bubble: bubbleWc } = bubble.contents();
  const pillMain = () => pill.executeJavaScript(`document.getElementById('main').title`);

  step('clic en la barra');
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
    'clic en Pequeña de la barra': afterClick.bounds.width === 200,
    'pastilla visible': afterClick.pillVisible,
    'pastilla al lado, sin tapar la burbuja': p.x + p.width <= b.x || p.x >= b.x + b.width,
    'la X cierra burbuja y pastilla': !closed.visible && !closed.pillVisible,
    'vuelven al elegir tamaño': reopened.visible && reopened.pillVisible,
    'mediana mide 400': medium.bounds.width === 400 && medium.bounds.height === 400,
    'el panel se sincroniza': medium.panel === 'medium' && full.panel === 'full',
    'completa cubre la pantalla': JSON.stringify(full.bounds) === JSON.stringify(full.area),
    'barra dentro en completa': full.toolbarBounds.y + full.toolbarBounds.height <= full.area.y + full.area.height,
    'vuelve a pequeña (200)': small.bounds.width === 200,
    'vuelve cerca de donde estaba': Math.abs(small.bounds.x - startSmall.x) <= 100 && Math.abs(small.bounds.y - startSmall.y) <= 100,
    'barra centrada bajo la burbuja': Math.abs((small.toolbarBounds.x + small.toolbarBounds.width / 2) - (small.bounds.x + small.bounds.width / 2)) <= 1,
  });
  // The measurements behind the size checks, so a failure shows what the bubble actually did.
  log(`medidas: inicio ${JSON.stringify(startSmall)} mediana ${JSON.stringify(medium.bounds)} completa ${JSON.stringify(full.bounds)} área ${JSON.stringify(full.area)} pequeña ${JSON.stringify(small.bounds)}`);

  step('grabación desde la pastilla');
  await drec('apply', { mode: 'screen', systemAudio: true });
  checks['pastilla dice Grabar'] = (await pillMain()).startsWith('Grabar');
  await clickIn(pill, '#main', HUMAN_CLICK_MS);
  await wait(3500 + 2000); // countdown, then 2 seconds of recording
  checks['pastilla dice Parar al grabar'] = (await pillMain()).startsWith('Parar');
  await clickIn(pill, '#pause', HUMAN_CLICK_MS);
  await wait(1000);
  checks['pausa con un toque'] = (await panel(`document.getElementById('status').textContent`)) === 'En pausa.';
  await clickIn(pill, '#pause', HUMAN_CLICK_MS);
  await wait(2000);
  checks['reanuda con un toque'] = (await panel(`document.getElementById('status').textContent`)) === 'Grabando.';
  await clickIn(pill, '#main', HUMAN_CLICK_MS);
  await wait(500);
  checks['para con un toque'] = !(await pillMain()).startsWith('Parar');
  let status = '';
  for (let i = 0; i < 60 && !/Guardado|No se pudo/.test(status); i++) {
    await wait(1000);
    status = await panel(`document.getElementById('status').textContent`);
  }
  checks['MP4 de pantalla guardado'] = status.startsWith('Guardado');

  step('resaltar clics');
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
  checks['capa de clics sobre la pantalla grabada'] = clickStart.ok && ov.visible && Boolean(recorded);
  checks['detector de clics en marcha'] = ov.hookRunning && !ov.hookError;
  checks['dibuja el círculo del clic'] = ripples > 0;
  checks['la capa se quita al parar'] = clickStop.ok && !clickOverlay.snapshot().visible && !clickOverlay.snapshot().hookRunning;
  if (ov.hookError) log(`clics: ${ov.hookError}`);
  await drec('apply', { clicks: false });

  step('efectos');
  await drec('apply', { background: 'blur', border: true, borderColor: '#e5383b' });
  let fx = {};
  for (let i = 0; i < 40; i++) {
    fx = await bubbleWc.executeJavaScript('window.bubbleStatus()');
    if (fx.effectReady || fx.error) break;
    await wait(500);
  }
  const ring = await bubbleWc.executeJavaScript(`getComputedStyle(document.getElementById('bubble')).borderTopColor`);
  checks['el desenfoque carga en la burbuja'] = Boolean(fx.effectReady) && !fx.error;
  checks['borde rojo en la burbuja'] = ring === 'rgb(229, 56, 59)';

  step('grabar una ventana');
  const wins = await listWindows(false);
  checks['hay ventanas para grabar'] = wins.length > 0;
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
    checks['graba una ventana'] = started.ok && stopped.ok && fs.existsSync(stopped.data.file);
    checks['sigue la posición de la ventana'] = Boolean(rect) && winSnap.mode === 'window' && !winSnap.visible;
    checks['clic dentro de la ventana sale en el video'] = windowRipples > 0;
    const CLOSE = 0.02; // within 2% of the window's size
    checks['cámara donde la burbuja tapa la ventana'] = Boolean(cameraSpot) && Math.abs(cameraSpot.x - expected.x) < CLOSE && Math.abs(cameraSpot.y - expected.y) < CLOSE;
    log(`cámara en ventana: esperado ${JSON.stringify(expected)} obtenido ${JSON.stringify(cameraSpot)} ventana ${JSON.stringify(rect)}`);
    if (!stopped.ok) log(`ventana: ${stopped.error || started.error}`);
    await drec('apply', { clicks: false });
  }

  // The user's case: a window on the right half of the second screen. A made-up window position
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
    checks['cámara bien en una ventana de la segunda pantalla'] = Boolean(spot)
      && Math.abs(spot.x - (40 * scale) / phys.width) < 0.02 && Math.abs(spot.y - (40 * scale) / phys.height) < 0.02;
    log(`segunda pantalla: ventana ${JSON.stringify(fakeWindow)} cámara ${JSON.stringify(spot)}`);
    bubble.placeOn(screen.getPrimaryDisplay().id);
  }

  step('solo cámara con desenfoque');
  await drec('apply', { mode: 'camera' });
  await wait(1500);
  const camStart = await drec('start');
  await wait(3000);
  const camStop = await drec('stop');
  checks['graba solo cámara con efecto'] = camStart.ok && camStop.ok && fs.existsSync(camStop.data.file);
  if (!camStop.ok) log(`cámara: ${camStop.error || camStart.error}`);

  step('cli drec');
  // The real CLI, run the way the installed drec.cmd runs it: this exe acting as Node.
  const cli = (argv, env = {}) => new Promise((resolve) => {
    // Installed, the CLI sits in resources/cli next to the app archive; in the source folder, in cli/.
    const drecJs = app.isPackaged ? path.join(process.resourcesPath, 'cli', 'drec.js') : path.join(__dirname, '..', 'cli', 'drec.js');
    const p = spawn(process.execPath, [drecJs, ...argv, '--json'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      let data = null;
      try { data = JSON.parse(out); } catch { /* not JSON */ }
      resolve({ code, data, err: err.trim() });
    });
  });
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
  const cornerSet = await cli(['set', '--screen', '1', '--bubble-corner', 'bottom-right']);
  await wait(300);
  const cornerBounds = bubble.snapshot().bounds;
  const area1 = screen.getDisplayMatching(cornerBounds); // the screen the bubble ended up on
  const otherDir = path.join(outputDir(), 'cli-folder');
  const dirSet = await cli(['set', '--output-dir', otherDir]);
  const dirReset = await cli(['set', '--output-dir', 'default']);
  const badCorner = await cli(['set', '--bubble-corner', 'middle-ish']);
  checks['drec version'] = cliVersion.code === 0 && String(cliVersion.data).startsWith(app.getVersion()) && /\((dev|built \d{4}-\d\d-\d\d \d\d:\d\d)\)$/.test(cliVersion.data);
  checks['drec doctor revisa todo'] = Array.isArray(cliDoctor.data?.checks) && cliDoctor.data.checks.length === 7 && cliDoctor.data.checks[0].ok;
  checks['drec bubble-corner abajo a la derecha'] = cornerSet.code === 0
    && Math.abs(cornerBounds.x + cornerBounds.width - (area1.workArea.x + area1.workArea.width - 40)) <= 2
    && Math.abs(cornerBounds.y + cornerBounds.height - (area1.workArea.y + area1.workArea.height - 40)) <= 2;
  checks['drec output-dir cambia la carpeta'] = dirSet.code === 0 && dirSet.data.outputDir === otherDir && fs.existsSync(otherDir);
  checks['drec output-dir default la devuelve'] = dirReset.code === 0 && dirReset.data.outputDir !== otherDir;
  checks['drec avisa de una esquina mala'] = badCorner.code === 1 && /bubble-corner/.test(badCorner.err);

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
    checks['drec bubble-corner usa la esquina de la ventana'] = winCorner.code === 0 && Boolean(winRect) && nearRight && nearBottom;
    log(`esquina de ventana: ventana ${JSON.stringify(winRect)} burbuja ${JSON.stringify(bb)}`);
  }
  if (cliDoctor.data) log(`doctor: ${cliDoctor.data.checks.map((c) => `${c.name}=${c.ok}`).join(' ')}`);
  const badToken = await cli(['status'], { DREC_TOKEN_FILE: path.join(__dirname, 'no-such-token') });
  const badValue = await cli(['set', '--bubble', 'giant']);
  checks['drec screens'] = cliScreens.code === 0 && Array.isArray(cliScreens.data) && cliScreens.data.length === screen.getAllDisplays().length;
  checks['drec windows'] = cliWindows.code === 0 && Array.isArray(cliWindows.data);
  checks['drec set'] = cliSet.code === 0 && cliSet.data.screenNumber === 1 && cliSet.data.mode === 'screen';
  checks['drec start graba'] = cliStart.code === 0 && cliStart.data.phase === 'recording';
  checks['drec pause y resume'] = cliPause.data?.phase === 'paused' && cliResume.data?.phase === 'recording';
  checks['drec stop da el MP4'] = cliStop.code === 0 && Boolean(cliStop.data?.file) && fs.existsSync(cliStop.data.file);
  checks['drec rechaza una clave falsa'] = badToken.code === 1 && /token/.test(badToken.err);
  checks['drec avisa de un valor malo'] = badValue.code === 1 && /bubble/.test(badValue.err);
  for (const [name, r] of Object.entries({ cliScreens, cliSet, cliStart, cliStop })) if (r.code !== 0) log(`${name}: ${r.err}`);

  // Leaves the test's own settings as a fresh install has them.
  await drec('apply', { mode: 'screen', background: 'none', border: false, systemAudio: false });

  const files = fs.existsSync(outputDir()) ? fs.readdirSync(outputDir()) : [];
  log('SMOKE ' + JSON.stringify({ ...devices, displays: screen.getAllDisplays().length, windows: wins.length, checks, files }));
  app.quit();
}

module.exports = { run };
