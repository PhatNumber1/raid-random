'use strict';
const $ = (id) => document.getElementById(id);
const key = document.querySelector('meta[name="raid-random-key"]').content;

function since(iso) {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
}

// One simple line drawing per stat.
const PERSON = 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6';
const ICONS = {
  viewers: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', // eye
  peak: 'M3 17l6-6 4 4 8-8M15 7h6v6', // line going up
  newFollowers: `${PERSON}M19 8v6M16 11h6`, // person with a plus
  subsGained: 'M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2-5.6-3.1L6.4 20l1.2-6.2L3 9.5l6.3-.8z', // star
  uptime: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2', // clock
  totalFollowers: 'M12 20.5S3 15 3 8.8A4.8 4.8 0 0 1 12 6.500a4.8 4.8 0 0 1 9 2.300C21 15 12 20.500 12 20.500z', // heart
  totalSubs: 'M3 8l4.500 4L12 5l4.500 7L21 8l-2 10H5z', // crown
};

function icon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', 'aria-hidden': 'true', class: ['subsGained', 'totalFollowers'].includes(id) ? 'icon solid' : 'icon' })) svg.setAttribute(k, v);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[id] || 'M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16z');
  svg.append(path);
  return svg;
}

// How each stat reads after its number, its name when there is no number, and both when space is tight.
const WORDS = {
  viewers: ['viewers', 'Viewers', 'viewers', 'Viewers'],
  peak: ['peak viewers today', 'Peak viewers today', 'peak today', 'Peak today'],
  newFollowers: ['new followers today', 'New followers today', 'new follows', 'New follows'],
  subsGained: ['subs gained today', 'Subs gained today', 'new subs', 'New subs'],
  uptime: ['live', 'Stream time', 'live', 'Live time'],
  totalFollowers: ['followers', 'Followers', 'followers', 'Followers'],
  totalSubs: ['subs', 'Subs', 'subs', 'Subs'],
};

function row(item) {
  const li = document.createElement('li');
  const words = WORDS[item.id] || [item.label, item.label, item.label, item.label];
  const text = document.createElement('div');
  const value = document.createElement('strong');
  const none = item.value === null || item.value === undefined;
  const one = (w) => (item.value === 1 ? w.replace(/(viewer|follower|follow|sub)s\b/, '$1') : w);
  if (none) {
    li.className = 'none';
    value.textContent = (item.hint || '–').replace('Not available for this channel', 'n/a');
  } else {
    value.textContent = item.kind === 'since' ? since(item.value) : item.value.toLocaleString() + (item.plus ? '+' : '');
  }
  const long = document.createElement('span');
  const short = document.createElement('span');
  long.className = 'long';
  short.className = 'short';
  long.textContent = one(words[none ? 1 : 0]);
  short.textContent = one(words[none ? 3 : 2]);
  text.append(value, ' ', long, short);
  li.title = `${words[1]}: ${none && item.hint ? item.hint : value.textContent}`;
  li.append(icon(item.id), text);
  return li;
}

// The biggest size at which every box fits, so the dock never needs to scroll.
const SIZES = ['', 'snug', 'tiny', 'mini'];
function fit() {
  const box = $('stats-box');
  document.body.classList.remove('raid-only');
  if (box.hidden) return;
  for (const size of SIZES) {
    document.body.classList.remove(...SIZES.filter(Boolean));
    if (size) document.body.classList.add(size);
    const high = box.scrollHeight > box.clientHeight + 1;
    const wide = [...box.querySelectorAll('li div')].some((d) => d.scrollWidth > d.clientWidth + 1);
    if (!high && !wide) return;
  }
  // Raiding in a small dock: the raid gets all the room, so its buttons are never cut off.
  if (!document.body.classList.contains('raid-idle')) document.body.classList.add('raid-only');
}
new ResizeObserver(() => fit()).observe(document.documentElement);

function show({ status, live = false, message = '', items = [] }) {
  $('status').textContent = status;
  $('status').classList.toggle('live', live);
  $('message').textContent = message || '';
  $('message').hidden = !message;
  $('stats').replaceChildren(...items.map(row));
  fit();
}

// ---------- the raid button ----------
let drawnRaid = '';
let acting = false;

function add(parent, tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  parent.append(el);
  return el;
}

function button(parent, text, path, { plain = false, body } = {}) {
  const b = add(parent, 'button', text, plain ? 'plain' : '');
  b.type = 'button';
  b.onclick = () => act(path, body);
}

function raidProblem(text) { $('raid-error').textContent = text || ''; $('raid-error').hidden = !text; }

async function act(path, body) {
  if (acting) return;
  acting = true;
  raidProblem('');
  for (const b of document.querySelectorAll('#raid button')) b.disabled = true;
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'X-Raid-Random-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 403) { location.reload(); return; }
    if (!res.ok) raidProblem((await res.json()).error);
  } catch {
    raidProblem('Raid Random is not answering.');
  } finally {
    acting = false;
    drawnRaid = '';
    refresh();
  }
}

function seconds(n) { const el = $('seconds'); if (el && n !== undefined) el.textContent = n; }

// Only redraws when something changed, so a button never disappears under your mouse.
function showRaid(raid) {
  const { secondsLeft, ...rest } = raid || {};
  const now = JSON.stringify(rest);
  if (now !== drawnRaid && !acting) {
    drawnRaid = now;
    drawRaid(raid);
    document.body.classList.toggle('raid-idle', raid?.state === 'idle');
    seconds(secondsLeft);
    fit();
  }
  seconds(secondsLeft);
}

