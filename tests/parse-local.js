// The local parser only answers when it is certain.
//
// Two properties matter more than coverage here:
//   1. It never produces a value that normalize() would reject. If it did, a
//      user would hear a confident read-back of an answer the form cannot
//      hold.
//   2. It returns null on anything ambiguous. Null costs a second question; a
//      wrong confident answer costs a wrong Social Security number on a
//      benefits application.
//
// Makes no API calls.

import { parseLocal } from '../src/parse.js';
import { normalize } from '../src/validate.js';
import { SECTIONS, findQuestion } from '../src/schema.js';
import { createEngine } from '../src/engine.js';
import { VALUE_CASES, DEFER_CASES } from '../tools/golden/parse-corpus.mjs';

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
    r === null ? 'got null (would be asked again)' : `got ${JSON.stringify(r.value)}`);
}

/** Asserts the parser returned null, so the question would be asked again. */
function defer(type, input, extra = {}) {
  const r = parseLocal(q(type, extra), input);
  check(`${type} ${JSON.stringify(input)} defers`, r === null,
    r ? `got ${JSON.stringify(r.value)} at confidence ${r.confidence}` : '');
}

// -- the canonical corpus --------------------------------------------------
//
// The val/defer cases live in tools/golden/parse-corpus.mjs, shared with the
// `parse` golden that pins the Kotlin port. Options are resolved through the
// schema by name, so a case always runs against the real option lists.

const opts = id => findQuestion(id).options;

/** The question a corpus case runs against: a real one, or a bare one of its type. */
function caseQuestion({ type, optionsKey, questionKey }) {
  if (questionKey) {
    const real = findQuestion(questionKey);
    if (!real || real.type !== type) throw new Error(`corpus: ${questionKey} is not a ${type} question`);
    return real;
  }
  return q(type, optionsKey ? { options: opts(optionsKey) } : {});
}

for (const c of VALUE_CASES) {
  const r = parseLocal(caseQuestion(c), c.input);
  check(`${c.questionKey ?? c.type} ${JSON.stringify(c.input)} -> ${JSON.stringify(c.value)}`,
    r !== null && JSON.stringify(r.value) === JSON.stringify(c.value),
    r === null ? 'got null (would be asked again)' : `got ${JSON.stringify(r.value)}`);
}

for (const c of DEFER_CASES) {
  const r = parseLocal(caseQuestion(c), c.input);
  check(`${c.questionKey ?? c.type} ${JSON.stringify(c.input)} defers`, r === null,
    r ? `got ${JSON.stringify(r.value)} at confidence ${r.confidence}` : '');
}

// normalize() maps a label or paraphrase back to the value, and refuses others.
{
  const RATING = { options: opts('eating_level') };
  const n = (value, extra) => normalize({ value, confidence: 1 }, q('choice', extra));
  check('normalize accepts a value', n('B', RATING).value === 'B');
  check('normalize maps a label', n('Needs supervision', RATING).value === 'B');
  check('normalize refuses an unknown answer', n('sometimes', RATING).needsClarification === true);
}

// Typed free text is not a transcript, and is left exactly as written: null
// here, and main.js keeps the text itself.
for (const s of ['de la Cruz', 'iPhone repair shop', 'Smith Jr.', 'Acme Tools, Inc.']) {
  const r = parseLocal(q('text'), s, { typed: true });
  check(`typed text ${JSON.stringify(s)} is left as written`, r === null,
    r ? `got ${JSON.stringify(r.value)}` : '');
}
{
  const r = parseLocal(q('date'), 'March 14th 1979', { typed: true });
  check('a typed date is still parsed', r?.value === '1979-03-14', JSON.stringify(r?.value));
}

// Wrong-length digits still reach normalize(), which asks for a correction.
{
  const r = parseLocal(q('ssn'), '1234');
  check('short ssn is parsed, then rejected by normalize',
    r !== null && normalize(r, q('ssn')).needsClarification === true,
    r === null ? 'parser deferred' : 'normalize accepted a 4-digit SSN');
}

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

// -- the live question carries what the parser reads ------------------------
//
// The app parses against engine.current(), not the schema node, so `per` and
// `kind` have to survive buildCurrent(). Without them "$20 an hour" defers on
// the one question that is meant to accept it.
{
  const engine = createEngine(SECTIONS, {
    answers: { forms: 'ssa', jobs: [{ employer: 'Acme' }], education_level: 'High school' }
  });
  const pay = engine.jumpTo('pay_amount', 0, 'jobs');
  check('current() carries per', pay?.per === 'any', JSON.stringify(pay?.per));
  check('a job\'s pay with its period parses through current()',
    parseLocal(pay, '$20 an hour')?.value === 20, JSON.stringify(parseLocal(pay, '$20 an hour')));
  const year = engine.jumpTo('education_year');
  check('current() carries kind', year?.kind === 'year', JSON.stringify(year?.kind));
  check('a spoken year parses through current()',
    parseLocal(year, 'nineteen ninety eight')?.value === 1998);
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

// Property 1: every text question keeps what was said.
{
  const lost = allQuestions
    .filter(x => x.type === 'text')
    .filter(x => parseLocal(x, 'some typed answer')?.value !== 'Some typed answer');
  check('every free-text question keeps the answer', lost.length === 0,
    lost.slice(0, 3).map(x => `  ${x.id}`).join('\n'));
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

// Property 3: confidence is never in the hedge zone. normalize() in
// validate.js treats < 0.5 as "re-ask"; the local parser must be certain or
// silent.
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
