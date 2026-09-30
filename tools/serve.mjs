// Serve the app on localhost, using only Node's standard library.
//
// This is the fallback for machines with Node but no Python. It mirrors
// tools/serve.py exactly: same ports, same 127.0.0.1-only binding, same
// security headers, same integrity check, same dedicated browser profile.
// See that file for why file:// is not an option, and why each of those
// matters. tests/launcher.js checks that the two agree.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Not 8000: see FIRST_PORT in tools/serve.py. Must stay identical to it.
const FIRST_PORT = 27183;
const TRIES = 20;

// A wrong type here is not cosmetic: a browser refuses a module served as
// anything but JavaScript, and the whole app is modules.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff2': 'font/woff2'
};

// Identical to HEADERS in tools/serve.py.
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; style-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};

// -- integrity -----------------------------------------------------------------

/** Every hash list: the vendored libraries and each committed model. */
export function integrityLists(root = ROOT) {
  const lists = [join(root, 'vendor', 'SHA256SUMS'), join(root, 'vendor', 'transformers', 'VERSIONS.txt')];
  const models = join(root, 'models');
  if (existsSync(models)) {
    for (const d of readdirSync(models, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()) {
      const list = join(models, d, 'SHA256SUMS');
      if (existsSync(list)) lists.push(list);
    }
  }
  return lists;
}

/** Problems with the pinned files, as short strings; empty when all match. */
export function verifyFiles(root = ROOT) {
  const problems = [];
  const lists = integrityLists(root);
  const shown = p => relative(root, p).split(sep).join('/');
  if (!lists.some(p => basename(dirname(dirname(p))) === 'models')) {
    problems.push('no speech model found under models/');
  }
  for (const list of lists) {
    if (!existsSync(list)) { problems.push(`missing ${shown(list)}`); continue; }
    for (const line of readFileSync(list, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
      if (!m) continue;
      const path = join(dirname(list), m[2]);
      if (!existsSync(path)) { problems.push(`missing ${shown(path)}`); continue; }
      const got = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (got !== m[1]) problems.push(`changed ${shown(path)}`);
    }
  }
  return problems;
}

// -- a browser of its own --------------------------------------------------------

// Identical to BROWSER_FLAGS in tools/serve.py, which says why each is there.
export const BROWSER_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-breakpad',
  '--disable-features=Translate,AutofillServerCommunication,OptimizationHints,MediaRouter'
];

/** Where the dedicated profile lives: per-user app data, never a synced folder. */
export function profileDir() {
  const base = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
      : (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  return join(base, 'SSA Disability Assistant', 'browser-profile');
}

const onPath = name => (process.env.PATH ?? '').split(delimiter)
  .map(d => join(d, name)).find(p => existsSync(p)) ?? null;

/** A Chromium-family browser, which takes the flags above; else null. */
export function findBrowser() {
  const override = process.env.SSA_BROWSER;
  if (override) return existsSync(override) ? override : null;
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser']) {
      for (const apps of ['/Applications', join(homedir(), 'Applications')]) {
        const exe = join(apps, `${app}.app`, 'Contents', 'MacOS', app);
        if (existsSync(exe)) return exe;
      }
    }
    return null;
  }
  if (process.platform === 'win32') {
    const rels = ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe',
      'Chromium\\Application\\chrome.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'];
    for (const env of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) {
      const base = process.env[env];
      for (const rel of base ? rels : []) {
        const exe = join(base, rel);
        if (existsSync(exe)) return exe;
      }
    }
    return null;
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
    'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
    const exe = onPath(name);
    if (exe) return exe;
  }
  return null;
}

function openDefault(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed either way */
  }
}

/** Open the page; returns the name of what opened it, or null. */
function openBrowser(url, useDefault) {
  const exe = useDefault ? null : findBrowser();
  if (exe) {
    try {
      const profile = profileDir();
      mkdirSync(profile, { recursive: true });
      try { chmodSync(profile, 0o700); } catch { /* Windows */ }
      spawn(exe, [`--user-data-dir=${profile}`, ...BROWSER_FLAGS, `--app=${url}`],
        { stdio: 'ignore', detached: true }).unref();
      return basename(exe).replace(/\.exe$/i, '');
    } catch { /* fall through to the ordinary browser */ }
  }
  openDefault(url);
  return null;
}

// -- serving ---------------------------------------------------------------------

function main(argv) {
  const useDefault = argv.includes('--default-browser');

  console.log();
  console.log('  Checking the speech model and libraries...');
  const problems = verifyFiles();
  if (problems.length) {
    console.log();
    console.log('  STOPPED. These files are not the ones this project was published with:');
    for (const p of problems) console.log(`      ${p}`);
    console.log();
    console.log('  They run with access to everything you say. Download a fresh copy');
    console.log('  of the project rather than using this one.');
    console.log();
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
    };

    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      return send(400, 'Bad request');
    }

    let file = resolve(join(ROOT, decodeURIComponent(pathname)));

    // Keep the server inside the project directory. Without this, a crafted
    // path walks up into the user's home folder.
    if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(403, 'Forbidden');

    try {
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    } catch {
      return send(404, 'Not found');
    }

    try {
      const info = await stat(file);
      res.writeHead(200, {
        ...HEADERS,
        'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': info.size,
        'Cache-Control': 'no-store'
      });
      createReadStream(file).pipe(res);
    } catch {
      send(404, 'Not found');
    }
  });

  let port = FIRST_PORT;

  server.on('error', err => {
    if (err.code === 'EADDRINUSE' && port < FIRST_PORT + TRIES - 1) {
      server.listen(++port, '127.0.0.1');   // port taken, try the next one
      return;
    }
    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  });

  server.on('listening', () => {
    const url = `http://localhost:${port}/`;
    console.log();
    console.log('  The assistant is running at:');
    console.log(`      ${url}`);
    console.log();
    console.log('  Leave this window open while you use it.');
    console.log('  Press Control-C here when you are finished.');
    console.log();
    setTimeout(() => {
      const opened = openBrowser(url, useDefault);
      if (opened) {
        console.log(`  Opened in a separate ${opened} window with its own profile:`);
        console.log('  no extensions, no account sync.');
      } else if (!useDefault) {
        console.log('  Chrome or Edge was not found, so this opened in your usual');
        console.log('  browser. Its extensions can read what you type there.');
      }
      console.log();
    }, 500);
  });

  process.on('SIGINT', () => {
    console.log('\n  Stopped. You can close this window.');
    process.exit(0);
  });

  server.listen(port, '127.0.0.1');
}

// Run as a program; imported by tests/launcher.js for its functions only.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
