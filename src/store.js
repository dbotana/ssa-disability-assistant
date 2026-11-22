// Local persistence. Nothing here ever leaves the device, but localStorage is
// a file in the browser profile on disk: readable by any program running as
// this user, and copied into every backup of the profile. Three rules follow.
//
//   1. Social Security and bank numbers are never written, encrypted or not.
//      A save records only *that* one was given (`withheld`), and a resumed
//      session asks for it again.
//   2. Everything else is written only encrypted, with a key derived from a
//      PIN the user chose (PBKDF2-SHA256, AES-256-GCM). The key lives in this
//      tab's memory and cannot be exported from it. No PIN, no saving: the
//      session lives in the tab and is gone when the tab closes.
//   3. A saved session expires. One not touched for MAX_AGE_MS is deleted the
//      next time the page loads.
//
// What the PIN does not do: stop someone who has the disk and time. A short
// PIN can be guessed offline, iteration count or not. It keeps the answers
// out of casual reach and out of readable backups; it is not a vault. That is
// the reason for rule 1.

import { SECTIONS, SENSITIVE_TYPES } from './schema.js';

export { SENSITIVE_TYPES };

const STATE_KEY = 'ssa-prep.state.v3';
// Unencrypted sessions written by earlier versions. Read once, to resume,
// and removed from storage in the same step.
const PLAIN_KEYS = ['ssa-prep.state.v2', 'ssa-prep.state.v1'];

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PIN_LENGTH = 4;
// OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. Deriving the key costs
// the user about half a second, once per session.
export const KDF_ITERATIONS = 600000;
/** The envelope's format version (`v`). */
export const STORE_VERSION = 3;

export class StoreError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;   // pin | none | unsupported
  }
}

// -- sensitive answers ---------------------------------------------------------

// Every question of a sensitive type, as { id, loopId }. Derived from the
// schema rather than listed, so a sensitive question added later is covered
// without anyone remembering this file.
const SENSITIVE_FIELDS = SECTIONS.flatMap(section => section.questions.flatMap(q => {
  if (q.type === 'loop') {
    return q.fields.filter(f => SENSITIVE_TYPES.has(f.type)).map(f => ({ id: f.id, loopId: q.id }));
  }
  return SENSITIVE_TYPES.has(q.type) ? [{ id: q.id, loopId: null }] : [];
}));

const filled = v => v != null && v !== '';

/**
 * Every sensitive answer present in a state, with its value.
 * @returns {{id:string, loopId?:string, loopIndex?:number, value:*}[]}
 */
export function sensitiveAnswers(state) {
  const answers = state?.answers ?? {};
  const out = [];
  for (const { id, loopId } of SENSITIVE_FIELDS) {
    if (!loopId) {
      if (filled(answers[id])) out.push({ id, value: answers[id] });
      continue;
    }
    const items = Array.isArray(answers[loopId]) ? answers[loopId] : [];
    items.forEach((item, loopIndex) => {
      if (filled(item?.[id])) out.push({ id, loopId, loopIndex, value: item[id] });
    });
  }
  return out;
}

/** A copy of the state with every sensitive answer removed. */
export function redact(state) {
  const safe = structuredClone(state);
  const withheld = [];
  for (const { id, loopId, loopIndex } of sensitiveAnswers(safe)) {
    if (loopId) delete safe.answers[loopId][loopIndex][id];
    else delete safe.answers[id];
    withheld.push(loopId ? { id, loopId, loopIndex } : { id });
  }
  return { state: safe, withheld };
}

const fieldKey = w => JSON.stringify([w.id, w.loopId ?? null, w.loopIndex ?? 0]);

/** Lists of withheld fields joined in order, each field once. */
export function mergeWithheld(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const w of list ?? []) if (!seen.has(fieldKey(w))) { out.push(w); seen.add(fieldKey(w)); }
  }
  return out;
}

