#!/usr/bin/env node
// Download a pinned model, for maintainers only.
//
// The app never fetches a model. The one it uses is committed under models/,
// so a downloaded copy of this project transcribes speech with the network
// unplugged from its very first run — and the page's Content-Security-Policy
// would refuse a remote fetch anyway. This script exists to refresh that
// committed copy, or to try a different size:
//
//   node tools/fetch-model.mjs                          whisper-base.en (default)
//   node tools/fetch-model.mjs onnx-community/whisper-small.en
//   node tools/fetch-model.mjs facebook/mms-1b-all      the MMS-1B-all lin/fra/eng adapters
//   node tools/fetch-model.mjs Xenova/mms-1b-all        the MMS-1B-all ONNX export (eng adapter baked in)
//   node tools/fetch-model.mjs facebook/mms-lid-126     the MMS-LID-126 config files (lid-source/)
//   node tools/fetch-model.mjs --verify                 re-hash what is on disk
//   node tools/fetch-model.mjs --verify <repo>          the same, for one pinned repo
//   node tools/fetch-model.mjs --verify mms             re-hash every MMS file against
//                                                       android/models/mms.SHA256SUMS
//
// Every file is pinned to one repository revision and checked against the
// SHA-256 Hugging Face publishes for it. The hashes are written to
// SHA256SUMS beside the model, which tests/vendor-integrity.js and both launchers check.
//
// Only the q8 ("_quantized") weights are fetched. They are what the app
// loads (see DTYPE in src/whisper-worker.js), and they are the only variant
// small enough to commit without Git LFS.
//
// The Whisper packs land in models/ and are committed. The MMS-1B-all
// artifacts are too large to commit (the q8 export alone is ~973 MB), so they
// land in the git-ignored android/models/third_party/mms-1b-all/ beside the
// ORT archives, each with its own SHA256SUMS and SOURCE.txt. The export's
// graph carries the English adapter baked in: all 144 named adapter tensors
// in it are byte-identical to Meta's adapter.eng (checked 2026-11-25), and
// transformers.js cannot load adapters. Lingala and French therefore need
// per-language ONNX exports produced from the pinned adapters.
//
// Those exports now exist. The owner produced the per-language ASR graphs on
// 2026-11-25 with tools/export-mms/ (onnx-lin/, onnx-fra/, onnx-eng/), and Run 9
// Step 1 added the language-ID graph from facebook/mms-lid-126
// (export-mms.py --lid, into lid-126/; this script fetches only that repo's
// config files, into lid-source/). A locally produced graph has no publisher
// checksum: its pin is the recipe in tools/export-mms/ plus its hashes. Every
// MMS file, fetched or exported, fp32 and q8, is pinned in the committed
// android/models/mms.SHA256SUMS, which `--verify mms` checks.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HF = 'https://huggingface.co';

// Bump a revision deliberately, after running tools/stt-eval.mjs against it.
const REVISIONS = {
  'onnx-community/whisper-base.en': '51eefc0af78b103839eda9e7e4f4186acc6517fe',
  // French and Lingala. There are no recordings in either language, so this
  // pin is checked by hash only; its accuracy has not been measured.
  'onnx-community/whisper-base': '1846881b6b3a3024392c1eea3ad983695bc23925',
  'onnx-community/whisper-small.en': '482fb8ba081b6e906f92efe103622316b2a0cc69',
  // Meta's MMS-1B-all (D6). The repo's weights are PyTorch, not ONNX; these
  // are the three language adapters Run 9 needs. tools/export-mms/export-mms.py
  // bakes each into its own ONNX export (onnx-lin, onnx-fra, onnx-eng), all
  // pinned in android/models/mms.SHA256SUMS.
  'facebook/mms-1b-all': '3d33597edbdaaba14a8e858e2c8caa76e3cec0cd',
  // A transformers.js-ready ONNX export of the same model. Its graph has the
  // English adapter baked in (see the header note), so it can pin the English
  // half and the CTC decoding reference, but not Lingala or French.
  'Xenova/mms-1b-all': 'bbfb637f299dd83dda65efe00e5317753ca569f2',
  // Meta's MMS language ID over 126 languages, lin, fra and eng among them
  // (Run 9). Only its config files are fetched here, into lid-source/; the
  // ONNX graph is exported from this revision by
  // tools/export-mms/export-mms.py --lid, into lid-126/.
  'facebook/mms-lid-126': '53da6e311f3ce48f324fe335924216187e3109a4'
};

const WHISPER_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx'
];

const FILES = {
  'facebook/mms-1b-all': [
    'config.json',
    'adapter.lin.safetensors',
    'adapter.fra.safetensors',
    'adapter.eng.safetensors'
  ],
  'Xenova/mms-1b-all': [
    'config.json',
    'preprocessor_config.json',
    'quantize_config.json',
    'special_tokens_map.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'vocab.json',
    'onnx/model_quantized.onnx'
  ],
  'facebook/mms-lid-126': [
    'config.json',
    'preprocessor_config.json'
  ]
};

