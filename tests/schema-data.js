// The schema is data.
//
// The Android port re-implements the interview from an exported copy of this
// schema (tools/export-schema.mjs -> tools/schema.json). Anything that is not
// plain JSON in the schema itself — a function, a Date, a regex — would be
// silently missing from that export, and a question's branch would silently
// stop being asked. So this test walks every value in the exported schema and
// fails on anything that is not JSON: the lint half of the "askIf into data"
// change.
//
// Makes no network requests.

import { SECTIONS, RATING_OPTIONS, RATING_GROUPS, RULE_OPERATORS, evalRule } from '../src/schema.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

// -- every value in the schema is JSON ---------------------------------------

function walk(value, path, seen) {
  if (value === null || value === undefined) return;
  if (typeof value === 'function') {
    check(`schema is data: function at ${path}`, false);
    return;
  }
  if (value instanceof RegExp || value instanceof Date) {
    check(`schema is data: ${value.constructor.name} at ${path}`, false);
    return;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return;   // shared rule objects are fine
    seen.add(value);
    for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, seen);
  }
}

walk(SECTIONS, 'SECTIONS', new Set());
walk(RATING_OPTIONS, 'RATING_OPTIONS', new Set());
walk(RATING_GROUPS, 'RATING_GROUPS', new Set());

// -- evalRule semantics -------------------------------------------------------

const ctx = (answers, item = null) => ({ answers, item });
const c = (name, rule, scope, expected, detail = '') =>
  check(name, evalRule(rule, scope) === expected,
    detail || `got ${evalRule(rule, scope)}, want ${expected}`);

c('null rule asks', null, ctx({}), true);
c('eq holds', { eq: ['has_guardian', true] }, ctx({ has_guardian: true }), true);
c('eq fails', { eq: ['has_guardian', true] }, ctx({}), false);
c('ne holds', { ne: ['level', 'A'] }, ctx({ level: 'B' }), true);
c('ne is true for a missing key — pair it with present', { ne: ['level', 'A'] }, ctx({}), true);
c('present holds', { present: 'pay_amount' }, ctx({ pay_amount: 15 }), true);
c('present fails on empty string', { present: 'pay_amount' }, ctx({ pay_amount: '' }), false);
c('present fails on missing', { present: 'pay_amount' }, ctx({}), false);
c('truthy', { truthy: 'ref1_name' }, ctx({ ref1_name: 'Ada' }), true);
c('truthy fails on empty', { truthy: 'ref1_name' }, ctx({ ref1_name: '' }), false);
c('notIn', { notIn: ['gender', ['M', 'F']] }, ctx({ gender: 'X' }), true);
c('notIn fails', { notIn: ['gender', ['M', 'F']] }, ctx({ gender: 'F' }), false);
c('form ssa', { form: 'ssa' }, ctx({ forms: 'both' }), true);
c('form ds only', { form: 'dsOnly' }, ctx({ forms: 'both' }), false);
c('form dsOnly holds', { form: 'dsOnly' }, ctx({ forms: 'ds' }), true);
c('and', { and: [{ present: 'x' }, { ne: ['x', 'A'] }] }, ctx({ x: 'B' }), true);
c('and fails', { and: [{ present: 'x' }, { ne: ['x', 'A'] }] }, ctx({ x: 'A' }), false);
c('or', { or: [{ eq: ['a', 1] }, { eq: ['b', 2] }] }, ctx({ b: 2 }), true);
c('not', { not: { eq: ['a', 1] } }, ctx({ a: 1 }), false);
c('item scope wins', { present: 'pay_amount' }, ctx({ pay_amount: 99 }, { pay_amount: '' }), false);
c('item scope reads the item', { present: 'pay_amount' }, ctx({}, { pay_amount: 12 }), true);
c('item scope never falls back to the answer set', { present: 'pay_amount' }, ctx({ pay_amount: 99 }, {}), false);
c('scope answers reads the answer set from a loop field',
  { present: 'pay_amount', scope: 'answers' }, ctx({ pay_amount: 99 }, {}), true);
c('a scope applies to the rules nested in it',
  { and: [{ eq: ['forms', 'ds'] }, { truthy: 'x' }], scope: 'answers' }, ctx({ forms: 'ds', x: 1 }, { x: 0 }), true);
c('an unknown rule never strands the interview', { weird: 1 }, ctx({}), true);

// -- every rule in the schema is well formed -----------------------------------
//
// evalRule() treats an operator it does not know as "ask", so that a bad rule
// can never strand the interview. The cost is that a typo ("eqq") silently
// asks the question every time. This catches it here instead, along with a
// key that names an answer the rule cannot see: a loop field reading a
// top-level id without `scope: 'answers'`, or the other way round.

const TOP_IDS = new Set(['forms']);
for (const section of SECTIONS) for (const q of section.questions) TOP_IDS.add(q.id);

