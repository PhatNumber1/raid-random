'use strict';
// The raid button, as a list of states the dock shows:
//   idle -> searching -> confirm -> starting -> countdown -> stopping -> stopped
//   ask   = we are not sure, so the stream keeps running and you decide
//   nobody = no one to raid: you decide whether the stream ends anyway
//   error = something went wrong before any raid began
// The stream is stopped in exactly two cases: Twitch confirmed THIS raid, or you pressed the button.
const crypto = require('node:crypto');
const { findCandidates, findElsewhere, findNetworkCandidates, forStage, choose, range, TIERS } = require('./picker');

const CANDIDATES_FRESH_MS = 2 * 60 * 1000;
const REMEMBER = 50;

class UserError extends Error { constructor(m) { super(m); this.userError = true; } }

class Raid {
  constructor({
    api, auth, obs, lineReady, store, network = null, now = Date.now, rng = Math.random, log = () => {},
    countdownMs = 90000, giveUpMs = 180000, graceMs = 5000, searchPauseMs = 3000,
  }) {
    Object.assign(this, { api, auth, obs, lineReady, store, network, now, rng, log, countdownMs, giveUpMs, graceMs, searchPauseMs });
    this.step = 0;
    this.set('idle');
    this.skipped = new Set();
    this.candidates = null;
  }

  set(state, extra = {}) {
    this.state = state;
    this.info = extra;
    this.step++;
    return this.step;
  }

  // True while quitting or signing out could leave a raid half done.
  get busy() { return ['starting', 'countdown', 'stopping'].includes(this.state); }

  view() {
    const { target, message, note, endsAt, part, parts } = this.info;
    return {
      state: this.state, message, note, part, parts,
      target: target && { id: target.user_id, name: target.user_name, login: target.user_login, viewers: target.viewer_count, game: target.game_name },
      secondsLeft: endsAt ? Math.max(0, Math.ceil((endsAt - this.now()) / 1000)) : undefined,
    };
  }

  need(...states) { if (!states.includes(this.state)) throw new UserError('That is not possible right now.'); }

  // Everything that must be true before a raid may begin. Returns your live stream.
  async ready() {
    const user = this.auth.user;
    if (!user) throw new UserError('Please sign in with Twitch first.');
    if (!this.lineReady()) throw new UserError('Still connecting to Twitch. Try again in a moment.');
    const mine = await this.api.stream(user.id);
    if (!mine) throw new UserError('You are not live on Twitch.');
    if (!mine.game_id) throw new UserError('Set a category on Twitch first, so we can find similar channels.');
    if (!(await this.obs.isStreaming())) throw new UserError('OBS is not streaming, so there is nothing to end.');
    return mine;
  }

  history() { const h = this.store.load('raids'); return Array.isArray(h) ? h : []; }

  remember(target, result) {
    const h = this.history().filter((r) => !(r.id === target.user_id && r.result === 'started'));
    h.push({ id: target.user_id, login: target.user_login, at: this.now(), result });
    this.store.save('raids', h.slice(-REMEMBER));
  }

  // Find someone (the main button), or someone else ("Pick another").
  async find(note) {
    this.need('idle', 'confirm', 'nobody', 'error', 'stopped');
    if (this.state === 'confirm') this.skipped.add(this.info.target.user_id);
    else { this.skipped.clear(); this.candidates = null; }
    const step = this.set('searching');
    let passed = false;
    try {
      const mine = await this.ready();
      passed = true;
      if (step !== this.step) return;
      const website = this.network?.available ? this.network : null;
      const plan = website ? await website.plan() : { mode: 'anyone', members: [] };
      if (step !== this.step) return;
      const me = this.auth.user.id;
      const again = this.skipped.size > 0;
      const steps = this.searchSteps(plan.mode, mine);
      let reason = null;
      for (const [i, s] of steps.entries()) {
        // What the dock shows while this step runs.
        this.info = { message: s.text, part: i + 1, parts: steps.length };
        const list = await this.streamsFor(s.stage, mine, plan, me);
        if (step !== this.step) return;
        const open = list.filter((x) => !this.skipped.has(x.user_id));
        const last = i === steps.length - 1;
        let target; let ref = null;
        if (website && (open.length || last)) {
          ref = crypto.randomUUID();
          const answer = await website.pick(ref, mine, open, { again, stage: s.stage, tiers: s.tiers, last });
          if (step !== this.step) return;
          target = open.find((x) => x.user_id === answer.target);
          reason = answer.reason;
        } else if (!website) {
          const before = this.history().filter((h) => ['started', 'confirmed'].includes(h.result)).pop()?.id;
          target = choose(open.filter((x) => x.user_id !== before), mine.viewer_count, this.rng, s.stage, s.tiers);
        }
        if (target) {
          this.ref = ref;
          this.set('confirm', { target, note: [note, s.wider].filter(Boolean).join(' ') || undefined });
          return;
        }
        if (last) break;
        // A moment to read it, and to press Cancel.
        this.info = { message: s.none, note: steps[i + 1].next, part: i + 1, parts: steps.length, endsAt: this.now() + this.searchPauseMs };
        await new Promise((done) => setTimeout(done, this.searchPauseMs));
        if (step !== this.step) return;
      }
      throw new UserError(again ? 'Nobody else fits right now.' : `${reason || 'No live channel was found'}. Nobody was raided.`);
    } catch (err) {
      if (step !== this.step) return;
      if (passed) this.nobody(err);
      else this.trouble(err);
    }
  }

