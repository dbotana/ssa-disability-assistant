// Export the interview schema and the correction tables as data.
//
// The Android app re-implements the interview from this file rather than from
// the source: prompts, option lists, askIf rules, hints, the correction
// vocabulary and the fixed spoken phrases are all data, and this export is what tools/golden/check.mjs
// verifies is fresh in CI. Anything that is not JSON in the source would be
// missing here, which is exactly what tests/schema-data.js guards against.
//
// Usage: node tools/export-schema.mjs
// Writes: tools/schema.json

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SECTIONS, SCHEMA_VERSION, FORM_IDS, FORM_TITLES,
  RATING_OPTIONS, RATING_GROUPS, DIGIT_TYPES, SENSITIVE_TYPES
} from '../src/schema.js';
import { ALIASES, LOOP_WORDS, ORDINALS, STOP, ratingAliases, MAX_LOOP_ITEMS } from '../src/correct.js';
import { LABELS } from '../src/summary.js';
import * as say from '../src/phrases.js';

const out = {
  schemaVersion: SCHEMA_VERSION,
  formIds: FORM_IDS,
  formTitles: FORM_TITLES,
  sections: SECTIONS,
  ratingOptions: RATING_OPTIONS,
  ratingGroups: RATING_GROUPS,
  digitTypes: [...DIGIT_TYPES],
  sensitiveTypes: [...SENSITIVE_TYPES],
  correct: {
    aliases: ALIASES,
    ratingAliases: ratingAliases(),
    loopWords: LOOP_WORDS,
    ordinals: ORDINALS,
    stop: [...STOP],
    maxLoopItems: MAX_LOOP_ITEMS
  },
  labels: LABELS,
  // Every fixed string the interview speaks, by its name in phrases.js, so
  // the Android app reads the same words the clips in audio/ were made from
  // instead of a hand-kept copy. Maps stay maps (INTRO, REASK, ERRORS).
  phrases: Object.fromEntries(Object.entries(say).filter(([, v]) => typeof v !== 'function'))
};

const dest = join(dirname(fileURLToPath(import.meta.url)), 'schema.json');
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${dest}`);
