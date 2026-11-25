'use strict';
// Serves the setup page and the dock, only to this PC.
// Any website you visit can try to talk to programs on your PC, so every request
// must use our exact address, and every API call needs a key only our pages are given.
const http = require('node:http');
const crypto = require('node:crypto');
const { STATS, REFRESH, isRefresh } = require('./stats');
const { readPublic } = require('./files');

const PAGES = { '/': 'setup.html', '/dock': 'dock.html' };
const ASSETS = {
  '/setup.js': ['setup.js', 'text/javascript'],
  '/dock.js': ['dock.js', 'text/javascript'],
  '/setup.css': ['setup.css', 'text/css'],
  '/dock.css': ['dock.css', 'text/css'],
  '/ping.svg': ['ping.svg', 'image/svg+xml'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};
const MAX_BODY = 10 * 1024;
const APP_HEADER = 'raid-random';

class BadRequest extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new BadRequest('Too much data')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new BadRequest('Not valid JSON')); }
    });
    req.on('error', reject);
  });
}

function checkStats(input) {
  if (!input || !Array.isArray(input.stats)) throw new BadRequest('Missing stats');
  const known = STATS.map((s) => s.id);
  if (input.stats.some((id) => !known.includes(id))) throw new BadRequest('Unknown stat');
  if (!input.stats.length) throw new BadRequest('Tick at least one stat.');
  return known.filter((id) => input.stats.includes(id));
}

function checkRefresh(value) {
  if (!isRefresh(value)) throw new BadRequest(`Choose a whole number from ${REFRESH.min} to ${REFRESH.max} seconds.`);
  return value;
}

function checkSettings(input, now = {}) {
  return {
    stats: checkStats(input),
    dock: input.dock !== false,
    autostart: input.autostart !== false,
    refresh: input.refresh === undefined ? now.refresh ?? REFRESH.usual : checkRefresh(input.refresh),
    saved: true,
  };
}

function createServer({ auth, stats, settings, installer = null, raid = null, network = null, subsState = () => 'off', port, demo = false, quit = () => {}, log = () => {}, showWindow = () => {}, openTwitch = () => {}, finish = () => {} }) {
  const key = crypto.randomBytes(24).toString('hex');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const notDuringRaid = () => { if (raid?.busy) throw new BadRequest('Please wait until the raid is finished.'); };
  // Answers quickly: slow work carries on and the dock follows along. Refusals still come back.
  const soon = (work) => {
    work.catch(() => {});
    return Promise.race([work, new Promise((r) => setTimeout(r, 100))]);
  };
  const raidStep = (work) => async (req) => {
    if (!raid) throw new BadRequest('Not available');
    await work(await readBody(req));
    return { raid: raid.view() };
  };

  const api = {
    'POST /api/raid/find': raidStep(() => soon(raid.find())),
    'POST /api/raid/go': raidStep((body) => soon(raid.go(String(body.targetId)))),
    'POST /api/raid/cancel': raidStep(() => raid.cancel()),
    'POST /api/raid/stop': raidStep(() => soon(raid.stopNow())),
    'POST /api/raid/keep': raidStep(() => raid.keepStreaming()),
    'GET /api/state': () => ({
      demo,
      auth: auth.status(),
      settings: settings.get(),
      refreshLimits: REFRESH,
      available: STATS.map(({ id, label, note }) => ({ id, label, note })),
      stats: auth.user ? stats.snapshot(subsState()) : null,
      raid: raid && auth.user ? raid.view() : null,
      network: { available: Boolean(network?.available), joined: Boolean(network?.joined) },
      obs: installer ? installer.status() : null,
    }),
    'POST /api/login': async () => { await auth.startLogin(); return { auth: auth.status() }; },
    'POST /api/logout': async () => {
      notDuringRaid(); await auth.signOut(); await network?.leave(); return { auth: auth.status() }; },
    // From the gear in the dock: only the stats, everything else stays as it is.
    'POST /api/stats': async (req) => {
      const next = { ...settings.get(), stats: checkStats(await readBody(req)) };
      settings.set(next);
      stats.refreshNow();
      return { settings: next };
    },
    'POST /api/refresh': async (req) => {
      const next = { ...settings.get(), refresh: checkRefresh((await readBody(req)).seconds) };
      settings.set(next);
      stats.refreshNow();
      return { settings: next };
    },
    'POST /api/settings': async (req) => {
      const next = checkSettings(await readBody(req), settings.get());
      settings.set(next);
      stats.refreshNow();
      const obs = installer ? await installer.apply(next) : null;
      return { settings: next, obs };
    },
    // Only ever the address Twitch gave us for this sign-in, checked to be on twitch.tv.
    'POST /api/open-twitch': () => {
      const s = auth.status();
      if (s.state !== 'pending') throw new BadRequest('No sign-in is waiting.');
      openTwitch(s.url);
      return { ok: true };
    },
    'POST /api/finish': () => { notDuringRaid(); finish(); return { ok: true }; },
    'POST /api/show-window': () => { showWindow(); return { ok: true }; },
    'POST /api/quit': async (req) => {
      notDuringRaid();
      log((await readBody(req)).by === 'page' ? 'Quit was pressed in the setup window.' : 'A newer copy is taking over.');
      quit(); return { ok: true };
    },
  };

  function send(res, status, type, body) {
    res.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Raid-Random': APP_HEADER,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  }
  const sendJson = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));

  return http.createServer(async (req, res) => {
    try {
      if (!hosts.has(req.headers.host)) return sendJson(res, 403, { error: 'Wrong address' });
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return sendJson(res, 403, { error: 'Wrong origin' });
      const { pathname } = new URL(req.url, 'http://127.0.0.1');

      if (pathname.startsWith('/api/')) {
        if (req.headers['x-raid-random-key'] !== key) return sendJson(res, 403, { error: 'Please reload this page' });
        const handler = api[`${req.method} ${pathname}`];
        if (!handler) return sendJson(res, 404, { error: 'Not found' });
        return sendJson(res, 200, await handler(req));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Not allowed' });
      if (PAGES[pathname]) {
        const html = readPublic(PAGES[pathname]).toString('utf8');
        return send(res, 200, 'text/html', html.replace('{{KEY}}', key));
      }
      if (ASSETS[pathname]) {
        const [file, type] = ASSETS[pathname];
        return send(res, 200, type, readPublic(file));
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const mild = err instanceof BadRequest || err.userError;
      if (!mild) log(`Request failed: ${err.message}`);
      if (!res.headersSent) sendJson(res, mild ? 400 : 502, { error: err.message });
      else res.end();
    }
  });
}

module.exports = { createServer, checkSettings, APP_HEADER };
