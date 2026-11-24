'use strict';
// Pretend Twitch and pretend OBS, so you can look around safely. Nothing here goes online.

class DemoAuth {
  constructor() { this.clientId = 'demo'; this.user = { id: '1', login: 'demo_streamer' }; }
  on() {}
  status() { return this.user ? { state: 'signed-in', login: this.user.login } : { state: 'signed-out', error: null }; }
  async startLogin() { this.user = { id: '1', login: 'demo_streamer' }; }
  async signOut() { this.user = null; }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

class DemoApi {
  constructor() {
    this.startedAt = new Date(Date.now() - 83 * 60000).toISOString();
    this.onEvent = () => {};
  }
  async stream(id) {
    return { user_id: id, type: 'live', game_id: '9', game_name: 'Demo Game', language: 'en', viewer_count: 24 + Math.floor(Math.random() * 20), started_at: this.startedAt };
  }
  async followers() { return { total: 1287, today: 9, capped: false }; }
  async subscriberTotal() { return 46; }
  async liveStreams() {
    await pause(600);
    const names = Array.from({ length: 30 }, (_, i) => `Pretend_Streamer_${i + 1}`);
    return { data: names.map((n, i) => ({ user_id: `10${i}`, user_name: n, user_login: n.toLowerCase(), type: 'live', viewer_count: 14 + i, game_name: 'Demo Game' })), cursor: null };
  }
  async startRaid(from, to) {
    this.timer = setTimeout(() => this.onEvent('channel.raid', { from_broadcaster_user_id: from, to_broadcaster_user_id: to, to_broadcaster_user_name: 'x' }), 8000);
  }
  async cancelRaid() { clearTimeout(this.timer); }
}

class DemoObs {
  async isStreaming() { return true; }
  async stopStream() { await pause(1500); }
}

module.exports = { DemoAuth, DemoApi, DemoObs };
