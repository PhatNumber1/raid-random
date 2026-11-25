'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { MemoryStore } = require('../src/store');
const { TwitchAuth, SCOPES, safeVerificationUrl } = require('../src/twitch-auth');
const { TwitchApi } = require('../src/twitch-api');
const { EventSub } = require('../src/eventsub');
const { Stats } = require('../src/stats');
const { createServer } = require('../src/server');
const { openWindow, findEngine } = require('../src/window');

const json = (status, body) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise((r) => setTimeout(r, 5));
const savedAuth = (extra = {}) => ({
  clientId: 'cid', userId: '7', login: 'me', accessToken: 'a1', refreshToken: 'r1',
  expiresAt: Date.now() + 3600e3, validatedAt: Date.now(), ...extra,
});

// ---------- sign-in ----------
test('sign-in: waits for approval, then keeps the tokens', async () => {
  const store = new MemoryStore();
  let approved = false;
  const fetch = async (url, opts) => {
    if (url.endsWith('/device')) return json(200, { device_code: 'dc', expires_in: 1800, interval: 5, user_code: 'ABCD', verification_uri: 'https://www.twitch.tv/activate?x=1' });
    if (url.endsWith('/validate')) return json(200, { user_id: '7', login: 'me', scopes: SCOPES });
    assert.equal(new URLSearchParams(opts.body).get('device_code'), 'dc');
    return approved ? json(200, { access_token: 'a', refresh_token: 'r', expires_in: 14400 }) : json(400, { status: 400, message: 'authorization_pending' });
  };
  const auth = new TwitchAuth({ clientId: 'cid', store, fetch });
  let changes = 0;
  auth.on('change', () => changes++);
  await auth.startLogin();
  assert.equal(auth.status().state, 'pending');
  assert.equal(auth.status().code, 'ABCD');
  await auth.pollOnce();
  assert.equal(auth.status().state, 'pending');
  approved = true;
  await auth.pollOnce();
  assert.deepEqual(auth.status(), { state: 'signed-in', login: 'me' });
  assert.equal(store.load('auth').refreshToken, 'r');
  assert.equal(changes, 1);
  clearTimeout(auth.pollTimer);
});

test('sign-in: cancelling ignores a late approval', async () => {
  let release;
  const fetch = async (url) => {
    if (url.endsWith('/device')) return json(200, { device_code: 'dc', expires_in: 1800, interval: 5, user_code: 'A', verification_uri: '' });
    await new Promise((r) => { release = r; });
    return json(200, { access_token: 'a', refresh_token: 'r', expires_in: 1 });
  };
  const auth = new TwitchAuth({ clientId: 'cid', store: new MemoryStore(), fetch });
  await auth.startLogin();
  const poll = auth.pollOnce();
  await tick();
  await auth.signOut();
  release();
  await poll;
  assert.equal(auth.status().state, 'signed-out');
  clearTimeout(auth.pollTimer);
});

test('sign-in: only links to the real Twitch', () => {
  for (const bad of ['https://evil.example/', 'http://www.twitch.tv/x', 'javascript:alert(1)', 'https://www.twitch.tv.evil.example/', undefined]) {
    assert.equal(safeVerificationUrl(bad), 'https://www.twitch.tv/activate');
  }
});

test('renewing: many callers cause one renewal, and the new refresh token is saved', async () => {
  const store = new MemoryStore({ auth: savedAuth({ expiresAt: Date.now() - 1 }) });
  let calls = 0;
  const auth = new TwitchAuth({
    clientId: 'cid', store,
    fetch: async () => { calls++; await tick(); return json(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 14400 }); },
  });
  assert.deepEqual(await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]), ['a2', 'a2', 'a2']);
  assert.equal(calls, 1);
  assert.equal(store.load('auth').refreshToken, 'r2');
});

test('renewing: a Twitch outage keeps you signed in, a refused token signs you out', async () => {
  for (const [status, state] of [[503, 'signed-in'], [400, 'signed-out']]) {
    const auth = new TwitchAuth({ clientId: 'cid', store: new MemoryStore({ auth: savedAuth({ expiresAt: 0 }) }), fetch: async () => json(status, {}) });
    await assert.rejects(auth.getToken());
    assert.equal(auth.status().state, state);
  }
});

// ---------- Twitch questions ----------
const apiWith = (reply) => new TwitchApi({ auth: { clientId: 'cid', getToken: async () => 't' }, fetch: reply });

