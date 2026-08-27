// Spoken field name -> question target. Runs with plain `node tests/correct-match.js`.
// Zero API calls — this exercises the local matcher and engine.setAnswer only.

import { resolveTarget, resolveChoice, describeTarget, stripLeadIn, buildTargets } from '../src/correct.js';
import { createEngine } from '../src/engine.js';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) return;
  failures++;
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/** An answer set with two providers and two jobs, for loop-scoped matching. */
const ANSWERS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  date_of_birth: '1815-12-10',
  ssn: '123456789',
  onset_date: '2021-03',
  routing_number: '021000021',
  account_number: '5544332211',
  ref1_name: 'Mary Somerville',
  ref1_phone: '5551234567',
  providers: [
    { name: 'Dr. Babbage', address: '1 Analytical Way', phone: '5550001111' },
    { name: 'City Clinic', address: '2 Difference Rd', phone: '5552223333' }
  ],
  jobs: [
    { employer: 'Royal Society', job_title: 'Analyst', hours_per_week: 40 },
    { employer: 'Observatory', job_title: 'Computer', hours_per_week: 20 }
  ],
  medications: [{ name: 'Aspirin', reason: 'Headaches' }]
};

/** Resolve, asserting a unique hit, and return the target. */
function resolveOne(phrase, answers = ANSWERS) {
  const r = resolveTarget(phrase, answers);
  if (!r.ok) {
    failures++;
    console.error(`FAIL  resolve "${phrase}" — ${r.reason}` +
      (r.candidates ? ` (${r.candidates.map(describeTarget).join(' | ')})` : ''));
    return null;
  }
  return r.target;
}

// --- 1. Lead-in phrases are stripped ---------------------------------------
{
  eq('strip "change my phone number"', stripLeadIn('change my phone number'), 'phone number');
  eq('strip "I want to correct my date of birth"',
    stripLeadIn('I want to correct my date of birth'), 'date of birth');
  eq('strip "fix the employer"', stripLeadIn('fix the employer'), 'employer');
  eq('leaves a bare field name alone', stripLeadIn('date of birth'), 'date of birth');
}

// --- 2. Top-level fields resolve from natural phrasings ---------------------
{
  const cases = [
    ['change my first name', 'first_name'],
    ['my last name', 'last_name'],
    ['change my date of birth', 'date_of_birth'],
    ['my birthday is wrong', 'date_of_birth'],
    ['correct my social security number', 'ssn'],
    ['change my routing number', 'routing_number'],
    ['fix my bank account number', 'account_number'],
    ['change the onset date', 'onset_date']
  ];
  for (const [phrase, id] of cases) {
    const t = resolveOne(phrase);
    if (t) eq(`"${phrase}" -> ${id}`, t.id, id);
  }
}

// --- 3. A field name that repeats across loops is scoped by the group word --
{
  const p = resolveOne("change my doctor's phone number");
  if (p) {
    eq('doctor phone -> providers.phone', [p.loopId, p.id], ['providers', 'phone']);
    eq('defaults to the first provider', p.loopIndex, 0);
  }

  const j = resolveOne("change the employer for my job");
  if (j) eq('job employer -> jobs.employer', [j.loopId, j.id], ['jobs', 'employer']);

  const m = resolveOne('change the name of my medication');
  if (m) eq('medication name -> medications.name', [m.loopId, m.id], ['medications', 'name']);
}

// --- 4. Ordinals pick the right loop item ----------------------------------
{
  const second = resolveOne("change the second provider's address");
  if (second) {
    eq('second provider address', [second.loopId, second.id], ['providers', 'address']);
    eq('lands on item index 1', second.loopIndex, 1);
    eq('reads back its stored value', second.value, '2 Difference Rd');
  }

  const first = resolveOne("the first provider's phone");
  if (first) eq('first provider is index 0', first.loopIndex, 0);

  const last = resolveOne("change the last provider's name");
  if (last) eq('"last" resolves to the final item', last.loopIndex, 1);

  const job2 = resolveOne('change the second job title');
  if (job2) eq('second job title', [job2.loopId, job2.id, job2.loopIndex], ['jobs', 'job_title', 1]);
}

