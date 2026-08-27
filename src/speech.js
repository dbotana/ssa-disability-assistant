// Spoken output: an utterance queue over the TTS API, falling back to the
// browser's built-in synthesizer.
//
// The fallback is not a nicety. If the key is missing, the network drops, or
// the TTS call fails, a blind user must still hear the question — going silent
// is the one failure this app cannot have.

import { synthesize } from './llm.js';

let current = null;          // { audio } | { utterance }
let queue = [];
let speaking = false;
let useFallback = false;
let voicePref = 'alloy';

export function setVoice(v) { voicePref = v; }
export function forceFallback(on) { useFallback = !!on; }
export function isSpeaking() { return speaking; }

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

async function play(text) {
  if (useFallback) return fallbackSpeak(text);
  let buffer;
  try {
    buffer = await synthesize(text, { voice: voicePref });
  } catch (err) {
    // An auth failure will not fix itself; stop paying the latency cost.
    if (err?.kind === 'auth' || err?.kind === 'network') useFallback = true;
    throw err;
  }

  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    current = { audio, url };
    audio.onended = () => { cleanup(url); resolve(); };
    audio.onerror = () => { cleanup(url); reject(new Error('playback failed')); };
    audio.play().catch(reject);
  });
}

function cleanup(url) {
  URL.revokeObjectURL(url);
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