test('a rejected token is renewed and the question asked again', async () => {
  const used = [];
  const api = new TwitchApi({
    auth: { clientId: 'cid', getToken: async (o) => (o?.force ? 'new' : 'old') },
    fetch: async (u, o) => { used.push(o.headers.Authorization); return used.length === 1 ? json(401, {}) : json(200, { data: [] }); },
  });
  assert.equal(await api.stream('7'), null);
  assert.deepEqual(used, ['Bearer old', 'Bearer new']);
});

test('followers: counts only today, across pages', async () => {
  const at = (n) => new Date(n).toISOString();
  const api = apiWith(async (url) => (url.includes('after=p2')
    ? json(200, { total: 500, data: [{ followed_at: at(1500) }, { followed_at: at(900) }], pagination: {} })
    : json(200, { total: 500, data: [{ followed_at: at(3000) }, { followed_at: at(2000) }], pagination: { cursor: 'p2' } })));
  assert.deepEqual(await api.followers('7', 1000), { total: 500, today: 3, capped: false });
});

test('followers: stops after a fixed number of pages', async () => {
  const api = apiWith(async () => json(200, { total: 9, data: [{ followed_at: new Date(5000).toISOString() }], pagination: { cursor: 'more' } }));
  assert.deepEqual(await api.followers('7', 1000), { total: 9, today: 10, capped: true });
});

// ---------- numbers ----------
const ALL = ['viewers', 'peak', 'newFollowers', 'subsGained', 'uptime', 'totalFollowers', 'totalSubs'];
const value = (snap, id) => snap.items.find((i) => i.id === id);

test('stats: peak keeps the highest, then starts over the next day', async () => {
  let now = new Date(2026, 5, 1, 20).getTime();
  let viewers = 30;
  const stats = new Stats({
    auth: { user: { id: '7' } }, store: new MemoryStore(), getSelected: () => ALL, now: () => now,
    api: {
      stream: async () => ({ viewer_count: viewers, started_at: 'x' }),
      followers: async () => ({ total: 5, today: 2, capped: false }),
      subscriberTotal: async () => 4,
    },
  });
  stats.onEvent('channel.subscribe');
  await stats.poll();
  viewers = 10;
  await stats.poll();
  let s = stats.snapshot('listening');
  assert.equal(value(s, 'viewers').value, 10);
  assert.equal(value(s, 'peak').value, 30);
  assert.equal(value(s, 'subsGained').value, 1);
  assert.equal(value(s, 'newFollowers').value, 2);
  now += 24 * 3600e3;
  s = stats.snapshot('listening');
  assert.equal(value(s, 'newFollowers').value, null);
  await stats.poll();
  s = stats.snapshot('listening');
  assert.equal(value(s, 'peak').value, 10);
  assert.equal(value(s, 'subsGained').value, 0);
});

test('stats: every number is asked each time, every 5 seconds, slower only if Twitch says so', async () => {
  const asked = { stream: 0, followers: 0, subs: 0 };
  let busy = false;
  const stats = new Stats({
    auth: { user: { id: '7' } }, store: new MemoryStore(), getSelected: () => ALL,
    api: {
      stream: async () => { asked.stream++; return null; },
      followers: async () => { asked.followers++; if (busy) throw Object.assign(new Error('slow down'), { status: 429 }); return { total: 1, today: 0 }; },
      subscriberTotal: async () => { asked.subs++; return 1; },
    },
  });
  for (let i = 0; i < 3; i++) await stats.poll();
  assert.deepEqual(asked, { stream: 3, followers: 3, subs: 3 });
  assert.deepEqual([stats.pause(0), stats.pause(400), stats.pause(99999)], [5000, 4600, 1000]);
  busy = true;
  await stats.poll();
  assert.equal(stats.pause(0), 60000);
  busy = false;
  await stats.poll();
  assert.equal(stats.pause(0), 5000);
});

test('stats: the chosen refresh time is used, and the countdown shows it', async () => {
  let now = 1000000;
  let seconds = 20;
  const stats = new Stats({
    auth: { user: { id: '7' } }, store: new MemoryStore(), getSelected: () => ['viewers'], getRefresh: () => seconds, now: () => now,
    api: { stream: async () => null },
  });
  assert.equal(stats.pause(500), 19500);
  assert.equal(stats.snapshot().nextIn, null);
  stats.start();
  await tick();
  assert.equal(stats.snapshot().nextIn, 20);
  now += 12300;
  assert.equal(stats.snapshot().nextIn, 8);
  now += 60000;
  assert.equal(stats.snapshot().nextIn, 0);
  seconds = 600;
  stats.errors.stream = { status: 429 };
  assert.equal(stats.pause(0), 600000); // never faster than chosen
  stats.stop();
});

