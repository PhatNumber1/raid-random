'use strict';
// Pretend Twitch and pretend OBS. No real raid is started and no real stream is stopped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../src/store');
const { findCandidates, findElsewhere, forStage, choose, range, TIERS } = require('../src/picker');
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

test('picking: leaves out the excluded and non-live, and offers the right ones at each step', async () => {
  const api = pages([[ch('a', 900), ch('b', 24), ch('b', 24), ch('c', 18), ch('d', 22, { type: '' }), ch('e', 2)]]);
  const all = await findCandidates(api, MINE, new Set(['c']));
  assert.deepEqual(all.map((s) => s.user_id), ['a', 'b', 'e']);
  assert.deepEqual(forStage(all, 20, 1).map((s) => s.user_id), ['b', 'e']); // similar size only
  assert.deepEqual(forStage(all, 20, 2).map((s) => s.user_id), ['b', 'e', 'a']); // any size, closest first
});

test('picking: one range at a time, then any size, then other categories', () => {
  const list = [ch('a', 35), ch('b', 55), ch('c', 5000)];
  assert.equal(choose(list, 20, () => 0, 1, 1), null);
  assert.equal(choose(list, 20, () => 0, 1, 2).user_id, 'a');
  assert.equal(choose([ch('b', 55)], 20, () => 0, 1, 2), null);
  assert.equal(choose([ch('b', 55)], 20, () => 0, 1, 3).user_id, 'b');
  assert.equal(choose([ch('c', 5000)], 20, () => 0, 1, 3), null);
  assert.equal(choose([ch('c', 5000)], 20, () => 0, 2).user_id, 'c');
  assert.equal(choose([ch('c', 5000)], 20, () => 0, 3).user_id, 'c');
  assert.equal(choose([], 20, () => 0, 3), null);
});

test('picking: other categories are random, never your own, and limited', async () => {
  const asked = [];
  const api = {
    topGames: async ({ after }) => ({ data: after ? [] : [{ id: 'g' }, ...Array.from({ length: 30 }, (_, i) => ({ id: `x${i}` }))], cursor: null }),
    liveStreams: async ({ gameId, language }) => { asked.push(gameId); assert.equal(language, 'en'); return { data: [ch(`s${gameId}`, 9000)], cursor: null }; },
  };
  const got = await findElsewhere(api, MINE, new Set(['sx1']));
  assert.equal(asked.length, 8); // nobody of a similar size, so it looks in 8 and stops
  assert.ok(!asked.includes('g') && new Set(asked).size === 8);
  assert.ok(!got.some((s) => s.user_id === 'sx1'));
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
    countdownMs: 60, giveUpMs: 120, graceMs: 30, searchPauseMs: 0, ...t.times,
    api: {
      stream: async (id) => (id === 'me' ? (t.live ? { ...MINE, game_id: t.game ?? 'g' } : null) : (t.gone === id ? null : ch(id, 20))),
      liveStreams: async ({ gameId }) => ({ data: gameId === 'g' ? t.targets : t.elsewhere || [], cursor: null }),
      topGames: async () => { if (t.topFails) throw new Error('timeout'); return { data: [{ id: 'g' }, { id: 'other' }], cursor: null }; },
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
  for (const [over, text] of [[{ live: false }, /not live/], [{ game: '' }, /category/], [{ streaming: false }, /not streaming/], [{ streaming: 'error' }, /Cannot reach OBS/], [{ line: false }, /connecting/]]) {
    const t = setup(over);
    await t.raid.find();
    assert.equal(t.raid.state, 'error');
    assert.match(t.raid.view().message, text);
  }
});

test('search: widens step by step, and says so', async () => {
  const seen = [];
  const t = setup({ targets: [ch('far', 55)], times: { searchPauseMs: 25 } });
  const watch = setInterval(() => { const v = t.raid.view(); if (v.state === 'searching' && v.message && !seen.includes(v.message)) seen.push(v.message); }, 2);
  await t.raid.find();
  clearInterval(watch);
  assert.equal(t.raid.view().target.id, 'far');
  assert.ok(seen.some((m) => /Nobody with 10 to 30 viewers/.test(m)), seen.join('|'));
  assert.ok(seen.some((m) => /Nobody with 0 to 40 viewers/.test(m)));
  assert.equal(t.raid.view().note, undefined); // still a similar size
});

test('search: any size in the category, then other categories, each with a note', async () => {
  const a = setup({ targets: [ch('big', 5000)] });
  await a.raid.find();
  assert.equal(a.raid.view().target.id, 'big');
  assert.match(a.raid.view().note, /one of the closest/);
  const b = setup({ targets: [], elsewhere: [ch('else', 22)] });
  await b.raid.find();
  assert.equal(b.raid.view().target.id, 'else');
  assert.match(b.raid.view().note, /different one/);
  assert.deepEqual([...a.raids, ...b.raids], []); // you still confirm
});

test('search: the steps shown match what is searched', () => {
  const steps = setup().raid.searchSteps('anyone', { viewer_count: 20, game_name: 'GTA 6' });
  assert.deepEqual(steps.map((s) => s.text), ['Searching GTA 6 for 10 to 30 viewers...', 'Searching GTA 6 for 0 to 40 viewers...', 'Searching GTA 6 for 0 to 60 viewers...', 'Searching GTA 6, any size...', 'Searching other categories...']);
  assert.equal(setup().raid.searchSteps('network', { viewer_count: 20 }).length, 1);
});

test('search: can be cancelled while it counts down to the next step', async () => {
  const t = setup({ targets: [], times: { searchPauseMs: 40 } });
  const search = t.raid.find();
  await wait(10);
  assert.equal(t.raid.state, 'searching');
  assert.ok(t.raid.view().secondsLeft >= 0);
  await t.raid.cancel();
  await search;
  assert.equal(t.raid.state, 'idle');
});

test('nobody: the stream keeps running until you choose to end it', async () => {
  for (const over of [{ targets: [] }, { targets: [], topFails: true }]) {
    const t = setup(over);
    await assert.rejects(t.raid.endAnyway(), /not possible/); // only when nobody was found
    await t.raid.find();
    assert.equal(t.raid.state, 'nobody');
    assert.match(t.raid.view().message, /Nobody was raided/);
    await wait(40);
    assert.equal(t.stops, 0);
    await t.raid.endAnyway();
    assert.equal(t.stops, 1);
    assert.equal(t.raid.state, 'stopped');
    assert.equal(t.raid.view().target ?? null, null);
  }
  const t = setup({ targets: [] });
  await t.raid.find();
  await t.raid.cancel(); // keep streaming
  assert.deepEqual([t.raid.state, t.stops], ['idle', 0]);
});

test('nobody: if OBS does not stop you are told, and can try again', async () => {
  let fail = true;
  const t = setup({ targets: [], stop: async () => { if (fail) throw new Error('OBS did not answer.'); } });
  await t.raid.find();
  await t.raid.endAnyway();
  assert.equal(t.raid.state, 'ask');
  fail = false;
  await t.raid.stopNow();
  assert.equal(t.raid.state, 'stopped');
});

test('raid: OBS closing between picking and confirming means no raid', async () => {
  const t = setup();
  await t.raid.find();
  t.streaming = false;
  await t.raid.go('a');
  assert.equal(t.raid.state, 'nobody');
  assert.equal(t.stops, 0);
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
