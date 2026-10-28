// Checks how big a Project is and "delete raw material, keep MP4" on throwaway folders, without the app.
// The plain MP4 is a hard link to screen.mp4 (or a copy on another drive), so the raw video costs no
// extra space while both exist. Run: node test/storage-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { projectSize, deleteRaw, RAW_DELETED_MESSAGE } = require('../src/project-storage');

const checks = {};
const run = (name, fn) => { try { fn(); checks[name] = true; } catch (err) { checks[name] = false; console.error(`${name}: ${err.message}`); } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dr-storage-'));

// A Project like finishProject leaves it: screen.mp4, camera.webm, events.json, project.json, and the plain
// MP4 in the output folder. `link` false makes the plain MP4 a copy (another drive).
function makeProject(name, { link = true, camera = true, plain = true } = {}) {
  const out = path.join(root, name);
  const dir = path.join(out, 'Projects', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'screen.mp4'), Buffer.alloc(5000, 1));
  if (camera) fs.writeFileSync(path.join(dir, 'camera.webm'), Buffer.alloc(3000, 2));
  fs.writeFileSync(path.join(dir, 'events.json'), '{"version":1,"cursor":[],"clicks":[]}');
  fs.writeFileSync(path.join(dir, 'background.png'), Buffer.alloc(200, 3));
  const plainFile = path.join(out, `${name}.mp4`);
  if (plain) (link ? fs.linkSync : fs.copyFileSync)(path.join(dir, 'screen.mp4'), plainFile);
  const project = { version: 1, mode: 'screen', durationSec: 3, screen: { file: 'screen.mp4' }, camera: camera ? { file: 'camera.webm', offsetMs: 0 } : null, backgroundImage: 'background.png', plainMp4: plain ? plainFile : null };
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project));
  return { dir, plainFile };
}
const readProject = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const bytesOf = (dir, f) => fs.statSync(path.join(dir, f)).size;

run('the size counts every file of the Project', () => {
  const { dir } = makeProject('sizes');
  const s = projectSize(dir);
  const all = fs.readdirSync(dir).reduce((n, f) => n + bytesOf(dir, f), 0);
  assert.strictEqual(s.bytes, all);
  assert.strictEqual(s.rawDeleted, false);
});

run('what deleting would free leaves out the video shared with the plain MP4', () => {
  const { dir } = makeProject('shared');
  const s = projectSize(dir);
  assert.strictEqual(s.freeable, s.bytes - bytesOf(dir, 'screen.mp4') - bytesOf(dir, 'project.json'));
});

run('with a copied plain MP4, the screen video is freed too', () => {
  const { dir } = makeProject('copied', { link: false });
  const s = projectSize(dir);
  assert.strictEqual(s.freeable, s.bytes - bytesOf(dir, 'project.json'));
});

run('deleting keeps the plain MP4 and project.json, removes the rest and marks the Project', () => {
  const { dir, plainFile } = makeProject('delete');
  const before = projectSize(dir);
  const done = deleteRaw(dir);
  assert.deepStrictEqual(fs.readdirSync(dir), ['project.json']);
  assert.strictEqual(fs.statSync(plainFile).size, 5000);
  assert.strictEqual(fs.readFileSync(plainFile)[0], 1);
  assert.strictEqual(done.freed, before.freeable);
  assert.deepStrictEqual(done.removed.sort(), ['background.png', 'camera.webm', 'events.json', 'screen.mp4']);
  const p = readProject(dir);
  assert(typeof p.rawDeleted === 'string' && !Number.isNaN(Date.parse(p.rawDeleted)));
  assert.strictEqual(p.backgroundImage, undefined);
});

run('after deleting, the size says so and a second delete is refused', () => {
  const { dir } = makeProject('twice');
  deleteRaw(dir);
  const s = projectSize(dir);
  assert.strictEqual(s.rawDeleted, true);
  assert.strictEqual(s.freeable, 0);
  assert.throws(() => deleteRaw(dir), /already deleted/);
});

run('no plain MP4 (moved, deleted or never made) means nothing is deleted', () => {
  const a = makeProject('noplain', { plain: false });
  assert.throws(() => deleteRaw(a.dir), /only copy/);
  const b = makeProject('gone');
  fs.rmSync(b.plainFile);
  assert.throws(() => deleteRaw(b.dir), /only copy/);
  assert(fs.existsSync(path.join(b.dir, 'screen.mp4')) && fs.existsSync(path.join(b.dir, 'camera.webm')));
});

run('a plain MP4 that is not the same recording is not trusted', () => {
  const { dir, plainFile } = makeProject('other', { link: false });
  fs.writeFileSync(plainFile, Buffer.alloc(10, 9)); // the user saved something else under that name
  assert.throws(() => deleteRaw(dir), /only copy/);
  assert(fs.existsSync(path.join(dir, 'screen.mp4')));
});

run('a different file of the same size is not trusted either', () => {
  const { dir, plainFile } = makeProject('samesize', { link: false });
  fs.writeFileSync(plainFile, Buffer.alloc(5000, 7));
  assert.throws(() => deleteRaw(dir), /only copy/);
});

run('files that are not raw material are left alone', () => {
  const { dir } = makeProject('extra');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  deleteRaw(dir);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['notes.txt', 'project.json']);
});

run('a Project that never converted to MP4 is refused', () => {
  const { dir } = makeProject('webm', { plain: false });
  const p = readProject(dir);
  p.screen.file = 'screen.webm';
  fs.renameSync(path.join(dir, 'screen.mp4'), path.join(dir, 'screen.webm'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p));
  assert.throws(() => deleteRaw(dir), /only copy/);
});

run('the message export gives after a delete is clear', () => {
  assert(/raw material was deleted/.test(RAW_DELETED_MESSAGE) && /cannot be exported/.test(RAW_DELETED_MESSAGE));
});

fs.rmSync(root, { recursive: true, force: true });
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
console.log(JSON.stringify(checks, null, 2));
console.log(failed.length ? `FAIL: ${failed.length} of ${Object.keys(checks).length}` : `OK: ${Object.keys(checks).length} of ${Object.keys(checks).length}`);
process.exit(failed.length ? 1 : 0);