function drawRaid(raid) {
  const box = $('raid');
  box.replaceChildren();
  if (!raid) return;
  const { state, target, message, note } = raid;
  if (note) add(box, 'p', note, 'dim');
  const name = () => add(box, 'p', target.name, 'name');
  const countdown = (before, after) => {
    const p = add(box, 'p', before);
    const s = add(p, 'span', '');
    s.id = 'seconds';
    p.append(after);
  };
  if (state === 'idle') button(box, 'End Stream / Raid Random', '/api/raid/find');
  else if (state === 'searching') {
    add(box, 'p', 'Looking for a channel...');
    button(box, 'Cancel', '/api/raid/cancel', { plain: true });
  } else if (state === 'confirm') {
    add(box, 'p', "You're about to raid");
    name();
    add(box, 'p', `${target.viewers} viewers, ${target.game}`, 'dim');
    add(box, 'p', 'Your stream ends after the raid goes through.', 'dim extra');
    button(box, 'Raid and end stream', '/api/raid/go', { body: { targetId: target.id } });
    const pair = add(box, 'div', '', 'pair');
    button(pair, 'Pick another', '/api/raid/find', { plain: true });
    button(pair, 'Cancel', '/api/raid/cancel', { plain: true });
  } else if (state === 'starting') {
    add(box, 'p', 'Starting the raid...');
    name();
  } else if (state === 'countdown') {
    add(box, 'p', 'Raiding');
    name();
    countdown('Goes through in about ', ' seconds, or when you press Raid Now on Twitch.');
    button(box, 'Cancel raid', '/api/raid/cancel', { plain: true });
  } else if (state === 'stopping') {
    add(box, 'p', 'Raid complete!');
    if (raid.secondsLeft === undefined) add(box, 'p', 'Stopping your stream...');
    else {
      countdown('Your stream ends in ', ' seconds.');
      button(box, 'Keep streaming', '/api/raid/keep', { plain: true });
    }
  } else if (state === 'stopped') {
    add(box, 'p', `You raided ${target.name}. Your stream has ended.`);
    button(box, 'OK', '/api/raid/cancel', { plain: true });
  } else if (state === 'ask') {
    add(box, 'p', message);
    button(box, 'End stream now', '/api/raid/stop');
    button(box, 'Keep streaming', '/api/raid/keep', { plain: true });
  } else if (state === 'error') {
    add(box, 'p', message);
    button(box, 'Try again', '/api/raid/find');
    button(box, 'Close', '/api/raid/cancel', { plain: true });
  }
}

// ---------- the gear ----------
let last = null; // the latest answer from the app

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'X-Raid-Random-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (res.status === 403) { location.reload(); throw new Error('Reloading...'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

function panel(open) {
  $('panel').hidden = !open;
  $('stats-box').hidden = open;
  document.body.classList.toggle('panel-open', open);
  fit();
  $('gear').setAttribute('aria-expanded', String(open));
  $('panel-note').textContent = '';
  if (!open) return;
  for (const old of $('choices').querySelectorAll('label')) old.remove();
  for (const stat of last.available) {
    const label = add($('choices'), 'label', '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = stat.id;
    box.checked = last.settings.stats.includes(stat.id);
    label.append(box, icon(stat.id), stat.label);
    if (stat.note) label.title = stat.note;
  }
}

$('gear').onclick = async () => {
  if (!last) return;
  if (!last.stats) { more(); return; } // not signed in: straight to the window
  panel($('panel').hidden);
};
$('close').onclick = () => { panel(false); $('gear').focus(); };
$('more').onclick = () => more();
async function more() {
  try { await post('/api/show-window'); } catch (err) { $('panel-note').textContent = err.message; }
}

// Every tick is saved right away, one after the other.
let saving = Promise.resolve();
$('choices').onchange = (e) => {
  const stats = [...$('choices').querySelectorAll('input:checked')].map((b) => b.value);
  if (!stats.length) { e.target.checked = true; $('panel-note').textContent = 'Keep at least one.'; return; }
  saving = saving.then(async () => {
    try { last.settings = (await post('/api/stats', { stats })).settings; $('panel-note').textContent = 'Saved'; await refresh(); } catch (err) { $('panel-note').textContent = err.message || 'Could not save.'; }
  });
};

let timer;
async function refresh() {
  clearTimeout(timer);
  await load();
  clearTimeout(timer);
  timer = setTimeout(refresh, 1000);
}

async function load() {
  try {
    const res = await fetch('/api/state', { headers: { 'X-Raid-Random-Key': key } });
    if (res.status === 403) { location.reload(); return null; } // the app was restarted
    if (!res.ok) throw new Error();
    const s = await res.json();
    last = s;
    $('demo').hidden = !s.demo;
    if (!s.stats && !$('panel').hidden) panel(false);
    showRaid(s.raid);
    if (!s.stats) {
      show({ status: 'Not signed in', message: 'Press the gear to sign in.' });
      return null;
    }
    const { live, problem, items } = s.stats;
    const status = live === null ? 'Checking' : live ? 'Live' : 'Offline';
    show({ status, live: live === true, message: problem, items });
    return s.raid?.state;
  } catch {
    show({ status: 'Not running', message: 'Start Raid Random, and this dock will catch up.' });
    showRaid(null);
    return null;
  }
}

refresh();
