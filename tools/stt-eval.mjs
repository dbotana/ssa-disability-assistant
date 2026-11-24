#!/usr/bin/env node
// Measure the committed speech model on recorded answers. Maintainer-only.
//
// Runs the model files the browser loads (models/whisper-base.en for English by
// default) over every WAV in tests/fixtures/speech/, then through the app's own
// cleanTranscript() -> parseLocal() -> normalize(), and compares the value
// that would be kept against expected.json. What matters is not whether the
// transcript is pretty but whether the right nine digits reach the form.
//
//   cd tools && npm install        once; installs transformers.js for Node
//   node tools/stt-eval.mjs [model] [language]   from the repository root
//   node tools/stt-eval.mjs whisper-base fr
//
// French and Lingala have no recordings in tests/fixtures/speech/, so this
// measures nothing for them: it says so and exits 2. No French or Lingala
// accuracy figure exists for this project.
//
// Not part of tests/: it needs onnxruntime-node, a native dependency the
// shipped app does not have and CI should not install. It makes no network
// requests: remote models are disabled, exactly as in the worker.
//
// The fixtures are synthetic (macOS `say`) and use the non-issuable SSNs
// 987-65-4320 through 4329. Add real recordings of real voices before
// trusting a number from this — but never of a real SSN.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGES } from '../src/i18n/languages.js';
import { PIPELINE_OPTIONS, asrOptions, readWav, loadIsFiller, keptValue } from './stt-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'speech');
const MODEL = process.argv[2] ?? 'whisper-base.en';
const LANG = process.argv[3] ?? 'en';
if (!LANGUAGES[LANG]) { console.error(`Unknown language ${LANG}.`); process.exit(2); }
const MULTILINGUAL = !MODEL.endsWith('.en');
if (!MULTILINGUAL && LANG !== 'en') {
  console.error(`${MODEL} is English-only and cannot transcribe ${LANG}.`);
  process.exit(2);
}
const ASR_OPTS = asrOptions(MODEL, LANG);

const expected = JSON.parse(await readFile(join(FIXTURES, 'expected.json'), 'utf8'));
// English fixtures have no prefix, and none starts with fr-/ln-.
const all = (await readdir(FIXTURES)).filter(f => f.endsWith('.wav')).sort();
const files = LANG === 'en' ? all : all.filter(f => f.startsWith(`${LANG}-`));
// Checked before the FILLER read and the transformers import, so a language
// with no recordings says so in every environment instead of failing later.
if (!files.length) {
  console.log(`No recordings in ${LANG}: tests/fixtures/speech/ holds English clips only.`);
  console.log(`Nothing was measured. Add ${LANG}-*.wav files with expected.json entries first.`);
  process.exit(2);
}

// What the app refuses as silence-filler, read from turn.js so the two cannot
// drift. There it only applies when the microphone also stayed quiet; every
// fixture that expects null is a silent one, so here it always applies.
const isFiller = await loadIsFiller(ROOT);
if (!isFiller) { console.error('Could not find FILLER_TRANSCRIPTS in src/turn.js'); process.exit(2); }

// Resolved from tools/node_modules, because this file lives in tools/.
let transformers;
try {
  transformers = await import('@huggingface/transformers');
} catch {
  console.error('transformers.js is not installed for Node. Run: cd tools && npm install');
  process.exit(2);
}
const { pipeline, env } = transformers;
env.allowRemoteModels = false;
env.localModelPath = join(ROOT, 'models') + '/';

let t0 = performance.now();
const asr = await pipeline('automatic-speech-recognition', MODEL, { ...PIPELINE_OPTIONS });
console.log(`${MODEL} (${LANG}): loaded in ${Math.round(performance.now() - t0)} ms\n`);

let pass = 0;
const times = [];
for (const file of files) {
  const name = file.replace(/\.wav$/, '');
  const want = expected[name];
  if (!want) { console.log(`SKIP ${name} (no entry in expected.json)`); continue; }

  const audio = readWav(await readFile(join(FIXTURES, file)));
  t0 = performance.now();
  const { text } = await asr(audio, ASR_OPTS);
  const ms = performance.now() - t0;
  times.push(ms);

  const { heard, value: got } = keptValue({ name, type: want.type, text, lang: LANG, isFiller });
  const ok = got === want.value;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(14)} ${String(Math.round(ms)).padStart(5)} ms  `
    + `heard ${JSON.stringify(heard)} -> ${JSON.stringify(got)}${ok ? '' : `, wanted ${JSON.stringify(want.value)}`}`);
}

times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)] ?? 0;
console.log(`\n${pass}/${times.length} kept the right value. Median ${Math.round(median)} ms per clip.`);
// Disposed before exiting: onnxruntime-node aborts on a mutex if its threads
// are still alive when the process tears down.
await asr.dispose();
process.exitCode = pass === times.length ? 0 : 1;