  // From "just like you" to "anyone at all". Network only never leaves the network.
  searchSteps(mode, mine) {
    if (mode === 'network') return [{ stage: 1, tiers: 3, text: 'Searching the Raid Random network...' }];
    const game = mine.game_name || 'your category';
    const similar = TIERS.map((t, i) => {
      const [low, high] = range(mine.viewer_count, t);
      return {
        stage: 1, tiers: i + 1, text: `Searching ${game} for ${low} to ${high} viewers...`, none: `Nobody with ${low} to ${high} viewers in ${game}.`,
        next: `Widening the range to ${low} to ${high} viewers`,
      };
    });
    return [
      ...similar,
      { stage: 2, text: `Searching ${game}, any size...`, none: `Nobody to raid in ${game}.`, next: 'Widening to any size', wider: 'Nobody your size in your category. This is one of the closest.' },
      { stage: 3, text: 'Searching other categories...', next: 'Widening to other categories', wider: 'Nobody found in your category. This is a different one.' },
    ];
  }

  // The channels for one step of the search. What was found is kept for "Pick another".
  async streamsFor(stage, mine, plan, me) {
    const old = this.candidates;
    const fresh = old && old.mode === plan.mode && old.game === mine.game_id && this.now() - old.at < CANDIDATES_FRESH_MS;
    if (!fresh) this.candidates = { mode: plan.mode, game: mine.game_id, at: this.now(), near: null, far: null };
    const c = this.candidates;
    if (plan.mode === 'network') {
      c.near ||= await findNetworkCandidates(this.api, mine, plan.members, new Set([me]));
      return c.near;
    }
    if (stage === 3) {
      c.far ||= await findElsewhere(this.api, mine, new Set([me]), this.rng);
      return forStage(c.far, mine.viewer_count, 3);
    }
    c.near ||= await findCandidates(this.api, mine, new Set([me]));
    return forStage(c.near, mine.viewer_count, stage);
  }

  // Nobody to raid, or no way to find out. The stream keeps running until you decide.
  nobody(err) {
    if (!err.userError) this.log(`Raid: ${err.message}`);
    this.set('nobody', { message: err.userError ? err.message : `Twitch could not be searched: ${err.message}. Nobody was raided.` });
  }

  // You chose to end without a raid.
  async endAnyway() { this.need('nobody'); await this.stop(null); }

  trouble(err) {
    if (!err.userError) this.log(`Raid: ${err.message}`);
    this.set('error', { message: err.message });
  }

  // You pressed Raid. `targetId` must be the channel you were actually shown.
  async go(targetId) {
    this.need('confirm');
    const { target } = this.info;
    if (target.user_id !== targetId) throw new UserError('The suggestion changed. Please check the name again.');
    const step = this.set('starting', { target });
    this.cancelling = false;
    const me = this.auth.user?.id;
    let sent = false;
    const ref = this.ref;
    this.tell = (code) => { if (ref) this.network.result(ref, code); };
    try {
      await this.ready();
      if (!(await this.api.stream(target.user_id))) return await this.another(step, target, `${target.user_name} just went offline.`);
      if (step !== this.step) return;
      if (!this.lineReady()) throw new UserError('The connection to Twitch dropped. Please try again.');
      if (ref) {
        // The website has the last word, with the rules as they are this second.
        const answer = await this.network.approve(ref);
        if (step !== this.step) return;
        if (answer.ok !== true) throw new UserError(`${answer.reason || 'The website did not approve this raid'}. Nobody was raided.`);
      }
      sent = true;
      this.watchFrom = this.now();
      await this.api.startRaid(me, target.user_id);
    } catch (err) {
      if (step !== this.step) return;
      if (sent && err.status === 400) { this.tell('refused'); return await this.another(step, target, `${target.user_name} is not accepting this raid.`); }
      if (sent && err.status === 409) { this.tell('busy'); return this.trouble(new UserError('A raid is already running on Twitch. Finish or cancel it there first.')); }
      if (sent && err.status === 429) { this.tell('too_many'); return this.trouble(new UserError('Twitch allows 10 raid tries per 10 minutes. Please wait a little.')); }
      if (sent && err.name !== 'SignedOutError' && (!err.status || err.status >= 500)) return this.unsure(err);
      if (sent) this.tell('twitch');
      return sent ? this.trouble(err) : this.nobody(err);
    }
    this.remember(target, 'started');
    if (step !== this.step) return; // the confirmation was faster than the reply
    this.startCountdown(target);
  }

