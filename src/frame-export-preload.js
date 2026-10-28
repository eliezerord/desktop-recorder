// The drawing window of the frame-by-frame Export (frame-export.js) gets only these calls.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frameApi', {
  screen: () => ipcRenderer.invoke('fx-screen'), // the next screen frame, RGBA, or null at the end
  camera: () => ipcRenderer.invoke('fx-camera'), // the next camera frame, RGBA, or null at the end
  frame: (px) => ipcRenderer.invoke('fx-frame', px), // a finished frame for the encoder
});
