// How much disk a Project uses, and "delete raw material, keep MP4". Nothing here runs on its own: the
// delete only happens on a click in the panel or on drec delete-raw (ticket 08).
// The plain MP4 in the output folder is a hard link to the Project's screen.mp4 (finishProject), so while
// both exist the screen video is stored once; deleting it from the Project frees nothing, the rest does.
const fs = require('fs');
const path = require('path');

const RAW_DELETED_MESSAGE = "This Project's raw material was deleted, so it cannot be exported again. Its plain MP4 is still in the recordings folder.";

const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const statOf = (file) => { try { return fs.statSync(file); } catch { return null; } };

// The raw material: the Capture (screen video, camera, events) and the Background picture kept for exports.
// project.json stays so the Project still lists and explains itself; any other file is left alone.
const RAW = /^(screen\.(mp4|webm)|camera\.webm|events\.json|background(-new)?\.(png|jpg|webp))$/;
function rawFiles(dir) {
  return fs.readdirSync(dir).filter((name) => RAW.test(name) && statOf(path.join(dir, name))?.isFile());
}

// Three 64 KB pieces (start, middle, end) of a file, to tell a copy of the recording from another file of the same size.
function samples(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    return [0, Math.floor(size / 2), Math.max(0, size - 65536)].map((at) => {
      const buf = Buffer.alloc(Math.min(65536, size));
      fs.readSync(fd, buf, 0, buf.length, at);
      return buf;
    });
  } finally { fs.closeSync(fd); }
}

// bytes: what the folder holds. freeable: what "delete raw material" gives back (a file with another
// hard link, the plain MP4, frees nothing). rawDeleted: the delete was already done.
function projectSize(dir) {
  let bytes = 0;
  let freeable = 0;
  for (const name of fs.readdirSync(dir)) {
    const st = statOf(path.join(dir, name));
    if (!st || !st.isFile()) continue;
    bytes += st.size;
    if (name !== 'project.json' && st.nlink <= 1) freeable += st.size;
  }
  let rawDeleted = false;
  try { rawDeleted = Boolean(readProject(dir).rawDeleted); } catch { /* no project.json: not a Project */ }
  return { bytes, freeable, rawDeleted };
}

// True when the plain MP4 holds the same recording as the Project's screen video: the same file (hard
// link) or a copy with the same size and the same bytes where it is sampled. Anything else means the raw
// material is the only copy.
function plainIsSafe(project, dir) {
  if (!project.plainMp4 || project.screen?.file !== 'screen.mp4') return false;
  const screenFile = path.join(dir, 'screen.mp4');
  const plain = statOf(project.plainMp4);
  const screen = statOf(screenFile);
  if (!plain || !plain.isFile() || !screen) return false;
  if (plain.ino === screen.ino && plain.dev === screen.dev) return true;
  if (plain.size !== screen.size) return false;
  const a = samples(project.plainMp4, plain.size);
  const b = samples(screenFile, screen.size);
  return a.every((piece, i) => piece.equals(b[i]));
}

// Removes the Capture files and keeps the plain MP4. Refuses, deleting nothing, when the plain MP4 is
// missing or is not this recording. Returns the files removed and the bytes given back.
function deleteRaw(dir) {
  const project = readProject(dir);
  if (project.rawDeleted) throw new Error('The raw material of this Project was already deleted.');
  if (!plainIsSafe(project, dir)) {
    throw new Error('The plain MP4 of this Project is missing or is not the same video, so the raw material is the only copy. Nothing was deleted.');
  }
  const { freeable } = projectSize(dir);
  const removed = rawFiles(dir);
  for (const name of removed) fs.rmSync(path.join(dir, name), { force: true });
  project.rawDeleted = new Date().toISOString();
  delete project.backgroundImage;
  const file = path.join(dir, 'project.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(project, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return { removed, freed: freeable };
}

// "1.2 GB", "340 MB", "12 KB".
function formatBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${n > 0 ? Math.max(1, Math.round(n / 1e3)) : 0} KB`;
}

module.exports = { projectSize, deleteRaw, formatBytes, RAW_DELETED_MESSAGE };
