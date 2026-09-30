#!/usr/bin/env node
// Download a Whisper model into models/, for maintainers only.
//
// The app never fetches a model. The one it uses is committed under models/,
// so a downloaded copy of this project transcribes speech with the network
// unplugged from its very first run — and the page's Content-Security-Policy
// would refuse a remote fetch anyway. This script exists to refresh that
// committed copy, or to try a different size:
//
//   node tools/fetch-model.mjs                          whisper-base.en (default)
//   node tools/fetch-model.mjs onnx-community/whisper-small.en
//   node tools/fetch-model.mjs --verify                 re-hash what is on disk
//
// Every file is pinned to one repository revision and checked against the
// SHA-256 Hugging Face publishes for it. The hashes are written to
// SHA256SUMS beside the model, which tests/model-integrity.js checks.
//
// Only the q8 ("_quantized") weights are fetched. They are what the app
// loads (see DTYPE in src/whisper-worker.js), and they are the only variant
// small enough to commit without Git LFS.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HF = 'https://huggingface.co';

// Bump a revision deliberately, after running tools/stt-eval.mjs against it.
const REVISIONS = {
  'onnx-community/whisper-base.en': '51eefc0af78b103839eda9e7e4f4186acc6517fe',
  'onnx-community/whisper-small.en': '482fb8ba081b6e906f92efe103622316b2a0cc69'
};

const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
];

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify');
const repo = args.find(a => !a.startsWith('--')) ?? 'onnx-community/whisper-base.en';
const rev = REVISIONS[repo];
if (!rev) {
  console.error(`No pinned revision for ${repo}. Add one to REVISIONS first.`);
  process.exit(1);
}
const dest = join(ROOT, 'models', basename(repo));

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

if (verifyOnly) {
  const sums = await readFile(join(dest, 'SHA256SUMS'), 'utf8');
  let bad = 0;
  for (const line of sums.trim().split('\n')) {
    const [want, path] = line.split(/\s+/);
    const got = sha256(await readFile(join(dest, path)));
    if (got !== want) { bad++; console.error(`MISMATCH ${path}`); }
  }
  console.log(bad ? `${bad} file(s) do not match.` : 'All files match SHA256SUMS.');
  process.exit(bad ? 1 : 0);
}

// Published hashes for this revision. Hugging Face reports an LFS object's
// SHA-256 as its oid; small files are plain git blobs and have none, so those
// are pinned by the revision alone.
const published = new Map();
for (const dir of ['', 'onnx']) {
  const res = await fetch(`${HF}/api/models/${repo}/tree/${rev}/${dir}`);
  if (!res.ok) throw new Error(`Listing ${dir || '/'} failed: ${res.status}`);
  for (const entry of await res.json()) {
    if (entry.lfs?.oid) published.set(entry.path, entry.lfs.oid);
  }
}

const lines = [];
for (const path of FILES) {
  process.stdout.write(`${path} … `);
  const res = await fetch(`${HF}/${repo}/resolve/${rev}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  const want = published.get(path);
  if (want && want !== got) throw new Error(`${path}: hash ${got} does not match published ${want}`);
  await mkdir(dirname(join(dest, path)), { recursive: true });
  await writeFile(join(dest, path), buf);
  lines.push(`${got}  ${path}`);
  console.log(`${(buf.length / 1e6).toFixed(1)} MB${want ? ', verified' : ''}`);
}

await writeFile(join(dest, 'SHA256SUMS'), lines.join('\n') + '\n');
await writeFile(join(dest, 'SOURCE.txt'), `${HF}/${repo}\nrevision ${rev}\n`);
console.log(`Wrote ${dest}`);
