// Draws the app icon in the Dots style and writes build/icon.png (512) and build/icon.ico (16 to 256).
// Run: npx electron build/make-icon.js
// Square dots in four greys on paper; the accent only recolors dots, nothing is filled solid.
// Each size gets its own grid, so the 16 px icon is still readable instead of a blur.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

// Runs inside a hidden window, where a canvas is available.
function drawAll(sizes) {
  const PAPER = '#f1ede1';
  const GREYS = ['#d3cec1', '#a9a497', '#7c7869', '#4a473f']; // g1 to g4 from the Dots tokens
  const INK = '#121110';
  const RECORD = '#e5383b'; // recording has its own color, like Claude orange for Claude content
  const B4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map((r) => r.map((x) => x / 16));

  // Cells across: fewer and bigger dots as the icon gets smaller.
  const gridFor = (s) => (s >= 128 ? 24 : s >= 48 ? 16 : s >= 32 ? 12 : 8);

  const BUBBLE = { x: 0.44, y: 0.45, r: 0.34 };
  const DOT = { x: 0.74, y: 0.74, r: 0.17 };

  function cell(u, v, gap) {
    const dRec = Math.hypot(u - DOT.x, v - DOT.y);
    if (dRec <= DOT.r) return RECORD;
    if (dRec <= DOT.r + gap) return null; // one empty cell around the feature
    const dx = u - BUBBLE.x;
    const dy = v - BUBBLE.y;
    const d = Math.hypot(dx, dy);
    if (d > BUBBLE.r) return null;
    // Light from the top left on a ball: bright side in the light grey, shadow towards ink.
    const z = Math.sqrt(BUBBLE.r ** 2 - d * d) / BUBBLE.r;
    const light = Math.max(0, (-dx / BUBBLE.r) * 0.5 + (-dy / BUBBLE.r) * 0.6 + z * 0.62);
    return light;
  }

  return sizes.map((s) => {
    const n = gridFor(s);
    const c = document.createElement('canvas');
    c.width = s;
    c.height = s;
    const g = c.getContext('2d');
    // Paper plate with rounded corners.
    const radius = s * 0.2;
    g.fillStyle = PAPER;
    g.beginPath();
    g.roundRect(0, 0, s, s, radius);
    g.fill();

    const pad = s * 0.06;
    const step = (s - pad * 2) / n;
    const dot = s >= 48 ? step * 0.78 : step; // small sizes drop the gap so the shape stays solid
    const off = (step - dot) / 2;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const u = (i + 0.5) / n;
        const v = (j + 0.5) / n;
        const val = cell(u, v, 1 / n);
        if (val === null) continue;
        let color = val;
        if (typeof val === 'number') {
          const levels = [GREYS[0], GREYS[1], GREYS[2], GREYS[3], INK];
          const t = (1 - Math.min(1, val)) * (levels.length - 1);
          const base = Math.floor(t);
          const pick = t - base > B4[j % 4][i % 4] ? base + 1 : base; // ordered blend between neighbouring greys
          color = levels[Math.min(levels.length - 1, pick)];
        }
        g.fillStyle = color;
        g.fillRect(Math.round(pad + i * step + off), Math.round(pad + j * step + off), Math.max(1, Math.round(dot)), Math.max(1, Math.round(dot)));
      }
    }
    return c.toDataURL('image/png');
  });
}

// Windows icon file: a header, one entry per size, then the PNG data of each size.
function writeIco(file, pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  fs.writeFileSync(file, Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>');
  const urls = await win.webContents.executeJavaScript(`(${drawAll.toString()})(${JSON.stringify(SIZES)})`);
  const pngs = SIZES.map((size, i) => ({ size, data: Buffer.from(urls[i].split(',')[1], 'base64') }));
  const dir = __dirname;
  fs.writeFileSync(path.join(dir, 'icon.png'), pngs.find((p) => p.size === 512).data);
  writeIco(path.join(dir, 'icon.ico'), pngs.filter((p) => ICO_SIZES.includes(p.size)));
  for (const s of [16, 32, 256]) fs.writeFileSync(path.join(dir, `preview-${s}.png`), pngs.find((p) => p.size === s).data);
  console.log('Saved icon.png, icon.ico and previews in', dir);
  app.quit();
});
