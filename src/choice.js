// Multiple-choice answers: "which form", the A–E daily-living scale, pay
// frequency, marital status.
//
// A choice question carries `options: [{ value, label, letter?, aliases? }]`.
// This module is the one place that turns what someone said into one of those
// values, so the local parser, the model's output check, and the summary all
// agree on what an answer means.
//
// Like parse.js, matching is all-or-nothing. One option named, clearly: that
// option. Two named, a negation, or nothing recognisable: null, and the caller
// asks again or hands the transcript to the model. "Not the starter kit" must
// never be read as "starter kit".
//
// Non-English matching folds case and strips diacritics (D5), and adds the
// translated label to the names an option answers to. Values, letters and
// English labels always keep working, so a mixed-channel setup is safe.

import { translate, fold, lexicon } from './i18n/index.js';

/** "Never" is deliberately absent: "never married" is an answer, not a negation. */
const NEGATION = /\b(not|no|nor|neither|without|cannot|(?:do|does|did|is|was|are|were|ca|wo|could|would|should)n'?t)\b/;
const LEAD = /^(um|uh|er|well|so|okay|ok|i think|i would say|i'd say|probably|maybe|it is|it's|its|that is|that's|thats|i guess)\b[\s,]*/;

const normalize = (s, lang = 'en') => {
  if (lang !== 'en') {
    // Lingala's open vowels are what users write on a phone keyboard too
    // ("fomele" for "fɔmɛlɛ"), so fold them before the strip that would
    // otherwise turn ɛ/ɔ into spaces.
    const folded = lang === 'ln'
      ? fold(s, lang).replace(/ɛ/g, 'e').replace(/ɔ/g, 'o')
      : fold(s, lang);
    return folded
      .replace(/[’']/g, ' ')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return String(s ?? '')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Spoken names for letters, as a transcriber may write them out. */
const LETTER_WORDS = { a: 'a', ay: 'a', b: 'b', bee: 'b', be: 'b', c: 'c', see: 'c', sea: 'c',
  d: 'd', dee: 'd', e: 'e', ee: 'e', f: 'f', ef: 'f', m: 'm', em: 'm' };

/**
 * The option a free-form answer names, or null.
 *
 * Bare letters count only when they are the whole answer ("B", "letter B"),
 * because "a" is also the most common word in English.
 */
export function matchChoice(options, text, { lang = 'en' } = {}) {
  if (!Array.isArray(options) || !options.length) return null;
  const tables = lexicon(lang);
  const lead = lang === 'en' ? LEAD : (tables.lead?.[0] ? new RegExp(tables.lead[0]) : null);
  const negation = lang === 'en' ? NEGATION : (tables.negation?.length
    ? new RegExp(tables.negation.join('|'))
    : NEGATION);

  let s = normalize(text, lang);
  for (let i = 0; i < 3; i++) {
    const next = lead ? s.replace(lead, '').trim() : s;
    if (next === s) break;
    s = next;
  }
  if (!s) return null;

  // Exact value, letter, English label, or translated label: "both", "B",
  // "Needs supervision", "nécessite une supervision".
  for (const o of options) {
    const names = [o.value, o.label, translate(o.label, lang)];
    if (names.some(n => s === normalize(n, lang))) return o;
  }

  // A lone letter, optionally introduced: "b", "letter b", "the letter bee".
  const letter = /^(?:the )?(?:letter |option )?([a-z]{1,3})$/.exec(s);
  if (letter && LETTER_WORDS[letter[1]]) {
    const hit = options.filter(o => o.letter && o.letter.toLowerCase() === LETTER_WORDS[letter[1]]);
    if (hit.length === 1) return hit[0];
  }

  if (negation.test(s)) return null;

  // Phrase search. Collect every alias found in the answer, then drop any match
  // sitting inside a longer one — "every two weeks" is not also "week", and
  // "never married" is not also "married".
  const found = [];
  for (const o of options) {
    const names = [o.label, translate(o.label, lang), ...(o.aliases ?? [])];
    for (const phrase of names) {
      const p = normalize(phrase, lang);
      if (!p) continue;
      const re = new RegExp(`(?:^|\\s)${escapeRe(p)}(?:$|\\s)`, 'g');
      for (const m of s.matchAll(re)) {
        const start = m.index + (m[0].startsWith(' ') ? 1 : 0);
        found.push({ option: o, start, end: start + p.length });
      }
    }
  }
  const kept = found.filter(f => !found.some(g =>
    g !== f && g.start <= f.start && g.end >= f.end && (g.end - g.start) > (f.end - f.start)));

  let values = [...new Set(kept.map(f => f.option.value))];

  // An option can stand for a combination of others: saying "the starter kit
  // and developmental services" means "both".
  for (const o of options) {
    if (!o.impliedBy) continue;
    if (o.impliedBy.every(v => values.includes(v))) {
      values = values.filter(v => !o.impliedBy.includes(v));
      if (!values.includes(o.value)) values.push(o.value);
    }
  }

  if (values.length !== 1) return null;
  return options.find(o => o.value === values[0]) ?? null;
}

/** The option whose value this is, for display and read-back. */
export function optionFor(options, value) {
  if (!Array.isArray(options)) return null;
  return options.find(o => o.value === value) ?? null;
}

/** Printable label for a stored choice value; the raw value if unknown. */
export function choiceLabel(options, value, lang = 'en') {
  if (value == null || value === '') return '';
  const option = optionFor(options, value);
  // Values that are not in the table are already display text (a caller may
  // hand back a label it localized earlier), so leave them alone rather than
  // asking the catalogue to translate a second time.
  if (!option) return String(value);
  return translate(option.label, lang);
}

/** "independent, needs supervision, or total care" — for spoken hints. */
export function optionsSentence(options, lang = 'en') {
  const labels = (options ?? []).map(o => translate(o.label, lang).toLowerCase());
  const connector = lexicon(lang).connector ?? 'or';
  if (labels.length <= 2) return labels.join(` ${connector} `);
  return `${labels.slice(0, -1).join(', ')}, ${connector} ${labels[labels.length - 1]}`;
}
