'use strict';
// A small color wheel: the direction is the color, the distance from the middle is how strong.
// The middle is white. Nothing gets too dark to read on the dark boxes.
const WHEEL_BOX = '#2b2d35'; // the boxes the numbers are on
const WHEEL_CONTRAST = 3.2; // a little above the standard for large bold text

function hslHex(hue, l) {
  const a = Math.min(l, 1 - l);
  const part = (n) => {
    const k = (n + hue / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${part(0)}${part(8)}${part(4)}`;
}
function brightness(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// The strongest version of a color that is still easy to read. Red stays red; dark blue gets lighter.
const edges = new Map();
function edge(hue) {
  const h = Math.round(hue) % 360;
  if (!edges.has(h)) {
    let l = 0.5;
    while ((brightness(hslHex(h, l)) + 0.05) / (brightness(WHEEL_BOX) + 0.05) < WHEEL_CONTRAST) l += 0.01;
    edges.set(h, l);
  }
  return edges.get(h);
}
const wheelHex = (hue, strength) => hslHex(hue, 1 - (1 - edge(hue)) * strength);

// The place on the wheel closest to a color.
function wheelPlace(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hue = 0;
  if (d) hue = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue *= 60;
  return { hue, strength: Math.max(0, Math.min(1, (1 - (max + min) / 2) / (1 - edge(hue)))) };
}

// onMove while choosing, onPick when it is chosen.
function makeWheel(el, { onMove = () => {}, onPick = () => {} }) {
  const ring = Array.from({ length: 25 }, (_, i) => wheelHex(i * 15, 1)).join(', ');
  el.style.background = `radial-gradient(circle closest-side, #fff, rgba(255, 255, 255, 0) 100%), conic-gradient(${ring})`;
  const dot = document.createElement('span');
  dot.className = 'wheel-dot';
  el.append(dot);
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  let place = { hue: 0, strength: 0 };
  const color = () => wheelHex(place.hue, place.strength);
  function draw() {
    const angle = (place.hue - 90) * Math.PI / 180;
    dot.style.left = `${50 + 46 * place.strength * Math.cos(angle)}%`;
    dot.style.top = `${50 + 46 * place.strength * Math.sin(angle)}%`;
    dot.style.backgroundColor = color();
    el.setAttribute('aria-valuenow', String(Math.round(place.hue)));
    el.setAttribute('aria-valuetext', color());
  }
  function fromPointer(e) {
    const r = el.getBoundingClientRect();
    if (!r.width) return; // hidden
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    place = { hue: (Math.atan2(y, x) * 180 / Math.PI + 450) % 360, strength: Math.min(1, Math.hypot(x, y) / 0.46) };
    draw();
    onMove(color());
  }
  el.onpointerdown = (e) => { el.setPointerCapture(e.pointerId); el.focus(); fromPointer(e); e.preventDefault(); };
  el.onpointermove = (e) => { if (el.hasPointerCapture(e.pointerId)) fromPointer(e); };
  el.onpointerup = () => onPick(color());
  el.onkeydown = (e) => {
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[e.key];
    if (!step) return;
    e.preventDefault();
    place = { hue: (place.hue + step[0] + 360) % 360, strength: Math.max(0, Math.min(1, place.strength + step[1])) };
    draw();
    onMove(color());
    onPick(color());
  };
  return { set(hex) { place = wheelPlace(hex); draw(); } };
}

if (typeof module !== 'undefined') module.exports = { wheelHex, wheelPlace };
