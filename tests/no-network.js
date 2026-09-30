// Nothing the user says or types can leave the device.
//
// This fork's whole reason to exist, checked statically so a change that
// quietly reintroduces a network path fails CI before it ships. Two layers:
//
//   1. The source has no way out: no remote URL, no cloud speech API, no
//      fetch to anything but a relative path, and the speech worker is
//      configured never to download a model or runtime.
//   2. The browser enforces it anyway: index.html and both local servers
//      carry the same Content-Security-Policy, and its connect-src allows
//      only the origin that served the page. The meta tag covers the page;
//      the servers' header is what covers the worker.
//
// Makes no network requests.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await jsFiles(path));
    else if (entry.name.endsWith('.js')) out.push(path);
  }
  return out;
}

// Comments are allowed to talk about what this fork removed.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

// -- 1. the source ----------------------------------------------------------

const FORBIDDEN = [
  [/https?:\/\//, 'a remote URL'],
  [/api\.openai\.com|openai/i, 'OpenAI'],
  [/SpeechRecognition/, 'browser speech recognition, which is cloud-based'],
  [/sendBeacon|WebSocket|EventSource|RTCPeerConnection|XMLHttpRequest/, 'another network API'],
  [/allowRemoteModels\s*=\s*true/, 'remote model downloads'],
  [/importScripts\s*\(/, 'importScripts'],
  [/\bimport\s*\(\s*['"`]https?:/, 'a remote dynamic import']
];

const files = await jsFiles(join(ROOT, 'src'));
check('src/ has JavaScript to scan', files.length > 10, `found ${files.length}`);

for (const file of files) {
  const name = relative(ROOT, file);
  const code = stripComments(await readFile(file, 'utf8'));
  for (const [re, what] of FORBIDDEN) {
    const m = code.match(re);
    check(`${name} contains no ${what}`, !m, m ? `found ${JSON.stringify(m[0])}` : '');
  }

  // Every fetch goes to a relative path: a string literal with no scheme, or
  // a form template, whose paths are checked below.
  for (const m of code.matchAll(/\bfetch\s*\(\s*([^,)]+)/g)) {
    const arg = m[1].trim();
    const ok = /^'(?![a-z][a-z0-9+.-]*:)[^']+'$/i.test(arg) || arg === 'spec.TEMPLATE';
    check(`${name}: fetch(${arg}) targets a relative path`, ok);
  }
}

for (const form of ['ds-intake.js', 'ssa-starter-kit.js']) {
  const src = await readFile(join(ROOT, 'src', 'forms', form), 'utf8');
  const m = src.match(/export const TEMPLATE = '([^']+)'/);
  check(`${form} TEMPLATE is a relative path into forms/`, !!m && /^forms\/[\w.-]+\.pdf$/.test(m[1]),
    m ? m[1] : 'no TEMPLATE found');
}

{
  const worker = await readFile(join(ROOT, 'src', 'whisper-worker.js'), 'utf8');
  check('the worker disables remote models', /env\.allowRemoteModels\s*=\s*false/.test(worker));
  check('the worker points wasmPaths at vendor/', /env\.backends\.onnx\.wasm\.wasmPaths\s*=\s*new URL\('\.\.\/vendor\/transformers\/'/.test(worker));
  check('the worker loads models from models/', /env\.localModelPath\s*=\s*new URL\('\.\.\/models\/'/.test(worker));
  check('the worker imports the vendored runtime',
    /from '\.\.\/vendor\/transformers\/transformers\.min\.js'/.test(worker));
}

// -- 2. the policy ----------------------------------------------------------

const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
check('index.html declares a Content-Security-Policy', !!meta);
const csp = meta?.[1] ?? '';

const directives = Object.fromEntries(csp.split(';').map(d => d.trim()).filter(Boolean)
  .map(d => { const [k, ...v] = d.split(/\s+/); return [k, v]; }));

check("connect-src is exactly 'self'", directives['connect-src']?.join(' ') === "'self'",
  `connect-src ${directives['connect-src']?.join(' ')}`);
check("default-src is 'self'", directives['default-src']?.join(' ') === "'self'");
for (const [k, v] of Object.entries(directives)) {
  check(`${k} allows no remote origin or wildcard`,
    !v.some(s => /^https?:|^\*|^wss?:|^data:$/.test(s) && !(k === 'img-src' && s === 'data:')),
    v.join(' '));
}
check("script-src allows no 'unsafe-eval' or 'unsafe-inline'",
  !/'unsafe-(eval|inline)'/.test(directives['script-src']?.join(' ') ?? ''));

for (const m of html.matchAll(/\s(?:src|href)="([^"]+)"/g)) {
  check(`index.html loads ${m[1]} from this origin`, !/^(https?:)?\/\//.test(m[1]));
}

const py = await readFile(join(ROOT, 'tools', 'serve.py'), 'utf8');
const mjs = await readFile(join(ROOT, 'tools', 'serve.mjs'), 'utf8');
const pyCsp = py.match(/"Content-Security-Policy": "([^"]+)"/)?.[1];
const mjsCsp = mjs.match(/'Content-Security-Policy': "([^"]+)"/)?.[1];
check('tools/serve.py sends the same CSP as index.html', pyCsp === csp, `serve.py: ${pyCsp}`);
check('tools/serve.mjs sends the same CSP as index.html', mjsCsp === csp, `serve.mjs: ${mjsCsp}`);
check('both servers bind to 127.0.0.1 only',
  /\("127\.0\.0\.1", port\)/.test(py) && /listen\(port, '127\.0\.0\.1'\)/.test(mjs));

// -- 3. what the browser or an extension would send on its own ------------
//
// A field with spell-checking on can be sent to Google (Chrome's Enhanced
// Spell Check) or Microsoft (Edge's Editor); Grammarly and LanguageTool do
// the same through their extensions. The CSP does not cover the browser's own
// services or extensions, so every field a user types into opts out.

for (const m of html.matchAll(/<(input|textarea)\b[^>]*>/g)) {
  const tag = m[0];
  if (/type="(radio|checkbox|file|button|submit)"/.test(tag)) continue;
  const id = tag.match(/id="([^"]+)"/)?.[1] ?? tag.slice(0, 40);
  check(`#${id} has spellcheck="false"`, /spellcheck="false"/.test(tag));
  check(`#${id} has autocomplete="off"`, /autocomplete="off"/.test(tag));
  check(`#${id} opts out of Grammarly`, /data-gramm="false"/.test(tag) && /data-enable-grammarly="false"/.test(tag));
  check(`#${id} opts out of LanguageTool`, /data-lt-active="false"/.test(tag));
}

// -- 4. the origin the answers are stored under ------------------------------
//
// Saved answers belong to http://localhost:<port>. A port shared with other
// local tools shares them too, so it is not a common default, and both
// launchers use the same one or they would each see a different session.

{
  const pyPort = Number(py.match(/^FIRST_PORT = (\d+)$/m)?.[1]);
  const mjsPort = Number(mjs.match(/^const FIRST_PORT = (\d+);$/m)?.[1]);
  check('both servers start from the same port', pyPort === mjsPort, `py ${pyPort}, mjs ${mjsPort}`);
  const COMMON = [3000, 3001, 4000, 4200, 5000, 5173, 5500, 8000, 8080, 8081, 8888, 9000];
  check('the port is not a common dev-server default', !COMMON.includes(pyPort), String(pyPort));
  check('the port is below the ephemeral range', pyPort > 1024 && pyPort + 20 < 32768, String(pyPort));
}

console.log(failures === 0 ? 'no-network: all checks passed' : `no-network: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
