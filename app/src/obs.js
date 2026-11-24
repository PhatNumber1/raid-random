'use strict';
// Talks to OBS on this PC through its built-in WebSocket server.
// The password is read from OBS's own settings each time and never stored or shown.
const fs = require('node:fs');
const crypto = require('node:crypto');

const sha = (text) => crypto.createHash('sha256').update(text).digest('base64');
const answer = (password, { salt, challenge }) => sha(sha(password + salt) + challenge);

const NOT_REACHABLE = 'Cannot reach OBS. Is it open? If so, open Tools, then WebSocket Server Settings, and tick Enable WebSocket server.';

class Obs {
  constructor({ configFile, createSocket = (url) => new WebSocket(url), timeoutMs = 5000, pollMs = 500, stopWaitMs = 20000 }) {
    Object.assign(this, { configFile, createSocket, timeoutMs, pollMs, stopWaitMs });
  }

  config() {
    try {
      const c = JSON.parse(fs.readFileSync(this.configFile(), 'utf8').replace(/^﻿/, ''));
      if (c.server_enabled) return c;
    } catch { /* same message below */ }
    throw new Error(NOT_REACHABLE);
  }

  // Opens a line, signs in, runs `work(ask)`, and always closes the line.
  async session(work) {
    const cfg = this.config();
    const waiting = new Map();
    let socket; let fail; let identified; let next = 0;
    const broken = new Promise((_, reject) => { fail = reject; });
    broken.catch(() => {});
    const ready = new Promise((resolve) => { identified = resolve; });
    const within = (promise, text) => {
      let timer;
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(text)), this.timeoutMs); });
      return Promise.race([promise, broken, late]).finally(() => clearTimeout(timer));
    };
    try {
      try { socket = this.createSocket(`ws://127.0.0.1:${cfg.server_port || 4455}`); } catch { throw new Error(NOT_REACHABLE); }
      socket.onerror = () => fail(new Error(NOT_REACHABLE));
      socket.onclose = (e) => fail(new Error(e?.code === 4009 ? 'OBS did not accept its own password. Restart OBS and try again.' : NOT_REACHABLE));
      socket.onmessage = (m) => {
        let msg;
        try { msg = JSON.parse(m.data); } catch { return; }
        const { op, d } = msg;
        if (op === 0) {
          const login = { rpcVersion: 1, eventSubscriptions: 0 };
          if (d.authentication) login.authentication = answer(cfg.server_password || '', d.authentication);
          socket.send(JSON.stringify({ op: 1, d: login }));
        } else if (op === 2) identified();
        else if (op === 7) { waiting.get(d.requestId)?.(d); waiting.delete(d.requestId); }
      };
      await within(ready, NOT_REACHABLE);
      const ask = async (requestType) => {
        const requestId = String(++next);
        const reply = new Promise((resolve) => waiting.set(requestId, resolve));
        socket.send(JSON.stringify({ op: 6, d: { requestType, requestId } }));
        const d = await within(reply, 'OBS did not answer.');
        if (!d.requestStatus.result) throw new Error(`OBS refused: ${d.requestStatus.comment || d.requestStatus.code}`);
        return d.responseData || {};
      };
      return await work(ask);
    } finally {
      if (socket) { socket.onclose = null; socket.onerror = null; socket.close(); }
    }
  }

  async isStreaming() {
    return this.session(async (ask) => (await ask('GetStreamStatus')).outputActive === true);
  }

  // Resolves only once OBS says the stream is really off.
  async stopStream() {
    return this.session(async (ask) => {
      const active = async () => (await ask('GetStreamStatus')).outputActive;
      if (!(await active())) return;
      await ask('StopStream');
      const until = Date.now() + this.stopWaitMs;
      while (await active()) {
        if (Date.now() > until) throw new Error('OBS has not finished stopping.');
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    });
  }
}

module.exports = { Obs, answer };
