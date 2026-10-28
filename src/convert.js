// WebM to MP4 with ffmpeg. Kept free of Electron so it can be tested on its own (test/convert-test.js).
const { spawn } = require('child_process');
// In the installed app the code sits inside app.asar, which a program cannot run from. ffmpeg is
// unpacked next to it (asarUnpack in package.json), so point at the unpacked copy.
const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

function convertToMp4(input, output, durationSec, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-i', input,
      // H.264 needs even width and height. The colours stay BT.601 (what the recorder gives) and the file says so in
      // all three tags: with only one, Chromium (the Editor preview, browsers) decodes them as BT.709 and red turns orange.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt601:out_range=tv',
      '-r', '30', // fixed 30 fps: editors handle the recorder's variable frame rate badly
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv',
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
