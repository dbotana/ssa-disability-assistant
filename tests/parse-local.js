// The local parser only answers when it is certain.
//
// Two properties matter more than coverage here:
//   1. It never produces a value that normalize() would reject. If it did, a
//      user would hear a confident read-back of an answer the form cannot
//      hold.
//   2. It returns null on anything ambiguous. Null costs a model call; a wrong
//      confident answer costs a wrong Social Security number on a benefits
//      application.
//
// Makes no API calls.

import { parseLocal } from '../src/parse.js';
import { normalize } from '../src/llm.js';
import { SECTIONS, findQuestion } from '../src/schema.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const q = (type, extra = {}) => ({ type, prompt: `test ${type}`, ...extra });

/** Asserts the parser produced this exact value. */
function val(type, input, expected, extra = {}) {
  const r = parseLocal(q(type, extra), input);
  check(`${type} ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`,
    r !== null && r.value === expected,
    r === null ? 'got null (deferred to model)' : `got ${JSON.stringify(r.value)}`);
}

/** Asserts the parser deferred. */
function defer(type, input, extra = {}) {
  const r = parseLocal(q(type, extra), input);
  check(`${type} ${JSON.stringify(input)} defers`, r === null,
    r ? `got ${JSON.stringify(r.value)} at confidence ${r.confidence}` : '');
}

// -- yes / no --------------------------------------------------------------

for (const s of ['yes', 'Yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'right',
  'true', 'affirmative', 'ok', 'okay', "that's right", 'uh huh', 'Yes.', 'yes!']) {
  val('yesno', s, true);
}
for (const s of ['no', 'No', 'nope', 'nah', 'negative', 'false', 'incorrect',
  'wrong', "that's wrong", 'uh uh', 'No.']) {
  val('yesno', s, false);
}
val('yesno', 'um, yes', true);          // lead filler stripped
val('yesno', 'well no', false);

// Anything beyond a bare yes/no is someone saying something else.
defer('yesno', 'yes but actually no');
defer('yesno', 'no wait, yes');
defer('yesno', 'yes I worked there until 2019');
defer('yesno', 'go back');
defer('yesno', 'I think so');
defer('yesno', 'maybe');
defer('yesno', 'can you repeat that');

// -- sensitive digits ------------------------------------------------------

val('ssn', '123456789', '123456789');
val('ssn', '123 45 6789', '123456789');
val('ssn', '123-45-6789', '123456789');
val('ssn', 'one two three four five six seven eight nine', '123456789');
val('ssn', 'one two three dash four five dash six seven eight nine', '123456789');
// Eight digits: parsed as a digit string, then rejected by normalize() —
// the parser's job is to read digits, not to enforce length.
val('ssn', 'five five five oh one two three four', '55501234');
val('routing', 'nine eight seven six five four three two one', '987654321');
val('account', '4321', '4321');

// Ambiguous shorthand has two readings. Never guess these.
defer('ssn', 'double seven three four five six seven eight nine');
defer('ssn', 'triple oh one two three four five six');
defer('ssn', 'seventeen twenty three forty five sixty seven');
// Any real word means this is not a bare digit string.
defer('ssn', 'my social is 123 45 6789');
defer('ssn', 'I do not remember');
defer('ssn', 'it starts with 123');
defer('account', 'the one ending in 4321');

// Wrong-length digits still reach normalize(), which asks for a correction.
// The parser's job is only to say "this is a digit string".
{
  const r = parseLocal(q('ssn'), '1234');
  check('short ssn is parsed, then rejected by normalize',
    r !== null && normalize(r, q('ssn')).needsClarification === true,
    r === null ? 'parser deferred' : 'normalize accepted a 4-digit SSN');
}

// -- phone -----------------------------------------------------------------

val('phone', '5551234567', '5551234567');
val('phone', '555 123 4567', '5551234567');
val('phone', '(555) 123-4567', '5551234567');
val('phone', 'five five five one two three four five six seven', '5551234567');
defer('phone', 'you can reach me at 555 123 4567');

// -- dates -----------------------------------------------------------------

