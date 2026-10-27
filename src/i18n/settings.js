// Per-channel language settings, stored on this device only.
//
// Four independent channels, each one of LANGUAGE_ORDER. The saved value is
// plain JSON: it records a preference, not an answer, so it needs no PIN.

import { DEFAULT_SETTINGS, LANGUAGE_ORDER } from './languages.js';

export const SETTINGS_KEY = 'ssa-languages-v1';

/** A fresh settings object with each channel validated independently. */
export function normalizeSettings(value) {
  const out = { ...DEFAULT_SETTINGS };
  if (!value || typeof value !== 'object') return out;
  for (const channel of Object.keys(out)) {
    if (LANGUAGE_ORDER.includes(value[channel])) out[channel] = value[channel];
  }
  return out;
}

/** The language code chosen for one channel. */
export function langFor(channel, settings) {
  const normalized = normalizeSettings(settings);
  return normalized[channel] ?? 'en';
}

/** Read settings, returning the defaults for anything unreadable. */
export function loadSettings(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(SETTINGS_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Save settings, ignoring a storage that refuses to write. */
export function saveSettings(settings, storage = globalThis.localStorage) {
  const normalized = normalizeSettings(settings);
  try {
    storage?.setItem?.(SETTINGS_KEY, JSON.stringify(normalized));
  } catch {
    // A private-mode browser with no storage: the interview still works.
  }
  return normalized;
}
