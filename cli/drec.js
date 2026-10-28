#!/usr/bin/env node
// drec: control Desktop Recorder from a terminal or an AI agent.
// It talks to the running app over a local Windows named pipe and starts the app when it is closed.
// The installed app runs this file with its own exe (drec.cmd sets ELECTRON_RUN_AS_NODE), so Node
// does not need to be installed. In the source folder it also runs with plain `node cli/drec.js`.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HELP = `drec - control Desktop Recorder

Usage: drec <command> [options]

Commands
  status                 What the app is doing and its current settings
  doctor [--probe-cursor on]
                         Check screens, camera, mic, MP4 converter, folder; hints for each problem.
                         --probe-cursor on also tests whether this PC can capture without the
                         system cursor (about 30 s; a blue window covers the first screen and the
                         mouse moves by itself)
  projects               Projects of your screen and window recordings, newest first, with their size
  edit [project]         Open the Editor on a Project (the last one if none is named): preview it, change its
                         Background, margin, rounded corners and format, and export. The changes are kept
                         in the Project, and drec export uses them too
  zooms [project]        The Zooms of a Project (the last one if none is named): number, start, length, strength
                         and aim. The Editor and drec export use this same list
  zoom-add <project> --at SECONDS [--length SECONDS] [--strength N] [--aim X,Y]
                         Add a Zoom at that moment of the recording: 2 s long and strength 1.6 unless told,
                         aimed at --aim (fractions of the screen; 0.5,0.5 is the middle, the default)
  zoom-strength <project> <number> <strength>
                         How far one Zoom goes in: 1.1 (a gentle push) to 3 (a close look)
  zoom-delete <project> <number>
                         Remove one Zoom; the Zooms after it move down one number
  layouts [project]      The Layout points of a Project (the last one if none is named): number, start, kind
                         and whether a Split is swapped.
                         A Layout is how the screen and the camera share the video; it changes at each point
  layout-add <project> --at SECONDS --kind card|screen|camera|split [--swap on]
                         From that moment of the recording, use that Layout: screen fills the video with the
                         screen recording, camera fills it with the camera, split puts the screen and the camera
                         side by side (16:9, 60/40) or one above the other (9:16, half and half), and card puts
                         the screen back on the Background. camera and split need a Project with a camera;
                         --swap on puts the camera first (left or on top). The move takes about 0.3 s.
                         --at 0 sets the Layout the video starts with (not swapped unless --swap on)
  layout-change <project> <number> [--kind card|screen|camera|split] [--swap on|off]
                         Change one Layout point's kind, or only turn a Split's swap on or off (--swap alone)
  layout-move <project> <number> --at SECONDS
                         Move one Layout point; the first one stays at 0 s. Points stay at least 0.3 s apart
  layout-delete <project> <number>
                         Remove one Layout point; the points after it move down one number. The first one stays
  delete-raw <project> --yes
                         Delete a Project's raw material and keep only its plain MP4, to free disk space.
                         The Project cannot be exported again. Without --yes it only says what would go
  export <project> [options]
                         Make a styled MP4 from a Project: the screen as a rounded Card on a Background,
                         the camera in a round Bubble. <project> is "latest", its number or its name.
  screens                Screens you can record, numbered
  windows                Open windows you can record, numbered
  devices                Cameras and microphones
  set [options]          Change settings without recording; also saves the default look of exports (--look-...)
  start [options]        Apply options, count down 3 s and start recording
  pause | resume         Pause or resume the recording
  stop                   Stop, wait for the MP4 and print its path
  record --seconds N     start, record N seconds, stop (takes the same options)
  open                   Start the app if it is closed
  quit                   Close the app
  version                The app's version

Options for set, start and record
  --mode screen|window|camera
  --screen N|primary            Screen number from "drec screens"
  --window N|"text"             Part of the window's title (steadier), or its number from "drec windows"
  --camera "text"|none          Part of the camera name ("OBS" for the OBS Virtual Camera)
  --mic "text"|none             Part of the microphone name
  --system-audio on|off         Also record the PC sound
  --bubble small|medium|full|hidden
  --bubble-corner top-left|top-right|bottom-left|bottom-right|center
                                Where the bubble sits on the recorded screen
  --clicks on|off               Highlight mouse clicks (screen and window recordings)
  --background none|blur|color|image
  --bg-color "#2f5bff"          Background color for --background color
  --bg-image path               Picture for --background image
  --border on|off               Ring around the camera
  --border-color "#ffffff"
  --output-dir path|default     Folder for the MP4s ("default" is Videos\\Desktop Recorder)
  --language en|es|pt           The app's interface language (English, Spanish, Portuguese)

