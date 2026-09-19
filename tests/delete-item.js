// Deleting loop entries. Runs with plain `node tests/delete-item.js`.
// Zero API calls — engine surgery and the spoken-phrase matcher only.

import { createEngine } from '../src/engine.js';
import { resolveDeletion, isDeletionPhrase, describeItem } from '../src/correct.js';

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

/** Drive a fresh engine to the given loop's entry prompt. */
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

/** Record `n` providers named by `names`, leaving the cursor at the entry. */
function withProviders(names) {
  const e = engineAtLoop('providers');
  for (const name of names) {
    e.submit(true);            // yes, add one
    e.submit(name);            // name
    e.submit(`${name} street`);// address
    e.submit('5550001111');    // phone
    e.submit('2020-01');       // first_seen
    e.submit('2021-01');       // last_seen
  }
  return e;
}

// --- 1. Deleting the middle item renumbers the rest -------------------------
{
  const e = withProviders(['Alpha', 'Beta', 'Gamma']);
  eq('three providers recorded', e.answers().providers.length, 3);

  check('removeItem reports success', e.removeItem('providers', 1));
  const items = e.answers().providers;
  eq('one was removed', items.length, 2);
  eq('the survivors are in order', items.map(i => i.name), ['Alpha', 'Gamma']);
  eq('the survivor kept its own fields', items[1].address, 'Gamma street');
}

// --- 2. Deleting the first and last items ----------------------------------
{
  const first = withProviders(['Alpha', 'Beta']);
  first.removeItem('providers', 0);
  eq('removing the first leaves the second', first.answers().providers.map(i => i.name), ['Beta']);

  const last = withProviders(['Alpha', 'Beta']);
  last.removeItem('providers', 1);
  eq('removing the last leaves the first', last.answers().providers.map(i => i.name), ['Alpha']);

  const only = withProviders(['Solo']);
  only.removeItem('providers', 0);
  eq('removing the only item empties the loop', only.answers().providers, []);
}

// --- 3. Bad arguments are refused, not guessed -----------------------------
{
  const e = withProviders(['Alpha']);
  check('unknown loop id refused', e.removeItem('not_a_loop', 0) === false);
  check('index past the end refused', e.removeItem('providers', 5) === false);
  check('negative index refused', e.removeItem('providers', -1) === false);
  check('a non-loop question id refused', e.removeItem('first_name', 0) === false);
  eq('nothing was removed by the bad calls', e.answers().providers.length, 1);
}

// --- 4. The live cursor survives a delete ----------------------------------
{
  // Cursor sits inside item 2's fields; delete item 0 beneath it.
  const e = withProviders(['Alpha', 'Beta']);
  e.submit(true);                      // open a third item
  e.submit('Gamma');                   // name it
  const before = e.current();
  eq('cursor is inside the third item', before.itemNumber, 3);

  e.removeItem('providers', 0);
  const after = e.current();
  eq('cursor followed its item down to number 2', after.itemNumber, 2);
  eq('and stayed on the same field', after.id, before.id);
  eq('the item under the cursor is still Gamma',
    e.answers().providers[after.itemNumber - 1].name, 'Gamma');
}

// --- 5. Deleting the item the cursor is inside parks it on the entry -------
{
  const e = withProviders(['Alpha']);
  e.submit(true);                      // open item 2
  e.submit('Beta');
  eq('cursor is in item 2', e.current().itemNumber, 2);

  e.removeItem('providers', 1);        // delete the item being filled in
  const q = e.current();
  eq('cursor parked on the loop entry', q.loopPhase, 'entry');
  eq('and offers to add after the survivor', q.itemNumber, 2);
  eq('the survivor is untouched', e.answers().providers.map(i => i.name), ['Alpha']);

  // The interview must still run to completion from there.
  e.submit(false);
  check('interview continues past the loop', e.current() === null || e.current().loopId !== 'providers');
}

// --- 6. Undo history is repaired, so back() cannot corrupt a later item ----
{
  const e = withProviders(['Alpha', 'Beta']);
  e.removeItem('providers', 0);
  eq('one provider left', e.answers().providers.map(i => i.name), ['Beta']);

  // Walk back through the snapshots recorded before the delete. A stale
  // loopIndex of 1 would truncate or overwrite the wrong item.
  for (let i = 0; i < 8; i++) e.back();
  const items = e.answers().providers;
  check('back() never grew the list past its real length', items.length <= 1,
    `list is ${JSON.stringify(items.map(i => i.name))}`);
  check('back() did not resurrect the deleted item',
    !items.some(i => i.name === 'Alpha'), JSON.stringify(items));
}

// --- 7. listItems names items for the spoken prompt ------------------------
{
  const e = withProviders(['Alpha', 'Beta']);
  const items = e.listItems('providers');
  eq('lists both', items.length, 2);
  eq('numbers are 1-based', items.map(i => i.number), [1, 2]);
  eq('titled by the first field', items.map(i => i.title), ['Alpha', 'Beta']);
  eq('carries the spoken label', items[0].itemLabel, 'provider');
  eq('an unknown loop lists nothing', e.listItems('nope'), []);
  eq('a loop with no items lists nothing', e.listItems('marriages'), []);

  eq('describeItem names number and title',
    describeItem(items[1]), 'provider 2, Beta');
  eq('describeItem falls back to the number alone',
    describeItem({ itemLabel: 'job', number: 3, title: null }), 'job 3');
}

// --- 8. Deletion phrases are recognised, corrections are not ---------------
{
  for (const p of ['remove that last provider', 'delete the second job',
    'get rid of that medication', 'erase the first condition']) {
    check(`"${p}" reads as a deletion`, isDeletionPhrase(p));
  }
  for (const p of ['change my phone number', 'correct my date of birth',
    'fix the second provider address']) {
    check(`"${p}" is not a deletion`, !isDeletionPhrase(p));
  }
}