// --- 4b. An item number that does not exist is a miss, not item 1 ----------
{
  // One provider recorded; the user asks for the second.
  const one = { providers: [{ name: 'Dr. Babbage', address: '1 Analytical Way' }] };
  const r = resolveTarget("change the second provider's address", one);
  check('a missing item does not fall back to item 1',
    !r.ok, `resolved to item ${r.ok ? r.target.loopIndex : '-'}`);

  // The same phrase must still work once the item exists.
  const two = resolveTarget("change the second provider's address", ANSWERS);
  check('the same phrase works when item 2 exists', two.ok);
  if (two.ok) eq('and lands on item 2', two.target.loopIndex, 1);

  // "last" tracks the real item count rather than a fixed index.
  const last = resolveTarget("change the last provider's address", one);
  check('"last" resolves against a one-item loop', last.ok);
  if (last.ok) eq('"last" of one item is item 0', last.target.loopIndex, 0);
}

// --- 4c. "Change my phone number" — the phrase this feature exists for -----
{
  // This form has no single "your phone number" field: phone numbers hang off
  // providers, references, and the landlord. Silently picking one would
  // overwrite a record the user never named, so the honest answer is to ask.
  const withPhones = {
    ref1_name: 'Mary Somerville',
    ref1_phone: '5551112222',
    landlord_name: 'Mr. Babbage',
    landlord_phone: '5553334444',
    providers: [{ name: 'Dr. Babbage', phone: '5550001111' }]
  };
  const r = resolveTarget('change my phone number', withPhones);
  check('a bare "phone number" asks which one', !r.ok && r.reason === 'ambiguous',
    `got ${r.ok ? describeTarget(r.target) : r.reason}`);
  if (!r.ok && r.candidates) {
    const described = r.candidates.map(describeTarget).join(' | ');
    check('the reference phone is offered', /reference/i.test(described), described);
    check('the landlord phone is offered', /landlord/i.test(described), described);
    check('the provider phone is offered', /provider/i.test(described), described);
  }

  // Naming the owner removes the ambiguity entirely.
  const doc = resolveTarget("change my doctor's phone number", withPhones);
  check('naming the doctor resolves outright', doc.ok);
  if (doc.ok) eq('and points at the provider', [doc.target.loopId, doc.target.id], ['providers', 'phone']);

  const ll = resolveTarget('change my landlord phone number', withPhones);
  check('naming the landlord resolves outright', ll.ok);
  if (ll.ok) eq('and points at the landlord', ll.target.id, 'landlord_phone');
}

// --- 5. A genuinely ambiguous phrase asks instead of guessing ---------------
{
  // "name" alone spans providers, medications, and the two legal-name fields.
  const r = resolveTarget('change the name', ANSWERS);
  check('bare "name" is ambiguous', !r.ok && r.reason === 'ambiguous',
    `got ${JSON.stringify(r.ok ? r.target.id : r.reason)}`);
  if (!r.ok && r.candidates) {
    check('ambiguity offers candidates', r.candidates.length > 1);
    check('candidates are describable',
      r.candidates.every(c => typeof describeTarget(c) === 'string' && describeTarget(c).length));
  }
}

// --- 6. Choosing from an ambiguous list ------------------------------------
{
  const r = resolveTarget('change the name', ANSWERS);
  check('setup: ambiguous', !r.ok);
  const candidates = r.candidates ?? [];

  const byOrdinal = resolveChoice('the second one', candidates);
  eq('ordinal picks the second candidate', byOrdinal, candidates[1]);

  const byNumber = resolveChoice('1', candidates);
  eq('a bare number picks the first', byNumber, candidates[0]);

  eq('an unrelated reply picks nothing', resolveChoice('bananas', candidates), null);
}

// --- 7. Nonsense resolves to nothing, rather than to a wrong field ----------
{
  for (const phrase of ['change my favorite color', 'xyzzy', '   ']) {
    const r = resolveTarget(phrase, ANSWERS);
    check(`"${phrase}" finds nothing`, !r.ok && r.reason === 'none',
      `got ${r.ok ? r.target.id : r.reason}`);
  }
}

