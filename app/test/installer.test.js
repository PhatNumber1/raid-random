'use strict';
// Everything here works on throwaway folders. Your real OBS is never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDocks, addDock, removeDock } = require('../src/obs-config');
const { Installer, findObsFile } = require('../src/installer');

const BOM = '\uFEFF';
const other = { title: 'Chat "é"', url: 'https://example.com/a?b=c&d', uuid: 'a'.repeat(32) };
const ini = (docks, eol = '\n') => [`${BOM}[General]`, 'Path=C:\\\\x', '', '[BasicWindow]', 'PreviewEnabled=true',
  `ExtraBrowserDocks=${JSON.stringify(docks).replace(/\\/g, '\\\\')}`, 'DockState=AAA', '', '[Basic]', 'Profile=x', ''].join(eol);
const url = 'file:///C:/x/dock.html';
const mine = { title: 'Raid Random', url, isOurs: (u) => u === url || u === 'http://127.0.0.1:1/dock' };
const withoutDockLine = (t) => t.split('\n').filter((l) => !l.startsWith('ExtraBrowserDocks=')).join('\n');

test('dock list: adds ours last and leaves everything else alone', () => {
  for (const eol of ['\n', '\r\n']) {
    const before = ini([other], eol);
    const after = addDock(before, mine);
    const docks = readDocks(after);
    assert.deepEqual(docks[0], other);
    assert.equal(docks[1].url, url);
    assert.match(docks[1].uuid, /^[0-9a-f]{32}$/);
    assert.equal(withoutDockLine(after), withoutDockLine(before));
    assert.equal(addDock(after, mine), after); // a second time changes nothing
    assert.deepEqual(readDocks(removeDock(after, mine)), [other]);
  }
});

test('dock list: takes over a hand-made dock, keeping its place, name and id', () => {
  const hand = { title: 'My raid dock', url: 'http://127.0.0.1:1/dock', uuid: 'b'.repeat(32) };
  assert.deepEqual(readDocks(addDock(ini([hand, other]), mine)), [{ ...hand, url }, other]);
});

test('dock list: works when the line or section does not exist yet', () => {
  for (const text of ['', '[General]\nA=1\n', '[BasicWindow]\nA=1\n', '[BasicWindow]\nExtraBrowserDocks=\n']) {
    const docks = readDocks(addDock(text, mine));
    assert.equal(docks.length, 1);
    assert.equal(docks[0].url, url);
  }
});

test('dock list: refuses a list it does not understand', () => {
  for (const bad of ['[{"title":', '{"a":1}', '[1]']) {
    assert.throws(() => addDock(`[BasicWindow]\nExtraBrowserDocks=${bad}\n`, mine), /nothing was changed/);
  }
});

