// Makes dist/RaidRandom.exe: one file that needs nothing installed.
//   node build/build.mjs
// How: bundle the code, then place it inside a copy of the official node.exe.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = path.join(root, 'app');
const dist = path.join(root, 'dist');
const work = path.join(dist, 'work');
const exe = path.join(dist, 'RaidRandom.exe');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const powershell = (args) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { encoding: 'utf8' }).trim();

// Only build on a genuine, signed Node. $env: keeps the path out of the command text.
process.env.RR_NODE = process.execPath;
const signer = powershell(['-Command', '$s = Get-AuthenticodeSignature -LiteralPath $env:RR_NODE; "$($s.Status)|$($s.SignerCertificate.Subject)"']);
if (!/^Valid\|.*OpenJS Foundation/.test(signer)) throw new Error(`This node.exe is not signed by the OpenJS Foundation: ${signer}`);

fs.mkdirSync(work, { recursive: true });
for (const name of fs.readdirSync(dist)) {
  const file = path.join(dist, name);
  try { fs.rmSync(file, { recursive: true, force: true }); } catch { if (name === 'RaidRandom.exe') fs.renameSync(file, path.join(dist, `old-${Date.now()}.exe`)); }
}
fs.mkdirSync(work, { recursive: true });

// 1. All code into one file.
const home = ['build', 'admin'].find((d) => fs.existsSync(path.join(root, d, 'node_modules', 'esbuild')));
if (!home) throw new Error('Run "npm install" inside the build folder first.');
const esbuild = createRequire(path.join(root, home, 'package.json'))('esbuild');
await esbuild.build({ entryPoints: [path.join(app, 'src', 'main.js')], bundle: true, platform: 'node', target: 'node24', outfile: path.join(work, 'app.js'), logLevel: 'warning' });

// 2. Code and pages into one blob.
const assets = Object.fromEntries(fs.readdirSync(path.join(app, 'public')).map((n) => [n, path.join(app, 'public', n)]));
fs.writeFileSync(path.join(work, 'sea.json'), JSON.stringify({ main: path.join(work, 'app.js'), output: path.join(work, 'app.blob'), disableExperimentalSEAWarning: true, assets }));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(work, 'sea.json')], { stdio: 'inherit' });

// 3. A copy of node.exe, without its signature (it would no longer match) and without a black window.
let bin = fs.readFileSync(process.execPath);
const pe = bin.readUInt32LE(0x3c);
if (bin.toString('latin1', pe, pe + 4) !== 'PE\0\0' || bin.readUInt16LE(pe + 24) !== 0x20b) throw new Error('Unexpected node.exe format');
const optional = pe + 24;
const security = optional + 112 + 4 * 8;
const certAt = bin.readUInt32LE(security);
const certSize = bin.readUInt32LE(security + 4);
if (certAt) {
  if (certAt + certSize !== bin.length) throw new Error('Unexpected signature position');
  bin.writeUInt32LE(0, security);
  bin.writeUInt32LE(0, security + 4);
  bin = bin.subarray(0, certAt);
}
if (bin.readUInt16LE(optional + 68) !== 3) throw new Error('Unexpected window type');
bin.writeUInt16LE(2, optional + 68); // a windowed program, so no console opens

// 4. Switch on "this .exe contains an app".
const at = bin.indexOf(`${FUSE}:0`);
if (at < 0 || bin.indexOf(`${FUSE}:0`, at + 1) >= 0) throw new Error('Unexpected Node version');
bin[at + FUSE.length + 1] = '1'.charCodeAt(0);
const draft = path.join(work, 'draft.exe');
fs.writeFileSync(draft, bin);
powershell(['-File', path.join(root, 'build', 'add-resource.ps1'), '-Exe', draft, '-Blob', path.join(work, 'app.blob')]);

// Only a complete and working .exe gets the final name.
const check = execFileSync(draft, ['--version-check'], { encoding: 'utf8' });
const version = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8')).version;
if (check.trim() !== `Raid Random ${version}`) throw new Error(`The built .exe did not answer correctly: ${check}`);
for (let i = 1; ; i++) {
  try { fs.renameSync(draft, exe); break; } catch (err) { if (i >= 10) throw err; await new Promise((r) => setTimeout(r, 1500)); }
}

// 5. A fingerprint, so people can check their download, and Node's license.
const sum = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
fs.writeFileSync(path.join(dist, 'SHA256.txt'), `${sum}  RaidRandom.exe\n`);
const license = path.join(path.dirname(process.execPath), 'LICENSE');
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(dist, 'NODE-LICENSE.txt'));
fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
console.log(`Built ${exe}\n${(fs.statSync(exe).size / 1e6).toFixed(1)} MB, Node ${process.version}, license file: ${fs.existsSync(license)}\nSHA-256 ${sum}`);
