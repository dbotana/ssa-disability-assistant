// Translation lookup and the formatting that depends on a language.
//
// The catalogue is keyed by the English source string (D1), so phrases.js,
// schema.js and the PDF prose need no keys of their own and a missing entry
// falls back to English rather than to an empty string. tests/i18n.js requires
// both catalogues to be complete over translationCorpus().
//
// Channels are resolved independently: callers pass a language code, never a
// settings object, so screen=fr, output=en and fill=ln is just three calls.

import { LANGUAGES, LANGUAGE_ORDER } from './languages.js';
import { MESSAGES } from './messages.js';
import { UI } from './ui.js';
import enLexicon from './catalog/en.lexicon.js';
import frStrings from './catalog/fr.strings.js';
import frLexicon from './catalog/fr.lexicon.js';
import lnStrings from './catalog/ln.strings.js';
import lnLexicon from './catalog/ln.lexicon.js';

export { CHANNELS, LANGUAGES, LANGUAGE_ORDER, DEFAULT_SETTINGS } from './languages.js';
export { SETTINGS_KEY, normalizeSettings, langFor, loadSettings, saveSettings } from './settings.js';
export { MESSAGES } from './messages.js';
export { UI } from './ui.js';
export { translationCorpus } from './corpus.js';

export const STRINGS = { en: null, fr: frStrings, ln: lnStrings };
export const LEXICONS = { en: enLexicon, fr: frLexicon, ln: lnLexicon };

const misses = new Set();

/** The translation of an English source string, or the source itself. */
export function translate(text, lang = 'en') {
  if (typeof text !== 'string' || !text) return text;
  if (lang === 'en' || !STRINGS[lang]) return text;
  const hit = STRINGS[lang].strings?.[text];
  if (typeof hit === 'string' && hit !== '') return hit;
  misses.add(`${lang}:${text}`);
  return text;
}

/**
 * Render a MESSAGES template. Substitution is a single pass, so a value that
 * happens to contain `{something}` is never expanded again.
 */
export function message(key, vars = {}, lang = 'en') {
  const template = translate(MESSAGES[key] ?? '', lang);
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''));
}

/** English source strings that were asked for and had no translation. */
export function missingKeys() {
  return [...misses].sort();
}

/** The recognition tables for a language. */
export function lexicon(lang = 'en') {
  return LEXICONS[lang] ?? LEXICONS.en;
}

/** Case-fold and strip diacritics for non-English matching; English is exact. */
export function fold(text, lang = 'en') {
  const s = String(text ?? '');
  if (lang === 'en') return s;
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The speech pack a language needs. */
export function sttFor(lang = 'en') {
  return LANGUAGES[lang]?.stt ?? LANGUAGES.en.stt;
}

const MONTHS_EN = LANGUAGES.en.months;

/** A date the way the language writes it. English output is unchanged. */
export function formatDate(iso, lang = 'en') {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return String(iso);
  if (lang === 'en') return `${MONTHS_EN[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  const months = LANGUAGES[lang]?.months ?? MONTHS_EN;
  return `${+m[3]} ${months[+m[2] - 1]} ${m[1]}`;
}

/** "March 1979", "still ongoing". */
export function formatMonthYear(value, lang = 'en') {
  if (String(value).toLowerCase() === 'present') return message('still_ongoing', {}, lang);
  const m = /^(\d{4})-(\d{2})$/.exec(String(value));
  if (!m) return String(value);
  if (lang === 'en') return `${MONTHS_EN[+m[2] - 1]} ${m[1]}`;
  const months = LANGUAGES[lang]?.months ?? MONTHS_EN;
  return `${months[+m[2] - 1]} ${m[1]}`;
}

/**
 * A money amount. English keeps the existing toLocaleString() path; French
 * and Lingala group with ASCII spaces and put the symbol after the number, and
 * never use toLocale*.
 */
export function formatMoney(value, lang = 'en') {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  if (lang === 'en') return n.toLocaleString();
  const grouped = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${grouped} $`;
}

/**
 * A spoken estimate of time remaining, or null when there is nothing honest
 * to say. The buckets are the same in every language.
 */
export function formatTimeRemaining(seconds, lang = 'en') {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return message('time_less_minute', {}, lang);
  const minutes = seconds / 60;
  if (minutes < 2.5) return message('time_two_minutes', {}, lang);
  if (minutes < 60) {
    const step = Math.max(5, Math.round(minutes / 5) * 5);
    return message('time_minutes', { count: step }, lang);
  }
  const halves = Math.round(minutes / 30) / 2;
  if (halves <= 1) return message('time_hour', {}, lang);
  const whole = Math.floor(halves);
  if (!(halves % 1)) return message('time_hours', { count: whole }, lang);
  return whole === 1
    ? message('time_hour_half', {}, lang)
    : message('time_and_half_hours', { count: whole }, lang);
}
