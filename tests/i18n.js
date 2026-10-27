// The translator module: complete catalogues, independent channels, and the
// English output every existing path still expects.
//
// Runs with plain `node tests/i18n.js`. No DOM, no network.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CHANNELS, DEFAULT_SETTINGS, LANGUAGES, LANGUAGE_ORDER, MESSAGES, UI, STRINGS, LEXICONS,
  normalizeSettings, langFor, loadSettings, saveSettings, SETTINGS_KEY,
  translationCorpus, translate, message, fold, sttFor, formatDate, formatMonthYear,
  formatMoney, formatTimeRemaining, missingKeys
} from '../src/i18n/index.js';
import { summaryText } from '../src/summary.js';
import { localCommand } from '../src/commands.js';
import { parseLocal } from '../src/parse.js';
import { SECTIONS } from '../src/schema.js';
import { yamlParse, runScenario } from '../tools/turn-runner.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};
const eq = (name, actual, expected) => check(name,
  JSON.stringify(actual) === JSON.stringify(expected),
  `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)]
  .map(m => m[1]).sort();

// -- catalogue completeness ---------------------------------------------------

const corpus = translationCorpus();
const corpusSet = new Set(corpus);

check('corpus is not empty', corpus.length > 700, String(corpus.length));
for (const lang of ['fr', 'ln']) {
  const table = STRINGS[lang]?.strings ?? {};
  const keys = Object.keys(table);
  const missing = corpus.filter(k => !(k in table));
  const extra = keys.filter(k => !corpusSet.has(k));
  check(`${lang}: every corpus key has a translation`, missing.length === 0,
    missing.slice(0, 10).join(' | '));
  check(`${lang}: no translation outside the corpus`, extra.length === 0,
    extra.slice(0, 10).join(' | '));
  const empty = keys.filter(k => typeof table[k] !== 'string' || !table[k].trim());
  check(`${lang}: every value is a non-empty string`, empty.length === 0,
    empty.slice(0, 10).join(' | '));
  const badVars = corpus.filter(k => k in table
    && placeholders(k).join(',') !== placeholders(table[k]).join(','));
  check(`${lang}: placeholders are preserved`, badVars.length === 0,
    badVars.slice(0, 10).join(' | '));
  const remote = keys.filter(k => /:\/\//.test(table[k]));
  check(`${lang}: no catalogue value contains a URL`, remote.length === 0,
    remote.slice(0, 10).join(' | '));
}

// MESSAGES and UI are part of the corpus, not a side table.
for (const key of Object.keys(MESSAGES)) {
  check(`message ${key} is in the corpus`, corpusSet.has(MESSAGES[key]));
}
for (const [key, value] of Object.entries(UI)) {
  check(`ui ${key} is in the corpus`, corpusSet.has(value));
}

// -- D10: English templates are unchanged ------------------------------------

const renderings = [
  ['section_of', { number: 1, count: 3 }, 'Section 1 of 3.'],
  ['section_label_with_count', { number: 2, count: 3, title: 'Housing' }, 'Section 2 of 3 — Housing'],
  ['progress_line', { percent: 40, time: 'about five minutes' }, '40% done · about five minutes left'],
  ['readback_heard', { value: 'five' }, 'I heard five. Is that correct?'],
  ['no_recorded', { label: 'providers' }, 'No providers recorded.'],
  ['summary_row', { label: 'Legal first name', value: 'Ada' }, 'Legal first name: Ada.'],
  ['table_caption', { label: 'Conditions', number: 1 }, 'Conditions 1'],
  ['saved_expiry', { days: 7 }, ' Saved sessions are deleted after 7 days.'],
  ['pin_too_short', { count: 4 }, 'A PIN needs at least 4 characters. Longer is safer.'],
  ['stt_unavailable', {}, 'Voice answers in this language need a speech model that is not installed on this computer. You can type your answers.']
];
for (const [key, vars, expected] of renderings) {
  eq(`English ${key} is byte-identical`, message(key, vars, 'en'), expected);
}

// A value containing a placeholder is substituted once, never re-expanded.
eq('substitution is a single pass',
  message('summary_row', { label: 'X', value: '{value}' }, 'en'), 'X: {value}.');

// -- resolution and settings --------------------------------------------------

eq('channels', CHANNELS, ['input', 'output', 'screen', 'fill']);
eq('language order', LANGUAGE_ORDER, ['en', 'fr', 'ln']);
for (const channel of CHANNELS) {
  eq(`default ${channel}`, DEFAULT_SETTINGS[channel], 'en');
}

const mixed = { input: 'en', output: 'fr', screen: 'en', fill: 'ln' };
eq('langFor input', langFor('input', mixed), 'en');
eq('langFor output', langFor('output', mixed), 'fr');
eq('langFor screen', langFor('screen', mixed), 'en');
eq('langFor fill', langFor('fill', mixed), 'ln');
eq('garbage settings fall back per channel',
  normalizeSettings({ input: 'de', output: 'fr', screen: null, fill: 7 }),
  { input: 'en', output: 'fr', screen: 'en', fill: 'en' });

{
  const data = new Map();
  const storage = {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k)
  };
  eq('loadSettings starts at the defaults', loadSettings(storage), { ...DEFAULT_SETTINGS });
  saveSettings(mixed, storage);
  eq('saveSettings writes under the documented key', [...data.keys()], [SETTINGS_KEY]);
  eq('settings round-trip', loadSettings(storage), mixed);

  data.set(SETTINGS_KEY, '{not json');
  eq('unreadable settings fall back to defaults', loadSettings(storage), { ...DEFAULT_SETTINGS });
  data.set(SETTINGS_KEY, '{"input":"fr","screen":"xx"}');
  eq('invalid stored channels fall back individually',
    loadSettings(storage), { input: 'fr', output: 'en', screen: 'en', fill: 'en' });

  const refusing = { getItem: () => null, setItem() { throw new Error('denied'); } };
  check('a refusing storage does not throw',
    normalizeSettings(saveSettings(mixed, refusing)).fill === 'ln');
  eq('a missing storage still returns defaults', loadSettings(null), { ...DEFAULT_SETTINGS });
}

// -- speech packs -------------------------------------------------------------

check('English speech is installed', sttFor('en').installed === true);
check('French names a multilingual model that is not installed',
  sttFor('fr').model === 'whisper-base' && sttFor('fr').installed === false);
check('Lingala names a multilingual model that is not installed',
  sttFor('ln').model === 'whisper-base' && sttFor('ln').installed === false);
check('only English has a clip pack', LANGUAGES.en.clips !== null);
check('French clips are null', LANGUAGES.fr.clips === null);
check('Lingala clips are null', LANGUAGES.ln.clips === null);
eq('French voice fallback', LANGUAGES.fr.voiceFallback, ['en']);
eq('Lingala voice fallback', LANGUAGES.ln.voiceFallback, ['fr', 'en']);
eq('HTML language tag', LANGUAGES.fr.htmlLang, 'fr');

// -- command tables -----------------------------------------------------------

for (const [lang, tables] of Object.entries(LEXICONS)) {
  const commands = tables.commands ?? {};

  // One word, one meaning: `kobongola` was under both `back` and `correct`.
  const owners = new Map();
  for (const [cmd, words] of Object.entries(commands)) {
    for (const word of words) {
      check(`${lang}: "${word}" names only one command`, !owners.has(word),
        `also ${owners.get(word)}`);
      owners.set(word, cmd);
    }
  }

  if (lang === 'en') continue;

  // A word cannot be both a command and a recognition marker, or a user who
  // answers "encore" to an end date hears the question again instead of having
  // "still ongoing" recorded (D5).
  const present = (tables.present ?? []).map(src => new RegExp(`^(?:${src})$`));
  const yes = new Set((tables.yes ?? []).map(w => fold(w, lang)));
  const no = new Set((tables.no ?? []).map(w => fold(w, lang)));
  for (const [cmd, words] of Object.entries(commands)) {
    for (const word of words) {
      const folded = fold(word, lang);
      check(`${lang}: command "${word}" is not also a present marker`,
        !present.some(re => re.test(folded)), 'it would be read as a date, not a command');
      check(`${lang}: command "${word}" is not also a yes/no answer`,
        !yes.has(folded) && !no.has(folded), 'it would be read as an answer, not a command');
    }
  }
}

// -- commands with punctuation ------------------------------------------------

// The lexicon stores "c est tout" and "ou en suis je"; people type the
// apostrophe and the hyphen, so matching normalizes them to spaces.
eq("French: c'est tout is finish", localCommand("c'est tout", 'fr'), 'finish');
eq('French: j\'ai fini is finish', localCommand("j'ai fini", 'fr'), 'finish');
eq('French: où en suis-je is where', localCommand('où en suis-je ?', 'fr'), 'where');
eq("French: répète s'il vous plaît is repeat", localCommand("répète s'il vous plaît", 'fr'), 'repeat');
eq('French: encore is not a command', localCommand('encore', 'fr'), null);
eq("Lingala: c'est tout is finish", localCommand("c'est tout", 'ln'), 'finish');

// -- screen catalogue and the page --------------------------------------------

const html = readFileSync(join(REPO, 'index.html'), 'utf8');
const used = [...new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]))];
for (const key of used) check(`index.html uses UI.${key}`, key in UI);
for (const key of Object.keys(UI)) check(`UI.${key} is used in index.html`, used.includes(key));

// -- folding and formatting ---------------------------------------------------

eq('French folding strips the accent', fold('Février', 'fr'), 'fevrier');
eq('Lingala folding keeps the open vowels', fold('Kopɛtɛ', 'ln'), 'kopɛtɛ');
eq('English folding is identity', fold('Février', 'en'), 'Février');
eq('French date order', formatDate('1979-03-14', 'fr'), '14 mars 1979');
eq('Lingala date order uses the French month names', formatDate('1979-03-14', 'ln'), '14 mars 1979');
eq('English date order is unchanged', formatDate('1979-03-14', 'en'), 'March 14, 1979');
eq('French month/year', formatMonthYear('2019-11', 'fr'), 'novembre 2019');
eq('English still working', formatMonthYear('present', 'en'), 'still ongoing');
eq('French still working', formatMonthYear('present', 'fr'), 'toujours en cours');
eq('French money groups with ASCII spaces', formatMoney(1200, 'fr'), '1 200 $');
check('French money has no non-breaking space', !/\u00a0/.test(formatMoney(1200, 'fr')));
eq('English money keeps toLocaleString', formatMoney(1200, 'en'), (1200).toLocaleString());
eq('English time estimate is unchanged', formatTimeRemaining(120, 'en'), 'about two minutes');
eq('French time estimate is translated', formatTimeRemaining(120, 'fr'), 'environ deux minutes');

// -- the spoken read-back keeps false and zero --------------------------------

// A yes/no answered "no" and a numeric zero are answers, not blanks: the
// read-back formats the stored values, not the printable rows, so neither
// disappears from what the user hears.
{
  const answers = JSON.parse(readFileSync(
    join(REPO, 'tests/fixtures/answers/starter-kit.json'), 'utf8'));
  const en = summaryText(answers);
  check('English read-back speaks a "no" answer', en.includes('Marriage still active, no'));
  check('English read-back has no NaN', !/NaN/.test(en));
  const zeroed = { ...answers, jobs: [{ ...answers.jobs[0], hours_per_day: 0 }] };
  check('English read-back speaks a zero', summaryText(zeroed).includes('Average hours per day, 0'));
  const fr = summaryText(answers, { lang: 'fr' });
  check('French read-back runs and is not empty', fr.trim().length > 0);
}

// -- date prompts match the day-first parser ---------------------------------

// Non-English typed dates are read day first (D5), so no French date prompt
// may ask for the month first, and no example may spell the year in number
// words the parser cannot read. English keeps its own month-first wording,
// because English dates are month first in the parser too.
const dateKeys = new Set(['Could you give me the month, day, and year?']);
for (const section of SECTIONS) {
  const walk = questions => {
    for (const q of questions ?? []) {
      if (q.type === 'date') {
        if (q.prompt) dateKeys.add(q.prompt);
        if (q.hint) dateKeys.add(q.hint);
      }
      walk(q.fields);
    }
  };
  walk(section.questions);
}

check('the schema has date questions to check', dateKeys.size >= 8, String(dateKeys.size));
for (const key of dateKeys) {
  const text = translate(key, 'fr');
  check(`French date wording is day first: ${key}`,
    !/mois,\s*(puis\s+)?le jour/i.test(text), text);
}

for (const lang of ['fr', 'ln']) {
  const spelled = corpus.filter(k => /mille neuf|soixante/i.test(STRINGS[lang].strings[k] ?? ''));
  check(`${lang}: no date example spells the year in number words`, spelled.length === 0,
    spelled.slice(0, 10).join(' | '));
}

eq('a typed French date is read day first, the order its prompts ask for',
  parseLocal({ type: 'date' }, '05/06/1979', { typed: true, lang: 'fr' })?.value, '1979-06-05');

// -- the dialog never looks up its own output ---------------------------------

// A translated string passed back through translate() is recorded as a miss.
// Run the French scenario and require the miss set to be empty: every string
// the dialog shows or speaks is looked up exactly once.
{
  const doc = yamlParse(readFileSync(join(REPO, 'tools/turn-scenarios/french-interview.yaml'), 'utf8'));
  const failuresInRun = await runScenario(doc.scenario, doc.steps);
  check('French turn scenario passes', failuresInRun.length === 0, failuresInRun.join(' | '));
  eq('French turn scenario records no missing keys', missingKeys(), []);
}

// translate() itself never invents text for a missing key.
eq('missing translation falls back to English', translate('no such key', 'fr'), 'no such key');
eq('English translate is identity', translate('Housing', 'en'), 'Housing');

console.log(failures ? `i18n: ${failures} failure(s)` : 'i18n: all checks passed');
process.exit(failures ? 1 : 0);