val('date', '1979-03-14', '1979-03-14');
val('date', '3/14/79', '1979-03-14');
val('date', '03-14-1979', '1979-03-14');
val('date', 'March 14th 1979', '1979-03-14');
val('date', 'march 14 1979', '1979-03-14');
val('date', 'the 14th of March 1979', '1979-03-14');
val('date', 'March 14th, 1979', '1979-03-14');
val('date', 'Mar 14 1979', '1979-03-14');
val('date', 'um, March 14th 1979', '1979-03-14');

// Two-digit years resolve to the past, never the future.
val('date', 'March 14th 79', '1979-03-14');
val('date', 'January 1st 05', '2005-01-01');

// Impossible and future dates are a misread, not an answer.
defer('date', 'February 30 1990');
defer('date', 'February 30th, 1990');
defer('date', 'March 32nd 1979');
defer('date', 'March 14th 2099');
defer('date', 'next Tuesday');
defer('date', 'sometime in the eighties');
defer('date', 'I do not remember exactly');
defer('date', 'March 1979');            // no day for a full date

// -- month / year ----------------------------------------------------------

val('monthyear', '1979-03', '1979-03');
val('monthyear', 'March 1979', '1979-03');
val('monthyear', 'march of 79', '1979-03');
val('monthyear', '3/79', '1979-03');
val('monthyear', 'August 2015', '2015-08');

// The schema literally prompts "you can say still seeing them".
val('monthyear', 'still working', 'present');
val('monthyear', 'still seeing them', 'present');
val('monthyear', 'ongoing', 'present');
val('monthyear', 'I still go there', 'present');
val('monthyear', 'currently', 'present');

defer('monthyear', 'a few years ago');
defer('monthyear', 'March 2099');
// "still, it was March 2015" names a real date — not the present sentinel.
val('monthyear', 'still March 2015', '2015-03');

// -- money and numbers -----------------------------------------------------

val('money', '1200', 1200);
val('money', '$1,200', 1200);
val('money', '1200 dollars', 1200);
val('money', 'about $1,200 a month', 1200);
val('number', '3', 3);
val('number', '12', 12);

// A range is a question for the user, not a number to pick from.
defer('money', 'eight hundred to a thousand');
defer('money', 'between 800 and 1000');
defer('money', '800 or 900');
defer('money', 'twelve hundred');       // number words: defer to the model
defer('number', 'a few');

// -- free text always defers ----------------------------------------------

for (const s of ['John', 'Springfield', 'diabetes', 'Dr. Smith at City Clinic']) {
  defer('text', s);
}

// -- choice ------------------------------------------------------------------

const opts = id => findQuestion(id).options;
const FORMS = { options: opts('forms') };
const RATING = { options: opts('eating_level') };
const PAY = { options: opts('pay_frequency') };
const MARITAL = { options: opts('marital_status') };

val('choice', 'the starter kit', 'ssa', FORMS);
val('choice', 'Starter Kit.', 'ssa', FORMS);
val('choice', 'developmental services', 'ds', FORMS);
val('choice', "um, it's the Maine application", 'ds', FORMS);
val('choice', 'both', 'both', FORMS);
val('choice', 'both of them please', 'both', FORMS);
// Naming each form is choosing both.
val('choice', 'the starter kit and developmental services', 'both', FORMS);
defer('choice', 'not the starter kit', FORMS);            // a negation is never an answer
defer('choice', 'I am not sure', FORMS);
defer('choice', 'the blue one', FORMS);

val('choice', 'independent', 'A', RATING);
val('choice', 'B', 'B', RATING);
val('choice', 'letter c', 'C', RATING);
val('choice', 'dee', 'D', RATING);
val('choice', 'needs supervision', 'B', RATING);
val('choice', 'they need physical assistance', 'D', RATING);
// "total assistance" is not also "assistance": the longer phrase wins.
val('choice', 'total assistance', 'E', RATING);
val('choice', 'needs skills training', 'C', RATING);
defer('choice', 'a little help sometimes', RATING);      // "a" inside a sentence is not option A
defer('choice', 'supervision or training', RATING);      // two options named
defer('choice', "doesn't need supervision", RATING);

val('choice', 'every two weeks', 'biweekly', PAY);
val('choice', 'hourly', 'hour', PAY);
val('choice', 'twice a month', 'twice_month', PAY);
val('choice', 'per year', 'year', PAY);
val('choice', 'never married', 'never_married', MARITAL);
val('choice', 'widowed', 'widowed', MARITAL);

