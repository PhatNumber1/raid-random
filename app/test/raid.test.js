'use strict';
// Pretend Twitch and pretend OBS. No real raid is started and no real stream is stopped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../src/store');
const { findCandidates, choose, range, TIERS } = require('../src/picker');
const { Raid } = require('../src/raid');
const { Obs, answer } = require('../src/obs');
const { EventSub } = require('../src/eventsub');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ch = (id, viewers, extra = {}) => ({ user_id: id, user_name: `N${id}`, user_login: `n${id}`, viewer_count: viewers, type: 'live', game_name: 'G', ...extra });
const status = (code) => Object.assign(new Error(`status ${code}`), { status: code });
const MINE = { viewer_count: 20, game_id: 'g', language: 'en' };

// ---------- picking ----------
const pages = (list) => ({
  calls: 0,
  async liveStreams({ after }) { this.calls++; const i = Number(after || 0); return { data: list[i] || [], cursor: i + 1 < list.length ? String(i + 1) : null }; },
});

test('picking: the sizes are ±50%, ±100% and ±200%', () => {
  assert.deepEqual(TIERS.map((x) => range(20, x)), [[10, 30], [0, 40], [0, 60]]);
  assert.deepEqual(TIERS.map((x) => range(0, x)), [[1, 1], [0, 2], [0, 3]]);
});

test('picking: widens only when nobody fits, and stops at ±200%', () => {
  const pick = (...v) => choose(v.map((n, k) => ch(String(k), n)), 20, () => 0)?.viewer_count ?? null;
  assert.equal(pick(35, 31, 10), 10);
  assert.equal(pick(60, 35), 35);
  assert.equal(pick(61, 60), 60);
  assert.equal(pick(61, 9000), null);
});

test('picking: leaves out the excluded, non-live and far too big', async () => {
  const api = pages([[ch('a', 900), ch('b', 24), ch('b', 24), ch('c', 18), ch('d', 22, { type: '' }), ch('e', 2)]]);
  assert.deepEqual((await findCandidates(api, MINE, new Set(['c']))).map((s) => s.user_id), ['b', 'e']);
});

test('picking: stops reading once channels are too small to matter', async () => {
  const api = pages([[ch('a', 500)], [ch('b', 12), ch('c', 3)], [ch('d', 1)]]);
  await findCandidates(api, MINE, new Set());
  assert.equal(api.calls, 2);
});

test('picking: your language first, everyone only if nobody fits ±50%', async () => {
  for (const [viewers, calls] of [[20, ['en']], [35, ['en', undefined]]]) {
    const asked = [];
    const api = { liveStreams: async (f) => { asked.push(f.language); return { data: [ch(f.language ? 'x' : 'y', f.language ? viewers : 20)], cursor: null }; } };
    const got = await findCandidates(api, MINE, new Set());
    assert.deepEqual(asked, calls);
    assert.equal(got.find((s) => s.user_id === 'x').same, true);
  }
});

// ---------- the raid ----------
function setup(over = {}) {
  const t = {
    stops: 0, raids: [], cancels: 0, live: true, streaming: true, line: true, targets: [ch('a', 20), ch('b', 21)],
    start: async () => {}, cancel: async () => {}, stop: async () => {}, ...over,
  };
  t.store = new MemoryStore();
  t.raid = new Raid({
    auth: { user: { id: 'me' } }, store: t.store, rng: () => 0, lineReady: () => t.line,
    countdownMs: 60, giveUpMs: 120, graceMs: 30, ...t.times,
    api: {
      stream: async (id) => (id === 'me' ? (t.live ? { ...MINE, game_id: t.game ?? 'g' } : null) : (t.gone === id ? null : ch(id, 20))),
      liveStreams: async () => ({ data: t.targets, cursor: null }),
      startRaid: async (from, to) => { t.raids.push(to); return t.start(); },
      cancelRaid: async () => { t.cancels++; return t.cancel(); },
    },
    obs: { isStreaming: async () => { if (t.streaming === 'error') throw new Error('Cannot reach OBS.'); return t.streaming; }, stopStream: async () => { t.stops++; return t.stop(); } },
  });
  t.event = (to = 'a', from = 'me') => t.raid.onEvent('channel.raid', { from_broadcaster_user_id: from, to_broadcaster_user_id: to, to_broadcaster_user_name: `N${to}` });
  t.go = async () => { await t.raid.find(); await t.raid.go('a'); };
  return t;
}

test('raid: the whole happy path stops the stream once, only after confirmation', async () => {
  const t = setup();
  await t.raid.find();
  assert.equal(t.raid.view().target.id, 'a');
  assert.equal(t.raids.length, 0); // nothing before you confirm
  await t.raid.go('a');
  assert.equal(t.raid.state, 'countdown');
  assert.equal(t.stops, 0); // Twitch saying yes is not enough
  t.event();
  assert.equal(t.raid.state, 'stopping');
  t.event(); // repeated
  await wait(60);
  assert.equal(t.raid.state, 'stopped');
  assert.equal(t.stops, 1);
  assert.equal(t.store.load('raids')[0].result, 'confirmed');
});

