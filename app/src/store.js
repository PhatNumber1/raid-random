'use strict';
// Saves small pieces of data as files in %APPDATA%\RaidRandom.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function defaultDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'RaidRandom');
}

class FileStore {
  constructor(dir = defaultDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }
  file(name) { return path.join(this.dir, `${name}.json`); }
  load(name) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return null; }
  }
  // Write to a temp file, then swap it in, so a crash never leaves half a file.
  save(name, value) {
    const tmp = `${this.file(name)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file(name));
  }
  remove(name) { fs.rmSync(this.file(name), { force: true }); }
}

class MemoryStore {
  constructor(data = {}) { this.data = structuredClone(data); }
  load(name) { return name in this.data ? structuredClone(this.data[name]) : null; }
  save(name, value) { this.data[name] = structuredClone(value); }
  remove(name) { delete this.data[name]; }
}

module.exports = { FileStore, MemoryStore };
