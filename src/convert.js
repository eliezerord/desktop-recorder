// WebM to MP4 with ffmpeg. Kept free of Electron so it can be tested on its own (test/convert-test.js).
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function convertToMp4(input, output, durationSec, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', // H.264 needs even width and height
      '-r', '30', // fixed 30 fps: editors handle the recorder's variable frame rate badly
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k',
      '-movflags', '+faststart',
      output,
    ];
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (data) => {
      const text = data.toString();
      tail = (tail + text).slice(-2000);
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (m && durationSec > 0) {
        const done = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress(Math.min(1, done / durationSec));
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg terminó con código ${code}. ${tail.slice(-300)}`))));
  });
}

module.exports = { convertToMp4, ffmpegPath };