test('raid: without confirmation the stream keeps running and you are asked', async () => {
  const t = setup();
  await t.go();
  await wait(160);
  assert.equal(t.raid.state, 'ask');
  assert.equal(t.stops, 0);
  t.event(); // far too late
  await wait(50);
  assert.equal(t.stops, 0);
  await t.raid.stopNow();
  assert.equal(t.stops, 1);
});

test('raid: events for someone else never stop the stream', async () => {
  const t = setup();
  t.event(); // not raiding at all
  await t.go();
  t.event('a', 'stranger');
  assert.equal(t.raid.state, 'countdown');
  t.event('zzz'); // raided another channel by hand
  assert.equal(t.raid.state, 'ask');
  await wait(60);
  assert.equal(t.stops, 0);
});

test('raid: the wrong or an old name is refused', async () => {
  const t = setup();
  await assert.rejects(t.raid.go('a'), /not possible/);
  await t.raid.find();
  await assert.rejects(t.raid.go('b'), /changed/);
  await t.raid.find(); // pick another
  assert.equal(t.raid.view().target.id, 'b');
  await assert.rejects(t.raid.go('a'), /changed/);
  assert.equal(t.raids.length, 0);
});

test('raid: pressing twice raids once', async () => {
  const t = setup();
  await t.raid.find();
  const first = t.raid.go('a');
  await assert.rejects(t.raid.go('a'));
  await first;
  assert.deepEqual(t.raids, ['a']);
});

test('raid: is refused when something is not ready', async () => {
  for (const [over, text] of [[{ live: false }, /not live/], [{ game: '' }, /category/], [{ streaming: false }, /not streaming/], [{ streaming: 'error' }, /Cannot reach OBS/], [{ line: false }, /connecting/], [{ targets: [] }, /No live channel of a similar size/]]) {
    const t = setup(over);
    await t.raid.find();
    assert.equal(t.raid.state, 'error');
    assert.match(t.raid.view().message, text);
  }
});

test('raid: OBS closing between picking and confirming means no raid', async () => {
  const t = setup();
  await t.raid.find();
  t.streaming = false;
  await t.raid.go('a');
  assert.equal(t.raid.state, 'error');
  assert.equal(t.raids.length, 0);
});

test('raid: a refusal or a target going offline offers another, without raiding it', async () => {
  for (const over of [{ start: async () => { throw status(400); } }, { gone: 'a' }]) {
    const t = setup(over);
    await t.go();
    assert.equal(t.raid.state, 'confirm');
    assert.equal(t.raid.view().target.id, 'b');
    assert.match(t.raid.view().note, /Na/);
    assert.ok(t.raids.length <= 1);
  }
});

test('raid: other Twitch refusals are explained', async () => {
  for (const [code, text] of [[409, /already running/], [429, /10 raid tries/], [401, /status 401/]]) {
    const t = setup({ start: async () => { throw status(code); } });
    await t.go();
    assert.equal(t.raid.state, 'error');
    assert.match(t.raid.view().message, text);
  }
});

test('raid: no clear answer from Twitch is watched, and never stops the stream by itself', async () => {
  for (const err of [new Error('timeout'), status(500)]) {
    const t = setup({ start: async () => { throw err; } });
    await t.go();
    assert.equal(t.raid.state, 'countdown');
    assert.match(t.raid.view().note, /Check Twitch/);
    await wait(160);
    assert.equal(t.raid.state, 'ask');
    assert.equal(t.stops, 0);
  }
});

test('raid: a confirmation that beats the reply still counts once', async () => {
  const t = setup();
  t.start = async () => { t.event(); };
  await t.go();
  assert.equal(t.raid.state, 'stopping');
  await wait(60);
  assert.equal(t.stops, 1);
});

test('cancel: during the countdown', async () => {
  const t = setup();
  await t.go();
  await t.raid.cancel();
  assert.equal(t.raid.state, 'idle');
  t.event();
  await wait(60);
  assert.equal(t.stops, 0);
});

test('cancel: too late, or failing, never stops the stream', async () => {
  for (const cancel of [async () => { throw status(404); }, async () => { throw new Error('offline'); }]) {
    const t = setup({ cancel });
    await t.go();
    await t.raid.cancel();
    assert.equal(t.raid.state, 'ask');
    t.event();
    await wait(60);
    assert.equal(t.stops, 0);
  }
  const t = setup();
  t.cancel = async () => { t.event(); };
  await t.go();
  await t.raid.cancel();
  assert.equal(t.raid.state, 'ask');
  await wait(60);
  assert.equal(t.stops, 0);
});

