// Adding loop entries from the review screen. Runs with `node tests/add-item.js`.
// Zero API calls — engine surgery and the spoken-phrase matcher only.
//
// The bug this guards against: "add another condition" used to resolve to the
// first condition's name field and overwrite it, so asking for a second
// condition cost the user the one they already had.

import { createEngine } from '../src/engine.js';
import {
  isAdditionPhrase, resolveAddition, resolveTarget, isDeletionPhrase, MAX_LOOP_ITEMS
} from '../src/correct.js';

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

/** Drive a fresh Starter Kit engine to the given loop's entry prompt. */
function engineAtLoop(loopId) {
  const e = createEngine();
  let guard = 0;
  while (e.current() && guard++ < 500) {
    const q = e.current();
    if (q.loopId === loopId && q.loopPhase === 'entry') return e;
    e.submit(q.id === 'forms' ? 'ssa' : q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  return e;
}

/** Record the named conditions, then walk on past the loop. */
function withConditions(names) {
  const e = engineAtLoop('conditions');
  for (const name of names) {
    e.submit(true);
    e.submit(name);
  }
  e.submit(false);        // no more for now
  return e;
}

/** What beginAddition() does in main.js, without the DOM. */
function addTo(e, loopId) {
  const entry = e.jumpTo(loopId);
  return { entry, first: e.submit(true) };
}

// --- 1. "add" is recognized, and does not collide with "change" ------------
{
  const answers = { forms: 'ssa', conditions: [{ name: 'diabetes' }] };

  for (const phrase of ['add a condition', 'add another condition',
    'I have another medical condition', 'add one more condition']) {
    check(`"${phrase}" reads as an addition`, isAdditionPhrase(phrase));
    const r = resolveAddition(phrase, answers);
    check(`"${phrase}" resolves to the conditions loop`, r.ok && r.loopId === 'conditions',
      JSON.stringify(r));
  }

  check('"change my condition" is not an addition', !isAdditionPhrase('change my condition'));
  check('"remove the second condition" is a deletion, not an addition',
    isDeletionPhrase('remove the second condition'));

  // The regression itself: the change path still edits in place.
  const target = resolveTarget('change my condition', answers);
  check('"change my condition" still resolves to a field',
    target.ok && target.target.id === 'name' && target.target.loopId === 'conditions',
    JSON.stringify(target));
}

// --- 2. A phrase naming no group is not an addition ------------------------
{
  const answers = { forms: 'ssa', conditions: [{ name: 'diabetes' }] };
  eq('"add" alone names nothing', resolveAddition('add', answers).reason, 'none');
  // The verb is never enough on its own. A group has to be named, which is
  // what keeps a stray "another" in an ordinary phrase from opening an entry.
  eq('a phrase naming no group is refused',
    resolveAddition('I take another pill in the morning', answers).reason, 'none');
  // Only groups this interview actually asks about are considered. "Condition"
  // names the Starter Kit's list here and the DS form's diagnoses there, and
  // the form choice is what tells them apart.
  const ssaHit = resolveAddition('add another condition', answers);
  eq('a Starter Kit interview adds to its condition list', ssaHit.loopId, 'conditions');
  const dsHit = resolveAddition('add another condition', { forms: 'ds', diagnoses: [] });
  eq('a DS interview adds to its diagnosis list instead', dsHit.loopId, 'diagnoses');
}

// --- 3. Adding appends, and leaves existing items untouched ----------------
{
  const e = withConditions(['diabetes', 'arthritis']);
  eq('two conditions recorded', e.answers().conditions.map(c => c.name), ['diabetes', 'arthritis']);

  const { entry, first } = addTo(e, 'conditions');
  eq('jumpTo lands on the loop entry', entry.loopPhase, 'entry');
  eq('submitting yes opens a third item', first.itemNumber, 3);
  eq('and lands on a field, not another entry prompt', first.loopPhase, 'field');

  e.submit('neuropathy');
  eq('the new condition was appended',
    e.answers().conditions.map(c => c.name), ['diabetes', 'arthritis', 'neuropathy']);
}

// --- 4. Finishing an item offers the repeat prompt, and no ends the run ----
{
  const e = withConditions(['diabetes']);
  addTo(e, 'conditions');
  const after = e.submit('arthritis');
  eq('the walk returns to this loop\'s repeat prompt', after.loopId, 'conditions');
  eq('which is a yes/no', after.type, 'yesno');
  check('main.js would still consider itself adding', after.loopId === 'conditions');

  const next = e.submit(false);
  check('saying no leaves the group', next === null || next.loopId !== 'conditions',
    JSON.stringify(next?.id));
  eq('nothing was lost on the way out',
    e.answers().conditions.map(c => c.name), ['diabetes', 'arthritis']);
}

// --- 5. Several items in one addition --------------------------------------
{
  const e = withConditions(['diabetes']);
  const startCount = e.answers().conditions.length;
  addTo(e, 'conditions');
  e.submit('arthritis');
  e.submit(true);                  // yes, another
  e.submit('neuropathy');
  e.submit(false);                 // no more
  eq('both were added', e.answers().conditions.map(c => c.name),
    ['diabetes', 'arthritis', 'neuropathy']);
  eq('the count main.js reports', e.answers().conditions.length - startCount, 2);
}

// --- 6. Adding to an empty list -------------------------------------------
{
  const e = withConditions([]);
  eq('the loop is empty but visited', e.answers().conditions, []);

  const { first } = addTo(e, 'conditions');
  eq('the first item opens on a field', first.loopPhase, 'field');
  eq('numbered one', first.itemNumber, 1);
  e.submit('asthma');
  eq('and is recorded', e.answers().conditions.map(c => c.name), ['asthma']);
}

// --- 7. Adding to a multi-field loop fills only the new item ----------------
{
  const e = createEngine();
  let guard = 0;
  while (e.current() && guard++ < 500) {
    const q = e.current();
    if (q.loopId === 'providers' && q.loopPhase === 'entry') break;
    e.submit(q.id === 'forms' ? 'ssa' : q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  e.submit(true);
  e.submit('City Clinic'); e.submit('1 Main St'); e.submit('5550001111');
  e.submit('2020-01'); e.submit('2021-01');
  e.submit(false);

  addTo(e, 'providers');
  e.submit('Lake Hospital'); e.submit('2 Lake Rd'); e.submit('5550002222');
  e.submit('2022-03'); e.submit('2023-04');

  const items = e.answers().providers;
  eq('two providers', items.map(i => i.name), ['City Clinic', 'Lake Hospital']);
  eq('the first one is untouched', items[0].phone, '5550001111');
  eq('the second one has its own values', items[1].address, '2 Lake Rd');
}

// --- 8. The item cap is reported, not silently exceeded --------------------
{
  const conditions = Array.from({ length: MAX_LOOP_ITEMS }, (_, i) => ({ name: `c${i}` }));
  const r = resolveAddition('add another condition', { forms: 'ssa', conditions });
  eq('a full list refuses', r.reason, 'full');
  eq('and names what is full', r.itemLabel, 'condition');

  const nearly = conditions.slice(0, MAX_LOOP_ITEMS - 1);
  check('one below the cap still adds',
    resolveAddition('add another condition', { forms: 'ssa', conditions: nearly }).ok);
}

console.log(failures === 0
  ? '\nAll addition checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
