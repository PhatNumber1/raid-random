'use strict';
// Starts everything.
//   --demo        made-up numbers, changes nothing on this PC
//   --no-open     does not open the setup window
//   --background  how Windows starts it: no window, and leaves a running copy alone
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../config.json');
const { FileStore, MemoryStore } = require('./store');
const { TwitchAuth } = require('./twitch-auth');
const { TwitchApi } = require('./twitch-api');
const { EventSub } = require('./eventsub');
const { Stats, DEFAULT_STATS, STATS } = require('./stats');
const { Installer } = require('./installer');
const { createServer, APP_HEADER } = require('./server');
const { Network } = require('./network');
const { Raid } = require('./raid');
const { Obs } = require('./obs');
const { openWindow, openLink } = require('./window');
const { packaged } = require('./files');
const { DemoAuth, DemoApi, DemoObs } = require('./demo');

if (process.argv.includes('--version-check')) { // used by the build, to see that the .exe works
  fs.writeSync(1, `Raid Random ${require('../package.json').version}\n`);
  process.exit(0);
}

const demo = process.argv.includes('--demo');
const background = process.argv.includes('--background');
const noOpen = background || process.argv.includes('--no-open');
const port = Number(process.env.RAID_RANDOM_TEST_PORT) || (demo ? config.port + 1 : config.port);
const address = `http://127.0.0.1:${port}/`;

const store = demo ? new MemoryStore({ today: null }) : new FileStore();

// Without a window to print to, write a small log file.
let logFile = null;
if (packaged || background) {
  logFile = demo ? null : path.join(store.dir, 'app.log');
  try { if (logFile && fs.statSync(logFile).size > 200000) fs.rmSync(logFile); } catch { /* no log yet */ }
}
function log(text) {
  const line = `${new Date().toLocaleTimeString()}  ${text}`;
  if (logFile) { try { fs.appendFileSync(logFile, `${line}\n`); } catch { /* ignore */ } } else if (!packaged) console.log(line);
}

