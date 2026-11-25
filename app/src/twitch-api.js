'use strict';
// Asks Twitch questions on behalf of the signed-in streamer.
const HELIX = 'https://api.twitch.tv/helix';
const MAX_FOLLOWER_PAGES = 10; // 100 per page

class TwitchApiError extends Error {
  constructor(status, message) { super(message); this.name = 'TwitchApiError'; this.status = status; }
}

class TwitchApi {
  constructor({ auth, fetch = globalThis.fetch }) {
    this.auth = auth;
    this.fetch = fetch;
  }

  async request(method, path, { query = {}, body } = {}) {
    let token = await this.auth.getToken();
    let res = await this.send(method, path, query, body, token);
    if (res.status === 401) {
      token = await this.auth.getToken({ force: true, rejected: token });
      res = await this.send(method, path, query, body, token);
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new TwitchApiError(res.status, data.message || `Twitch error ${res.status}`);
    return data;
  }

  send(method, path, query, body, token) {
    const qs = new URLSearchParams(query).toString();
    return this.fetch(`${HELIX}/${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': this.auth.clientId,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  }

  async stream(userId) {
    const r = await this.request('GET', 'streams', { query: { user_id: userId } });
    return r.data?.[0] || null;
  }

  // Newest followers come first, so stop at the first one from before `sinceMs`.
  async followers(userId, sinceMs) {
    let after; let total = 0; let today = 0;
    for (let page = 0; page < MAX_FOLLOWER_PAGES; page++) {
      const r = await this.request('GET', 'channels/followers', {
        query: { broadcaster_id: userId, first: 100, ...(after ? { after } : {}) },
      });
      total = r.total;
      for (const f of r.data) {
        if (Date.parse(f.followed_at) < sinceMs) return { total, today, capped: false };
        today++;
      }
      after = r.pagination?.cursor;
      if (!after) return { total, today, capped: false };
    }
    return { total, today, capped: true };
  }

  async subscriberTotal(userId) {
    const r = await this.request('GET', 'subscriptions', { query: { broadcaster_id: userId, first: 1 } });
    return r.total;
  }

  // Live channels in a category, biggest first.
  async liveStreams({ gameId, language, after }) {
    const r = await this.request('GET', 'streams', {
      query: { game_id: gameId, type: 'live', first: 100, ...(language ? { language } : {}), ...(after ? { after } : {}) },
    });
    return { data: r.data || [], cursor: r.pagination?.cursor || null };
  }

  // Categories, most watched first.
  async topGames({ after }) {
    const r = await this.request('GET', 'games/top', { query: { first: 100, ...(after ? { after } : {}) } });
    return { data: r.data || [], cursor: r.pagination?.cursor || null };
  }

  // Which of these channels are live right now, with their viewers.
  async streamsOf(ids) {
    const found = [];
    for (let i = 0; i < ids.length; i += 100) {
      const query = new URLSearchParams([['first', '100'], ...ids.slice(i, i + 100).map((id) => ['user_id', id])]);
      found.push(...((await this.request('GET', 'streams', { query })).data || []));
    }
    return found;
  }

  // Only starts Twitch's countdown. The raid itself happens later.
  startRaid(from, to) {
    return this.request('POST', 'raids', { query: { from_broadcaster_id: from, to_broadcaster_id: to } });
  }

  cancelRaid(from) {
    return this.request('DELETE', 'raids', { query: { broadcaster_id: from } });
  }

  subscribeEvent(type, version, condition, sessionId) {
    return this.request('POST', 'eventsub/subscriptions', {
      body: { type, version, condition, transport: { method: 'websocket', session_id: sessionId } },
    });
  }
}

module.exports = { TwitchApi, TwitchApiError };
