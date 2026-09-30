// The two launchers: they refuse to serve tampered files, and they open the
// page in a browser profile of its own.
//
// tools/serve.py and tools/serve.mjs are the same program twice, for machines
// with only one of Python and Node. This checks each one's integrity check
// against a scratch copy of the pinned-file layout — a changed file and a
// missing file must both stop it — and that the two agree on the browser
// flags that keep extensions, sync and background requests away from the
// page. The Python half is skipped, with a note, where python3 is missing.
//
// Makes no network requests.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as node from '../tools/serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const sha = text => createHash('sha256').update(text).digest('hex');

/** A scratch project with one pinned file in each of the three lists. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'ssa-launcher-'));
  const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  put('vendor/pdf-lib.min.js', 'pdf');
  put('vendor/SHA256SUMS', `${sha('pdf')}  pdf-lib.min.js\n`);
  put('vendor/transformers/transformers.min.js', 'rt');
  put('vendor/transformers/VERSIONS.txt', `runtime\n\n${sha('rt')}  transformers.min.js\n`);
  put('models/whisper-test/onnx/encoder.onnx', 'model');
  put('models/whisper-test/SHA256SUMS', `${sha('model')}  onnx/encoder.onnx\n`);
  return { root, put };
}

// -- python, if there is one --------------------------------------------------

const hasPython = spawnSync('python3', ['--version']).status === 0;
function py(expr, env = {}) {
  const r = spawnSync('python3', ['-c',
    `import sys, json; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'tools'))}); import serve; print(json.dumps(${expr}))`],
  { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}
const verifiers = [['serve.mjs', root => node.verifyFiles(root)]];
if (hasPython) verifiers.push(['serve.py', root => py(`serve.verify_files(__import__('pathlib').Path(${JSON.stringify(root)}))`)]);
else console.log('launcher: python3 not found, checking serve.mjs only');

// -- the integrity check ---------------------------------------------------------

for (const [name, verify] of verifiers) {
  check(`${name}: the real project passes`, verify(ROOT).length === 0, verify(ROOT).join('; '));

  const { root, put } = scratch();
  try {
    check(`${name}: an intact scratch project passes`, verify(root).length === 0, verify(root).join('; '));

    put('models/whisper-test/onnx/encoder.onnx', 'model, altered');
    let problems = verify(root);
    check(`${name}: a changed model file stops it`,
      problems.some(p => p === 'changed models/whisper-test/onnx/encoder.onnx'), problems.join('; '));
    put('models/whisper-test/onnx/encoder.onnx', 'model');

    rmSync(join(root, 'vendor/pdf-lib.min.js'));
    problems = verify(root);
    check(`${name}: a missing library stops it`,
      problems.some(p => p === 'missing vendor/pdf-lib.min.js'), problems.join('; '));
    put('vendor/pdf-lib.min.js', 'pdf');

    rmSync(join(root, 'vendor/transformers/VERSIONS.txt'));
    problems = verify(root);
    check(`${name}: a missing hash list stops it`,
      problems.some(p => p === 'missing vendor/transformers/VERSIONS.txt'), problems.join('; '));
    put('vendor/transformers/VERSIONS.txt', `${sha('rt')}  transformers.min.js\n`);

    rmSync(join(root, 'models'), { recursive: true });
    problems = verify(root);
    check(`${name}: no model at all stops it`,
      problems.some(p => /no speech model/.test(p)), problems.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -- the browser profile -------------------------------------------------------

{
  const flags = node.BROWSER_FLAGS;
  for (const need of ['--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-breakpad']) {
    check(`the browser is launched with ${need}`, flags.includes(need));
  }
  check('translation and autofill servers are turned off',
    flags.some(f => /^--disable-features=.*Translate/.test(f) && /AutofillServerCommunication/.test(f)));

  const profile = node.profileDir();
  check('the profile lives outside the project folder', !profile.startsWith(ROOT), profile);
  check('the profile is this app\'s own', /SSA Disability Assistant/.test(profile), profile);

  const self = fileURLToPath(import.meta.url);
  process.env.SSA_BROWSER = self;
  check('SSA_BROWSER names the browser', node.findBrowser() === self);
  process.env.SSA_BROWSER = join(ROOT, 'no-such-browser');
  check('a missing SSA_BROWSER finds nothing rather than something else', node.findBrowser() === null);
  delete process.env.SSA_BROWSER;

  if (hasPython) {
    check('serve.py launches with the same flags', JSON.stringify(py('serve.BROWSER_FLAGS')) === JSON.stringify(flags),
      JSON.stringify(py('serve.BROWSER_FLAGS')));
    check('serve.py keeps the profile in the same place', py('str(serve.profile_dir())') === profile);
    check('serve.py honours SSA_BROWSER', py('serve.find_browser()', { SSA_BROWSER: self }) === self);
  }

  // Both scripts must actually pass the flags and the profile to the browser.
  for (const file of ['serve.py', 'serve.mjs']) {
    const src = readFileSync(join(ROOT, 'tools', file), 'utf8');
    check(`${file} launches with its own --user-data-dir`, /--user-data-dir=/.test(src));
    check(`${file} opens the page as an app window`, /--app=/.test(src));
    check(`${file} checks the files before serving`, /verify_?[fF]iles\(\)/.test(src));
  }
}

console.log(failures === 0 ? 'launcher: all checks passed' : `launcher: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
