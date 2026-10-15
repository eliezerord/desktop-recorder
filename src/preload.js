// Small bridge between the windows and the main process. Pages get only these calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Control panel
  listScreens: () => ipcRenderer.invoke('list-screens'),
  selectScreen: (sourceId, displayId) => ipcRenderer.invoke('select-screen', sourceId, displayId),
  listWindows: () => ipcRenderer.invoke('list-windows'),
  selectWindow: (sourceId) => ipcRenderer.invoke('select-window', sourceId),
  setEffects: (fx) => ipcRenderer.send('set-effects', fx),
  pickBackgroundImage: () => ipcRenderer.invoke('pick-bg-image'),
  bubblePlacement: () => ipcRenderer.invoke('bubble-placement'),
  setCamera: (deviceId) => ipcRenderer.send('set-camera', deviceId),
  setBubbleSize: (size) => ipcRenderer.send('set-bubble-size', size),
  setBubbleEnabled: (on) => ipcRenderer.send('set-bubble-enabled', on),
  setSystemAudio: (on) => ipcRenderer.send('set-system-audio', on),
  recBegin: () => ipcRenderer.invoke('rec-begin'),
  recChunk: (bytes) => ipcRenderer.send('rec-chunk', bytes),
  recFinish: (info) => ipcRenderer.invoke('rec-finish', info),
  openFolder: () => ipcRenderer.send('open-folder'),
  getOutputDir: () => ipcRenderer.invoke('get-output-dir'),
  chooseOutputDir: () => ipcRenderer.invoke('choose-output-dir'),
  resetOutputDir: () => ipcRenderer.invoke('reset-output-dir'),
  onOutputDir: (fn) => ipcRenderer.on('output-dir', (_e, dir) => fn(dir)),
  onShortcut: (fn) => ipcRenderer.on('shortcut', (_e, key) => fn(key)),
  onConvertProgress: (fn) => ipcRenderer.on('convert-progress', (_e, p) => fn(p)),
  onBubbleSizeChanged: (fn) => ipcRenderer.on('bubble-size-changed', (_e, size) => fn(size)),
  getLanguage: () => ipcRenderer.invoke('get-language'),
  setLanguage: (lang) => ipcRenderer.send('set-language', lang),
  onLanguage: (fn) => ipcRenderer.on('language', (_e, lang) => fn(lang)),
  onWindowClick: (fn) => ipcRenderer.on('window-click', (_e, spot) => fn(spot)),
  reportRecState: (s) => ipcRenderer.send('rec-state', s),

  // Bubble
  onBubbleCamera: (fn) => ipcRenderer.on('bubble-camera', (_e, id) => fn(id)),
  onBubbleMode: (fn) => ipcRenderer.on('bubble-mode', (_e, mode) => fn(mode)),
  onBubbleEffects: (fn) => ipcRenderer.on('bubble-effects', (_e, fx) => fn(fx)),
  bubbleDragStart: () => ipcRenderer.send('bubble-drag-start'),
  bubbleDragEnd: () => ipcRenderer.send('bubble-drag-end'),

  // Bubble toolbar
  toolbarAction: (action) => ipcRenderer.send('toolbar-action', action),
  onToolbarState: (fn) => ipcRenderer.on('toolbar-state', (_e, s) => fn(s)),

  // Click highlight overlay
  onClickAt: (fn) => ipcRenderer.on('click-at', (_e, p) => fn(p)),

  // Recording pill
  recAction: (action) => ipcRenderer.send('rec-action', action),
  onRecState: (fn) => ipcRenderer.on('rec-state', (_e, s) => fn(s)),
});
