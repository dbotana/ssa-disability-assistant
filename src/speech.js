// Spoken output: an utterance queue over pre-synthesized clips, the TTS API,
// and the browser's built-in synthesizer, in that order.
//
// The fallback chain is not a nicety. If the key is missing, the network
// drops, or the TTS call fails, a blind user must still hear the question —
// going silent is the one failure this app cannot have. Every layer added
// here therefore falls through to the one below it on any error at all.
//
// Most of what this app says is fixed text from schema.js and phrases.js,
// pre-synthesized into audio/ by tools/build-audio.mjs. Those clips cost
// nothing to play, work with no API key, and work offline.

import { synthesize } from './llm.js';
import { hashText } from './ttshash.js';

let current = null;          // { audio } | { utterance }
let queue = [];
let speaking = false;
let useFallback = false;
let voicePref = 'alloy';

// Hashes of the clips sitting in audio/. Empty until loadManifest() resolves,
// and empty forever if it fails — a missing manifest costs money, not speech.
let manifest = new Set();
let manifestReady = null;

const CACHE_NAME = 'tts-v1';

export function setVoice(v) { voicePref = v; }
export function forceFallback(on) { useFallback = !!on; }
export function isSpeaking() { return speaking; }

/**
 * Load the pre-synthesized clip index. Safe to call more than once; safe to
 * never call, since play() awaits it anyway.
 */
export function loadManifest() {
  manifestReady ??= fetch('audio/manifest.json', { cache: 'no-cache' })
    .then(res => (res.ok ? res.json() : null))
    .then(data => { manifest = new Set(data?.hashes ?? []); })
    .catch(() => { manifest = new Set(); });
  return manifestReady;
}

/**
 * Speak text. Resolves when playback finishes (or immediately if interrupted).
 * @param {object} opts
 * @param {boolean} opts.interrupt cancel anything currently playing
 */
export function speak(text, { interrupt = true } = {}) {
  if (!text) return Promise.resolve();
  if (interrupt) cancel();

  return new Promise(resolve => {
    queue.push({ text, resolve });
    if (!speaking) drain();
  });
}

async function drain() {
  speaking = true;
  while (queue.length) {
    const item = queue.shift();
    try {
      await play(item.text);
    } catch {
      try { await fallbackSpeak(item.text); } catch { /* nothing left to try */ }
    }
    item.resolve();
  }
  speaking = false;
}

/**
 * One utterance, cheapest source first.
 *
 * The pre-synthesized check deliberately runs before the useFallback guard.
 * useFallback means "the API is not usable" — no key, auth rejected, offline —
 * none of which stop a local mp3 from playing. Checking it first would hand a
 * key-free user robotic browser speech for questions we already have in the
 * real voice.
 */
async function play(text) {
  const key = await cacheKey(text);

  if (key && manifest.has(key)) {
    try { return await playUrl(`audio/${key}.mp3`); } catch { /* fall through */ }
  }

  if (key) {
    const hit = await cacheGet(key);
    if (hit) {
      try { return await playBuffer(hit); } catch { /* fall through */ }
    }
  }

  if (useFallback) return fallbackSpeak(text);

  let buffer;
  try {
    buffer = await synthesize(text, { voice: voicePref });
  } catch (err) {
    // An auth failure will not fix itself; stop paying the latency cost.
    if (err?.kind === 'auth' || err?.kind === 'network') useFallback = true;
    throw err;
  }

  if (key) cachePut(key, buffer);
  return playBuffer(buffer);
}

/** Hash for this utterance, or null when hashing is unavailable. */
async function cacheKey(text) {
  await loadManifest();
  try {
    return await hashText(text, voicePref);
  } catch {
    // crypto.subtle needs a secure context. On file:// there is no hashing,
    // no cache, and no manifest — just the paid path, which still works.
    return null;
  }
}

// -- runtime cache ---------------------------------------------------------
//
// Dynamic text — read-backs holding a user's answer, model-authored clarify
// prompts — is not in audio/, but the same user hears the same read-back every
// time they correct the same field. The Cache API stores the Response as-is,
// so there is no encoding step and no schema to version.

async function cacheGet(key) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(cacheUrl(key));
    return res ? await res.arrayBuffer() : null;
  } catch {
    return null;   // private mode, storage denied, no Cache API
  }
}

function cachePut(key, buffer) {
  try {
    caches.open(CACHE_NAME)
      .then(cache => cache.put(cacheUrl(key), new Response(buffer, {
        headers: { 'Content-Type': 'audio/mpeg' }
      })))
      .catch(() => { /* best effort */ });
  } catch { /* best effort */ }
}

const cacheUrl = key => `https://tts.local/${key}.mp3`;

// -- playback --------------------------------------------------------------

function playBuffer(buffer) {
  const blob = new Blob([buffer], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  return playUrl(url, url);
}

/**
 * @param {string} src what to play
 * @param {string|null} objectUrl revoke this when done, if we created one
 */
function playUrl(src, objectUrl = null) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(src);
    current = { audio, url: objectUrl };
    audio.onended = () => { cleanup(objectUrl); resolve(); };
    audio.onerror = () => { cleanup(objectUrl); reject(new Error('playback failed')); };
    audio.play().catch(err => { cleanup(objectUrl); reject(err); });
  });
}

function cleanup(url) {
  if (url) URL.revokeObjectURL(url);
  current = null;
}

function fallbackSpeak(text) {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) { reject(new Error('no speech synthesis')); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = () => { current = null; resolve(); };
    u.onerror = () => { current = null; resolve(); };  // never strand the queue
    current = { utterance: u };
    window.speechSynthesis.speak(u);
  });
}

/** Stop playback immediately and drop anything queued. */
export function cancel() {
  queue.forEach(item => item.resolve());
  queue = [];
  if (current?.audio) {
    current.audio.pause();
    if (current.url) URL.revokeObjectURL(current.url);
  }
  try { window.speechSynthesis?.cancel(); } catch { /* not available */ }
  current = null;
  speaking = false;
}
