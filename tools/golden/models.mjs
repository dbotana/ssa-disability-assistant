#!/usr/bin/env node
// The Whisper reference golden: what transformers.js 3.8.1 and
// onnxruntime-node 1.21.0 produce from models/whisper-base.en, recorded so the
// `:models` module of the Android and iOS ports can be checked against it.
//
//   node tools/golden/models.mjs              writes the golden
//   node tools/golden/models.mjs --check      compares with the committed one
//   node tools/golden/models.mjs --check FILE compares with FILE
//
// Exit codes: 0 the golden was written, or the checked one is fresh; 1 the
// checked golden is stale or missing; 2 tools/node_modules is missing or holds
// the wrong version; 3 a generator assertion failed or the arguments were
// wrong. It loads the model from models/, exactly as the app does, and makes no
// network requests: remote models are disabled. The golden is generated, never
// edited by hand.
//
// Not in check.mjs or tests/: onnxruntime-node is a native dependency the
// shipped app does not have and CI should not install. Run it when the model,
// the pinned runtime, or the reference's decoding changes, and commit what it
// writes.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PIPELINE_OPTIONS, asrOptions, readWav, loadIsFiller, keptValue } from '../stt-common.mjs';

// Generated in UTC whatever the machine's timezone, as tools/golden/index.mjs
// is: a fixed "now" passed to parseLocal must mean the same instant everywhere,
// and CI runs in UTC. Node applies a TZ assigned at runtime to every Date made
// after it.
process.env.TZ = 'UTC';
if (new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset() !== 0) {
  throw new Error('whisper golden generator: could not switch to UTC');
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLS = join(ROOT, 'tools');
const MODEL = 'whisper-base.en';
const MODEL_DIR = join(ROOT, 'models', MODEL);
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'speech');
const DEST = join(ROOT, 'android', 'models', 'src', 'commonTest', 'resources', 'golden', 'whisper.json');
// A fixed "today", the same instant tools/golden/index.mjs uses.
const NOW = () => new Date(Date.UTC(2026, 8, 19, 12, 0, 0));

// The versions the golden was recorded with. A different runtime may lay the
// graph out differently or decode differently, so the golden refuses to speak
// for it.
const TRANSFORMERS_VERSION = '3.8.1';
const ONNXRUNTIME_NODE_VERSION = '1.21.0';

/** A generator assertion, as opposed to a bug or a missing package. */
class GeneratorError extends Error {}

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/**
 * A float array as base64: little-endian IEEE 754, `dims` row-major. Exact,
 * and about a third of the size the same values take as decimal text.
 */
function pack(values, dtype, dims) {
  const count = dims.reduce((a, b) => a * b, 1);
  if (count !== values.length) {
    throw new GeneratorError(`pack: ${dims.join('x')} needs ${count} values, got ${values.length}`);
  }
  const bytes = dtype === 'float32' ? 4 : 8;
  const buf = Buffer.alloc(count * bytes);
  for (let i = 0; i < count; i++) {
    const v = values[i];
    if (typeof v !== 'number') throw new GeneratorError(`pack: value ${i} is ${typeof v}, not a number`);
    if (bytes === 4) buf.writeFloatLE(v, i * 4);
    else buf.writeDoubleLE(v, i * 8);
  }
  return { dtype, dims, byteOrder: 'little-endian', base64: buf.toString('base64') };
}

/** Not installed or the wrong version: exit 2, not a generator failure. */
class NotFound extends Error {}