test('stats: today survives a restart but not a change of account', () => {
  const store = new MemoryStore();
  const make = (id) => new Stats({ auth: { user: { id } }, store, api: {}, getSelected: () => ALL });
  make('7').onEvent('channel.subscribe');
  assert.equal(value(make('7').snapshot(), 'subsGained').value, 1);
  assert.equal(value(make('8').snapshot(), 'subsGained').value, 0);
});

test('stats: one failing number does not break the others', async () => {
  const stats = new Stats({
    auth: { user: { id: '7' } }, store: new MemoryStore(), getSelected: () => ALL,
    api: {
      stream: async () => null,
      followers: async () => ({ total: 5, today: 1 }),
      subscriberTotal: async () => { throw Object.assign(new Error('no'), { status: 403 }); },
    },
  });
  await stats.poll();
  const s = stats.snapshot('unavailable');
  assert.equal(s.live, false);
  assert.equal(value(s, 'viewers').hint, 'Offline');
  assert.equal(value(s, 'totalFollowers').value, 5);
  assert.equal(value(s, 'totalSubs').hint, 'Not available for this channel');
  assert.equal(value(s, 'subsGained').value, null);
});

// ---------- live line ----------
function line(subscribe = async () => {}) {
  const sockets = []; const events = []; const subs = [];
  const es = new EventSub({
    api: { subscribeEvent: async (...a) => { subs.push(a); return subscribe(); } },
    onEvent: (t) => events.push(t),
    createSocket: (url) => { const s = { url, closed: false, close() { this.closed = true; } }; sockets.push(s); return s; },
  });
  const say = async (s, type, payload = {}, id = Math.random().toString()) => {
    s.onmessage({ data: JSON.stringify({ metadata: { message_type: type, message_id: id, message_timestamp: new Date().toISOString() }, payload }) });
    await tick();
  };
  return { es, sockets, events, subs, say };
}
const welcome = (id) => ({ session: { id, keepalive_timeout_seconds: 10 } });
const sub = { subscription: { type: 'channel.subscribe' }, event: {} };

test('live line: subscribes, and counts a repeated message once', async () => {
  const { es, sockets, events, subs, say } = line();
  es.start('7');
  await say(sockets[0], 'session_welcome', welcome('s1'));
  assert.equal(es.state, 'listening');
  assert.deepEqual(subs.map((x) => x[0]), ['channel.raid', 'channel.subscribe']);
  assert.equal(subs[0][3], 's1');
  await say(sockets[0], 'notification', sub, 'm1');
  await say(sockets[0], 'notification', sub, 'm1');
  assert.equal(events.length, 1);
  es.stop();
});

test('live line: a move keeps the old line until the new one works', async () => {
  const { es, sockets, events, subs, say } = line();
  es.start('7');
  await say(sockets[0], 'session_welcome', welcome('s1'));
  await say(sockets[0], 'session_reconnect', { session: { reconnect_url: 'wss://next' } });
  assert.equal(sockets[1].url, 'wss://next');
  assert.equal(sockets[0].closed, false);
  await say(sockets[0], 'notification', sub, 'm2');
  assert.equal(events.length, 1);
  await say(sockets[1], 'session_welcome', welcome('s1'));
  assert.equal(sockets[0].closed, true);
  assert.equal(subs.length, 2); // not subscribed a second time
  es.stop();
});

test('live line: a refusal is marked, not hammered', async () => {
  const { es, sockets, say } = line(async () => { throw Object.assign(new Error('no'), { status: 403 }); });
  es.start('7');
  await say(sockets[0], 'session_welcome', welcome('s1'));
  assert.equal(es.state, 'unavailable');
  assert.equal(sockets.length, 1);
  es.stop();
});

// ---------- the window ----------
test('window: Edge first, then Chrome, then the normal browser', () => {
  const env = { 'ProgramFiles(x86)': 'X86', ProgramFiles: 'PF', LOCALAPPDATA: 'LA' };
  const has = (word) => (f) => f.includes(word);
  assert.match(findEngine(env, () => true), /msedge\.exe$/);
  assert.match(findEngine(env, has('chrome')), /chrome\.exe$/);
  assert.equal(findEngine(env, () => false), null);
  const calls = [];
  const start = (file, args) => calls.push([file, args]);
  openWindow('http://127.0.0.1:1/', { profile: 'P', engine: 'edge', start });
  openWindow('http://127.0.0.1:1/', { profile: 'P', engine: null, start });
  assert.deepEqual([calls[0][0], calls[0][1].slice(0, 2)], ['edge', ['--app=http://127.0.0.1:1/', '--user-data-dir=P']]);
  assert.equal(calls[1][0], 'rundll32.exe');
});

