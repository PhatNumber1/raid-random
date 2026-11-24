'use strict';
// Reads and changes the list of custom browser docks inside OBS's settings text.
// Only the one ExtraBrowserDocks line is ever touched. Everything else stays as it was.
const crypto = require('node:crypto');

const SECTION = 'BasicWindow';
const KEY = 'ExtraBrowserDocks';

// OBS stores backslashes and line breaks in an escaped form.
const unescape = (s) => s.replace(/\\(\\|n|r)/g, (_, c) => ({ '\\': '\\', n: '\n', r: '\r' }[c]));
const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n');

// Finds where the section and the line are.
function locate(lines) {
  let section = null; let sectionAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^﻿/, '').trim();
    const head = /^\[(.*)\]$/.exec(line);
    if (head) {
      section = head[1];
      if (section === SECTION && sectionAt < 0) sectionAt = i;
    } else if (section === SECTION && line.startsWith(`${KEY}=`)) {
      return { sectionAt, keyAt: i, raw: line.slice(KEY.length + 1) };
    }
  }
  return { sectionAt, keyAt: -1, raw: '' };
}

function parse(raw) {
  if (!raw.trim()) return [];
  let docks;
  try { docks = JSON.parse(unescape(raw)); } catch { throw new Error("OBS's dock list could not be understood, so nothing was changed."); }
  if (!Array.isArray(docks) || docks.some((d) => !d || typeof d !== 'object')) {
    throw new Error("OBS's dock list looks unusual, so nothing was changed.");
  }
  return docks;
}

function readDocks(text) { return parse(locate(text.split('\n')).raw); }

function writeDocks(text, docks) {
  const lines = text.split('\n');
  const { sectionAt, keyAt } = locate(lines);
  const eol = text.includes('\r\n') ? '\r' : '';
  const entry = `${KEY}=${escape(JSON.stringify(docks))}${eol}`;
  if (keyAt >= 0) lines[keyAt] = entry;
  else if (sectionAt >= 0) lines.splice(sectionAt + 1, 0, entry);
  else {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push(eol, `[${SECTION}]${eol}`, entry, '');
  }
  return lines.join('\n');
}

// `isOurs(url)` says which docks belong to Raid Random.
function addDock(text, { title, url, isOurs }) {
  const docks = readDocks(text);
  const mine = docks.filter((d) => isOurs(d.url));
  if (mine.length === 1 && mine[0].url === url) return text; // already right
  const ours = { title: mine[0]?.title || title, url, uuid: mine[0]?.uuid || crypto.randomBytes(16).toString('hex') };
  const next = docks.filter((d) => !isOurs(d.url));
  const at = mine.length ? docks.filter((d, i) => i < docks.indexOf(mine[0]) && !isOurs(d.url)).length : next.length;
  next.splice(at, 0, ours);
  return writeDocks(text, next);
}

function removeDock(text, { isOurs }) {
  const docks = readDocks(text);
  const next = docks.filter((d) => !isOurs(d.url));
  return next.length === docks.length ? text : writeDocks(text, next);
}

module.exports = { readDocks, addDock, removeDock };
