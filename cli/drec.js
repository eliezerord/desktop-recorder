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
  doctor                 Check screens, camera, mic, MP4 converter, folder; hints for each problem
  screens                Screens you can record, numbered
  windows                Open windows you can record, numbered
  devices                Cameras and microphones
  set [options]          Change settings without recording
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

Examples
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
  '--clicks': ['clicks', 'bool'],
  '--background': ['background', String],
  '--bg-color': ['bgColor', String],
  '--bg-image': ['bgImage', 'path'],
  '--border': ['border', 'bool'],
  '--border-color': ['borderColor', String],
  '--seconds': ['seconds', Number],
};

function parse(argv) {
  const [cmd = 'help', ...rest] = argv;
  const args = {};
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === '--json') { json = true; continue; }
    if (flag === '--help' || flag === '-h') return { cmd: 'help', args, json };
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
    } else if (type === Number) {
      args[key] = Number(raw);
      if (!(args[key] > 0)) throw new Error(`${flag} takes a positive number.`);
    } else {
      args[key] = raw;
    }
  }
  return { cmd, args, json };
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
const TIMEOUTS = { start: 60000, stop: 30 * 60000, record: 30 * 60000 };

function print(cmd, data, json) {
  if (json) { console.log(JSON.stringify(data, null, 2)); return; }
  if (cmd === 'screens') data.forEach((s) => console.log(`${s.number}  ${s.name}  ${s.size}`));
  else if (cmd === 'windows') data.forEach((w) => console.log(`${w.number}  ${w.name}`));
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
    if (data.outputDir) console.log(`saves to: ${data.outputDir}`);
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