test('keep streaming: works during the last seconds', async () => {
  const t = setup();
  await t.go();
  t.event();
  t.raid.keepStreaming();
  await wait(60);
  assert.equal(t.stops, 0);
  assert.equal(t.raid.state, 'idle');
});

test('stop: if OBS does not stop you are told, and can try again', async () => {
  let fail = true;
  const t = setup({ stop: async () => { if (fail) throw new Error('OBS did not answer.'); } });
  await t.go();
  t.event();
  await wait(60);
  assert.equal(t.raid.state, 'ask');
  fail = false;
  await t.raid.stopNow();
  assert.equal(t.raid.state, 'stopped');
});

test('raid: signing out or quitting is blocked while a raid runs', async () => {
  const t = setup();
  assert.equal(t.raid.busy, false);
  await t.go();
  assert.equal(t.raid.busy, true);
  t.raid.signedOut();
  assert.equal(t.raid.state, 'countdown');
});

test('raid: never the same channel twice in a row', async () => {
  const t = setup();
  await t.go();
  t.event();
  await wait(60);
  await t.raid.find();
  assert.equal(t.raid.view().target.id, 'b');
  await t.raid.go('b');
  t.event('b');
  await wait(60);
  await t.raid.find();
  assert.equal(t.raid.view().target.id, 'a'); // the one before is fine again
});

// ---------- OBS ----------
function fakeObs({ enabled = true, stopsAfter = 1, refuse = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-random-test-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ server_enabled: enabled, server_port: 4455, server_password: 'test-only' }));
  const t = { asked: [], active: true, closed: false, left: stopsAfter };
  const auth = { salt: 'salt', challenge: 'challenge' };
  const createSocket = () => {
    const s = {
      close() { t.closed = true; },
      send(text) {
        const { op, d } = JSON.parse(text);
        if (op === 1) {
          if (refuse || d.authentication !== answer('test-only', auth)) { setTimeout(() => s.onclose?.({ code: 4009 })); return; }
          setTimeout(() => s.onmessage({ data: JSON.stringify({ op: 2, d: {} }) }));
          return;
        }
        t.asked.push(d.requestType);
        if (d.requestType === 'StopStream') t.stopping = true;
        else if (t.stopping && t.left-- <= 0) t.active = false;
        setTimeout(() => s.onmessage({ data: JSON.stringify({ op: 7, d: { requestId: d.requestId, requestStatus: { result: true, code: 100 }, responseData: { outputActive: t.active } } }) }));
      },
    };
    setTimeout(() => s.onmessage({ data: JSON.stringify({ op: 0, d: { authentication: auth } }) }));
    return s;
  };
  t.obs = new Obs({ configFile: () => file, createSocket, timeoutMs: 200, pollMs: 5, stopWaitMs: 60 });
  t.done = () => fs.rmSync(dir, { recursive: true });
  return t;
}

test('OBS: the sign-in answer matches the published recipe', () => {
  const crypto = require('node:crypto');
  const h = (x) => crypto.createHash('sha256').update(x).digest('base64');
  assert.equal(answer('p', { salt: 's', challenge: 'c' }), h(h('ps') + 'c'));
});

test('OBS: stops, waits until it is really off, and closes the line', async () => {
  const t = fakeObs();
  assert.equal(await t.obs.isStreaming(), true);
  await t.obs.stopStream();
  assert.equal(t.active, false);
  assert.equal(t.asked.filter((a) => a === 'StopStream').length, 1);
  assert.equal(t.closed, true);
  await t.obs.stopStream(); // already off: does not press stop again
  assert.equal(t.asked.filter((a) => a === 'StopStream').length, 1);
  t.done();
});

test('OBS: problems are reported, not ignored', async () => {
  const off = fakeObs({ enabled: false });
  await assert.rejects(off.obs.isStreaming(), /WebSocket Server Settings/);
  off.done();
  const wrong = fakeObs({ refuse: true });
  await assert.rejects(wrong.obs.isStreaming(), /password/);
  wrong.done();
  const stuck = fakeObs({ stopsAfter: 1e9 });
  await assert.rejects(stuck.obs.stopStream(), /not finished/);
  stuck.done();
});

// ---------- live line ----------
test('live line: a channel without subs can still raid', async () => {
  const sockets = [];
  const es = new EventSub({
    api: { subscribeEvent: async (type) => { if (type === 'channel.subscribe') throw status(403); } },
    onEvent() {}, createSocket: () => { const s = { close() {} }; sockets.push(s); return s; },
  });
  es.start('7');
  sockets[0].onmessage({ data: JSON.stringify({ metadata: { message_type: 'session_welcome' }, payload: { session: { id: 's', keepalive_timeout_seconds: 10 } } }) });
  await wait(10);
  assert.equal(es.state, 'listening');
  assert.equal(es.subsState, 'unavailable');
  es.stop();
});