// --- 9. Deletion phrases resolve to a specific item -----------------------
{
  const answers = {
    providers: [{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }],
    jobs: [{ employer: 'Acme' }],
    medications: []
  };

  const last = resolveDeletion('remove that last provider', answers);
  check('"last provider" resolves', last.ok, last.reason);
  if (last.ok) eq('to the third item', [last.loopId, last.loopIndex], ['providers', 2]);

  const second = resolveDeletion('delete the second provider', answers);
  check('"second provider" resolves', second.ok, second.reason);
  if (second.ok) eq('to index 1', second.loopIndex, 1);

  // A single-item loop needs no ordinal.
  const onlyJob = resolveDeletion('remove that job', answers);
  check('the only job resolves without an ordinal', onlyJob.ok, onlyJob.reason);
  if (onlyJob.ok) eq('to the one job', [onlyJob.loopId, onlyJob.loopIndex], ['jobs', 0]);

  // Naming the item beats counting.
  const byName = resolveDeletion('delete the provider Beta', answers);
  check('a named provider resolves', byName.ok, byName.reason);
  if (byName.ok) eq('to the item with that name', byName.loopIndex, 1);
}

// --- 10. Unsafe deletions ask instead of guessing --------------------------
{
  const answers = { providers: [{ name: 'Alpha' }, { name: 'Beta' }], medications: [] };

  const vague = resolveDeletion('delete a provider', answers);
  check('an unnumbered multi-item loop asks', !vague.ok && vague.reason === 'ambiguous',
    `got ${vague.ok ? vague.loopIndex : vague.reason}`);
  if (!vague.ok && vague.candidates) {
    eq('and offers every item', vague.candidates.map(c => c.title), ['Alpha', 'Beta']);
  }

  const past = resolveDeletion('remove the fifth provider', answers);
  check('an item number past the end does not delete item 1',
    !past.ok, `resolved to index ${past.ok ? past.loopIndex : '-'}`);

  const empty = resolveDeletion('remove that medication', answers);
  check('an empty loop reports empty', !empty.ok && empty.reason === 'empty', empty.reason);
  if (!empty.ok) eq('and names the label', empty.itemLabel, 'medication');

  const nothing = resolveDeletion('remove the thingamajig', answers);
  check('an unnamed group resolves to nothing', !nothing.ok && nothing.reason === 'none');
}

// --- 11. Resolve then delete, end to end -----------------------------------
{
  const e = withProviders(['Alpha', 'Beta', 'Gamma']);
  const r = resolveDeletion('get rid of the second provider', e.answers());
  check('phrase resolved', r.ok, r.reason);
  if (r.ok) {
    check('engine accepted the delete', e.removeItem(r.loopId, r.loopIndex));
    eq('the right provider went away', e.answers().providers.map(i => i.name), ['Alpha', 'Gamma']);
  }
}

// --- 12. A deleted item stops counting as missing --------------------------
{
  const e = engineAtLoop('providers');
  e.submit(true);
  e.skip();                            // name is required, and skipped
  e.submit('somewhere');
  e.submit('5550001111');
  e.submit('2020-01');
  e.submit('2021-01');
  e.submit(false);

  check('the blank required name is reported missing',
    e.missingRequired().some(m => m.loopId === 'providers' && m.id === 'name'));

  e.removeItem('providers', 0);
  check('and stops being reported once the item is deleted',
    !e.missingRequired().some(m => m.loopId === 'providers'),
    JSON.stringify(e.missingRequired()));
}

// --- 13. Mid-interview deletion leaves the interview usable ---------------
{
  // Two providers recorded, a third half-filled — the "added one by mistake"
  // case. Deleting an earlier item must not disturb the open question.
  const e = withProviders(['Alpha', 'Beta']);
  e.submit(true);
  e.submit('Gamma');
  const before = e.current();

  const r = resolveDeletion('remove the first provider', e.answers());
  check('mid-interview phrase resolves', r.ok, r.reason);
  if (r.ok) {
    e.removeItem(r.loopId, r.loopIndex);
    const after = e.current();
    check('the interview is still live', after !== null);
    eq('still on the same field', after.id, before.id);
    eq('the open item renumbered to 2', after.itemNumber, 2);
    eq('and is still the one being filled in',
      e.answers().providers[after.itemNumber - 1].name, 'Gamma');
    eq('the right provider was removed',
      e.answers().providers.map(i => i.name), ['Beta', 'Gamma']);
  }

  // And it must still run to the end.
  let guard = 0;
  while (e.current() && guard++ < 800) {
    const q = e.current();
    e.submit(q.id === 'forms' ? 'ssa' : q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  check('interview reaches completion after a mid-flight delete', e.isComplete());
}

// --- 14. A deletion phrase is only a command when it names real items ------
{
  // The guard main.js uses before treating a transcript as a delete command.
  const namesSomething = (text, answers) =>
    isDeletionPhrase(text) && resolveDeletion(text, answers).reason !== 'none';

  const answers = { providers: [{ name: 'Alpha' }] };
  check('"remove the provider" is a command', namesSomething('remove the provider', answers));

  // An answer that merely contains a removal verb must stay an answer, or it
  // would hijack the turn instead of being recorded.
  check('"they removed my gallbladder" is not a command',
    !namesSomething('they removed my gallbladder', answers));
  check('"delete" naming no group is not a command',
    !namesSomething('delete that', answers));
  check('a plain answer is not a command',
    !namesSomething('City Clinic', answers));
}

console.log(failures === 0
  ? '\nAll deletion checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