// Where each pack lands. Everything not listed goes to models/<name>/.
const DESTS = {
  'facebook/mms-1b-all': join('android', 'models', 'third_party', 'mms-1b-all', 'adapters'),
  'Xenova/mms-1b-all': join('android', 'models', 'third_party', 'mms-1b-all', 'onnx'),
  // Not lid-126/: that folder belongs to the export (export-mms.py --lid).
  'facebook/mms-lid-126': join('android', 'models', 'third_party', 'mms-1b-all', 'lid-source')
};

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify');
const repo = args.find(a => !a.startsWith('--')) ?? 'onnx-community/whisper-base.en';

// `--verify mms` re-hashes every MMS file, fetched or exported, against the
// committed pins (Run 9, Decision 8). The files are git-ignored; the pins are not.
const MMS_ROOT = join(ROOT, 'android', 'models', 'third_party', 'mms-1b-all');
const MMS_SUMS = join(ROOT, 'android', 'models', 'mms.SHA256SUMS');
if (verifyOnly && repo === 'mms') process.exit(await verifyMms());

const rev = REVISIONS[repo];
if (!rev) {
  console.error(`No pinned revision for ${repo}. Add one to REVISIONS first.`);
  process.exit(1);
}
const files = FILES[repo] ?? WHISPER_FILES;
const dest = join(ROOT, DESTS[repo] ?? join('models', basename(repo)));

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

// Every line of android/models/mms.SHA256SUMS is '<sha256>  <folder>/<path>',
// relative to MMS_ROOT. Each folder's own SHA256SUMS must list exactly the
// same entries, and every file must hash to its pin. Files are streamed: an
// fp32 graph's model.onnx_data is about 3.86 GB.
async function verifyMms() {
  let bad = 0;
  const fail = message => { bad++; console.error(message); };
  const parse = (text, where) => {
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim() || line.startsWith('#')) continue;
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      if (m) entries.push({ want: m[1], path: m[2] });
      else fail(`MALFORMED ${where}: ${line}`);
    }
    return entries;
  };
  const pins = parse(await readFile(MMS_SUMS, 'utf8'), 'android/models/mms.SHA256SUMS');
  const folderOf = path => path.split('/')[0];

  for (const folder of new Set(pins.map(p => folderOf(p.path)))) {
    const pinned = new Set(pins.filter(p => folderOf(p.path) === folder)
      .map(p => `${p.want}  ${p.path.slice(folder.length + 1)}`));
    let text;
    try {
      text = await readFile(join(MMS_ROOT, folder, 'SHA256SUMS'), 'utf8');
    } catch (e) {
      fail(`MISSING ${folder}/SHA256SUMS (${e.code ?? e.message})`);
      continue;
    }
    const own = new Set(parse(text, `${folder}/SHA256SUMS`).map(p => `${p.want}  ${p.path}`));
    for (const entry of own) {
      if (!pinned.has(entry)) fail(`NOT PINNED ${folder}/SHA256SUMS line '${entry}' is not in mms.SHA256SUMS`);
    }
    for (const entry of pinned) {
      if (!own.has(entry)) fail(`NOT LISTED mms.SHA256SUMS line '${entry}' is not in ${folder}/SHA256SUMS`);
    }
  }

  for (const { want, path } of pins) {
    let got;
    try {
      got = await hashFile(join(MMS_ROOT, path));
    } catch (e) {
      fail(`MISSING ${path} (${e.code ?? e.message})`);
      continue;
    }
    if (got !== want) fail(`MISMATCH ${path}: ${got}, pinned ${want}`);
  }
  console.log(bad
    ? `${bad} problem(s) against android/models/mms.SHA256SUMS.`
    : `All ${pins.length} MMS files match android/models/mms.SHA256SUMS.`);
  return bad ? 1 : 0;
}

if (verifyOnly) {
  const sums = await readFile(join(dest, 'SHA256SUMS'), 'utf8');
  let bad = 0;
  for (const line of sums.trim().split('\n')) {
    const [want, path] = line.split(/\s+/);
    const got = await hashFile(join(dest, path));
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
  if (!res.ok) {
    // The root listing must exist; a repo without an onnx/ folder may 404.
    if (dir === '' || res.status !== 404) {
      throw new Error(`Listing ${dir || '/'} failed: ${res.status}`);
    }
    continue;
  }
  for (const entry of await res.json()) {
    if (entry.lfs?.oid) published.set(entry.path, entry.lfs.oid);
  }
}

const lines = [];
for (const path of files) {
  process.stdout.write(`${path} … `);
  const res = await fetch(`${HF}/${repo}/resolve/${rev}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  await mkdir(dirname(join(dest, path)), { recursive: true });
  // Stream to disk while hashing, so the ~1 GB export never sits in memory.
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    res.body,
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    },
    createWriteStream(join(dest, path))
  );
  const got = hash.digest('hex');
  const want = published.get(path);
  if (want && want !== got) {
    await rm(join(dest, path));
    throw new Error(`${path}: hash ${got} does not match published ${want}`);
  }
  lines.push(`${got}  ${path}`);
  console.log(`${(size / 1e6).toFixed(1)} MB${want ? ', verified' : ''}`);
}

await writeFile(join(dest, 'SHA256SUMS'), lines.join('\n') + '\n');
await writeFile(join(dest, 'SOURCE.txt'), `${HF}/${repo}\nrevision ${rev}\n`);
console.log(`Wrote ${dest}`);
