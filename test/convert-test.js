// Checks the WebM to MP4 step without opening the app.
// Makes a 4-second WebM like the recorder does (odd size, VP9 + Opus), converts it and checks the MP4.
// Run: node test/convert-test.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { convertToMp4, ffmpegPath } = require('../src/convert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-test-'));
const webm = path.join(dir, 'in.webm');
const mp4 = path.join(dir, 'out.mp4');

const make = spawnSync(ffmpegPath, [
  '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=1281x721:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440',
  '-t', '4',
  '-c:v', 'libvpx-vp9', '-b:v', '1M', '-c:a', 'libopus',
  webm,
], { encoding: 'utf8' });
if (make.status !== 0) { console.error(make.stderr.slice(-800)); process.exit(1); }

let lastProgress = 0;
convertToMp4(webm, mp4, 4, (p) => { lastProgress = p; })
  .then(() => {
    const info = spawnSync(ffmpegPath, ['-i', mp4], { encoding: 'utf8' }).stderr;
    const checks = {
      'video H.264': /Video: h264/.test(info),
      'tamaño par (1280x720)': /1280x720/.test(info),
      '30 fps': /30 fps/.test(info),
      'audio AAC': /Audio: aac/.test(info),
      'progreso llega a ~100%': lastProgress > 0.9,
    };
    let ok = true;
    for (const [name, pass] of Object.entries(checks)) {
      console.log(`${pass ? 'OK  ' : 'FAIL'} ${name}`);
      ok = ok && pass;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => { console.error('FAIL conversión:', err.message); process.exit(1); });
