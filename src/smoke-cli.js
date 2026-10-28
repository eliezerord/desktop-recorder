// The real drec CLI, run the way the installed drec.cmd runs it: this exe acting as Node.
// Shared by the smoke tests. Resolves { code, data, err } for one command.
const path = require('path');
const { spawn } = require('child_process');

function makeCli(app) {
  return (argv, env = {}) => new Promise((resolve) => {
    // Installed, the CLI sits in resources/cli next to the app archive; in the source folder, in cli/.
    const drecJs = app.isPackaged ? path.join(process.resourcesPath, 'cli', 'drec.js') : path.join(__dirname, '..', 'cli', 'drec.js');
    const child = spawn(process.execPath, [drecJs, ...argv, '--json'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let data = null;
      try { data = JSON.parse(out); } catch { /* not JSON */ }
      resolve({ code, data, err: err.trim() });
    });
  });
}

module.exports = { makeCli };