// The .exe has no window, so a problem at the start is shown in Notepad.
function giveUp(text) {
  log(text);
  if (packaged && logFile && !background) spawn('notepad.exe', [logFile], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  process.exit(1);
}

const showWindow = () => {
  if (process.platform === 'win32') openWindow(address, { profile: path.join(process.env.LOCALAPPDATA || store.dir || '.', 'RaidRandom', 'window'), log });
};

function loadSettings() {
  const s = store.load('settings');
  const known = STATS.map((x) => x.id);
  if (!s || !Array.isArray(s.stats)) return { stats: DEFAULT_STATS, dock: true, autostart: true, saved: false };
  return {
    stats: s.stats.filter((id) => known.includes(id)), dock: s.dock !== false, autostart: s.autostart !== false, saved: true,
  };
}
let current = loadSettings();
const settings = { get: () => current, set: (s) => { store.save('settings', s); current = s; } };

const auth = demo ? new DemoAuth() : new TwitchAuth({ clientId: config.twitchClientId.trim(), store });
const api = demo ? new DemoApi() : new TwitchApi({ auth });
const stats = new Stats({ api, auth, store, getSelected: () => current.stats, log });
const events = demo ? null : new EventSub({ api, onEvent, log });
const installer = demo ? null : new Installer({ port, appDir: path.join(__dirname, '..'), log });

const obs = demo ? new DemoObs() : new Obs({
  configFile: () => path.join(path.dirname(installer.obsFile() || ''), 'plugin_config', 'obs-websocket', 'config.json'),
});
const network = demo ? null : new Network({
  url: config.networkUrl, auth, store, log, getStream: () => stats.stream, version: require('../package.json').version,
});
const raid = new Raid({ api, auth, obs, store, network, log, lineReady: () => demo || events.state === 'listening', ...(demo ? { countdownMs: 8000 } : {}) });
function onEvent(type, event) { stats.onEvent(type); raid.onEvent(type, event); }
if (demo) api.onEvent = onEvent;

if (demo) for (let i = 0; i < 3; i++) stats.onEvent('channel.subscribe');

function followSignIn() {
  if (auth.user) { stats.start(); events?.start(auth.user.id); network?.start(); } else { stats.stop(); events?.stop(); network?.stop(); raid.signedOut(); }
}
auth.on('change', followSignIn);

// The permanent copy does the work, so the downloaded file can be moved or deleted.
function handOff(args) {
  if (!packaged || !installer || path.resolve(process.execPath).toLowerCase() === path.resolve(installer.installedExe).toLowerCase()) return false;
  if (!fs.existsSync(installer.installedExe)) return false;
  log('Handing over to the installed copy.');
  spawn(installer.installedExe, args, { stdio: 'ignore', detached: true }).on('error', (err) => log(`Could not start it: ${err.message}`)).unref();
  return true;
}

// After a crash, start again by itself. Not endlessly: at most 5 times in a row.
process.on('unhandledRejection', (err) => log(`Problem: ${err?.stack || err}`));
process.on('uncaughtException', (err) => {
  log(`Crash: ${err?.stack || err}`);
  const times = process.uptime() > 600 ? 0 : Number(process.env.RAID_RANDOM_RESTARTS) || 0;
  if (packaged && !demo && times < 5) {
    log('Starting again.');
    server?.close();
    server?.closeAllConnections();
    spawn(process.execPath, ['--background'], { stdio: 'ignore', detached: true, env: { ...process.env, RAID_RANDOM_RESTARTS: String(times + 1), RAID_RANDOM_TEST_CRASH: '' } }).unref();
  }
  process.exit(1);
});
if (process.env.RAID_RANDOM_TEST_PORT && process.env.RAID_RANDOM_TEST_CRASH) setTimeout(() => { throw new Error('test crash'); }, Number(process.env.RAID_RANDOM_TEST_CRASH));

const quit = () => { log('Stopping.'); setTimeout(() => process.exit(0), 100); };
const finish = () => handOff(['--no-open']);
const server = createServer({ finish, auth, stats, settings, installer, raid, network, subsState: () => events?.subsState, port, demo, quit, log, showWindow, openTwitch: (url) => openLink(url, { log }) });

function fetchPage(method, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, timeout: 3000 }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ headers: res.headers, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// Another copy is already running. Started by hand, this one takes over, so you always get the newest.
let takeovers = 0;
async function portTaken() {
  try {
    const page = await fetchPage('GET', address);
    if (page.headers['x-raid-random'] !== APP_HEADER) throw new Error('other program');
    if (background) { log('Already running.'); process.exit(0); }
    if (takeovers++ >= 3) { giveUp('Could not replace the copy that is already running. If a raid is running, wait until it is finished.'); }
    const key = /raid-random-key" content="([0-9a-f]+)"/.exec(page.text)?.[1];
    await fetchPage('POST', `${address}api/quit`, { 'X-Raid-Random-Key': key });
    setTimeout(listen, 1000);
  } catch {
    if (takeovers > 0 && takeovers < 3) { takeovers++; setTimeout(listen, 1000); return; } // it was just closing
    giveUp(`Another program is using port ${port}, which Raid Random needs. Close that program and try again.`);
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') portTaken();
  else giveUp(`Could not start: ${err.message}`);
});
server.on('listening', async () => {
  log(`Raid Random is running${demo ? ' (DEMO: made-up numbers)' : ''}.`);
  log(`Address for this PC only: ${address}`);
  if (!demo && !auth.clientId) log('No Twitch Client ID yet. Follow docs/SETUP.md, then start again.');
  // Already set up on this PC? Then keep the copy Windows starts up to date.
  if (installer && !background && current.saved && (current.dock || current.autostart)) {
    try {
      await installer.update(current);
      if (handOff(noOpen ? ['--no-open'] : [])) return; // it takes over within a moment
    } catch (err) { log(`Could not update the installed copy: ${err.message}`); }
  }
  followSignIn();
  network?.finishLeaving().catch(() => {});
  if (!noOpen) showWindow();
});
function listen() { server.listen(port, '127.0.0.1'); }
listen();