// --- 8. Loops with no items contribute no targets ---------------------------
{
  const targets = buildTargets({ first_name: 'Ada' });
  check('no provider targets when none were added',
    !targets.some(t => t.loopId === 'providers'));
  check('top-level targets still present',
    targets.some(t => t.id === 'first_name'));

  const r = resolveTarget("change my doctor's phone number", { first_name: 'Ada' });
  check('naming an empty loop finds nothing', !r.ok);
}

// --- 9. setAnswer writes in place without moving the cursor ----------------
{
  const e = createEngine();
  // Walk far enough to answer the first two questions.
  e.submit('Ada');
  e.submit('Lovelace');
  const before = e.current().id;

  const ok = e.setAnswer('first_name', 'Augusta');
  check('setAnswer reports success', ok);
  eq('value was replaced', e.answers().first_name, 'Augusta');
  eq('cursor did not move', e.current().id, before);
  eq('the other answer is untouched', e.answers().last_name, 'Lovelace');

  check('setAnswer rejects an unknown id', e.setAnswer('not_a_field', 'x') === false);
}

// --- 10. setAnswer targets one loop item, scoped by loop id -----------------
{
  const e = createEngine();
  // Drive to the providers loop and record two items.
  let guard = 0;
  while (e.current() && guard++ < 400) {
    const q = e.current();
    if (q.loopId === 'providers' && q.loopPhase === 'entry' && q.itemNumber === 1) break;
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  check('reached the providers loop', !!e.current());

  e.submit(true);                       // yes, add a provider
  e.submit('Dr. Babbage');              // name
  e.submit('1 Analytical Way');         // address
  e.submit('5550001111');               // phone
  e.submit('2020-01');                  // first_seen
  e.submit('2021-01');                  // last_seen
  e.submit(true);                       // yes, add another
  e.submit('City Clinic');
  e.submit('2 Difference Rd');
  e.submit('5552223333');
  e.submit('2022-01');
  e.submit('2023-01');

  const items = e.answers().providers;
  eq('two providers recorded', items.length, 2);

  const ok = e.setAnswer('phone', '5559998888', { loopId: 'providers', loopIndex: 1 });
  check('loop-scoped setAnswer succeeds', ok);
  eq('second provider phone changed', e.answers().providers[1].phone, '5559998888');
  eq('first provider phone untouched', e.answers().providers[0].phone, '5550001111');

  check('rejects an out-of-range item',
    e.setAnswer('phone', '1', { loopId: 'providers', loopIndex: 9 }) === false);
  check('rejects a field that is not in that loop',
    e.setAnswer('employer', 'x', { loopId: 'providers', loopIndex: 0 }) === false);
}

// --- 11. jumpTo is scoped by loop id ---------------------------------------
{
  const e = createEngine();
  let guard = 0;
  while (e.current() && guard++ < 400) {
    const q = e.current();
    if (q.loopId === 'providers' && q.loopPhase === 'entry') break;
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  e.submit(true);
  e.submit('Dr. Babbage');
  e.submit('1 Analytical Way');
  e.submit('5550001111');
  e.submit('2020-01');
  e.submit('2021-01');
  e.submit(false);                      // no more providers

  const q = e.jumpTo('phone', 0, 'providers');
  check('jumped to the provider phone', !!q, 'jumpTo returned null');
  if (q) {
    eq('landed on the right field', q.id, 'phone');
    eq('landed in the right loop', q.loopId, 'providers');
  }

  // An item that does not exist must not be jumped to.
  eq('jumpTo refuses a missing item', e.jumpTo('phone', 5, 'providers'), null);
}

// --- 12. describeTarget names loop items for the spoken prompt -------------
{
  const t = resolveOne("change the second provider's address");
  if (t) {
    const d = describeTarget(t);
    check('describes the item number', /provider 2/i.test(d), d);
    check('describes the field', /address/i.test(d), d);
  }
  const top = resolveOne('change my first name');
  if (top) eq('a top-level target is just its label', describeTarget(top), top.label);
}

console.log(failures === 0
  ? '\nAll correction checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