function setup({ running = false, docks = [other] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-random-test-'));
  const file = path.join(dir, 'user.ini');
  fs.writeFileSync(file, ini(docks));
  const state = { running, command: null };
  const installer = new Installer({
    port: 1, appDir: path.join(__dirname, '..'), home: path.join(dir, 'home'), obsFile: () => file,
    isObsRunning: async () => { if (state.running === 'unknown') throw new Error('x'); return state.running; },
    autostart: { set: async (c) => { state.command = c; }, remove: async () => { state.command = null; } },
  });
  const backups = () => fs.readdirSync(dir).filter((n) => n.endsWith('.bak'));
  return { dir, file, state, installer, backups, done: () => { clearTimeout(installer.timer); fs.rmSync(dir, { recursive: true }); } };
}

test('Save: adds the dock, makes a backup, copies the app and starts it with Windows', async () => {
  const t = setup();
  const before = fs.readFileSync(t.file);
  const s = await t.installer.apply({ dock: true, autostart: true });
  assert.deepEqual(s, { dock: 'added', waiting: false, error: null });
  assert.deepEqual(fs.readFileSync(path.join(t.dir, t.backups()[0])), before);
  assert.ok(fs.existsSync(path.join(t.installer.installedApp, 'src', 'main.js')));
  assert.ok(fs.existsSync(t.installer.loader));
  assert.ok(!fs.existsSync(path.join(t.installer.installedApp, 'test')));
  assert.match(t.state.command, /--headless ".*node.*" ".*main\.js" --background$/);
  await t.installer.apply({ dock: true, autostart: true });
  assert.equal(t.backups().length, 1); // nothing to change, so no new backup
  t.done();
});

test('Save: unticking takes the dock and the Windows start away again', async () => {
  const t = setup();
  await t.installer.apply({ dock: true, autostart: true });
  const s = await t.installer.apply({ dock: false, autostart: false });
  assert.equal(s.dock, 'missing');
  assert.equal(t.state.command, null);
  assert.deepEqual(readDocks(fs.readFileSync(t.file, 'utf8')), [other]);
  t.done();
});

test('Save: waits while OBS is open, then finishes', async () => {
  const t = setup({ running: true });
  const before = fs.readFileSync(t.file);
  let s = await t.installer.apply({ dock: true, autostart: false });
  assert.equal(s.waiting, true);
  assert.deepEqual(fs.readFileSync(t.file), before);
  // OBS closes and saves something of its own first. That must survive.
  fs.writeFileSync(t.file, ini([other, { ...other, title: 'New' }]));
  t.state.running = false;
  await t.installer.tryDock(true, t.installer.job);
  s = t.installer.status();
  assert.deepEqual(s, { dock: 'added', waiting: false, error: null });
  assert.equal(readDocks(fs.readFileSync(t.file, 'utf8')).length, 3);
  t.done();
});

test('Save: changes nothing when it cannot be sure', async () => {
  for (const damage of [(t) => { t.state.running = 'unknown'; }, (t) => fs.writeFileSync(t.file, Buffer.from([0x5b, 0xff, 0xfe])), (t) => fs.writeFileSync(t.file, '[BasicWindow]\nExtraBrowserDocks=oops\n')]) {
    const t = setup();
    damage(t);
    const before = fs.readFileSync(t.file);
    const s = await t.installer.apply({ dock: true, autostart: false });
    assert.match(s.error, /nothing was changed/);
    assert.deepEqual(fs.readFileSync(t.file), before);
    assert.equal(t.backups().length, 0);
    t.done();
  }
});

test('Save: keeps only the newest backups', async () => {
  const t = setup();
  let n = 0;
  t.installer.now = () => new Date(2026, 0, 1, 0, 0, n++);
  for (let i = 0; i < 4; i++) {
    await t.installer.apply({ dock: true, autostart: false });
    await t.installer.apply({ dock: false, autostart: false });
  }
  assert.equal(t.backups().length, 5);
  t.done();
});

test('the .exe: is copied, started with Windows, and replaced by a newer one', async () => {
  const t = setup();
  const download = path.join(t.dir, 'Downloaded.exe');
  fs.writeFileSync(download, 'version 1');
  Object.assign(t.installer, { packaged: true, execPath: download });
  t.installer.autostart.get = async () => t.state.command;
  await t.installer.apply({ dock: true, autostart: true });
  assert.equal(t.state.command, `"${t.installer.installedExe}" --background`);
  assert.ok(!fs.existsSync(t.installer.installedApp));
  for (const v of ['version 2', 'version 3']) {
    fs.writeFileSync(download, v);
    t.state.command = 'an older command';
    await t.installer.update({ autostart: true });
    assert.equal(fs.readFileSync(t.installer.installedExe, 'utf8'), v);
    assert.match(t.state.command, /RaidRandom\.exe" --background$/);
  }
  t.state.command = null; // the user switched it off elsewhere
  await t.installer.update({ autostart: true });
  assert.equal(t.state.command, null);
  t.installer.execPath = t.installer.installedExe; // the installed one does not copy itself
  await t.installer.update({ autostart: false });
  t.done();
});

test('finding OBS: newer, older and moved settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-random-test-'));
  const obs = path.join(dir, 'obs-studio');
  assert.equal(findObsFile(dir), null);
  fs.mkdirSync(obs);
  fs.writeFileSync(path.join(obs, 'global.ini'), '[General]\n');
  assert.equal(findObsFile(dir), path.join(obs, 'global.ini'));
  fs.writeFileSync(path.join(obs, 'user.ini'), '');
  assert.equal(findObsFile(dir), path.join(obs, 'user.ini'));
  const moved = path.join(dir, 'moved');
  fs.mkdirSync(path.join(moved, 'obs-studio'), { recursive: true });
  fs.writeFileSync(path.join(moved, 'obs-studio', 'user.ini'), '');
  fs.writeFileSync(path.join(obs, 'global.ini'), `[Locations]\nConfiguration=${moved.replace(/\\/g, '\\\\')}\n`);
  assert.equal(findObsFile(dir), path.join(moved, 'obs-studio', 'user.ini'));
  fs.rmSync(dir, { recursive: true });
});
