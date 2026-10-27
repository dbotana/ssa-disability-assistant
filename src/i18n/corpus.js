// Every English source string that must exist in each non-English catalogue.
//
// Kept next to the tables it walks rather than generated from a build step, so
// a new prompt, option, label or fixed phrase fails tests/i18n.js until it is
// translated. tools/i18n-report.mjs prints this list and the misses.

import { SECTIONS, FORM_TITLES, RATING_OPTIONS, RATING_GROUPS } from '../schema.js';
import { allPhrases } from '../phrases.js';
import { LABELS } from '../summary.js';
import { WORKSHEET } from '../pdf.js';
import { MESSAGES } from './messages.js';
import { UI } from './ui.js';
import * as ssaKit from '../forms/ssa-starter-kit.js';
import * as dsIntake from '../forms/ds-intake.js';

// validate.js is intentionally unchanged; these are the strings its
// clarifyPrompt field can carry, and turn.js translates them where it speaks
// them.
const CLARIFY = [
  'Please answer yes or no.',
  'I need all nine digits of the Social Security number. You can say them one at a time.',
  'A routing number has nine digits. You can say them one at a time.',
  'I did not get the full account number. You can say the digits one at a time.',
  'I need a ten digit phone number, including the area code.',
  'A zip code has five digits. You can say them one at a time.',
  'I did not get a complete email address. You can spell it out, or say skip.',
  'Could you give me the month, day, and year?',
  'Could you give me the month and the year?',
  'Could you say that as a number?',
  'I did not catch that. Could you say it again?',
  'I am not sure I heard that correctly. Could you say it again?'
];

/** Strings the DS mapping writes as display labels (addendum labels). */
const DS_LABELS = [
  'Date', 'Applicant name', 'Date of birth', 'MaineCare number', 'Social Security number',
  'Street address', 'Mailing address', 'Town', 'State', 'Zip', 'Phone number',
  'Marital status', 'Email', 'Place of birth', 'Primary language', 'Deaf or hard of hearing',
  'Person or agency completing the application', 'Their mailing address', 'Their city',
  'Their county', 'Their zip', 'Their phone', 'Their fax', 'Their email',
  "Guardian's name", "Guardian's mailing address", "Guardian's city", "Guardian's county",
  "Guardian's zip", "Guardian's phone", "Guardian's email", "Guardian's relationship",
  'Emergency contact name', 'Emergency contact address', 'Emergency contact city',
  'Emergency contact county', 'Emergency contact zip', 'Emergency contact phone',
  'Emergency contact email', 'Emergency contact relationship',
  'Current diagnoses', 'Current medications', 'Medication allergies', 'Food allergies',
  'Environmental allergies', 'Dietary restrictions', 'Date of diagnosis', 'Age at diagnosis',
  'Confirmed diagnosis', 'Confirmed diagnosis 1', 'Confirmed diagnosis 2', 'Confirmed diagnosis 3',
  '5b. Diagnoses confirmed by psychological evaluation, continued',
  'diagnosis',
  'Current living arrangement', 'Who is in the household', 'Highest grade completed',
  'Name of school', 'Special education or 504 plan', 'Psychoeducational evaluation',
  'Currently employed', 'Employment history', 'Involvement with Vocational Rehabilitation',
  'Volunteer experiences', 'Applicant name', 'Guardian name', 'Other name',
  'Never married', 'Married', 'Widowed', 'Divorced', 'Present',
  'Anticipated graduation date', 'rating', 'explanation'
];

// The table and column titles the Starter Kit mapping writes into its
// addendum.
const SSA_TABLE_LABELS = ssaKit.TABLES.flatMap(t => [
  t.title, `${t.title}, continued`, t.itemLabel,
  ...t.columns.map(c => c.label)
]);

function stringsOf(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === 'object') return Object.values(value).flatMap(stringsOf);
  return [];
}

/** The sorted, de-duplicated list of English sources every catalogue needs. */
export function translationCorpus() {
  const list = [];
  const add = (...values) => { for (const v of values) list.push(...stringsOf(v)); };

  for (const section of SECTIONS) {
    add(section.title);
    for (const q of section.questions) {
      add(q.prompt, q.hint, q.warn, q.entryPrompt, q.repeatPrompt, q.itemLabel);
      if (q.options) for (const o of q.options) add(o.label);
      if (q.type === 'loop') {
        for (const f of q.fields) {
          add(f.prompt, f.hint, f.warn);
          if (f.options) for (const o of f.options) add(o.label);
        }
      }
    }
  }

  add(allPhrases());
  add(Object.values(MESSAGES));
  add(Object.values(UI));
  add(Object.values(LABELS));
  add(Object.values(WORKSHEET));
  add(Object.values(FORM_TITLES));
  add(RATING_OPTIONS.map(o => o.label));
  add(RATING_GROUPS.map(g => g.title));
  add(ssaKit.TITLE, ssaKit.ADDENDUM, dsIntake.TITLE, dsIntake.ADDENDUM);
  add(SSA_TABLE_LABELS);
  add(DS_LABELS);
  add(CLARIFY);

  return [...new Set(list.filter(s => typeof s === 'string' && s.trim()))].sort();
}