Options for export
  --background ocean|sunset|forest|dusk|peach|mint|slate|midnight|sand|rose
  --bubble-place inside|outside  The camera on the Card, or on the Background beside it (default outside)
  --bubble-corner top-left|top-right|bottom-left|bottom-right   (default bottom-left)
  --bubble-shape circle|rounded  The camera as a circle or as a square with rounded corners (default circle)
  --zoom on|off                  Smooth zoom into the screen at clicks (default on)
  --margin PERCENT               Space around the Card, 0 to 15 percent of the shorter side (default 5)
  --card-corners PERCENT         How round the Card's corners are, 0 to 6 percent of the shorter side (default 2.2)
  --bubble-size PERCENT          The Bubble's width, 10 to 40 percent of the shorter side (default: the size it was recorded with)
  --background-image PATH|none   Your own picture as the Background (PNG, JPEG or WebP). It is copied into the Project and
                                 used by its next exports too; none takes it out. --background chosen on purpose wins once
  --aspect 16:9|9:16             16:9 is 1920x1080 for YouTube, 9:16 is 1080x1920 for Reels (default 16:9)
  --trim-start SECONDS           Leave out everything before this moment of the recording (kept in the Project)
  --trim-end SECONDS|end         Leave out everything after it; "end" goes back to the end of the recording
  --cursor on|off                A smooth cursor drawn on window recordings (default on; a screen recording keeps its own)
  --clicks on|off                A circle at each click (default on; not drawn again if recorded with click highlights)

