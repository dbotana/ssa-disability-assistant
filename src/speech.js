// Spoken output: an utterance queue over pre-synthesized clips and the
// operating system's own voices, in that order.
//
// Going silent is the one failure this app cannot have — a blind user must
// still hear the question — so every layer falls through to the one below it
// on any error at all. The last layer is the live region: announce() in
// a11y.js puts the same text where a screen reader will read it.
//
// Most of what this app says is fixed text from schema.js and phrases.js,
// pre-synthesized into audio/ by tools/build-audio.mjs. Those clips are
// static files; playing one sends nothing anywhere.
//
// Everything else — read-backs holding a user's answer, spoken digit by digit
// for an SSN — goes to speechSynthesis, and only with a voice the browser
// reports as localService. That restriction is the point: Chrome lists
// "Google US English" and friends alongside the system voices, and those are
// synthesized on Google's servers. Handing one a Social Security number would
// undo everything else this fork does. Upstream also sent these read-backs to
// the OpenAI TTS API and kept the audio in Cache Storage; both are gone.

import { hashText, VOICE } from './ttshash.js';

let current = null;          // { audio } | { utterance }
let queue = [];
let speaking = false;

// Hashes of the clips sitting in audio/. Empty until loadManifest() resolves,
// and empty forever if it fails — a missing manifest costs polish, not speech.
let manifest = new Set();
let manifestReady = null;

// Upstream cached synthesized read-backs, which contain users' answers, in
// Cache Storage under this name. Anyone who ran that version on this origin
// may still have it; remove it.
try { globalThis.caches?.delete('tts-v1').catch(() => {}); } catch { /* no Cache API */ }

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
    } catch { /* nothing left to try; the live region still has the text */ }
    item.resolve();
  }
  speaking = false;
}

/** One utterance: the recorded clip if there is one, else a local voice. */
async function play(text) {
  const key = await clipKey(text);
  if (key && manifest.has(key)) {
    try { return await playUrl(`audio/${key}.mp3`); } catch { /* fall through */ }
  }
  return localSpeak(text);
}

/** Hash for this utterance, or null when hashing is unavailable. */
async function clipKey(text) {
  await loadManifest();
  try {
    return await hashText(text, VOICE);
  } catch {
    // crypto.subtle needs a secure context. Without it there is no clip
    // lookup, and everything is spoken by the local voice instead.
    return null;
  }
}

// -- playback --------------------------------------------------------------

function playUrl(src) {
  return new Promise((resolve, reject) => {
    const audio = new Audio(src);
    current = { audio };
    audio.onended = () => { current = null; resolve(); };
    audio.onerror = () => { current = null; reject(new Error('playback failed')); };
    audio.play().catch(err => { current = null; reject(err); });
  });
}

// -- the system voice ------------------------------------------------------

let localVoice;   // undefined: not looked up yet; null: there is none
let watchingVoices = false;

/**
 * The on-device voice to use, preferring US English.
 *
 * Chrome fills getVoices() asynchronously, so an empty list on the first call
 * means "not yet", not "none": wait briefly for voiceschanged before deciding.
 * The decision is then kept — waiting on every utterance would add a second
 * and a half to each one on a machine with no voices — and looked at again
 * only if the browser says its voices changed.
 */
async function pickLocalVoice() {
  if (localVoice !== undefined) return localVoice;
  const synth = window.speechSynthesis;
  if (synth?.addEventListener && !watchingVoices) {
    watchingVoices = true;
    synth.addEventListener('voiceschanged', () => { localVoice = undefined; });
  }
  let voices = synth?.getVoices?.() ?? [];
  if (!voices.length && synth?.addEventListener) {
    await new Promise(resolve => {
      const done = () => { synth.removeEventListener('voiceschanged', done); resolve(); };
      synth.addEventListener('voiceschanged', done);
      setTimeout(done, 1500);
    });
    voices = synth.getVoices?.() ?? [];
  }
  const local = voices.filter(v => v.localService === true);
  const us = v => /^en[-_]US$/i.test(v.lang);
  localVoice = local.find(v => us(v) && v.default)
    ?? local.find(us)
    ?? local.find(v => /^en/i.test(v.lang))
    ?? null;
  return localVoice;
}

/**
 * Speak with a local voice, or not at all. Never rejects: when no on-device
 * voice exists the text is already in the live region, and a remote voice is
 * not an acceptable substitute.
 */
async function localSpeak(text) {
  const synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
  const voice = await pickLocalVoice();
  if (!voice) return;
  await new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 0.95;
    u.onend = () => { current = null; resolve(); };
    u.onerror = () => { current = null; resolve(); };  // never strand the queue
    current = { utterance: u };
    synth.speak(u);
  });
}

/** Stop playback immediately and drop anything queued. */
export function cancel() {
  queue.forEach(item => item.resolve());
  queue = [];
  if (current?.audio) current.audio.pause();
  try { window.speechSynthesis?.cancel(); } catch { /* not available */ }
  current = null;
  speaking = false;
}