// -- the format, pure ----------------------------------------------------------
//
// What a save writes, as plain functions, so the Android and iOS apps
// (android/core store/SessionStore.kt) write and read the same bytes. Pinned
// by the `store` golden, which also carries a WebCrypto test vector.

/**
 * The plaintext a save encrypts: the state with every sensitive answer
 * removed, the withheld fields (this state's, then the carried ones), and,
 * when there are any, the translations and input-language tags (plan 4.4,
 * 4.8) that belong with the session.
 */
export function sessionPayload(state, { savedAt, carried = [], translations = null, inputLangs = null } = {}) {
  const { state: safe, withheld } = redact(state);
  const payload = { savedAt, state: safe, withheld: mergeWithheld(withheld, carried) };
  if (translations && translations.length) payload.translations = translations;
  if (inputLangs && inputLangs.length) payload.inputLangs = inputLangs;
  return payload;
}

/** The envelope written to disk around an encrypted payload. Byte fields are base64. */
export function sessionEnvelope({ savedAt, salt, iv, data, iterations = KDF_ITERATIONS }) {
  return {
    v: STORE_VERSION,
    savedAt,
    kdf: { name: 'PBKDF2-SHA256', iterations, salt },
    iv,
    data
  };
}

/** Has a session saved at `savedAt` expired by `now`? (Rule 3.) */
export function isExpired(savedAt, now) {
  return now - (savedAt ?? 0) > MAX_AGE_MS;
}

/**
 * A decrypted payload as the caller gets it back: sensitive answers redacted
 * again (belt and braces), and the withheld list the session carries from
 * now on.
 */
export function openedSession(parsed, envelopeSavedAt = null) {
  const { state, withheld } = redact(parsed.state);
  return {
    savedAt: parsed.savedAt ?? envelopeSavedAt,
    state,
    withheld: [...(parsed.withheld ?? []), ...withheld],
    translations: parsed.translations ?? [],
    inputLangs: parsed.inputLangs ?? []
  };
}