// normalize() maps a label or paraphrase back to the value, and refuses others.
{
  const n = (value, extra) => normalize({ value, confidence: 1 }, q('choice', extra));
  check('normalize accepts a value', n('B', RATING).value === 'B');
  check('normalize maps a label', n('Needs supervision', RATING).value === 'B');
  check('normalize refuses an unknown answer', n('sometimes', RATING).needsClarification === true);
}

// -- zip and email -------------------------------------------------------------

val('zip', '04101', '04101');
val('zip', 'oh four one oh one', '04101');
val('zip', '04101-1234', '041011234');
defer('zip', '4101');
defer('zip', 'Portland');

val('email', 'Jane.Doe@Example.com', 'jane.doe@example.com');
val('email', 'jane dot doe at example dot com', 'jane.doe@example.com');
defer('email', 'jane at the office');
defer('email', 'I do not have one');

// -- dates that may lie ahead ----------------------------------------------------

{
  const next = new Date().getFullYear() + 1;
  defer('monthyear', `June ${next}`);                        // most dates are past
  val('monthyear', `June ${next}`, `${next}-06`, { allowFuture: true });
  const yy = String(next % 100).padStart(2, '0');
  const r = parseLocal(q('monthyear', { allowFuture: true }), `June ${yy}`);
  check('a two-digit year near the future stays in this century when allowed',
    r?.value === `${next}-06`, JSON.stringify(r));
}

// -- properties over the real schema --------------------------------------

const allQuestions = [];
for (const section of SECTIONS) {
  for (const question of section.questions) {
    allQuestions.push(question);
    for (const f of question.fields ?? []) allQuestions.push(f);
  }
}

check('the schema has questions to test', allQuestions.length > 50,
  `found ${allQuestions.length}`);

// Property 1: every text question defers, always.
{
  const leaked = allQuestions
    .filter(x => x.type === 'text')
    .filter(x => parseLocal(x, 'some typed answer') !== null);
  check('parseLocal never answers a free-text question', leaked.length === 0,
    leaked.slice(0, 3).map(x => `  ${x.id}`).join('\n'));
}

// Property 2: the parser and the validator never disagree. A confident local
// value that normalize() would reject is the failure this guards.
{
  const probes = [
    'yes', 'no', '123456789', '5551234567', 'March 14th 1979', '1979-03-14',
    'March 1979', 'still working', '1200', '$1,200', 'twelve hundred',
    'double seven', 'next Tuesday', 'February 30 1990', 'I do not remember',
    '', '   ', 'go back', 'repeat that'
  ];
  const bad = [];
  for (const question of allQuestions) {
    for (const probe of probes) {
      const r = parseLocal(question, probe);
      if (!r) continue;
      const n = normalize({ ...r }, question);
      if (n.needsClarification && r.confidence >= 0.5 && question.type !== 'ssn'
        && question.type !== 'routing' && question.type !== 'account') {
        bad.push(`${question.id} (${question.type}) ${JSON.stringify(probe)} -> ${JSON.stringify(r.value)}`);
      }
    }
  }
  check('a confident local parse is never rejected by normalize', bad.length === 0,
    bad.slice(0, 5).join('\n     '));
}

// Property 3: confidence is never in the hedge zone. The guard at llm.js:294
// treats < 0.5 as "re-ask"; the local parser must be certain or silent.
{
  const probes = ['yes', 'no', '123456789', 'March 14th 79', 'march of 79', '3/79', '1200'];
  const hedged = [];
  for (const question of allQuestions) {
    for (const probe of probes) {
      const r = parseLocal(question, probe);
      if (r && r.confidence < 0.5) hedged.push(`${question.id} ${JSON.stringify(probe)} @ ${r.confidence}`);
    }
  }
  check('parseLocal never returns confidence below 0.5', hedged.length === 0,
    hedged.slice(0, 5).join('\n     '));
}

// Property 4: empty input never produces an answer.
{
  const leaked = allQuestions.filter(x =>
    parseLocal(x, '') !== null || parseLocal(x, '   ') !== null || parseLocal(x, null) !== null);
  check('empty input always defers', leaked.length === 0,
    leaked.slice(0, 3).map(x => `  ${x.id}`).join('\n'));
}

console.log(failures === 0 ? 'parse-local: all checks passed' : `parse-local: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
