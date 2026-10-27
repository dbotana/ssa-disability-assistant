// Speech to text without leaving the device.
//
// This replaces two things upstream had: the OpenAI transcription call, which
// uploaded every recording, and the browser's SpeechRecognition, which Chrome
// streams to Google and Safari to Apple. Either one sent a spoken Social
// Security number to a third party. Here the recording is decoded in the page
// and handed to Whisper running in a worker (whisper-worker.js).
//
// Every promise this module returns settles. A blind user left waiting on a
// turn that silently died has no prompt, no error, and no way to know.

import { sttFor } from './i18n/index.js';

const TARGET_RATE = 16000;           // what Whisper was trained on
const LOAD_TIMEOUT_MS = 180000;      // slow disk, slow CPU, first compile
const TRANSCRIBE_TIMEOUT_MS = 90000; // a 60 s digit capture on a slow machine

export class SttError extends Error {
  constructor(message, { kind = 'unknown' } = {}) {
    super(message);
    this.kind = kind;   // empty | model | unsupported | unavailable | unknown
  }
}

let worker = null;
const readyByModel = new Map();
let nextId = 1;
let onProgress = null;
const waiting = new Map();

const UNAVAILABLE = 'Voice answers in this language need a speech model that is not installed on this computer. '
  + 'You can type your answers.';

const packFor = (lang = 'en') => sttFor(lang);

/** Can voice answers in this language work with the models on disk? */
export function available(lang = 'en') {
  return !!packFor(lang).installed;
}

function packFields(lang) {
  const pack = packFor(lang);
  return { model: pack.model, language: pack.language, multilingual: pack.multilingual };
}

/** Can this browser run the local model at all? */
export function isSupported() {
  return typeof Worker !== 'undefined'
    && typeof WebAssembly !== 'undefined'
    && offlineContextClass() !== null;
}

function offlineContextClass() {
  return globalThis.OfflineAudioContext ?? globalThis.webkitOfflineAudioContext ?? null;
}

function failAll(err) {
  for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(err); }
  waiting.clear();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./whisper-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data?.type === 'progress') { try { onProgress?.(data); } catch { /* UI only */ } return; }
    const entry = waiting.get(data?.id);
    if (!entry) return;   // answered after it timed out
    waiting.delete(data.id);
    clearTimeout(entry.timer);
    if (data.type === 'error') entry.reject(new SttError(data.message, { kind: data.kind ?? 'unknown' }));
    else entry.resolve(data);
  };
  // The worker script itself failed: a missing vendor file, a browser that
  // cannot run module workers. Nothing queued will ever be answered.
  worker.onerror = e => {
    e?.preventDefault?.();
    failAll(new SttError('The speech model could not start.', { kind: 'model' }));
    worker?.terminate();
    worker = null;
    readyByModel.clear();
  };
  return worker;
}

function call(message, { transfer = [], timeoutMs }) {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new SttError('The speech model took too long.', {
        kind: message.type === 'load' ? 'model' : 'unknown'
      }));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    w.postMessage({ ...message, id }, transfer);
  });
}

/**
 * Start the model a language needs and resolve when it is ready. Safe to call
 * repeatedly; a failed load is forgotten so the next call tries again.
 *
 * A language whose pack is not on disk rejects at once with `unavailable`,
 * before a worker is even created: no model, no network, no waiting.
 *
 * @param {(p:{file:string, loaded:number, total:number}) => void} progress
 * @param {string} lang the input channel's language
 */
export function load(progress = null, lang = 'en') {
  if (progress) onProgress = progress;
  const pack = packFor(lang);
  if (!pack.installed) {
    return Promise.reject(new SttError(UNAVAILABLE, { kind: 'unavailable' }));
  }
  if (!isSupported()) {
    return Promise.reject(new SttError('This browser cannot run the speech model.', { kind: 'unsupported' }));
  }
  if (!readyByModel.has(pack.model)) {
    const pending = call({ type: 'load', ...packFields(lang) }, { timeoutMs: LOAD_TIMEOUT_MS })
      .catch(err => { readyByModel.delete(pack.model); throw err; });
    readyByModel.set(pack.model, pending);
  }
  return readyByModel.get(pack.model);
}

/**
 * Recorder output (webm/opus in Chrome, mp4/aac in Safari) to mono 16 kHz.
 *
 * decodeAudioData resamples to its context's rate, so decoding in a 16 kHz
 * offline context does the resampling as well. Channels are averaged by hand;
 * a microphone is mono in practice, but a headset can report two.
 */
export async function toPcm16k(blob) {
  const Offline = offlineContextClass();
  const ctx = new Offline(1, TARGET_RATE, TARGET_RATE);
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const out = new Float32Array(decoded.length);
  const n = decoded.numberOfChannels;
  for (let c = 0; c < n; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i] / n;
  }
  return out;
}

// Whisper's way of transcribing something that is not speech: [BLANK_AUDIO],
// (silence), [Music], (coughs). None of it is ever part of an answer. A
// parenthetical that holds digits — "(207)" — is a spoken number the
// transcriber grouped, not an annotation, and must survive.
const NON_SPEECH = /\[[^\]]*\]|\([^0-9)]*\)/g;

/** Strip non-speech annotations and collapse whitespace. */
export function cleanTranscript(text) {
  return String(text ?? '').replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
}

/** Transcribe one captured answer. Rejects with an SttError. */
export async function transcribe(blob, lang = 'en') {
  if (!blob?.size) throw new SttError('I did not hear anything.', { kind: 'empty' });
  await load(null, lang);

  let audio;
  try {
    audio = await toPcm16k(blob);
  } catch {
    throw new SttError('That recording could not be read.', { kind: 'unknown' });
  }
  if (!audio.length) throw new SttError('I did not hear anything.', { kind: 'empty' });

  const { text } = await call(
    { type: 'transcribe', ...packFields(lang), audio },
    { transfer: [audio.buffer], timeoutMs: TRANSCRIBE_TIMEOUT_MS }
  );
  const clean = cleanTranscript(text);
  if (!clean) throw new SttError('I did not hear anything.', { kind: 'empty' });
  return clean;
}
