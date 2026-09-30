// The speech model and its runtime are exactly the bytes that were vetted.
//
// Both are committed binaries that run with access to every spoken answer,
// so a silently swapped file — a bad merge, a hand edit, a tampered clone —
// is worth catching. The hashes were recorded when each was fetched:
// models/*/SHA256SUMS by tools/fetch-model.mjs, and vendor/transformers/
// VERSIONS.txt when the runtime was copied out of its npm package.
//
// Makes no network requests.

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

console.log(failures === 0 ? 'vendor-integrity: all checks passed' : `vendor-integrity: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