Default look for exports (with set; drec export uses these unless told otherwise)
  --look-background ID           --look-bubble-place inside|outside   --look-bubble-corner top-left|...
  --look-aspect 16:9|9:16        --look-margin PERCENT                --look-zoom on|off
  --look-card-corners PERCENT    --look-bubble-size PERCENT           --look-bubble-shape circle|rounded
  --look-cursor on|off           --look-clicks on|off
  --look-background-image PATH|none   A picture for every export (kept in the app's folder); none removes it
  --look-reset on                Forget every default look setting
  (they have the "look-" prefix because set already has --background for the camera's background effect)

Examples
  drec set --look-background dusk --look-aspect 9:16 --look-zoom off
  drec export latest --background dusk --bubble-place outside
  drec zooms latest
  drec zoom-add latest --at 12.5 --length 3 --strength 2 --aim 0.8,0.2
  drec zoom-delete latest 2
  drec layout-add latest --at 0.5 --kind screen
  drec layout-change latest 2 --kind split --swap on
  drec start --screen 2 --clicks on --bubble-corner bottom-right
  drec start --window "Claude" --background blur --border on --border-color "#2f5bff"
  drec record --seconds 30 --mode camera --camera "OBS"

Add --json to any command for machine-readable output. Exit code 1 means it failed.
`;

// Same names as src/cli-server.js; DREC_PIPE and DREC_TOKEN_FILE override both sides (tests).
function endpoints() {
  return {
    pipe: process.env.DREC_PIPE || `\\\\.\\pipe\\desktop-recorder-${os.userInfo().username}`,
    tokenFile: process.env.DREC_TOKEN_FILE || path.join(process.env.APPDATA || os.homedir(), 'desktop-recorder-cli', 'token'),
  };
}

const ON_OFF = { on: true, off: false, true: true, false: false, yes: true, no: false };
const OPTIONS = {
  '--mode': ['mode', String],
  '--screen': ['screen', String],
  '--window': ['window', String],
  '--camera': ['camera', String],
  '--mic': ['mic', String],
  '--system-audio': ['systemAudio', 'bool'],
  '--bubble': ['bubble', String],
  '--bubble-corner': ['bubbleCorner', String],
  '--output-dir': ['outputDir', 'dir'],
  '--language': ['language', String],
  '--clicks': ['clicks', 'bool'],
  '--background': ['background', String],
  '--bg-color': ['bgColor', String],
  '--bg-image': ['bgImage', 'path'],
  '--border': ['border', 'bool'],
  '--border-color': ['borderColor', String],
  '--seconds': ['seconds', Number],
  '--probe-cursor': ['probeCursor', 'bool'],
  '--bubble-place': ['bubblePlace', String],
  '--bubble-shape': ['bubbleShape', String],
  '--margin': ['margin', 'percent'],
  '--card-corners': ['cardCorners', 'percent'],
  '--bubble-size': ['bubbleSize', 'percent'],
  '--background-image': ['backgroundImage', 'pathOrNone'],
  '--look-background': ['lookBackground', String],
  '--look-bubble-place': ['lookBubblePlace', String],
  '--look-bubble-corner': ['lookBubbleCorner', String],
  '--look-bubble-shape': ['lookBubbleShape', String],
  '--look-aspect': ['lookAspect', String],
  '--look-margin': ['lookMargin', 'percent'],
  '--look-card-corners': ['lookCardCorners', 'percent'],
  '--look-bubble-size': ['lookBubbleSize', 'percent'],
  '--look-zoom': ['lookZoom', 'bool'],
  '--look-cursor': ['lookCursor', 'bool'],
  '--look-clicks': ['lookClicks', 'bool'],
  '--look-background-image': ['lookBackgroundImage', 'pathOrNone'],
  '--look-reset': ['lookReset', 'bool'],
  '--zoom': ['zoom', 'bool'],
  '--cursor': ['cursor', 'bool'],
  '--aspect': ['aspect', String],
  '--trim-start': ['trimStart', 'time'],
  '--trim-end': ['trimEnd', 'time'],
  '--at': ['at', 'seconds'],
  '--length': ['length', 'seconds'],
  '--strength': ['strength', Number],
  '--aim': ['aim', 'aim'],
  '--kind': ['kind', String],
  '--swap': ['swap', 'bool'],
};

// Words that come without a --flag, in order, for the commands that take them.
const POSITIONAL = {
  export: ['project'], 'delete-raw': ['project'], edit: ['project'], zooms: ['project'],
  'zoom-add': ['project'], 'zoom-delete': ['project', 'number'], 'zoom-strength': ['project', 'number', 'strength'],
  layouts: ['project'], 'layout-add': ['project'],
  'layout-change': ['project', 'number'], 'layout-move': ['project', 'number'], 'layout-delete': ['project', 'number'],
};

// The Zoom commands that change the list need the Project named, so a Zoom number is never read as a Project.
function checkZoomCommand(cmd, args) {
  if (!cmd.startsWith('zoom-')) return;
  if (args.project === undefined) throw new Error(`${cmd} needs a Project: "latest", its number or its name (see drec projects).`);
  if (cmd !== 'zoom-add' && !/^\d+$/.test(String(args.number ?? ''))) throw new Error(`${cmd} needs the Zoom's number from "drec zooms", like 2.`);
  if (args.number !== undefined) args.number = Number(args.number);
  if (cmd === 'zoom-strength') {
    if (args.strength === undefined || args.strength === '' || !Number.isFinite(Number(args.strength))) throw new Error("zoom-strength needs a strength after the Zoom's number, like 1.8.");
    args.strength = Number(args.strength);
  }
  if (cmd === 'zoom-add' && args.at === undefined) throw new Error('zoom-add needs --at SECONDS, the moment of the recording to zoom at.');
}

function parse(argv) {
  const [cmd = 'help', ...rest] = argv;
  const args = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json') { json = true; continue; }
    if (flag === '--help' || flag === '-h') return { cmd: 'help', args, json };
    if (cmd === 'delete-raw' && flag === '--yes') { args.yes = true; continue; }
    if (!flag.startsWith('--') && POSITIONAL[cmd]) {
      const slot = POSITIONAL[cmd].find((k) => args[k] === undefined);
      if (!slot) throw new Error(`${cmd} takes ${POSITIONAL[cmd].map((k) => `<${k}>`).join(' ')} and options; "${flag}" is one word too many.`);
      args[slot] = flag; // the Project, a Zoom number, a strength
      continue;
    }
    const spec = OPTIONS[flag];
    if (!spec) throw new Error(`Unknown option ${flag}. Run "drec help".`);
    const raw = rest[++i];
    if (raw === undefined) throw new Error(`${flag} needs a value.`);
    const [key, type] = spec;
    if (type === 'bool') {
      if (!(raw.toLowerCase() in ON_OFF)) throw new Error(`${flag} takes on or off.`);
      args[key] = ON_OFF[raw.toLowerCase()];
    } else if (type === 'path') {
      args[key] = path.resolve(raw);
    } else if (type === 'dir') {
      args[key] = raw.toLowerCase() === 'default' ? 'default' : path.resolve(raw);
    } else if (type === 'percent') {
      if (raw === '' || !(Number(raw) >= 0)) throw new Error(`${flag} takes a number, like 5.`);
      args[key] = Number(raw);
    } else if (type === 'pathOrNone') {
      args[key] = raw.toLowerCase() === 'none' ? 'none' : path.resolve(raw);
    } else if (type === 'seconds') {
      if (raw === '' || !(Number(raw) >= 0)) throw new Error(`${flag} takes seconds, like 12.5.`);
      args[key] = Number(raw);
    } else if (type === 'aim') {
      const xy = raw.split(',').map((n) => (n.trim() === '' ? NaN : Number(n)));
      if (xy.length !== 2 || !xy.every((n) => n >= 0 && n <= 1)) throw new Error(`${flag} takes two numbers from 0 to 1, like 0.5,0.5 (the middle).`);
      args[key] = xy;
    } else if (type === 'time') {
      if (raw.toLowerCase() === 'end') args[key] = 'end';
      else if (raw !== '' && Number(raw) >= 0) args[key] = Number(raw);
      else throw new Error(`${flag} takes seconds, like 12.5${key === 'trimEnd' ? ' (or end)' : ''}.`);
    } else if (type === Number) {
      args[key] = Number(raw);
      if (!(args[key] > 0)) throw new Error(`${flag} takes a positive number.`);
    } else {
      args[key] = raw;
    }
  }
  checkZoomCommand(cmd, args);
  checkLayoutCommand(cmd, args);
  return { cmd, args, json };
}

