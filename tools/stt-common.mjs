// Speech-evaluation helpers shared by tools/stt-eval.mjs and
// tools/golden/models.mjs, so the Whisper golden's "kept" value is computed
// by exactly the steps the evaluation prints. Maintainer-only; no network.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cleanTranscript } from '../src/localstt.js';
import { parseLocal } from '../src/parse.js';
import { normalize } from '../src/validate.js';

/** The options both tools load the ASR pipeline with. */
export const PIPELINE_OPTIONS = Object.freeze({ dtype: 'q8' });

/** The options passed with each clip. */
export function asrOptions(model, lang) {
  return model.endsWith('.en')
    ? { chunk_length_s: 30 }
    : { language: lang, task: 'transcribe', chunk_length_s: 30 };
}

/** 16-bit PCM WAV -> Float32Array. The fixtures are mono 16 kHz already. */
export function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV file');
  let off = 12;
  let rate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(off + 12);
    if (id === 'data') {
      if (rate !== 16000) throw new Error(`expected 16 kHz, got ${rate}`);
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + off + 8, buf.byteOffset + off + 8 + size));
      return Float32Array.from(pcm, v => v / 32768);
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('no data chunk');
}

/**
 * What the app refuses as silence-filler, read from src/turn.js so the two
 * cannot drift. Returns null when FILLER_TRANSCRIPTS cannot be found.
 */
export async function loadIsFiller(root) {
  const src = await readFile(join(root, 'src', 'turn.js'), 'utf8');
  const m = src.match(/const FILLER_TRANSCRIPTS = new Set\((\[[\s\S]*?\])\);/);
  if (!m) return null;
  const filler = new Set(JSON.parse(m[1].replace(/'/g, '"')));
  return s => filler.has(s.toLowerCase().replace(/[.!?,\s]+$/, '').trim());
}

/** cleanTranscript -> filler -> parseLocal -> normalize: the value kept. */
export function keptValue({ name, type, text, lang, isFiller, now }) {
  const heard = cleanTranscript(text);
  const question = { id: name, type, confirm: true };
  const local = heard && !isFiller(heard) ? parseLocal(question, heard, { lang, now }) : null;
  const result = local ? normalize(local, question) : null;
  const value = result && !result.needsClarification ? result.value : null;
  return { heard, value };
}