  startCountdown(target) {
    const step = this.set('countdown', { target, endsAt: this.watchFrom + this.countdownMs });
    this.later(this.watchFrom + this.giveUpMs - this.now(), step, () => {
      this.tell('not_confirmed');
      this.set('ask', { target, message: 'Twitch has not confirmed the raid, so your stream is still running. Check Twitch, then choose.' });
    });
  }

  later(ms, step, work) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (step === this.step) work(); }, Math.max(0, ms));
    this.timer.unref?.();
  }

  async another(step, target, note) {
    if (step !== this.step) return;
    this.set('confirm', { target });
    await this.find(note); // never raids by itself: you confirm the new name
  }

  // No answer from Twitch: the raid may or may not have begun. Keep watching, as if it had.
  unsure(err) {
    this.log(`Raid: no clear answer (${err.message})`);
    const { target } = this.info;
    this.remember(target, 'started');
    this.startCountdown(target);
    this.info.note = 'Twitch did not answer clearly. Check Twitch to see if the raid is running.';
  }

  // Signed out: forget a suggestion, but never a raid that may be running.
  signedOut() { if (!this.busy && this.state !== 'ask') this.set('idle'); }

  async cancel() {
    this.need('searching', 'confirm', 'nobody', 'error', 'stopped', 'countdown');
    if (this.state !== 'countdown') { this.set('idle'); return; }
    const step = this.step;
    const { target } = this.info;
    this.cancelling = true;
    try {
      await this.api.cancelRaid(this.auth.user.id);
      if (step === this.step) { clearTimeout(this.timer); this.remember(target, 'cancelled'); this.tell('cancelled'); this.set('idle'); }
    } catch (err) {
      if (step !== this.step) return;
      clearTimeout(this.timer);
      this.tell('unclear');
      this.set('ask', {
        target,
        message: err.status === 404
          ? 'Twitch says no raid is waiting. It may have gone through already. Your stream is still running.'
          : 'Could not cancel the raid. Cancel it on Twitch. Your stream will not be stopped.',
      });
    }
  }

  // You decide, after we were not sure.
  async stopNow() { this.need('ask'); await this.stop(this.info.target); }

  keepStreaming() {
    this.need('ask', 'stopping');
    if (this.info.sent) throw new UserError('OBS is already stopping.');
    clearTimeout(this.timer);
    this.set('idle');
  }

  onEvent(type, event) {
    if (type !== 'channel.raid' || !['starting', 'countdown'].includes(this.state)) return;
    if (event.from_broadcaster_user_id !== this.auth.user?.id) return;
    const { target } = this.info;
    clearTimeout(this.timer);
    if (event.to_broadcaster_user_id !== target.user_id) {
      this.tell('other_channel');
      this.set('ask', { target, message: `You raided ${event.to_broadcaster_user_name} instead. Your stream is still running.` });
      return;
    }
    this.remember(target, 'confirmed');
    this.tell('confirmed');
    this.log('Raid confirmed by Twitch.');
    if (this.cancelling) {
      this.set('ask', { target, message: 'The raid went through before it could be cancelled. Your stream is still running.' });
      return;
    }
    // A few seconds to change your mind.
    const step = this.set('stopping', { target, endsAt: this.now() + this.graceMs });
    this.later(this.graceMs, step, () => this.stop(target));
  }

  async stop(target) {
    const step = this.set('stopping', { target, sent: true });
    try {
      await this.obs.stopStream();
      if (step !== this.step) return;
      this.log('Stream stopped.');
      this.set('stopped', { target });
    } catch (err) {
      if (step !== this.step) return;
      this.log(`Raid: ${err.message}`);
      this.set('ask', { target, message: `OBS did not stop: ${err.message} Please stop the stream in OBS, or try again.` });
    }
  }
}

module.exports = { Raid, UserError };
