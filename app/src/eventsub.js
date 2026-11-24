'use strict';
// A live line to Twitch that tells us about new subs, and about our raid going through,
// the moment they happen.
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';
const MAX_AGE_MS = 10 * 60 * 1000;
const REFUSED_RETRY_MS = 10 * 60 * 1000;
const SUBS_RETRY_MS = 30 * 1000;

class EventSub {
  constructor({ api, onEvent, createSocket = (url) => new WebSocket(url), now = Date.now, log = () => {} }) {
    Object.assign(this, { api, onEvent, createSocket, now, log });
    this.seen = new Set();
    this.userId = null;
    this.socket = null;
    this.oldSocket = null; // the previous line, during a move Twitch asked for
    this.failures = 0;
    this.state = 'off'; // off | connecting | listening | unavailable
    this.subsState = 'off'; // the same, for subs only: not every channel has subs
  }

  start(userId) {
    this.stop();
    this.userId = userId;
    this.failures = 0;
    this.open(EVENTSUB_URL);
  }

  stop() {
    this.userId = null;
    clearTimeout(this.retryTimer);
    clearTimeout(this.aliveTimer);
    this.dropSockets();
    this.state = 'off';
    this.subsState = 'off';
  }

  dropSockets() {
    clearTimeout(this.subsTimer);
    const all = [this.socket, this.oldSocket];
    this.socket = null;
    this.oldSocket = null;
    for (const s of all) s?.close();
  }

  open(url) {
    if (this.state !== 'listening') this.state = 'connecting';
    let socket;
    try { socket = this.createSocket(url); } catch { this.retry(); return; }
    this.socket = socket;
    this.watch(socket, 15000);
    socket.onmessage = (m) => this.handle(socket, m.data).catch((err) => this.log(`EventSub: ${err.message}`));
    socket.onerror = () => {};
    socket.onclose = () => { if (this.socket === socket) this.retry(); }; // an old line closing is expected
  }

  // If Twitch goes quiet for too long, assume the line is dead.
  watch(socket, ms) {
    clearTimeout(this.aliveTimer);
    this.aliveTimer = setTimeout(() => { if (this.socket === socket) this.retry(); }, ms);
    this.aliveTimer.unref?.();
  }

  retry(delay = Math.min(60000, 1000 * 2 ** this.failures++), state = 'connecting') {
    clearTimeout(this.aliveTimer);
    clearTimeout(this.retryTimer);
    this.dropSockets();
    if (!this.userId) return;
    this.state = state;
    this.retryTimer = setTimeout(() => { if (this.userId) this.open(EVENTSUB_URL); }, delay);
    this.retryTimer.unref?.();
  }

  async handle(socket, raw) {
    if (socket !== this.socket && socket !== this.oldSocket) return;
    const { metadata, payload } = JSON.parse(raw);
    const type = metadata.message_type;

    // During a move, events may still arrive on the old line. Keep counting them.
    if (type === 'notification') this.notify(metadata, payload);
    if (socket !== this.socket) return;

    if (type === 'session_welcome') {
      this.keepaliveMs = ((payload.session.keepalive_timeout_seconds || 10) + 5) * 1000;
      this.watch(socket, this.keepaliveMs);
      if (this.oldSocket) { // subscriptions moved with us
        const old = this.oldSocket;
        this.oldSocket = null;
        old.close();
        return;
      }
      await this.subscribe(socket, payload.session.id);
    } else if (type === 'session_reconnect') {
      this.oldSocket = socket;
      this.open(payload.session.reconnect_url);
    } else if (type === 'revocation') {
      if (payload.subscription?.type === 'channel.subscribe') this.subsState = 'unavailable';
      else this.retry(REFUSED_RETRY_MS, 'unavailable');
    } else if (this.keepaliveMs) {
      this.watch(socket, this.keepaliveMs);
    }
  }

  // Raids first: the raid button depends on them, and every channel can have them.
  async subscribe(socket, sessionId) {
    try {
      await this.api.subscribeEvent('channel.raid', '1', { from_broadcaster_user_id: this.userId }, sessionId);
      if (this.socket !== socket) return;
      this.state = 'listening';
      this.failures = 0;
      this.log('Connected to Twitch live events.');
    } catch (err) {
      if (this.socket !== socket) return;
      this.log(`Cannot listen for raids: ${err.message}`);
      if (err.status === 400 || err.status === 403) this.retry(REFUSED_RETRY_MS, 'unavailable');
      else this.retry();
      return;
    }
    await this.subscribeSubs(socket, sessionId);
  }

  async subscribeSubs(socket, sessionId) {
    try {
      await this.api.subscribeEvent('channel.subscribe', '1', { broadcaster_user_id: this.userId }, sessionId);
      if (this.userId) this.subsState = 'listening';
    } catch (err) {
      if (this.socket !== socket) return;
      this.log(`Cannot listen for subs: ${err.message}`);
      const refused = err.status === 400 || err.status === 403;
      this.subsState = refused ? 'unavailable' : 'connecting';
      if (refused) return;
      this.subsTimer = setTimeout(() => { if (this.socket === socket) this.subscribeSubs(socket, sessionId); }, SUBS_RETRY_MS);
      this.subsTimer.unref?.();
    }
  }

  notify(metadata, payload) {
    const id = metadata.message_id;
    if (this.seen.has(id)) return; // Twitch may send the same message twice
    if (this.now() - Date.parse(metadata.message_timestamp) > MAX_AGE_MS) return;
    this.seen.add(id);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    this.onEvent(payload.subscription.type, payload.event);
  }
}

module.exports = { EventSub };
