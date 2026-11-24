'use strict';
// What happens when you press Save:
//   1. copies the app to a permanent folder (%LOCALAPPDATA%\RaidRandom)
//   2. starts it with Windows, if ticked
//   3. adds the dock to OBS, if ticked, once OBS is closed and after making a backup
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { packaged: isPackaged } = require('./files');
const { readDocks, addDock, removeDock } = require('./obs-config');

const DOCK_TITLE = 'Raid Random';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'RaidRandom';
const BACKUPS_KEPT = 5;
const WAIT_MS = 3000;

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function obsIsRunning() {
  const out = await run('tasklist.exe', ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH']);
  return /obs64\.exe/i.test(out);
}

// The registry list of programs Windows starts for this user.
function autostartFor(key = process.env.RAID_RANDOM_TEST_RUN_KEY || RUN_KEY, name = RUN_NAME) {
  return {
    get: async () => {
      try { return /REG_SZ\s+(.*)/.exec(await run('reg.exe', ['query', key, '/v', name]))?.[1].trim() || null; } catch { return null; }
    },
    set: (command) => run('reg.exe', ['add', key, '/v', name, '/t', 'REG_SZ', '/d', command, '/f']),
    async remove() { if (await this.get()) await run('reg.exe', ['delete', key, '/v', name, '/f']); },
  };
}

// OBS 31 and newer keep docks in user.ini, older versions in global.ini.
function findObsFile(appData = process.env.APPDATA) {
  let base = path.join(appData, 'obs-studio');
  try {
    const text = fs.readFileSync(path.join(base, 'global.ini'), 'utf8');
    const moved = /^\[Locations\][^[]*?^Configuration=(.+)$/m.exec(text)?.[1].trim().replace(/\\\\/g, '\\');
    if (moved && fs.existsSync(path.join(moved, 'obs-studio'))) base = path.join(moved, 'obs-studio');
  } catch { /* no global.ini: use the usual place */ }
  for (const name of ['user.ini', 'global.ini']) {
    const file = path.join(base, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function loaderPage(port) {
  // Opened by OBS from disk. Waits for the app, then switches to the real dock.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Raid Random</title>
<style>body{margin:0;padding:12px;background:#1f2126;color:#c6c7d0;font:14px/1.4 "Segoe UI",sans-serif}</style></head>
<body><p>Waiting for Raid Random to start...</p>
<script>
(function check() {
  var probe = new Image();
  probe.onload = function () { location.replace('http://127.0.0.1:${port}/dock'); };
  probe.onerror = function () { setTimeout(check, 2000); };
  probe.src = 'http://127.0.0.1:${port}/ping.svg?' + Date.now();
})();
</script></body></html>
`;
}

class Installer {
  constructor({
    port, appDir, home = path.join(process.env.LOCALAPPDATA || '', 'RaidRandom'), obsFile = () => findObsFile(),
    isObsRunning = obsIsRunning, autostart = autostartFor(), execPath = process.execPath, packaged = isPackaged, now = () => new Date(), log = () => {},
  }) {
    Object.assign(this, { port, appDir, home, obsFile, isObsRunning, autostart, execPath, packaged, now, log });
    this.loader = path.join(home, 'dock.html');
    this.url = pathToFileURL(this.loader).href;
    this.installedApp = path.join(home, 'app');
    this.installedExe = path.join(home, 'RaidRandom.exe');
    this.waiting = false;
    this.error = null;
    this.job = 0;
  }

  isOurs = (url) => url === this.url || url === `http://127.0.0.1:${this.port}/dock` || url === `http://localhost:${this.port}/dock`;

  status() {
    let dock = 'missing';
    try {
      const file = this.obsFile();
      if (!file) dock = 'no-obs';
      else if (readDocks(fs.readFileSync(file, 'utf8')).some((d) => d.url === this.url)) dock = 'added';
    } catch { /* shown through error */ }
    return { dock, waiting: this.waiting, error: this.error };
  }

  command() {
    if (this.packaged) return `"${this.installedExe}" --background`;
    const conhost = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'conhost.exe');
    // conhost --headless runs it without a black window.
    return `"${conhost}" --headless "${this.execPath}" "${path.join(this.installedApp, 'src', 'main.js')}" --background`;
  }

  copyApp() {
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(this.loader, loaderPage(this.port));
    if (this.packaged) { this.copyExe(); return; }
    if (path.resolve(this.appDir) === path.resolve(this.installedApp)) return;
    for (const part of ['src', 'public', 'config.json', 'package.json']) {
      fs.cpSync(path.join(this.appDir, part), path.join(this.installedApp, part), { recursive: true, force: true });
    }
  }

  // Windows does not allow replacing a running .exe, but it does allow renaming it.
  copyExe() {
    if (path.resolve(this.execPath).toLowerCase() === path.resolve(this.installedExe).toLowerCase()) return;
    const fresh = `${this.installedExe}.new`;
    const old = `${this.installedExe}.old`;
    fs.copyFileSync(this.execPath, fresh);
    try { fs.rmSync(old, { force: true }); } catch { /* still running from an earlier update */ }
    if (fs.existsSync(this.installedExe)) fs.renameSync(this.installedExe, fs.existsSync(old) ? `${old}-${Date.now()}` : old);
    fs.renameSync(fresh, this.installedExe);
  }

  // Called when a newer version is started by hand on a PC that is already set up.
  async update({ autostart }) {
    this.copyApp();
    const now = await this.autostart.get();
    if (!autostart || !now) { this.log('Installed copy is up to date. Not set to start with Windows.'); return; }
    if (now !== this.command()) {
      await this.autostart.set(this.command());
      if ((await this.autostart.get()) !== this.command()) throw new Error('the Windows startup entry could not be changed');
    }
    this.log('Installed copy and Windows startup are up to date.');
  }

  // Makes the PC match what was ticked. Saving again replaces an earlier unfinished Save.
  async apply({ dock, autostart }) {
    const job = ++this.job;
    clearTimeout(this.timer);
    this.waiting = false;
    this.error = null;
    try {
      if (dock || autostart) this.copyApp();
      if (autostart) await this.autostart.set(this.command());
      else await this.autostart.remove();
      if (job === this.job) await this.tryDock(dock, job);
    } catch (err) {
      if (job === this.job) this.fail(err);
    }
    return this.status();
  }

  fail(err) {
    this.error = err.message;
    this.waiting = false;
    this.log(`Setup: ${err.message}`);
  }

  async tryDock(want, job) {
    const file = this.obsFile();
    if (!file) {
      if (want) throw new Error('OBS settings were not found. Install OBS and open it once, then press Save again.');
      return;
    }
    if (this.change(file, want) === null) { this.waiting = false; return; } // nothing to do
    let running;
    try { running = await this.isObsRunning(); } catch { throw new Error('Could not check whether OBS is open, so nothing was changed.'); }
    if (job !== this.job) return;
    if (running) {
      this.waiting = true;
      this.timer = setTimeout(() => this.tryDock(want, job).catch((err) => job === this.job && this.fail(err)), WAIT_MS);
      this.timer.unref?.();
      return;
    }
    this.write(file, want);
    this.waiting = false;
  }

  // Works out the new contents. null means nothing needs to change.
  change(file, want) {
    const before = fs.readFileSync(file);
    const text = before.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(before)) throw new Error("OBS's settings file has an unexpected format, so nothing was changed.");
    const options = { title: DOCK_TITLE, url: this.url, isOurs: this.isOurs };
    const after = want ? addDock(text, options) : removeDock(text, options);
    if (after === text) return null;
    // Everyone else's docks must come through untouched.
    const others = (t) => JSON.stringify(readDocks(t).filter((d) => !this.isOurs(d.url)));
    if (others(text) !== others(after)) throw new Error('A safety check failed, so nothing was changed.');
    return { before, after };
  }

  write(file, want) {
    const result = this.change(file, want); // read again: OBS may just have saved it
    if (!result) return;
    const stamp = this.now().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
    const prefix = `${path.basename(file)}.raid-random-`;
    fs.writeFileSync(path.join(path.dirname(file), `${prefix}${stamp}.bak`), result.before);
    const tmp = `${file}.raid-random-tmp`;
    fs.writeFileSync(tmp, result.after);
    fs.renameSync(tmp, file);
    const old = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(prefix) && n.endsWith('.bak')).sort();
    for (const name of old.slice(0, -BACKUPS_KEPT)) fs.rmSync(path.join(path.dirname(file), name), { force: true });
    this.log(want ? 'Dock added to OBS.' : 'Dock removed from OBS.');
  }
}

module.exports = { Installer, autostartFor, findObsFile, obsIsRunning, loaderPage };
