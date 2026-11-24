'use strict';
// Talks to the Raid Random website, if one is set in config.json.
// Signing in with Twitch joins the network, and signing out leaves it. The setup window says so.
// The website chooses and approves every raid. If it cannot be reached, nobody is raided.
const TICK_MS = 2 * 60 * 1000;
const SOON_MS = 5 * 1000; // while the first check-in has not worked yet
const OFFLINE_EVERY_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 5000;
const OUTBOX = 20;
const UNREACHABLE = 'The Raid Random website cannot be reached, so nobody was raided. Your stream is still running.';

function safeUrl(url) {
  try {
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1'].includes(u.hostname);
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.origin : null;
  } catch { return null; }
}

function band(n) {
  if (n <= 0) return '0';
  if (n <= 10) return '1-10';
  if (n <= 50) return '11-50';
  if (n <= 200) return '51-200';
  return n <= 1000 ? '201-1000' : '1000+';
}

const ids = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string').slice(0, 5000) : []);

class Network {
  constructor({ url, auth, store, getStream, version = '', fetch = globalThis.fetch, now = Date.now, log = () => {} }) {
    Object.assign(this, { auth, store, getStream, version, fetch, now, log });
    this.url = safeUrl(url);
    this.joining = null;
    this.lastSent = 0;
    this.lastLive = null;
  }

  get available() { return Boolean(this.url); }

  // The key for this streamer on this PC, or null when they have not joined.
  saved() { const s = this.store.load('network'); return s && typeof s.key === 'string' ? s : null; }
  get joined() { const s = this.saved(); return Boolean(s && s.userId === this.auth.user?.id); }

  async send(method, path, { body, key } = {}) {
    const res = await this.fetch(this.url + path, {
      method,
      redirect: 'error', // never carry a sign-in somewhere else
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Website error ${res.status}`), { status: res.status });
    return data;
  }

  async key() {
    const user = this.auth.user;
    if (!this.available || !user) return null;
    const s = this.saved();
    if (s && s.userId === user.id) return s.key;
    this.joining ||= this.join(user).finally(() => { this.joining = null; });
    return this.joining;
  }

  async join(user) {
    const { key } = await this.send('POST', '/api/join', { body: { token: await this.auth.getToken() } });
    if (!/^[0-9a-f]{64}$/.test(key || '')) throw new Error('The website gave an unexpected answer');
    const s = { userId: user.id, key };
    if (this.auth.user?.id !== user.id) { // signed out while we were joining
      this.store.save('leaving', s);
      await this.finishLeaving();
      return null;
    }
    if (this.store.load('leaving')?.userId === user.id) this.store.remove('leaving'); // back again
    this.store.save('network', s);
    this.log('Joined the Raid Random network.');
    return key;
  }

  // With the key, and joins again once if the website no longer knows it.
  async asMember(method, path, body) {
    for (let again = false; ; again = true) {
      const key = await this.key();
      if (!key) return null;
      try { return await this.send(method, path, { body, key }); } catch (err) {
        if (err.status !== 401 || again) throw err;
        this.store.remove('network');
      }
    }
  }

  start() {
    if (!this.available) return;
    this.stop();
    this.running = true;
    this.tick();
  }

  stop() { this.running = false; clearTimeout(this.timer); }

  async tick() {
    clearTimeout(this.timer);
    let done = false;
    try { done = await this.update(); } catch (err) { this.log(`Website: ${err.message}`); }
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), done === 'soon' ? SOON_MS : TICK_MS);
    this.timer.unref?.();
  }

  async update() {
    await this.finishLeaving();
    if (!this.auth.user) return;
    await this.key(); // joining does not wait for anything
    await this.flush();
    const stream = this.getStream();
    if (stream === undefined) return 'soon'; // Twitch has not answered yet
    const live = Boolean(stream);
    if (!live && this.lastLive === false && this.now() - this.lastSent < OFFLINE_EVERY_MS) return;
    const sent = await this.asMember('POST', '/api/checkin', {
      live, game: stream?.game_name || '', viewers: live ? band(stream.viewer_count) : '', version: this.version,
    });
    if (sent) { this.lastSent = this.now(); this.lastLive = live; }
  }

  // Deletes what the website holds. If it cannot be reached, this is tried again later.
  async leave() {
    const s = this.saved();
    if (!s || !this.available) return;
    this.store.save('leaving', s);
    this.store.remove('network');
    this.store.remove('outbox');
    this.lastLive = null;
    try { await this.finishLeaving(); } catch (err) { this.log(`Website: ${err.message}. Leaving is tried again later.`); }
  }

  async finishLeaving() {
    const s = this.store.load('leaving');
    if (!s || !this.available) return;
    try { await this.send('POST', '/api/leave', { key: s.key, body: {} }); } catch (err) { if (err.status !== 401) throw err; }
    this.store.remove('leaving');
  }

  // Like asMember, but a raid must never go ahead without an answer.
  async must(method, path, body) {
    let answer;
    try { answer = await this.asMember(method, path, body); } catch (err) {
      this.log(`Website: ${err.message}`);
      // 4xx: the website itself says no. Anything else: we cannot know the rules.
      const clear = err.status >= 400 && err.status < 500 && err.status !== 404;
      throw Object.assign(new Error(clear ? err.message : UNREACHABLE), { userError: true });
    }
    if (!answer) throw Object.assign(new Error('Please sign in with Twitch first.'), { userError: true });
    return answer;
  }

  async plan() {
    const raw = await this.must('GET', '/api/policy');
    if (raw.mode !== 'anyone' && raw.mode !== 'network') throw Object.assign(new Error(UNREACHABLE), { userError: true });
    return { mode: raw.mode, members: ids(raw.members) };
  }

  // Which of these may be raided? The website decides, not this app.
  pick(ref, mine, streams, again) {
    return this.must('POST', '/api/pick', {
      ref, again, viewers: mine.viewer_count,
      candidates: streams.map((s) => ({ id: s.user_id, login: s.user_login, viewers: s.viewer_count, same: s.same === true })),
    });
  }

  approve(ref) { return this.must('POST', '/api/approve', { ref }); }

  // Never holds up a raid. What cannot be sent now is sent later.
  async result(ref, code) {
    const box = this.store.load('outbox') || [];
    box.push({ ref, code });
    this.store.save('outbox', box.slice(-OUTBOX));
    try { await this.flush(); } catch (err) { this.log(`Website: ${err.message}`); }
  }

  async flush() {
    for (;;) {
      const [next] = this.store.load('outbox') || [];
      if (!next || !this.available || !this.auth.user) return;
      try {
        if (!(await this.asMember('POST', '/api/result', next))) return;
      } catch (err) {
        if (![400, 404].includes(err.status)) throw err; // not wanted any more: drop it
      }
      this.store.save('outbox', (this.store.load('outbox') || []).filter((x) => x.ref !== next.ref || x.code !== next.code));
    }
  }
}

module.exports = { Network, safeUrl, band };
