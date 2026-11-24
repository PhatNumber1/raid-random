'use strict';
// Shows the setup as its own small window: no address bar, no tabs. It is drawn by Microsoft
// Edge, which is part of Windows, with a separate profile so it never mixes with your browsing.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SIZE = [520, 860];

function findEngine(env = process.env, exists = fs.existsSync) {
  const edge = ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  const chrome = ['Google', 'Chrome', 'Application', 'chrome.exe'];
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  for (const parts of [edge, chrome]) {
    for (const root of roots) {
      const file = path.join(root, ...parts);
      if (exists(file)) return file;
    }
  }
  return null;
}

function windowArgs(address, profile) {
  return [
    `--app=${address}`, `--user-data-dir=${profile}`, `--window-size=${SIZE.join(',')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-mode',
  ];
}

function launch(file, args, log) {
  spawn(file, args, { stdio: 'ignore', detached: true }).on('error', (err) => log(`Could not open a window: ${err.message}`)).unref();
}

// The user's normal browser. Only used for Twitch, where they are already signed in.
function openLink(url, { log = () => {}, start = launch } = {}) {
  start('rundll32.exe', ['url.dll,FileProtocolHandler', url], log);
}

function openWindow(address, { profile, log = () => {}, start = launch, engine = findEngine() }) {
  if (engine) start(engine, windowArgs(address, profile), log);
  else { log('Edge and Chrome were not found, so the normal browser is used.'); openLink(address, { log, start }); }
}

module.exports = { openWindow, openLink, findEngine, windowArgs };
