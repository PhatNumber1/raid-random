'use strict';
const $ = (id) => document.getElementById(id);
const key = document.querySelector('meta[name="raid-random-key"]').content;
const STEPS = ['welcome', 'signin', 'stats', 'install', 'done'];
const sections = [...document.querySelectorAll('[data-step]')];

let state = null; // the latest answer from the app
let wizard = null; // true on the first run, false once it is set up
let step = 0;
let offline = false;
let busy = false;

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Raid-Random-Key': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) { location.reload(); throw new Error('Reloading...'); } // the app was restarted
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function problem(text) { $('problem').textContent = text || ''; $('problem').hidden = !text; }
const chosen = () => [...document.querySelectorAll('input[name="stat"]:checked')].map((b) => b.value);

function showAuth(auth) {
  for (const s of ['not-configured', 'signed-out', 'pending', 'signed-in']) $(s).hidden = s !== auth.state;
  if (auth.state === 'pending') $('code').textContent = auth.code;
  if (auth.state === 'signed-in') $('who').textContent = auth.login;
  $('login-error').textContent = auth.error || '';
  $('login-error').hidden = !auth.error;
}

// What happened with OBS, and whether that is the end of it.
function obsResult({ obs, settings, demo }) {
  const again = wizard ? 'go back and press Install again' : 'press Save again';
  if (demo) return { title: 'Raid Random is ready', text: 'Demo mode does not change OBS.' };
  if (obs.error) return { title: 'Something needs your attention', text: obs.error, bad: true };
  if (obs.waiting) return { title: 'Please close OBS', text: 'Raid Random is waiting for OBS to close. It finishes by itself after that.' };
  if (!settings.dock) return { title: 'Raid Random is ready', text: 'The dock was not added to OBS, because you left that unticked.' };
  if (obs.dock === 'added') return { title: 'Raid Random is ready', text: 'The dock is in OBS. Open OBS to see it. If it is hidden, choose Docks, then Raid Random.' };
  if (obs.dock === 'no-obs') return { title: 'OBS was not found', text: `Install OBS and open it once. Then ${again}.`, bad: true };
  return { title: 'The dock is not in OBS', text: `Close OBS. Then ${again}.`, bad: true };
}

function drawChoices(available, ticked) {
  for (const stat of available) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'stat';
    box.value = stat.id;
    box.checked = ticked.includes(stat.id);
    const text = document.createElement('span');
    text.textContent = stat.label;
    if (stat.note) {
      const note = document.createElement('small');
      note.textContent = stat.note;
      text.append(note);
    }
    label.append(box, text);
    $('choices').append(label);
  }
}

function draw() {
  const now = STEPS[step];
  const signedIn = state.auth.state === 'signed-in';
  document.body.classList.toggle('wizard', wizard);
  for (const s of sections) s.hidden = wizard ? s.dataset.step !== now : s.dataset.step === 'welcome';
  showAuth(state.auth);
  $('network').hidden = !state.network.available;
  const result = obsResult(state);
  if ($('obs-text').textContent !== result.text) $('obs-text').textContent = result.text;
  $('obs-text').classList.toggle('bad', Boolean(result.bad));
  $('quit-box').hidden = wizard;

  const title = !wizard ? 'Raid Random' : now === 'done' ? result.title : sections[step].dataset.title;
  if ($('title').textContent !== title) $('title').textContent = title;
  $('progress').textContent = wizard && now !== 'done' ? `Step ${step + 1} of ${STEPS.length - 1}` : '';
  $('back').hidden = !wizard || step === 0 || (now === 'done' && !result.bad);
  $('next').textContent = !wizard ? 'Save' : now === 'install' ? 'Install' : now === 'done' ? 'Finish' : 'Next';
  const needsSignIn = !wizard || now === 'signin' || now === 'install';
  const needsStats = !wizard || now === 'stats' || now === 'install';
  $('next').disabled = busy || (needsSignIn && !signedIn) || (needsStats && (!chosen().length || !$('refresh').checkValidity()));
  $('back').disabled = busy;
}

function go(n) {
  step = n;
  problem('');
  draw();
  document.querySelector('main').scrollTop = 0;
  $('title').focus();
}

async function refresh() {
  try {
    state = await call('GET', '/api/state');
    if (offline) { offline = false; problem(''); }
    $('demo').hidden = !state.demo;
    if (wizard === null) {
      wizard = !state.settings.saved;
      drawChoices(state.available, state.settings.stats);
      Object.assign($('refresh'), { min: state.refreshLimits.min, max: state.refreshLimits.max, value: state.settings.refresh });
      $('refresh-note').textContent = `From ${state.refreshLimits.min} to ${state.refreshLimits.max} seconds. New subs always show right away.`;
      $('dock').checked = state.settings.dock;
      $('autostart').checked = state.settings.autostart;
    }
    draw();
  } catch {
    offline = true;
    problem('Raid Random is not running. Start it again, and this window will catch up.');
    $('next').disabled = true;
  }
}

async function act(button, work) {
  busy = true;
  button.disabled = true;
  problem('');
  let failed = null;
  try { await work(); } catch (err) { failed = err; }
  busy = false;
  button.disabled = false;
  await refresh();
  if (failed) problem(failed.message);
}

const save = () => call('POST', '/api/settings', { stats: chosen(), refresh: $('refresh').valueAsNumber, dock: $('dock').checked, autostart: $('autostart').checked });

$('next').onclick = () => {
  if (!wizard) { act($('next'), async () => { await save(); $('saved').textContent = 'Saved'; }); return; }
  if (STEPS[step] === 'done') { call('POST', '/api/finish', {}).catch(() => {}).then(() => window.close()); return; }
  if (STEPS[step] === 'install') { act($('next'), async () => { await save(); step = STEPS.indexOf('done'); }); return; }
  go(step + 1);
};
$('back').onclick = () => go(step - 1);
$('again').onclick = () => { wizard = true; go(0); };
$('login').onclick = () => act($('login'), () => call('POST', '/api/login'));
$('activate').onclick = () => act($('activate'), () => call('POST', '/api/open-twitch', {}));
$('cancel').onclick = () => act($('cancel'), () => call('POST', '/api/logout'));
$('logout').onclick = () => act($('logout'), () => call('POST', '/api/logout'));
$('quit').onclick = () => act($('quit'), () => call('POST', '/api/quit', { by: 'page' }).then(() => window.close()));
document.querySelector('main').oninput = () => { if (state) draw(); };
document.querySelector('main').onchange = () => { $('saved').textContent = ''; if (state) draw(); };

refresh();
setInterval(() => { if (!busy) refresh(); }, 2000);
