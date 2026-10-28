// Draws the fixed layers of a look (see look.mjs) in a hidden window and hands back PNG buffers.
// The window lives only for this call, so an idle app holds nothing for Export.
const { BrowserWindow } = require('electron');
const path = require('path');

async function renderLayers(spec) {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(__dirname, 'look-renderer.html'));
    const urls = await win.webContents.executeJavaScript(`window.renderLayers(${JSON.stringify(spec)})`);
    if (urls.unreadable) throw new Error('unreadable-background-image'); // export.js says it in words
    return Object.fromEntries(Object.entries(urls).map(([name, url]) => [name, url ? Buffer.from(url.split(',')[1], 'base64') : null]));
  } finally {
    win.destroy();
  }
}

module.exports = { renderLayers };
