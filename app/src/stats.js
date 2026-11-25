'use strict';
// Works out the numbers shown in the dock.

// Every stat the user can tick. To add one: add a line here and a value in snapshot().
const STATS = [
  { id: 'viewers', label: 'Current viewers', on: true },
  { id: 'peak', label: 'Peak viewers today', on: true, note: 'Counted while this app is running' },
  { id: 'newFollowers', label: 'New followers today', on: true },
  { id: 'subsGained', label: 'Subs gained today', on: true, note: 'New and gifted subs, counted while this app is running. Affiliates and Partners only' },
  { id: 'uptime', label: 'Stream time', on: false },
  { id: 'totalFollowers', label: 'Total followers', on: false },
  { id: 'totalSubs', label: 'Total subs', on: false, note: 'Affiliates and Partners only' },
];
const DEFAULT_STATS = STATS.filter((s) => s.on).map((s) => s.id);

// How often to ask Twitch, in seconds. Faster than 2 would get close to Twitch's limit.
const REFRESH = { min: 2, max: 3600, usual: 5 };
const isRefresh = (n) => Number.isInteger(n) && n >= REFRESH.min && n <= REFRESH.max;
const SLOW_MS = 60 * 1000; // after Twitch says "too many requests"

function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

class Stats {
  constructor({ api, auth, store, getSelected, getRefresh = () => REFRESH.usual, now = Date.now, log = () => {} }) {
    Object.assign(this, { api, auth, store, getSelected, getRefresh, now, log });
    this.running = false;
    this.run = 0;
    this.reset();
  }

  reset() {
    this.stream = undefined; // undefined = not checked yet, null = offline
    this.followers = null;
    this.subsTotal = null;
    this.errors = {};
    this.updatedAt = null;
    this.nextAt = null;
  }

  start() {
    this.stop();
    this.running = true;
    this.reset();
    this.loop(++this.run);
  }

  stop() {
    this.running = false;
    this.run++;
    clearTimeout(this.timer);
  }

  async loop(run) {
    const began = this.now();
    this.nextAt = null; // asking right now
    await this.poll();
    if (!this.running || run !== this.run) return;
    const wait = this.pause(this.now() - began);
    this.nextAt = this.now() + wait;
    this.timer = setTimeout(() => this.loop(run), wait);
    this.timer.unref?.();
  }

  // The chosen time from start to start, however long Twitch took to answer.
  pause(took) {
    if (Object.values(this.errors).some((err) => err.status === 429)) return Math.max(SLOW_MS, this.getRefresh() * 1000);
    return Math.max(1000, this.getRefresh() * 1000 - took);
  }

  // Today's running totals, which start over at midnight or for a different account.
  today() {
    const userId = this.auth.user?.id;
    const day = startOfDay(this.now());
    if (!this.daily || this.daily.userId !== userId || this.daily.day !== day) {
      const saved = this.store.load('today');
      const fits = saved && saved.userId === userId && saved.day === day;
      if (this.daily && !fits) this.followers = null;
      this.daily = fits ? saved : { userId, day, peak: null, subsGained: 0 };
    }
    return this.daily;
  }

  saveToday() { this.store.save('today', this.daily); }

  async part(name, work) {
    const run = this.run;
    try {
      const value = await work();
      if (run !== this.run) return; // signed out or switched account meanwhile
      delete this.errors[name];
      this[name] = value;
    } catch (err) {
      if (run !== this.run) return;
      this.errors[name] = err;
      this.log(`${name}: ${err.message}`);
    }
  }

  async poll() {
    const user = this.auth.user;
    if (!user) return;
    this.today();
    const now = this.now();
    const run = this.run;
    const wants = new Set(this.getSelected());
    const jobs = [this.part('stream', () => this.api.stream(user.id))];
    if (wants.has('newFollowers') || wants.has('totalFollowers')) {
      const midnight = startOfDay(now);
      jobs.push(this.part('followers', async () => ({ ...(await this.api.followers(user.id, midnight)), day: midnight })));
    }
    if (wants.has('totalSubs')) jobs.push(this.part('subsTotal', () => this.api.subscriberTotal(user.id)));
    await Promise.all(jobs);
    if (run !== this.run) return;
    const daily = this.today();
    if (this.stream && !this.errors.stream) {
      const peak = Math.max(daily.peak ?? 0, this.stream.viewer_count);
      if (peak !== daily.peak) { daily.peak = peak; this.saveToday(); }
    }
    if (!this.errors.stream) this.updatedAt = this.now();
  }

  // Called after the user saves new choices, so new stats fill in at once.
  refreshNow() {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.loop(++this.run);
  }

  onEvent(type) {
    if (type !== 'channel.subscribe' || !this.auth.user) return;
    this.today().subsGained++;
    this.saveToday();
  }

  snapshot(subsState) {
    const daily = this.today();
    const live = this.stream;
    const sameDay = this.followers && this.followers.day === daily.day;
    const subsProblem = subsState === 'unavailable' ? 'Not available for this channel' : null;
    const all = {
      viewers: { value: live ? live.viewer_count : null, hint: live === null ? 'Offline' : null },
      peak: { value: daily.peak },
      newFollowers: { value: sameDay ? this.followers.today : null, plus: Boolean(sameDay && this.followers.capped) },
      subsGained: { value: subsProblem ? null : daily.subsGained, hint: subsProblem },
      uptime: { value: live ? live.started_at : null, kind: 'since', hint: live === null ? 'Offline' : null },
      totalFollowers: { value: this.followers ? this.followers.total : null },
      totalSubs: {
        value: this.errors.subsTotal ? null : this.subsTotal,
        hint: [400, 401, 403].includes(this.errors.subsTotal?.status) ? 'Not available for this channel' : null,
      },
    };
    return {
      live: live === undefined ? null : Boolean(live),
      updatedAt: this.updatedAt,
      nextIn: this.nextAt === null ? null : Math.max(0, Math.ceil((this.nextAt - this.now()) / 1000)),
      problem: this.errors.stream ? 'Cannot reach Twitch. Trying again...' : null,
      items: STATS.filter((s) => this.getSelected().includes(s.id)).map((s) => ({ id: s.id, label: s.label, ...all[s.id] })),
    };
  }
}

module.exports = { Stats, STATS, DEFAULT_STATS, REFRESH, isRefresh };
