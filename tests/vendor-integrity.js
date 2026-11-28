// The speech model and its runtime are exactly the bytes that were vetted.
//
// Both are committed binaries that run with access to every spoken answer,
// so a silently swapped file — a bad merge, a hand edit, a tampered clone —
// is worth catching. The hashes were recorded when each was fetched:
// models/*/SHA256SUMS by tools/fetch-model.mjs, vendor/transformers/
// VERSIONS.txt when the runtime was copied out of its npm package, and
// vendor/SHA256SUMS for pdf-lib, which runs in the page with every answer.
// The launchers run the same check before serving (tests/launcher.js).
//
// Makes no network requests.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES } from '../src/i18n/languages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');

/** Lines of "<hex>  <path>", as shasum and fetch-model.mjs write them. */
async function verify(dir, listFile) {
  const text = await readFile(join(dir, listFile), 'utf8');
  const entries = [...text.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)];
  check(`${listFile} in ${dir.slice(ROOT.length + 1)} lists files`, entries.length > 0);
  for (const [, want, path] of entries) {
    let got = null;
    try { got = await sha256(join(dir, path)); } catch { /* missing */ }
    check(`${dir.slice(ROOT.length + 1)}/${path} matches its recorded hash`, got === want,
      got ? `got ${got}` : 'file is missing');
  }
  return entries.map(e => e[2]);
}

const libraries = await verify(join(ROOT, 'vendor'), 'SHA256SUMS');
check('pdf-lib is pinned', libraries.includes('pdf-lib.min.js'));
check('the iOS writer bundle is pinned', libraries.includes('ssa-pdf-writer.js'));

const vendored = await verify(join(ROOT, 'vendor', 'transformers'), 'VERSIONS.txt');
for (const need of ['transformers.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  check(`the runtime file ${need} is pinned`, vendored.includes(need));
}

const models = (await readdir(join(ROOT, 'models'), { withFileTypes: true })).filter(d => d.isDirectory());
check('at least one model is committed', models.length > 0);
for (const model of models) {
  const files = await verify(join(ROOT, 'models', model.name), 'SHA256SUMS');
  for (const need of ['config.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']) {
    check(`${model.name} includes ${need}`, files.includes(need));
  }
}

// The worker names one model; it has to be one of the committed ones.
const worker = await readFile(join(ROOT, 'src', 'whisper-worker.js'), 'utf8');
const used = worker.match(/const MODEL = '([^']+)'/)?.[1];
check('the worker loads a committed model', models.some(m => m.name === used), `MODEL = ${used}`);

// The language table's `installed` flag is a fact about this checkout, not a
// promise: an installed pack must name a committed directory, and an
// uninstalled one must not pretend it is there.
const committed = new Set(models.map(m => m.name));
check('both speech packs are committed',
  committed.has('whisper-base.en') && committed.has('whisper-base'), [...committed].join(', '));

// Each pack names the revision it was fetched at, and that is the one
// tools/fetch-model.mjs pins. Only q8 weights are committed.
const fetcher = await readFile(join(ROOT, 'tools', 'fetch-model.mjs'), 'utf8');
for (const model of models) {
  const dir = join(ROOT, 'models', model.name);
  const source = await readFile(join(dir, 'SOURCE.txt'), 'utf8').catch(() => '');
  const m = source.match(/^https:\/\/huggingface\.co\/(\S+)\nrevision ([0-9a-f]{40})\n$/);
  check(`${model.name} SOURCE.txt names a repository and revision`, !!m, JSON.stringify(source));
  if (m) {
    check(`${model.name} is the pack its SOURCE.txt names`, m[1].split('/').pop() === model.name, m[1]);
    check(`${model.name} revision is the one fetch-model.mjs pins`, fetcher.includes(`'${m[1]}': '${m[2]}'`), m[2]);
  }
  const onnx = await readdir(join(dir, 'onnx'));
  check(`${model.name} commits q8 weights only`, onnx.every(f => f.endsWith('_quantized.onnx')), onnx.join(', '));
}

// A multilingual pack must know every language that loads it.
for (const [code, language] of Object.entries(LANGUAGES)) {
  const stt = language.stt;
  if (!stt?.installed || !stt.multilingual) continue;
  const gen = JSON.parse(await readFile(join(ROOT, 'models', stt.model, 'generation_config.json'), 'utf8'));
  check(`${code}: ${stt.model} is multilingual`, gen.is_multilingual === true);
  check(`${code}: ${stt.model} has the <|${stt.language}|> token`,
    Number.isInteger(gen.lang_to_id?.[`<|${stt.language}|>`]));
}
for (const [code, language] of Object.entries(LANGUAGES)) {
  const model = language.stt?.model;
  check(`${code} speech pack names a model`, typeof model === 'string' && model.length > 0);
  if (language.stt?.installed) {
    check(`${code} installed speech pack is committed`, committed.has(model), model);
  } else {
    check(`${code} uninstalled speech pack is absent`, !committed.has(model), model);
  }
}

// The app's own pin file: the three generated files the iOS bundle copies
// (schema.json and the two goldens) are checked against it at first use, so a
// regenerated schema or golden that nobody re-pinned would ship a file the app
// refuses at launch. Catching it here names the fix instead.
{
  const pinsPath = join(ROOT, 'ios', 'App', 'SsaResources.SHA256SUMS');
  const text = await readFile(pinsPath, 'utf8').catch(() => null);
  check('ios/App/SsaResources.SHA256SUMS exists', text !== null);
  if (text !== null) {
    const entries = [...text.matchAll(/^([0-9a-f]{64})\s+(\S+)$/gm)];
    check('SsaResources.SHA256SUMS lists files', entries.length > 0);
    const sources = {
      'schema.json': join(ROOT, 'tools', 'schema.json'),
      'golden/metrics.json': join(ROOT, 'android', 'core', 'src', 'commonMain', 'resources', 'golden', 'metrics.json'),
      'golden/templateManifest.json': join(ROOT, 'android', 'core', 'src', 'commonMain', 'resources', 'golden', 'templateManifest.json')
    };
    for (const [, want, name] of entries) {
      const source = sources[name];
      check(`SsaResources.SHA256SUMS names a known file (${name})`, source !== undefined);
      if (source === undefined) continue;
      const got = await sha256(source).catch(() => null);
      check(`the iOS bundle's ${name} matches its pin`, got === want,
        got ? `got ${got}; re-pin with sha256sum (see ios/App/README.md)` : 'file is missing');
    }
    check('SsaResources.SHA256SUMS pins all three files',
      Object.keys(sources).every(name => entries.some(e => e[2] === name)));
  }
}

console.log(failures === 0 ? 'vendor-integrity: all checks passed' : `vendor-integrity: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