/** Problems with one rule: [] when it is well formed. `keys` is what item scope can read. */
function lintRule(rule, where, scope, keys, problems = []) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    problems.push(`${where}: not a rule object`);
    return problems;
  }
  const ops = Object.keys(rule).filter(k => k !== 'scope');
  if (ops.length !== 1 || !RULE_OPERATORS.includes(ops[0])) {
    problems.push(`${where}: expected one of ${RULE_OPERATORS.join(', ')}, got ${JSON.stringify(Object.keys(rule))}`);
    return problems;
  }
  if (rule.scope !== undefined) {
    if (rule.scope !== 'answers' && rule.scope !== 'item') problems.push(`${where}: scope ${JSON.stringify(rule.scope)}`);
    if (rule.scope === 'item' && keys === null) problems.push(`${where}: item scope on a top-level question`);
    scope = rule.scope;
  }
  const known = scope === 'answers' ? TOP_IDS : (keys ?? new Set());
  const key = k => {
    if (typeof k !== 'string') problems.push(`${where}: key ${JSON.stringify(k)} is not a string`);
    else if (!known.has(k)) problems.push(`${where}: ${scope} scope has no ${JSON.stringify(k)}`);
  };
  const op = ops[0];
  const arg = rule[op];
  switch (op) {
    case 'and': case 'or':
      if (!Array.isArray(arg) || !arg.length) problems.push(`${where}: ${op} needs a list of rules`);
      else arg.forEach((r, i) => lintRule(r, `${where}.${op}[${i}]`, scope, keys, problems));
      break;
    case 'not': lintRule(arg, `${where}.not`, scope, keys, problems); break;
    case 'eq': case 'ne':
      if (!Array.isArray(arg) || arg.length !== 2) problems.push(`${where}: ${op} needs [key, value]`);
      else key(arg[0]);
      break;
    case 'present': case 'truthy': key(arg); break;
    case 'notIn':
      if (!Array.isArray(arg) || arg.length !== 2 || !Array.isArray(arg[1])) problems.push(`${where}: notIn needs [key, [values]]`);
      else key(arg[0]);
      break;
    case 'form':
      if (!['ssa', 'ds', 'dsOnly'].includes(arg)) problems.push(`${where}: form ${JSON.stringify(arg)}`);
      break;
  }
  return problems;
}

{
  const problems = [];
  let rules = 0;
  for (const section of SECTIONS) {
    for (const q of section.questions) {
      if (q.askIf != null) { rules++; lintRule(q.askIf, q.id, 'answers', null, problems); }
      if (q.type !== 'loop') continue;
      const fieldIds = new Set(q.fields.map(f => f.id));
      for (const f of q.fields) {
        if (f.askIf != null) { rules++; lintRule(f.askIf, `${q.id}.${f.id}`, 'item', fieldIds, problems); }
      }
    }
  }
  check('the schema has askIf rules to lint', rules > 50, `found ${rules}`);
  check('every askIf rule is well formed and reads keys its scope has', problems.length === 0,
    problems.slice(0, 8).join('\n     '));
}

// The lint itself fires.
{
  const fields = new Set(['pay_amount']);
  const flags = (rule, scope = 'answers', keys = null) => lintRule(rule, 'probe', scope, keys).length > 0;
  check('the lint catches an unknown operator', flags({ eqq: ['forms', 'ssa'] }));
  check('the lint catches two operators in one rule', flags({ eq: ['forms', 'ssa'], ne: ['forms', 'ds'] }));
  check('the lint catches a key the scope does not have', flags({ present: 'pay_amount' }));
  check('the lint catches a top-level id read from item scope', flags({ eq: ['forms', 'ssa'] }, 'item', fields));
  check('the lint catches item scope on a top-level question', flags({ present: 'pay_amount', scope: 'item' }));
  check('the lint accepts a well-formed field rule', !flags({ present: 'pay_amount' }, 'item', fields));
}

// The rules the schema actually uses behave like the closures they replaced.
{
  const a = answers => ({ answers, item: null });
  const rating = SECTIONS.find(s => s.id === 'adl').questions[1];
  check('rating explain is asked after a non-A rating',
    evalRule(rating.askIf, a({ eating_level: 'C' })) === true);
  check('rating explain is not asked after independent',
    evalRule(rating.askIf, a({ eating_level: 'A' })) === false);
  check('rating explain is not asked when unanswered',
    evalRule(rating.askIf, a({})) === false);

  const jobs = SECTIONS.find(s => s.id === 'employment').questions.find(q => q.id === 'jobs');
  check('the Starter Kit job list is gated on the form choice',
    evalRule(jobs.askIf, a({ forms: 'ds' })) === false);
  check('and asked with the Starter Kit',
    evalRule(jobs.askIf, a({ forms: 'ssa' })) === true);

  const ecName = SECTIONS.find(s => s.id === 'emergency').questions.find(q => q.id === 'ec_name');
  check('emergency contact is not asked when the guardian is it',
    evalRule(ecName.askIf, a({ has_guardian: true, ec_same_as_guardian: true })) === false);
  check('emergency contact is asked otherwise',
    evalRule(ecName.askIf, a({ has_guardian: false })) === true);

  const pay = SECTIONS.find(s => s.id === 'employment').questions.find(q => q.id === 'jobs')
    .fields.find(f => f.id === 'pay_frequency');
  check('pay frequency is asked once an amount exists',
    evalRule(pay.askIf, { answers: {}, item: { pay_amount: 20 } }) === true);
  check('pay frequency is not asked without an amount',
    evalRule(pay.askIf, { answers: {}, item: {} }) === false);
}

console.log(failures === 0 ? 'schema-data: all checks passed' : `schema-data: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
