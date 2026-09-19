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

// "Never" is deliberately absent: "never married" is an answer, not a negation.
const NEGATION = /\b(not|no|nor|neither|without|cannot|(?:do|does|did|is|was|are|were|ca|wo|could|would|should)n'?t)\b/;
const LEAD = /^(um|uh|er|well|so|okay|ok|i think|i would say|i'd say|probably|maybe|it is|it's|its|that is|that's|thats|i guess)\b[\s,]*/;

const normalize = s => String(s ?? '')
  .toLowerCase()
  .replace(/[’']/g, "'")
  .replace(/[^a-z0-9'\s-]/g, ' ')
  .replace(/-/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
export function matchChoice(options, text) {
  if (!Array.isArray(options) || !options.length) return null;
  let s = normalize(text);
  for (let i = 0; i < 3; i++) {
    const next = s.replace(LEAD, '').trim();
    if (next === s) break;
    s = next;
  }
  if (!s) return null;

  // Exact value or label: "both", "B", "Needs supervision".
  for (const o of options) {
    if (s === normalize(o.value) || s === normalize(o.label)) return o;
  }

  // A lone letter, optionally introduced: "b", "letter b", "the letter bee".
  const letter = /^(?:the )?(?:letter |option )?([a-z]{1,3})$/.exec(s);
  if (letter && LETTER_WORDS[letter[1]]) {
    const hit = options.filter(o => o.letter && o.letter.toLowerCase() === LETTER_WORDS[letter[1]]);
    if (hit.length === 1) return hit[0];
  }

  if (NEGATION.test(s)) return null;

  // Phrase search. Collect every alias found in the answer, then drop any match
  // sitting inside a longer one — "every two weeks" is not also "week", and
  // "never married" is not also "married".
  const found = [];
  for (const o of options) {
    for (const phrase of [o.label, ...(o.aliases ?? [])]) {
      const p = normalize(phrase);
      if (!p) continue;
      const re = new RegExp(`\\b${escapeRe(p)}\\b`, 'g');
      for (const m of s.matchAll(re)) {
        found.push({ option: o, start: m.index, end: m.index + p.length });
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
export function choiceLabel(options, value) {
  if (value == null || value === '') return '';
  return optionFor(options, value)?.label ?? String(value);
}

/** "independent, needs supervision, or total care" — for spoken hints. */
export function optionsSentence(options) {
  const labels = (options ?? []).map(o => o.label.toLowerCase());
  if (labels.length <= 2) return labels.join(' or ');
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}`;
}
