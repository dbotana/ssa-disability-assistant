// Turn a Lingala string into text Simba-TTS-lin can actually say.
//
// Simba's vocabulary is 39 symbols: lowercase a-z without x, the digits 0-8
// with no 9, space, apostrophe, hyphen, underscore and the modifier letter
// apostrophe. It has no open vowels, no tone marks and no capitals. A digit
// that reaches it can vanish, which is how an SSN read-back loses a number,
// so this normalizer spells every digit as a word and respells every letter
// the model lacks.
//
// This is a pure function and the JS reference for the Kotlin port in
// android/core (SpeechNormalizer.kt). The number words are data: reviewers decide whether a Lingala
// session hears Lingala (`libwa`) or French (`neuf`) digits (plan 4.1).
//
// It lives apart from speech.js, which is the web app's playback queue.
// English does not go through here: it keeps the existing `say` port, so the
// English turn golden cannot move.

import { translationCorpus } from './i18n/corpus.js';
import { translate, message } from './i18n/index.js';

/** The 39 symbols Simba-TTS-lin's tokenizer knows, in vocabulary order. */
export const SIMBA_VOCABULARY =
  "abcdefghijklmnopqrstuvwyz012345678 '-_ʼ";

/** The same set as an array, for goldens and the Kotlin port. */
export const SIMBA_SYMBOLS = [...SIMBA_VOCABULARY];

/**
 * Digit words, by the language a session reads numbers in. Each list is
 * indexed by the digit. Lingala is the default; French is the alternative the
 * plan's reviewers choose between.
 */
export const NUMBER_WORDS = {
  ln: ['zero', 'moko', 'mibale', 'misato', 'minei', 'mitano', 'motoba', 'nsambo', 'mwambe', 'libwa'],
  fr: ['zero', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf']
};

export const DEFAULT_NUMBER_LANGUAGE = 'ln';

/**
 * Respelling rules for letters the model cannot spell. `x` is the common one:
 * French loanwords (`deux`, `six`, `dix`) and English names such as Maxine.
 * Each rule is data so a listener's correction is a one-line change.
 */
export const RESPELL = { x: 'ks' };

/** Characters kept because the model has them; everything else is a gap. */
const KEEP = /[a-z '\-_ʼ]/;

/**
 * Normalize one string for Simba.
 *
 * @param {string} text
 * @param {{numberLanguage?: 'ln'|'fr', respell?: Record<string,string>}} [options]
 * @returns {string} speakable text, using only [SIMBA_VOCABULARY] symbols
 */
export function normalizeForSpeech(text, { numberLanguage = DEFAULT_NUMBER_LANGUAGE, respell = RESPELL } = {}) {
  let s = String(text ?? '');

  // Compatibility-decompose first, so a precomposed ɛ/ɔ and a combining tone
  // mark both end up as a base letter plus marks that can be dropped.
  s = s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

  // The parser's own fold: the model was trained without the open vowels.
  s = s.replace(/ɛ/g, 'e').replace(/ɔ/g, 'o');

  // Typographic apostrophes and dashes become the symbols the model has.
  s = s.replace(/[’‘`´]/g, "'").replace(/[‐‑‒–—―]/g, '-');

  // Every digit becomes a word. Spaces around it keep neighbouring words
  // apart when the digit was glued to them ("SSN987...").
  const words = NUMBER_WORDS[numberLanguage] ?? NUMBER_WORDS[DEFAULT_NUMBER_LANGUAGE];
  s = s.replace(/[0-9]/g, d => ` ${words[Number(d)]} `);

  // Respell letters the model lacks, as whole symbols.
  for (const [from, to] of Object.entries(respell)) {
    s = s.split(from).join(` ${to} `);
  }

  // Anything outside the vocabulary is a word gap. Digits that somehow
  // survived (a rule could map onto one) are dropped too: never pass a digit.
  let out = '';
  for (const ch of s) {
    if (KEEP.test(ch) && !/[0-9]/.test(ch)) out += ch;
    else out += ' ';
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Split a long string at sentence ends (and, for a sentence still too long,
 * at word gaps) and normalize each piece. The caller speaks the pieces in
 * order, so a long read-back does not have to be one utterance.
 */
export function speechSegments(text, { maxLength = 220, ...options } = {}) {
  const pieces = String(text ?? '')
    .split(/(?<=[.!?])\s+/u)
    .flatMap(part => {
      if (part.length <= maxLength) return [part];
      const words = part.split(/\s+/);
      const out = [];
      let line = '';
      for (const word of words) {
        if (line && line.length + 1 + word.length > maxLength) { out.push(line); line = word; }
        else line = line ? `${line} ${word}` : word;
      }
      if (line) out.push(line);
      return out;
    });
  return pieces.map(part => normalizeForSpeech(part, options)).filter(Boolean);
}

/** Characters in [normalized] that the model cannot say. */
export function unknownSymbols(normalized) {
  return [...new Set([...String(normalized ?? '')].filter(ch => !SIMBA_SYMBOLS.includes(ch)))];
}

/**
 * Every Lingala string the app may speak: the catalogue (which is the whole
 * translation corpus, translated), the read-back templates, and the kinds of
 * value a read-back substitutes. The golden normalizes all of them and fails
 * on one unknown symbol or one leftover digit.
 */
export function lingalaSpeechCorpus() {
  const set = new Set();
  for (const key of translationCorpus()) {
    const ln = translate(key, 'ln');
    if (ln) set.add(ln);
  }
  for (const sample of [
    '987654321', '2075550100', '04101', '041011234', '03/14/1979',
    'Maxine', 'deux', 'six', 'dix', 'MaineCare', 'Social Security',
    'Kopɛtɛ nzoto', 'Bɔkɔ́', 'Lingála', 'na yo, mpe mokolo.'
  ]) set.add(sample);
  // Read-back templates with a value filled in, the way a read-back is spoken.
  for (const value of ['9 8 7, 6 5, 4 3 2 1', '(207) 555-0100', '14/3/1979', 'Maxine Dix']) {
    for (const key of ['readback_heard', 'readback_typed']) set.add(message(key, { value }, 'ln'));
  }
  return [...set].sort();
}
