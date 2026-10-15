// The app side of the drec CLI. It listens on a Windows named pipe, which only exists on this PC
// (no network port), and every request must carry a random token that the app writes to the
// user's own profile folder, so other users and other programs without that file get nothing.
// Protocol: one JSON line in ({ token, cmd, args }), one JSON line out ({ ok, data } or { ok, error }).
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Shared with cli/drec.js. DREC_PIPE and DREC_TOKEN_FILE point both sides somewhere else (tests).
function endpoints() {
  return {
    pipe: process.env.DREC_PIPE || `\\\\.\\pipe\\desktop-recorder-${os.userInfo().username}`,
    tokenFile: process.env.DREC_TOKEN_FILE || path.join(process.env.APPDATA || os.homedir(), 'desktop-recorder-cli', 'token'),
  };
}

function start(handlers, log = console.log) {
  const { pipe, tokenFile } = endpoints();
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end);
      buffer = '';
      let reply;
      try {
        const req = JSON.parse(line);
        if (req.token !== token) throw new Error('Wrong CLI token. Close and reopen Desktop Recorder.');
        const handler = handlers[req.cmd];
        if (!handler) throw new Error(`Unknown command: ${req.cmd}`);
        reply = { ok: true, data: await handler(req.args || {}) };
      } catch (err) {
        reply = { ok: false, error: err.message };
      }
      if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`);
    });
    socket.on('error', () => { /* the CLI went away; nothing to answer */ });
  });
  server.on('error', (err) => log(`CLI: no se pudo abrir ${pipe}: ${err.message}`));
  server.listen(pipe);
  return server;
}

module.exports = { start, endpoints };