// The Layout commands that change the list need the Project named, like the Zoom ones, and a point's number
// (from "drec layouts") for all but layout-add.
function checkLayoutCommand(cmd, args) {
  if (!cmd.startsWith('layout-')) return;
  if (args.project === undefined) throw new Error(`${cmd} needs a Project: "latest", its number or its name (see drec projects).`);
  if (cmd !== 'layout-add') {
    if (!/^\d+$/.test(String(args.number ?? ''))) throw new Error(`${cmd} needs the Layout point's number from "drec layouts", like 2.`);
    args.number = Number(args.number);
  }
  if (cmd === 'layout-add' && args.at === undefined) throw new Error('layout-add needs --at SECONDS, the moment of the recording the Layout starts.');
  if (cmd === 'layout-move' && args.at === undefined) throw new Error('layout-move needs --at SECONDS, the new moment of the recording for that point.');
  if (cmd === 'layout-add' && args.kind === undefined) throw new Error('layout-add needs --kind, the Layout to use from then on: card, screen, camera or split.');
  if (cmd === 'layout-change' && args.kind === undefined && args.swap === undefined) throw new Error('layout-change needs --kind card|screen|camera|split, or --swap on|off for a Split point.');
}

function request(cmd, args, timeoutMs) {
  const { pipe, tokenFile } = endpoints();
  return new Promise((resolve, reject) => {
    let token;
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch { token = ''; }
    const socket = net.connect(pipe);
    let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`No answer from the app after ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, cmd, args })}\n`));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        const reply = JSON.parse(data);
        if (reply.ok) resolve(reply.data);
        else reject(new Error(reply.error));
      } catch {
        reject(new Error('The app sent an answer drec could not read.'));
      }
    });
    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// How to start the app: the installed exe that runs this script, or Electron in the source folder.
function appCommand() {
  if (process.env.DREC_APP) return { cmd: process.env.DREC_APP, args: [] };
  if (process.versions.electron && !/^electron(\.exe)?$/i.test(path.basename(process.execPath))) {
    return { cmd: process.execPath, args: [] };
  }
  const root = path.join(__dirname, '..');
  return { cmd: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: [root] };
}

const APP_START_TIMEOUT_MS = 30000;
async function ensureApp() {
  try {
    await request('ping', {}, 5000);
    return;
  } catch (err) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(err.code)) throw err;
  }
  const { cmd, args } = appCommand();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // the app itself must start as an app, not as Node
  spawn(cmd, args, { detached: true, stdio: 'ignore', env }).unref();
  const until = Date.now() + APP_START_TIMEOUT_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    try { await request('ping', {}, 3000); return; } catch { /* still starting */ }
  }
  throw new Error('Desktop Recorder did not start within 30 s.');
}

// Long waits: start includes the 3 s countdown; stop includes the MP4 conversion of a long video.
const TIMEOUTS = { start: 60000, stop: 30 * 60000, record: 30 * 60000, doctor: 3 * 60000, export: 30 * 60000 };

