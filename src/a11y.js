// Screen-reader announcements and focus management.
//
// Two live regions only. Polite carries questions, progress, and confirmations;
// assertive is reserved for errors and microphone state changes. More than one
// assertive region causes announcements to pile up and clobber each other in
// VoiceOver and NVDA, so there is exactly one.

import { choiceLabel } from './choice.js';
import {
  translate, formatDate as dateIn, formatMonthYear as monthYearIn,
  formatMoney as moneyIn, formatTimeRemaining as timeIn
} from './i18n/index.js';

let politeEl = null;
let assertiveEl = null;

export function initA11y() {
  politeEl = document.getElementById('live-polite');
  assertiveEl = document.getElementById('live-assertive');
}

/**
 * Announce to the screen reader. Re-announcing identical text is a no-op in
 * most readers, so we clear the node first and set it on the next frame.
 */
export function announce(text, assertive = false) {
  const el = assertive ? assertiveEl : politeEl;
  if (!el || !text) return;
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = text; });
}

/** Move focus without scrolling the page out from under a sighted helper. */
export function focusMain() {
  document.getElementById('talk-button')?.focus({ preventScroll: true });
}

/** Spoken-friendly digit read-back: "5 5 5, 1 2, 3 4 5 6". */
export function spellDigits(value, groups = null) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) return '';
  const chunks = groups
    ? groups.reduce((acc, n) => (acc.rest ? { out: [...acc.out, acc.rest.slice(0, n)], rest: acc.rest.slice(n) } : acc), { out: [], rest: digits }).out
    : [digits];
  const tail = groups ? digits.slice(groups.reduce((a, b) => a + b, 0)) : '';
  return [...chunks, tail].filter(Boolean).map(c => c.split('').join(' ')).join(', ');
}

/**
 * Human-readable rendering of a stored value, for read-back and the summary.
 * `options` is the question's option list, for choice answers. English is the
 * original code, untouched; other languages translate the words but never the
 * digits, which are read one at a time in every language.
 */
export function speakableValue(value, type, options = null, lang = 'en') {
  if (value == null || value === '') {
    return lang === 'en' ? 'not answered' : translate('not answered', lang);
  }
  if (type === 'yesno') {
    const word = value === true ? 'Yes' : 'No';
    return lang === 'en' ? word.toLowerCase() : translate(word, lang).toLowerCase();
  }
  if (type === 'choice') return choiceLabel(options, value, lang).toLowerCase();
  if (type === 'zip') return spellDigits(value, [5]);
  if (type === 'ssn') return spellDigits(value, [3, 2, 4]);
  if (type === 'routing') return spellDigits(value, [3, 3, 3]);
  if (type === 'account' || type === 'phone') return spellDigits(value, [3, 3]);
  if (type === 'date') return formatDate(value, lang);
  if (type === 'monthyear') return formatMonthYear(value, lang);
  if (type === 'money') {
    return lang === 'en'
      ? `${Number(value).toLocaleString()} dollars`
      : moneyIn(value, lang);
  }
  return String(value);
}

export function formatDate(iso, lang = 'en') {
  if (lang === 'en') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
    if (!m) return String(iso);
    return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  }
  return dateIn(iso, lang);
}

export function formatMonthYear(value, lang = 'en') {
  if (lang === 'en') {
    if (String(value).toLowerCase() === 'present') return 'still ongoing';
    const m = /^(\d{4})-(\d{2})$/.exec(String(value));
    if (!m) return String(value);
    return `${MONTHS[+m[2] - 1]} ${m[1]}`;
  }
  return monthYearIn(value, lang);
}

export function formatTimeRemaining(seconds, lang = 'en') {
  if (lang === 'en') {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
    if (seconds < 60) return 'less than a minute';
    const minutes = seconds / 60;
    if (minutes < 2.5) return 'about two minutes';
    if (minutes < 60) {
      const step = Math.max(5, Math.round(minutes / 5) * 5);
      return `about ${step} minutes`;
    }
    const halves = Math.round(minutes / 30) / 2;
    if (halves <= 1) return 'about an hour';
    const whole = Math.floor(halves);
    if (!(halves % 1)) return `about ${whole} hours`;
    return whole === 1
      ? 'about an hour and a half'
      : `about ${whole} and a half hours`;
  }
  return timeIn(seconds, lang);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