/** The package.json version of an installed package, or exit 2's reason. */
function installedVersion(name) {
  try {
    return JSON.parse(readFileSync(join(TOOLS, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    throw new NotFound(`${name} is not installed in tools/node_modules.`);
  }
}

const USAGE = [
  'usage: node tools/golden/models.mjs                 write android/models/src/commonTest/resources/golden/whisper.json',
  '       node tools/golden/models.mjs --check [file]   compare (default: the committed golden)'
].join('\n');

/**
 * GPT-2's byte encoder: the character each byte is written as in the vocabulary
 * file. Whisper's tokenizer is byte-level BPE, so a non-ASCII character is
 * several tokens, one per UTF-8 byte, and a character cut in half decodes to
 * U+FFFD.
 */
function byteChars() {
  const bs = [];
  for (let b = 0x21; b <= 0x7e; b++) bs.push(b);
  for (let b = 0xa1; b <= 0xac; b++) bs.push(b);
  for (let b = 0xae; b <= 0xff; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  const map = new Array(256);
  bs.forEach((b, i) => { map[b] = String.fromCodePoint(cs[i]); });
  return map;
}

/** The JSON paths where two parsed trees differ, at most `limit` of them. */
function diffPaths(a, b, path = '', out = [], limit = 10) {
  if (out.length >= limit) return out;
  const at = path || '(root)';
  const isObj = v => v !== null && typeof v === 'object';
  if (!isObj(a) || !isObj(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at);
    return out;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(at); return out; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${at} (${a.length} vs ${b.length} entries)`);
    for (let i = 0; i < Math.min(a.length, b.length) && out.length < limit; i++) {
      diffPaths(a[i], b[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (out.length >= limit) break;
    const next = path ? `${path}.${key}` : key;
    if (!(key in a) || !(key in b)) out.push(next);
    else diffPaths(a[key], b[key], next, out, limit);
  }
  return out;
}

/** `main()` returns the process exit code. */
async function main() {
  const argv = process.argv.slice(2);
  let checking = false;
  let checkPath = DEST;
  if (argv.length) {
    if (argv[0] !== '--check' || argv.length > 2) {
      console.error(USAGE);
      return 3;
    }
    checking = true;
    checkPath = argv[1] ?? DEST;
  }

  // 1. transformers.js, from tools/node_modules because this file lives below tools/.
  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    console.error('transformers.js is not installed for Node. Run: cd tools && npm install');
    return 2;
  }
  const { pipeline, env } = transformers;
  let tfVersion;
  let ortVersion;
  try {
    tfVersion = installedVersion('@huggingface/transformers');
    ortVersion = installedVersion('onnxruntime-node');
  } catch (err) {
    if (!(err instanceof NotFound)) throw err;
    console.error(`${err.message} Run: cd tools && npm install`);
    return 2;
  }
  if (tfVersion !== TRANSFORMERS_VERSION) {
    console.error(`tools/node_modules has transformers.js ${tfVersion}; this golden is for ${TRANSFORMERS_VERSION}. Run: cd tools && npm install`);
    return 2;
  }
  if (ortVersion !== ONNXRUNTIME_NODE_VERSION) {
    console.error(`tools/node_modules has onnxruntime-node ${ortVersion}; this golden is for ${ONNXRUNTIME_NODE_VERSION}. Run: cd tools && npm install`);
    return 2;
  }

  // 2. The model files must be the ones SHA256SUMS pins.
  const files = {};
  for (const line of readFileSync(join(MODEL_DIR, 'SHA256SUMS'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = line.trim().match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (!m) {
      throw new GeneratorError(`models/${MODEL}/SHA256SUMS has a line this script cannot read: ${JSON.stringify(line)}\nRun: node tools/fetch-model.mjs --verify`);
    }
    const [, hash, name] = m;
    const actual = sha256(readFileSync(join(MODEL_DIR, name)));
    if (actual !== hash) {
      throw new GeneratorError(`models/${MODEL}/${name} is not the file SHA256SUMS pins (${actual}).\nRun: node tools/fetch-model.mjs --verify`);
    }
    files[name] = hash;
  }
  if (!Object.keys(files).length) throw new GeneratorError(`models/${MODEL}/SHA256SUMS lists no files`);

  // 3. Observe session creation, before the pipeline makes any. transformers.js's
  //    backend takes InferenceSession from this same module object, so replacing
  //    create here records every session it opens.
  const ortModule = await import('onnxruntime-node');
  const ort = ortModule.default ?? ortModule;
  const created = [];
  const originalCreate = ort.InferenceSession.create;
  Object.defineProperty(ort.InferenceSession, 'create', {
    configurable: true, writable: true,
    value: async function (...args) {
      const options = JSON.parse(JSON.stringify(args[1] ?? {}));
      const session = await originalCreate.apply(this, args);
      created.push({ source: args[0], options, session });
      return session;
    }
  });

  // 4. Load the pipeline from models/, as the app loads it.
  env.allowRemoteModels = false;
  env.localModelPath = join(ROOT, 'models') + '/';
  const asr = await pipeline('automatic-speech-recognition', MODEL, { ...PIPELINE_OPTIONS });

  let golden;
  try {
    // 5. The ONNX sessions: which file each one is, and how it was opened.
    if (created.length !== 2) {
      throw new GeneratorError(`expected 2 ONNX sessions, transformers.js created ${created.length}`);
    }
    const sessions = {};
    for (const key of Object.keys(asr.model.sessions).sort()) {
      const session = asr.model.sessions[key];
      const rec = created.find(c => c.session === session);
      if (!rec) throw new GeneratorError(`the ${key} session was not created through InferenceSession.create`);
      let file = null;
      if (typeof rec.source === 'string') {
        file = relative(MODEL_DIR, rec.source).split(sep).join('/');
        if (file.startsWith('..')) throw new GeneratorError(`the ${key} session was opened from ${rec.source}, outside models/${MODEL}`);
      }
      sessions[key] = {
        file,
        options: rec.options,
        config: JSON.parse(JSON.stringify(session.config ?? null)),
        inputNames: [...session.inputNames],
        outputNames: [...session.outputNames]
      };
    }

    // 6. The feature extractor: the mel filter bank and the Hann window, so the
    //    port's own front end is checked against the one that made the features.
    const fe = asr.processor.feature_extractor;
    const config = {};
    for (const key of ['sampling_rate', 'n_fft', 'hop_length', 'chunk_length', 'n_samples', 'nb_max_frames', 'feature_size']) {
      config[key] = fe.config[key];
    }
    const window = pack(fe.window, 'float64', [fe.window.length]);
    if (fe.window.length !== config.n_fft) {
      throw new GeneratorError(`the window has ${fe.window.length} values, n_fft is ${config.n_fft}`);
    }
    const rows = config.feature_size;
    const cols = config.n_fft / 2 + 1;
    const mel = fe.config.mel_filters;
    if (!Array.isArray(mel) || mel.length !== rows || mel.some(r => r.length !== cols)) {
      throw new GeneratorError(`mel_filters is not ${rows} rows of ${cols} values`);
    }
    const melFlat = [];
    for (const row of mel) for (const v of row) melFlat.push(v);
    const melFilters = pack(melFlat, 'float64', [rows, cols]);

    // 7. The decoding facts: the prompt, the ids that matter, and what the
    //    tokenizer skips.
    const gc = asr.model._prepare_generation_config(null, {});
    const prompt = asr.model._retrieve_init_tokens(gc).map(Number);
    const specialIds = [...new Set(asr.tokenizer.all_special_ids)].map(Number).sort((a, b) => a - b);
    const tokensToIds = asr.tokenizer.model.tokens_to_ids;
    const skippedIds = [];
    for (const t of asr.tokenizer.special_tokens) {
      const id = tokensToIds.get(t);
      if (id === undefined) throw new GeneratorError(`the tokenizer has no id for the special token ${JSON.stringify(t)}`);
      skippedIds.push(Number(id));
    }
    const uniqueSkipped = [...new Set(skippedIds)].sort((a, b) => a - b);
    const decoding = {
      prompt,
      decoderStartTokenId: Number(gc.decoder_start_token_id),
      noTimestampsTokenId: Number(gc.no_timestamps_token_id),
      eosTokenId: Number(gc.eos_token_id),
      maxLength: Number(gc.max_length),
      beginSuppressTokens: (gc.begin_suppress_tokens ?? []).map(Number),
      suppressTokens: (gc.suppress_tokens ?? []).map(Number),
      specialIds,
      skippedIds: uniqueSkipped,
      cleanUpTokenizationSpaces: asr.tokenizer.clean_up_tokenization_spaces
    };

    // 8. Observe generate, so the feature tensor the decoder actually saw and
    //    the ids it returned are recorded rather than guessed.
    const calls = [];
    const originalGenerate = asr.model.generate.bind(asr.model);
    asr.model.generate = async (args) => {
      const out = await originalGenerate(args);
      calls.push({ args, out });
      return out;
    };

    // 9. Every fixture clip: its features, the ids generate returned, the
    //    transcript, and the value tools/stt-eval.mjs would keep.
    const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8'));
    const wavs = readdirSync(FIXTURES).filter(f => f.endsWith('.wav')).sort();
    const isFiller = await loadIsFiller(ROOT);
    if (!isFiller) throw new GeneratorError('could not find FILLER_TRANSCRIPTS in src/turn.js');

    const clips = [];
    let keptRight = 0;
    for (const file of wavs) {
      const name = file.replace(/\.wav$/, '');
      const want = expected[name];
      if (!want) throw new GeneratorError(`${file} has no entry in tests/fixtures/speech/expected.json`);

      const buf = readFileSync(join(FIXTURES, file));
      const samples = readWav(buf);
      calls.length = 0;
      const { text } = await asr(samples, asrOptions(MODEL, 'en'));
      if (calls.length !== 1) {
        throw new GeneratorError(`${file} ran generate ${calls.length} times; a clip over 30 s would chunk, which this golden does not cover`);
      }

      const { args, out } = calls[0];
      const inputs = args.inputs;
      const wanted = [1, config.feature_size, config.nb_max_frames];
      if (inputs.type !== 'float32' || wanted.some((v, i) => inputs.dims[i] !== v) || inputs.dims.length !== 3) {
        throw new GeneratorError(`${file}: input_features is ${inputs.type} ${JSON.stringify(inputs.dims)}, expected float32 ${JSON.stringify(wanted)}`);
      }
      const generateArgs = {};
      for (const key of Object.keys(args).sort()) {
        if (key === 'inputs') continue;
        const v = args[key];
        const t = typeof v;
        if (v !== null && t !== 'number' && t !== 'string' && t !== 'boolean') {
          throw new GeneratorError(`${file}: generate got ${key} of type ${t}, which this golden cannot record`);
        }
        generateArgs[key] = v;
      }
      const ids = Array.from(out.data, Number);
      if (out.dims.length !== 2 || out.dims[0] !== 1) {
        throw new GeneratorError(`${file}: generate returned dims ${JSON.stringify(out.dims)}, expected [1, n]`);
      }

      const promptMatches = prompt.every((id, i) => ids[i] === id);
      if (!promptMatches) {
        throw new GeneratorError(`${file}: ids ${JSON.stringify(ids.slice(0, prompt.length))} do not start with the prompt ${JSON.stringify(prompt)}`);
      }
      const stoppedAt = ids.at(-1) === decoding.eosTokenId ? 'eos'
        : ids.length >= decoding.maxLength ? 'max_length'
        : 'other';
      const decoded = asr.tokenizer.decode(ids, { skip_special_tokens: true });
      if (decoded !== text) {
        throw new GeneratorError(`${file}: decoding the ids gives ${JSON.stringify(decoded)}, the pipeline returned ${JSON.stringify(text)}`);
      }

      const { heard, value } = keptValue({ name, type: want.type, text, lang: 'en', isFiller, now: NOW });
      if (value === want.value) keptRight++;

      const melCount = inputs.dims[1];
      const frames = inputs.dims[2];
      const frameSum = new Array(frames).fill(0);
      const frameMax = new Array(frames).fill(-Infinity);
      for (let m = 0; m < melCount; m++) {
        for (let f = 0; f < frames; f++) {
          const v = inputs.data[m * frames + f];
          frameSum[f] += v;
          if (v > frameMax[f]) frameMax[f] = v;
        }
      }
      const features = {
        dims: [...inputs.dims],
        frameSum: pack(frameSum, 'float64', [frames]),
        frameMax: pack(frameMax, 'float32', [frames])
      };
      // One whole feature tensor, so the port's front end can be compared value
      // by value and not only through the two summaries above.
      if (name === 'yes') features.matrix = pack(inputs.data, 'float32', [...inputs.dims]);

      clips.push({
        name, file, sha256: sha256(buf), sampleCount: samples.length,
        generateArgs, features, ids, stoppedAt, text, clean: heard, kept: value
      });
      console.log(`${name.padEnd(14)} ${ids.length} ids, ${stoppedAt}, text ${JSON.stringify(text)} -> kept ${JSON.stringify(value)}`);
    }
    if (!clips.some(c => c.name === 'yes')) {
      throw new GeneratorError('no clip named yes: features.matrix would be missing');
    }
    console.log(`${keptRight}/${clips.length} kept the expected.json value`);

    // 10. Decode cases: the tokenizer paths that matter, in a fixed order. A
    //     byte-level tokenizer turns one character into several tokens, so a
    //     character split across tokens is where ports go wrong.
    const enc = s => asr.tokenizer.encode(s, { add_special_tokens: false }).map(Number);
    const vocab = JSON.parse(readFileSync(join(MODEL_DIR, 'tokenizer.json'), 'utf8')).model.vocab;
    const charOf = byteChars();
    const byteIds = ch => [...Buffer.from(ch, 'utf8')].map(b => {
      const id = vocab[charOf[b]];
      if (id === undefined) throw new GeneratorError(`the vocabulary has no token for byte 0x${b.toString(16)} of ${JSON.stringify(ch)}`);
      return Number(id);
    });
    const SOT = decoding.decoderStartTokenId;
    const EOT = decoding.eosTokenId;
    const NOTS = decoding.noTimestampsTokenId;
    const TS0 = tokensToIds.get('<|0.00|>');
    const TS1 = tokensToIds.get('<|0.02|>');
    if (TS0 === undefined || TS1 === undefined) {
      throw new GeneratorError('the vocabulary has no timestamp token <|0.00|> or <|0.02|>');
    }

    const cases = [
      ['special only', [SOT, NOTS, EOT]],
      ['prompt, text, end', [SOT, NOTS, ...enc(' Yes.'), EOT]],
      ['every skipped id', uniqueSkipped],
      ['timestamp tokens are not special', [SOT, TS0, ...enc(' Hello'), TS1, EOT]],
      ['leading space', enc(' Maine Medical Center in Portland.')],
      ['no leading space', enc('Yes')],
      ['two spaces', enc('  two  spaces')],
      ['newline', enc(' one\ntwo')],
      ['digits dashed', enc(' 987-65-4321')],
      ['digits grouped', enc(' (207) 555-0142')],
      ['long digits', enc(' 0123456789 2075550142')],
      ['clean-up spaces', enc(" Yes , I do n't know . It 's 5 ! Really ?")],
      ['é merged', enc(' café')],
      ['é split', [...enc(' caf'), ...byteIds('é')], { text: ' café' }],
      ['ɛ split', [...enc(' kop'), ...byteIds('ɛ'), ...enc('t'), ...byteIds('ɛ')], { text: ' kopɛtɛ' }],
      ['ɔ split', [...enc(' mb'), ...byteIds('ɔ'), ...enc('k'), ...byteIds('ɔ')], { text: ' mbɔkɔ' }],
      ['combining tone mark split', [...enc(' B'), ...byteIds('ɔ'), ...enc('k'), ...byteIds('ɔ'), ...byteIds('\u0301')], { text: ' Bɔkɔ\u0301' }],
      ['Lingala as encoded', enc(' Nakoki kopɛsa yɔ́ mbɔ́tɛ.')],
      ['truncated é', [...enc(' caf'), byteIds('é')[0]], { endsWith: '\uFFFD' }],
      ['emoji', enc(' 👍')]
    ];
    const decodeCases = cases.map(([name, ids, check]) => {
      const text = asr.tokenizer.decode(ids, { skip_special_tokens: true });
      if (check?.text !== undefined && text !== check.text) {
        throw new GeneratorError(`decode case ${JSON.stringify(name)}: ${JSON.stringify(text)}, expected ${JSON.stringify(check.text)}`);
      }
      if (check?.endsWith !== undefined && !text.endsWith(check.endsWith)) {
        throw new GeneratorError(`decode case ${JSON.stringify(name)}: ${JSON.stringify(text)} does not end with ${JSON.stringify(check.endsWith)}`);
      }
      if (check !== undefined && !ids.some(id => asr.tokenizer.decode([id], { skip_special_tokens: true }).includes('\uFFFD'))) {
        throw new GeneratorError(`decode case ${JSON.stringify(name)}: no single token decodes to U+FFFD, so nothing is split`);
      }
      return { name, ids, text };
    });

    // 11. Assemble, in a fixed key order.
    golden = {
      generator: 'tools/golden/models.mjs',
      reference: {
        transformers: tfVersion,
        onnxruntimeNode: ortVersion,
        platform: `${process.platform}-${process.arch}`
      },
      now: NOW().toISOString(),
      model: { name: MODEL, dtype: PIPELINE_OPTIONS.dtype, files },
      sessions,
      features: { config, window, melFilters },
      decoding,
      clips,
      decodeCases,
      notes: [
        'Generated by tools/golden/models.mjs from transformers.js and onnxruntime-node; never edit by hand.',
        'Packed arrays are little-endian IEEE 754, base64; dims are row-major.',
        'features.matrix (yes only) is the input_features tensor the pipeline passed to generate: index = mel * frames + frame.',
        "frameSum is the float64 sum of a frame's mel values in mel order; frameMax is their maximum.",
        'ids are the sequence generate returned, prompt included.',
        'text is the pipeline output; decoding ids with skip_special_tokens gives the same string.',
        'kept is the value tools/stt-eval.mjs would keep (cleanTranscript, the filler rule, parseLocal with `now`, normalize).',
        'decoding.suppressTokens is listed in generation_config.json; transformers.js 3.8.1 does not apply it (its _get_logits_processor comments it out).'
      ]
    };
  } finally {
    // onnxruntime-node aborts if its sessions are alive at exit.
    await asr.dispose();
  }

  const text = JSON.stringify(golden, null, 2) + '\n';
  if (text.includes(ROOT)) {
    throw new GeneratorError('the golden would contain an absolute path, which must never be committed');
  }

  if (!checking) {
    mkdirSync(dirname(DEST), { recursive: true });
    writeFileSync(DEST, text);
    console.log(`golden whisper.json (${Buffer.byteLength(text)} bytes)`);
    return 0;
  }

  if (!existsSync(checkPath)) {
    console.log(`whisper golden missing: ${checkPath}`);
    return 1;
  }
  const stored = readFileSync(checkPath);
  if (Buffer.from(text).equals(stored)) {
    console.log(`whisper golden fresh (${Buffer.byteLength(text)} bytes)`);
    return 0;
  }

  // Another CPU may legitimately pick different ids; say so before the diff.
  try {
    const before = JSON.parse(stored.toString('utf8')).reference?.platform;
    if (before !== `${process.platform}-${process.arch}`) {
      console.error(`note: the golden was recorded on ${before}, this machine is ${process.platform}-${process.arch}; token ids may legitimately differ`);
    }
  } catch {
    // not JSON: reported below
  }

  console.log(`whisper golden is stale: ${checkPath}`);
  let parsed = null;
  try {
    parsed = JSON.parse(stored.toString('utf8'));
  } catch {
    console.error('  stored: not JSON');
  }
  if (parsed !== null) {
    const differing = diffPaths(parsed, JSON.parse(text));
    if (differing.length) for (const p of differing) console.error(`  differs at ${p}`);
    else console.error('  same JSON, different bytes');
  }
  return 1;
}

process.exitCode = await main().catch(err => {
  console.error(err instanceof GeneratorError ? `models.mjs: ${err.message}` : err);
  return 3;
});