/** PBKDF2-SHA256 over the NFC form of the PIN, then an AES-256-GCM key. */
export async function deriveSessionKey(pin, saltBytes, { iterations = KDF_ITERATIONS, extractable = false } = {}) {
  const material = await subtle().importKey(
    'raw', new TextEncoder().encode(String(pin).normalize('NFC')), 'PBKDF2', false, ['deriveKey']
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

/**
 * Repair a withheld list after a loop item is deleted.
 *
 * A withheld entry records a loop field by its position. Deleting an item
 * renumbers the ones after it, so without this the list asks about the wrong
 * spouse: the entry at the deleted index is gone, and every entry after it
 * moves down one. Same repair for the controller's live list and this
 * module's carried list (TODO.md, *Known quirks*).
 */
export function repairWithheldList(list, loopId, removedIndex) {
  const out = [];
  for (const w of list) {
    if ((w.loopId ?? null) !== loopId) { out.push(w); continue; }
    const index = w.loopIndex ?? 0;
    if (index === removedIndex) continue;
    out.push(index > removedIndex ? { ...w, loopIndex: index - 1 } : w);
  }
  return out;
}

/** Apply the same repair to the fields this store carries between saves. */
export function repairWithheld(loopId, removedIndex) {
  carried = repairWithheldList(carried, loopId, removedIndex);
}

// Translations and input-language tags kept with the session. The web has no
// translator, so these stay empty there; the format carries them for the
// apps and for a session moved between them.
let sessionTranslations = [];
let sessionInputLangs = [];

// -- the key -------------------------------------------------------------------

let key = null;        // AES-GCM CryptoKey, non-extractable; null = not saving
let salt = null;       // the PBKDF2 salt that key was derived with
// The PBKDF2 iterations that key was derived with. Every save records them,
// so a session opened at another count is re-saved with the count its key
// was actually derived at.
let iterations = KDF_ITERATIONS;
// Fields withheld by the session this one resumed, and fields whose answers
// were dropped from memory while it ran (markWithheld). They stay withheld in
// every later save, answered again or not: they are never on disk either way.
let carried = [];
let writing = Promise.resolve();
// Bumped by clearState() and forgetKey(). A write queued before an erase
// checks it and does nothing, so "Erase everything" cannot be undone by a
// save that was still being encrypted.
let generation = 0;

const subtle = () => globalThis.crypto?.subtle ?? null;

/** Is this browser able to encrypt a saved session at all? */
export function canEncrypt() {
  return !!subtle() && typeof globalThis.crypto.getRandomValues === 'function';
}

// Not extractable: the key never leaves the tab.
const deriveKey = (pin, saltBytes) => deriveSessionKey(pin, saltBytes);

/** Protect a new session's saves with this PIN. */
export async function usePin(pin) {
  if (!canEncrypt()) throw new StoreError('This browser cannot encrypt saved answers.', 'unsupported');
  if (String(pin).length < MIN_PIN_LENGTH) {
    throw new StoreError(`A PIN needs at least ${MIN_PIN_LENGTH} characters.`, 'pin');
  }
  salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  iterations = KDF_ITERATIONS;
  key = await deriveKey(pin, salt);
}

/** Stop saving, and drop the key from memory. */
export function forgetKey() {
  generation++;
  key = null;
  salt = null;
  iterations = KDF_ITERATIONS;
  carried = [];
  sessionTranslations = [];
  sessionInputLangs = [];
}

/** Will saveState() actually save? */
export function isPersisting() {
  return key !== null;
}

/**
 * List these fields as withheld in every later save, though the state no
 * longer holds them. For answers dropped from memory mid-session (main.js's
 * idle lock): without this, the next save records nothing to ask again, and
 * a session resumed after the tab closes never asks for them.
 */
export function markWithheld(fields) {
  carried = mergeWithheld(carried, fields);
}

// -- encoding ------------------------------------------------------------------

// In slices: spread whole, a ciphertext past about 100 KB overflows the call
// stack, and saveState() would drop the save without a word.
export function toB64(bytes) {
  const all = new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < all.length; i += 0x8000) text += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return btoa(text);
}
export const fromB64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

function readJson(k) {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function remove(k) {
  try { localStorage.removeItem(k); } catch { /* nothing to do */ }
}

// -- saving --------------------------------------------------------------------

/**
 * Save a session: sensitive answers removed, the rest encrypted.
 *
 * Returns whether it will be saved — false when no PIN protects this session,
 * in which case nothing is written. The write itself is asynchronous; call
 * flush() before telling the user it has happened. `replace` drops the
 * withheld list carried from a resumed session, for a state that does not
 * continue it (an imported file, a restart).
 */
export function saveState(state, { replace = false, translations, inputLangs } = {}) {
  if (!key) return false;
  if (replace) { carried = []; sessionTranslations = []; sessionInputLangs = []; }
  if (translations) sessionTranslations = translations;
  if (inputLangs) sessionInputLangs = inputLangs;

  const savedAt = Date.now();
  const payload = new TextEncoder().encode(JSON.stringify(sessionPayload(state, {
    savedAt, carried, translations: sessionTranslations, inputLangs: sessionInputLangs
  })));
  const useKey = key;
  const useSalt = salt;
  const useIterations = iterations;
  const gen = generation;
  // Chained, so saves land in the order they were made.
  writing = writing.then(async () => {
    try {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const data = await subtle().encrypt({ name: 'AES-GCM', iv }, useKey, payload);
      if (gen !== generation) return;   // erased while this was encrypting
      localStorage.setItem(STATE_KEY, JSON.stringify(sessionEnvelope({
        savedAt, salt: toB64(useSalt), iv: toB64(iv), data: toB64(data), iterations: useIterations
      })));
      for (const k of PLAIN_KEYS) remove(k);
    } catch {
      /* private mode or quota — the interview continues in memory */
    }
  });
  return true;
}

/** Resolves once every save made so far has been written. */
export function flush() {
  return writing;
}

// -- loading -------------------------------------------------------------------

/**
 * What is saved, without decrypting it: { savedAt, locked } or null.
 * `locked` is true for an encrypted session, which needs the PIN to open.
 * Deletes a session older than MAX_AGE_MS, so an abandoned one does not sit
 * on disk indefinitely.
 */
export function savedSessionInfo(now = Date.now()) {
  const enc = readJson(STATE_KEY);
  if (enc?.v === STORE_VERSION && enc.data) {
    if (isExpired(enc.savedAt, now)) { remove(STATE_KEY); } else {
      return { savedAt: enc.savedAt, locked: true };
    }
  }
  for (const k of PLAIN_KEYS) {
    const plain = readJson(k);
    if (!plain?.state?.cursor) continue;
    if (isExpired(plain.savedAt, now)) { remove(k); continue; }
    return { savedAt: plain.savedAt, locked: false };
  }
  return null;
}

/**
 * Open the encrypted session with its PIN. On success the same key protects
 * every save after it. Returns { savedAt, state, withheld }.
 */
export async function unlock(pin) {
  const enc = readJson(STATE_KEY);
  if (!enc?.data) throw new StoreError('There is no saved session.', 'none');
  if (!canEncrypt()) throw new StoreError('This browser cannot open saved answers.', 'unsupported');
  const saltBytes = fromB64(enc.kdf.salt);
  // The iterations the session was written with, so a format that raises
  // them later still opens older sessions.
  const candidateIterations = enc.kdf.iterations ?? KDF_ITERATIONS;
  const candidate = await deriveSessionKey(pin, saltBytes, { iterations: candidateIterations });
  let plain;
  try {
    plain = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(enc.iv) }, candidate, fromB64(enc.data));
  } catch {
    // AES-GCM authenticates: a wrong key fails here rather than decrypting to
    // garbage, and so does a blob that was tampered with.
    throw new StoreError('That PIN does not open the saved answers.', 'pin');
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  key = candidate;
  salt = saltBytes;
  iterations = candidateIterations;
  // Belt and braces: a blob never holds sensitive answers, but if one did,
  // it would not come back into memory from disk.
  const opened = openedSession(parsed, enc.savedAt);
  carried = opened.withheld;
  sessionTranslations = opened.translations;
  sessionInputLangs = opened.inputLangs;
  return { ...opened, withheld: carried.slice() };
}

/**
 * Take an unencrypted session saved by an earlier version: it is removed from
 * storage as it is read, and its sensitive answers never come back. Returns
 * { savedAt, state, withheld } or null.
 */
export function takeLegacy() {
  for (const k of PLAIN_KEYS) {
    const parsed = readJson(k);
    if (!parsed?.state?.cursor) continue;
    for (const kk of PLAIN_KEYS) remove(kk);
    const { state, withheld } = redact(parsed.state);
    carried = [...(parsed.withheld ?? []), ...withheld];
    return { savedAt: parsed.savedAt, state, withheld: carried.slice() };
  }
  return null;
}

/**
 * Scrub sensitive answers out of any unencrypted session on disk, without
 * taking it. Run at page load, so an older version's saved SSN is gone from
 * disk before anyone decides whether to resume.
 */
export function scrubLegacy() {
  for (const k of PLAIN_KEYS) {
    const parsed = readJson(k);
    if (!parsed?.state || !sensitiveAnswers(parsed.state).length) continue;
    const { state, withheld } = redact(parsed.state);
    try {
      localStorage.setItem(k, JSON.stringify({
        ...parsed, state, withheld: [...(parsed.withheld ?? []), ...withheld]
      }));
    } catch { remove(k); }
  }
}

/** Delete the saved session. The key, if any, keeps protecting new saves. */
export function clearState() {
  generation++;
  carried = [];
  sessionTranslations = [];
  sessionInputLangs = [];
  for (const k of [STATE_KEY, ...PLAIN_KEYS]) remove(k);
}