// The same "1.2 GB", "340 MB", "12 KB" the app shows (formatBytes in src/project-storage.js).
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${n > 0 ? Math.max(1, Math.round(n / 1e3)) : 0} KB`);

function print(cmd, data, json) {
  if (json) { console.log(JSON.stringify(data, null, 2)); return; }
  if (cmd === 'screens') data.forEach((s) => console.log(`${s.number}  ${s.name}  ${s.size}`));
  else if (cmd === 'windows') data.forEach((w) => console.log(`${w.number}  ${w.name}`));
  else if (cmd === 'projects') data.forEach((p) => console.log(`${p.number}  ${p.name}  ${p.mode}  ${String(p.created).slice(0, 10)}  ${p.durationSec} s${p.camera ? '  camera' : ''}  ${size(p.sizeBytes)}${p.rawDeleted ? '  raw material deleted' : ''}${p.look && Object.keys(p.look).length ? `  look: ${Object.entries(p.look).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`));
  else if (cmd === 'edit') console.log(`Opened the Editor on ${data.project}.`);
  else if (cmd === 'layouts' || cmd.startsWith('layout-')) {
    if (data.message) console.log(data.message);
    console.log(`${data.project}: ${data.layouts.length} ${data.layouts.length === 1 ? 'Layout point' : 'Layout points'}`);
    data.layouts.forEach((p) => console.log(`  ${p.number}  at ${p.atSec} s  ${p.kind}${p.swap ? ' (swapped)' : ''}`));
  } else if (cmd === 'zooms' || cmd.startsWith('zoom-')) {
    if (data.message) console.log(data.message);
    console.log(`${data.project}: Zoom is ${data.zoomOn ? 'on' : 'off'}, ${data.zooms.length} ${data.zooms.length === 1 ? 'Zoom' : 'Zooms'}`);
    data.zooms.forEach((z) => console.log(`  ${z.number}  at ${z.startSec} s  for ${z.lengthSec} s  strength ${z.strength}  aim ${z.x}, ${z.y}`));
  }
  else if (cmd === 'delete-raw') console.log(`Deleted the raw material of ${data.project}: ${size(data.freedBytes)} freed. Its plain MP4 stays.`);
  else if (cmd === 'devices') {
    console.log('Cameras');
    data.cameras.forEach((c) => console.log(`  ${c.label}`));
    console.log('Microphones');
    data.mics.forEach((m) => console.log(`  ${m.label}`));
  } else if (cmd === 'doctor') {
    data.checks.forEach((c) => console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}${c.ok ? '' : `\n      fix: ${c.hint}`}`));
  } else if (data && data.file) console.log(data.file);
  else if (data && data.phase) {
    const where = data.mode === 'window' ? `window "${data.window}"` : data.mode === 'camera' ? 'camera only' : `screen ${data.screenNumber || ''}`.trim();
    console.log(`${data.phase}  ${data.time}  ${where}`);
    const fx = data.effects || {};
    console.log(`camera: ${data.camera || 'none'}  bubble: ${data.bubble}  background: ${fx.background || 'none'}  border: ${fx.border ? fx.borderColor : 'off'}`);
    console.log(`mic: ${data.mic || 'none'}  pc sound: ${data.systemAudio ? 'on' : 'off'}  clicks: ${data.clicks ? 'on' : 'off'}`);
    if (data.outputDir) console.log(`saves to: ${data.outputDir}  language: ${data.language || 'en'}`);
    const saved = data.exportLook && Object.entries(data.exportLook).map(([k, v]) => `${k} ${v}`).join(', ');
    if (saved) console.log(`export look: ${saved}`);
    if (data.lastFile) console.log(`last file: ${data.lastFile}`);
    if (data.lastError) console.log(`last error: ${data.lastError}`);
  } else if (data !== undefined) console.log(typeof data === 'string' ? data : JSON.stringify(data));
}

async function main() {
  const { cmd, args, json } = parse(process.argv.slice(2));
  if (cmd === 'help') { console.log(HELP); return; }
  if (cmd === 'quit') {
    try { await request('quit', {}, 5000); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    return;
  }
  await ensureApp();
  if (cmd === 'open') { if (!json) console.log('Desktop Recorder is running.'); return; }
  if (cmd === 'record') {
    if (!args.seconds) throw new Error('record needs --seconds N.');
    const { seconds, ...settings } = args;
    await request('start', settings, TIMEOUTS.start);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    print('stop', await request('stop', {}, TIMEOUTS.stop), json);
    return;
  }
  const data = await request(cmd, args, TIMEOUTS[cmd] || 60000);
  print(cmd, data, json);
  if (cmd === 'doctor' && !data.ok) process.exitCode = 1; // a failed check is a failure for scripts too
}

main().catch((err) => {
  const msg = err.code === 'ENOENT' ? 'Desktop Recorder is not running and could not be reached.' : err.message;
  console.error(`drec: ${msg}`);
  process.exit(1);
});
