'use strict';
// The pages, whether they sit in the public folder or inside the finished .exe.
const fs = require('node:fs');
const path = require('node:path');
const sea = require('node:sea');

const packaged = sea.isSea();

function readPublic(name) {
  return packaged ? Buffer.from(sea.getAsset(name)) : fs.readFileSync(path.join(__dirname, '..', 'public', name));
}

module.exports = { packaged, readPublic };
