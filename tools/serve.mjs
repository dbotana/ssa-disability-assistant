// Serve the app on localhost, using only Node's standard library.
//
// This is the fallback for machines with Node but no Python. It mirrors
// tools/serve.py exactly: same ports, same 127.0.0.1-only binding, same
// browser launch. See that file for why file:// is not an option.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIRST_PORT = 8000;
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
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff2': 'font/woff2'
};

function openBrowser(url) {
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

const server = createServer(async (req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
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
  setTimeout(() => openBrowser(url), 500);
});

process.on('SIGINT', () => {
  console.log('\n  Stopped. You can close this window.');
  process.exit(0);
});

server.listen(port, '127.0.0.1');
