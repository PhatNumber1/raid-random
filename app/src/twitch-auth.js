'use strict';
// Signing in with Twitch using the "device code" login:
//   1. we ask Twitch for a short code
//   2. the user opens twitch.tv and approves that code
//   3. we keep asking Twitch "approved yet?" until it hands us a token
// No password or client secret ever passes through this app.
const { EventEmitter } = require('node:events');

const ID_URL = 'https://id.twitch.tv/oauth2';
const SCOPES = ['channel:manage:raids', 'moderator:read:followers', 'channel:read:subscriptions'];
const REFRESH_EARLY_MS = 5 * 60 * 1000;
const VALIDATE_EVERY_MS = 60 * 60 * 1000; // Twitch asks apps to check tokens hourly

class SignedOutError extends Error {
  constructor(message = 'Please sign in with Twitch.') { super(message); this.name = 'SignedOutError'; }
}

// Only ever send people to the real Twitch site.
function safeVerificationUrl(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:' && (u.hostname === 'www.twitch.tv' || u.hostname === 'twitch.tv')) return u.href;
  } catch { /* fall through */ }
  return 'https://www.twitch.tv/activate';
}

class TwitchAuth extends EventEmitter {
  constructor({ clientId, store, fetch = globalThis.fetch, now = Date.now }) {
    super();
    this.clientId = clientId;
    this.store = store;
    this.fetch = fetch;
    this.now = now;
    this.pending = null;
    this.error = null;
    this.refreshing = null;
    this.attempt = 0;
    this.saved = store.load('auth');
    if (this.saved && this.saved.clientId !== clientId) this.saved = null;
  }

  get user() { return this.saved ? { id: this.saved.userId, login: this.saved.login } : null; }

  status() {
    if (!this.clientId) return { state: 'not-configured' };
    if (this.pending) return { state: 'pending', code: this.pending.userCode, url: this.pending.url };
    if (this.saved) return { state: 'signed-in', login: this.saved.login };
    return { state: 'signed-out', error: this.error };
  }

  async post(path, params) {
    const res = await this.fetch(`${ID_URL}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  async startLogin() {
    if (!this.clientId) throw new Error('No Twitch Client ID yet. See docs/SETUP.md.');
    const attempt = ++this.attempt; // a newer login replaces an older one
    clearTimeout(this.pollTimer);
    this.pending = null;
    this.error = null;
    const { ok, body } = await this.post('device', { client_id: this.clientId, scopes: SCOPES.join(' ') });
    if (attempt !== this.attempt) return;
    if (!ok) throw new Error(`Twitch refused the sign-in: ${body.message || 'unknown reason'}`);
    this.pending = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      url: safeVerificationUrl(body.verification_uri),
      expiresAt: this.now() + body.expires_in * 1000,
      intervalMs: Math.max(1, body.interval || 5) * 1000,
    };
    this.schedulePoll(attempt);
  }

  schedulePoll(attempt) {
    this.pollTimer = setTimeout(() => this.pollOnce(attempt).catch(() => {}), this.pending.intervalMs);
    this.pollTimer.unref?.();
  }

  async pollOnce(attempt = this.attempt) {
    const pending = this.pending;
    if (!pending || attempt !== this.attempt) return;
    if (this.now() >= pending.expiresAt) { this.failLogin('That code ran out. Please try again.'); return; }
    let result;
    try {
      result = await this.post('token', {
        client_id: this.clientId,
        scopes: SCOPES.join(' '),
        device_code: pending.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    } catch {
      if (attempt === this.attempt) this.schedulePoll(attempt); // internet hiccup: keep trying
      return;
    }
    if (attempt !== this.attempt) return;
    if (!result.ok) {
      const waiting = result.body.message === 'authorization_pending' || result.status >= 500;
      if (waiting) this.schedulePoll(attempt);
      else this.failLogin('Twitch did not approve the sign-in. Please try again.');
      return;
    }
    try {
      const info = await this.validate(result.body.access_token);
      if (attempt !== this.attempt) return;
      const missing = SCOPES.filter((s) => !info.scopes.includes(s));
      if (missing.length) { this.failLogin('Some permissions were not granted. Please try again.'); return; }
      this.pending = null;
      this.error = null;
      this.keep(result.body, info);
      this.emit('change');
    } catch {
      if (attempt === this.attempt) this.failLogin('Could not finish signing in. Please try again.');
    }
  }

  failLogin(message) {
    this.pending = null;
    this.error = message;
  }

  keep(token, info = {}) {
    this.saved = {
      clientId: this.clientId,
      userId: info.user_id || this.saved.userId,
      login: info.login || this.saved.login,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: this.now() + token.expires_in * 1000,
      validatedAt: this.now(),
    };
    this.store.save('auth', this.saved);
  }

  async validate(accessToken) {
    const res = await this.fetch(`${ID_URL}/validate`, {
      headers: { Authorization: `OAuth ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw Object.assign(new Error('Token check failed'), { status: res.status });
    return res.json();
  }

  // Returns a token that works right now, renewing it when needed.
  async getToken({ force = false, rejected = null } = {}) {
    if (!this.saved) throw new SignedOutError();
    if (this.refreshing) return this.refreshing;
    // Someone else already renewed the token Twitch rejected.
    if (rejected && rejected !== this.saved.accessToken) return this.saved.accessToken;
    if (force || this.now() > this.saved.expiresAt - REFRESH_EARLY_MS) return this.refresh();
    if (this.now() - this.saved.validatedAt > VALIDATE_EVERY_MS) {
      try {
        await this.validate(this.saved.accessToken);
        if (this.saved) this.saved.validatedAt = this.now();
      } catch (err) {
        if (err.status === 401) return this.saved ? this.refresh() : Promise.reject(new SignedOutError());
      }
    }
    if (!this.saved) throw new SignedOutError();
    return this.saved.accessToken;
  }

  // Refresh tokens work once, so two refreshes must never run side by side.
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async doRefresh() {
    const before = this.saved;
    const { ok, status, body } = await this.post('token', {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: before.refreshToken,
    });
    if (this.saved !== before) throw new SignedOutError(); // signed out while waiting
    if (ok) { this.keep(body); return this.saved.accessToken; }
    if (status === 400 || status === 401) {
      this.forget();
      this.error = 'Your Twitch sign-in ran out. Please sign in again.';
      throw new SignedOutError(this.error);
    }
    throw new Error('Twitch is not answering right now.'); // temporary: stay signed in
  }

  forget() {
    this.saved = null;
    this.store.remove('auth');
    this.emit('change');
  }

  async signOut() {
    this.attempt++;
    clearTimeout(this.pollTimer);
    this.pending = null;
    this.error = null;
    const old = this.saved;
    if (!old) return;
    this.forget();
    try { await this.post('revoke', { client_id: this.clientId, token: old.accessToken }); } catch { /* best effort */ }
  }
}

module.exports = { TwitchAuth, SignedOutError, SCOPES, safeVerificationUrl };