// ---------- local server ----------
test('server: our pages work, other websites are refused', async () => {
  const port = 38999;
  let pending = false;
  const opened = [];
  let settings = { stats: ['viewers'], saved: false };
  const server = createServer({
    port,
    auth: { user: null, status: () => (pending ? { state: 'pending', url: 'https://www.twitch.tv/activate?x=1' } : { state: 'signed-out' }) },
    openTwitch: (url) => opened.push(url),
    showWindow: () => opened.push('window'),
    openInfo: (url) => opened.push(url),
    stats: { refreshNow() {}, snapshot: () => ({}) },
    settings: { get: () => settings, set: (s) => { settings = s; } },
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const ask = (method, path, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    const page = await ask('GET', '/dock');
    const key = /raid-random-key" content="([0-9a-f]{48})"/.exec(page.text)[1];
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal((await ask('GET', '/api/state')).status, 403);
    assert.equal((await ask('GET', '/', { Host: 'evil.example' })).status, 403);
    assert.equal((await ask('POST', '/api/login', { 'X-Raid-Random-Key': key, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await ask('GET', '/../config.json')).status, 404);
    const post = (p, h = {}) => ask('POST', p, { 'X-Raid-Random-Key': key, ...h });
    assert.equal((await post('/api/open-twitch')).status, 400); // no sign-in waiting
    pending = true;
    assert.equal((await post('/api/open-twitch')).status, 200);
    assert.equal((await post('/api/show-window')).status, 200);
    assert.equal((await post('/api/open-privacy')).status, 200);
    assert.equal((await post('/api/open-licenses')).status, 200);
    assert.deepEqual(opened, ['https://www.twitch.tv/activate?x=1', 'window', 'https://github.com/PhatNumber1/raid-random#privacy', `http://127.0.0.1:${port}/licenses.txt`]);
    const text = await ask('GET', '/licenses.txt');
    assert.match(text.headers['content-type'], /^text\/plain/);
    assert.match(text.text, /Node\.js contributors/);
    assert.equal((await ask('POST', '/api/show-window')).status, 403);
    assert.equal((await ask('GET', '/api/state', { 'X-Raid-Random-Key': key })).status, 200);
    const save = (b) => ask('POST', '/api/settings', { 'X-Raid-Random-Key': key }, b);
    assert.equal((await save('{"stats":["nope"]}')).status, 400);
    assert.equal((await save('not json')).status, 400);
    assert.equal((await save('{"stats":["peak","viewers"]}')).status, 200);
    assert.deepEqual(settings, { stats: ['viewers', 'peak'], dock: true, autostart: true, refresh: 5, saved: true });
    assert.equal((await save('{"stats":["peak"],"refresh":30}')).status, 200);
    assert.equal(settings.refresh, 30);
    assert.equal((await save('{"stats":["peak"]}')).status, 200);
    assert.equal(settings.refresh, 30); // left out means unchanged
    const every = (b) => ask('POST', '/api/refresh', { 'X-Raid-Random-Key': key }, b);
    for (const good of [2, 10, 3600]) { assert.equal((await every(JSON.stringify({ seconds: good }))).status, 200); assert.equal(settings.refresh, good); }
    for (const bad of [1, 0, -5, 2.5, 3601, '10', null]) assert.equal((await every(JSON.stringify({ seconds: bad }))).status, 400);
    assert.equal(settings.refresh, 3600);
    settings = { ...settings, dock: false, autostart: false };
    assert.equal((await post('/api/finish')).status, 200);
    const gear = (b) => ask('POST', '/api/stats', { 'X-Raid-Random-Key': key }, b);
    assert.equal((await gear('{"stats":["uptime"],"dock":true,"autostart":true}')).status, 200);
    assert.deepEqual(settings, { stats: ['uptime'], dock: false, autostart: false, refresh: 3600, saved: true }); // only the stats
    for (const bad of ['{"stats":[]}', '{"stats":["nope"]}', '{}']) assert.equal((await gear(bad)).status, 400);
  } finally { server.close(); }
});
