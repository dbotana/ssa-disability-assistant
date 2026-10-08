// The fixed spoken corpus: every string the app can speak without a user's
// answer in it. One definition, two consumers:
//
//   tools/build-audio.mjs  synthesizes a clip for each string
//   tools/golden/index.mjs pins each string -> its ttshash in the `tts` golden
//
// Section preambles and item labels are their own clips rather than baked
// into the question text: the turn controller speaks them as separate
// utterances, so each is an independent cache hit.

import { SECTIONS, sectionCountsByForm } from '../src/schema.js';
import { allPhrases } from '../src/phrases.js';
import { normalizeText } from '../src/ttshash.js';
import { formatTimeRemaining } from '../src/a11y.js';

// Must match MAX_LOOP_ITEMS in src/correct.js, which refuses to add past it
// for exactly this reason: item 13 would have no clip to announce it.
export const MAX_LOOP_ITEMS = 12;

/** Enough sample points to hit every bucket formatTimeRemaining can return. */
export const TIME_SAMPLES = (() => {
  const s = [30];
  for (let m = 1; m <= 60; m += 1) s.push(m * 60);
  for (let m = 60; m <= 300; m += 15) s.push(m * 60);
  return s;
})();

/** Must match titleCase() in the turn controller, or labels never hit. */
export function titleCase(s) {
  return String(s).replace(/^(.)/, (_, c) => c.toUpperCase());
}

export function collectCorpus() {
  const out = new Set();
  const add = t => { const s = normalizeText(t); if (s) out.add(s); };

  allPhrases().forEach(add);

  // Sections are numbered among those the chosen forms use, so each form
  // choice has its own count.
  for (const count of sectionCountsByForm()) {
    for (let i = 1; i <= count; i++) add(`Section ${i} of ${count}.`);
  }

  SECTIONS.forEach(section => {
    add(`${section.title}.`);

    for (const q of section.questions) {
      add(q.prompt);
      add(q.warn);
      add(q.hint);
      add(q.entryPrompt);
      add(q.repeatPrompt);

      for (const f of q.fields ?? []) {
        add(f.prompt);
        add(f.warn);
        add(f.hint);
      }

      // "Provider 2." — spoken at the top of each loop item after the first.
      if (q.itemLabel) {
        for (let n = 2; n <= MAX_LOOP_ITEMS; n++) {
          add(`${titleCase(q.itemLabel)} ${n}.`);
        }
        // Opening the first item of an empty list from the review screen has
        // no "Provider 2." to announce it, so it says this instead.
        add(`Adding a new ${q.itemLabel}.`);
      }
    }
  });

  // formatTimeRemaining() buckets hard, so its whole range is a few dozen
  // strings.
  for (const seconds of TIME_SAMPLES) {
    const left = formatTimeRemaining(seconds);
    if (left) add(`${left} left.`);
  }

  return [...out];
}
