// Follows where a window is on screen while it is recorded, so a click can be placed inside the
// window's video. Electron does not give a window's position from its capture id, so a small
// PowerShell process asks Windows for it a few times a second. Nothing extra is installed.
// It reads the DWM frame bounds, which are in physical pixels like the mouse hook's coordinates.
const { spawn } = require('child_process');

const POLL_MS = 200; // the window may be moved during a recording
const SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DrecWin {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out Rect rect, int size);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
}
"@
$h = [IntPtr]__HWND__
while ($true) {
  if (-not [DrecWin]::IsWindow($h)) { 'gone'; break }
  $r = New-Object DrecWin+Rect
  [void][DrecWin]::DwmGetWindowAttribute($h, 9, [ref]$r, 16)
  "$($r.Left) $($r.Top) $($r.Right) $($r.Bottom)"
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;

let proc = null;
let hwnd = null;
let rect = null;

// "window:132456:0" is how Electron names a window source; the middle number is its handle.
function handleFromSourceId(sourceId) {
  const n = Number(String(sourceId || '').split(':')[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function start(sourceId) {
  const next = handleFromSourceId(sourceId);
  if (next === hwnd && proc) return; // already following this window
  stop();
  hwnd = next;
  if (!hwnd) return;
  const encoded = Buffer.from(SCRIPT.replace('__HWND__', String(hwnd)), 'utf16le').toString('base64');
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === 'gone') { rect = null; continue; }
      const [left, top, right, bottom] = line.split(' ').map(Number);
      if ([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top) rect = { left, top, right, bottom };
    }
  });
  proc.on('error', () => { proc = null; });
  proc.on('exit', () => { proc = null; });
}

// One reading of where a window is, for placing the bubble in one of its corners before recording.
const READ_ONCE_TIMEOUT_MS = 8000; // the PowerShell helper can take a few seconds to start
function readOnce(sourceId) {
  return new Promise((resolve) => {
    const handle = handleFromSourceId(sourceId);
    if (!handle) { resolve(null); return; }
    const once = SCRIPT.replace('__HWND__', String(handle)).replace('Start-Sleep', 'break; Start-Sleep');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(once, 'utf16le').toString('base64')], { windowsHide: true });
    let out = '';
    const timer = setTimeout(() => { p.kill(); resolve(null); }, READ_ONCE_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('exit', () => {
      clearTimeout(timer);
      const [left, top, right, bottom] = out.trim().split(/\s+/).map(Number);
      resolve([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top ? { left, top, right, bottom } : null);
    });
  });
}

function stop() {
  if (proc) proc.kill();
  proc = null;
  hwnd = null;
  rect = null;
}

// Where a click in physical pixels falls inside the window, as fractions from 0 to 1, or null.
function locate(x, y) {
  if (!rect) return null;
  if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return null;
  return { fx: (x - rect.left) / (rect.right - rect.left), fy: (y - rect.top) / (rect.bottom - rect.top) };
}

module.exports = { start, stop, locate, readOnce, current: () => rect };
