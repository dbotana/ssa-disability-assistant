// Scripted walk of the interview engine. Runs with plain `node tests/engine-walk.js`.
// Zero API calls — this exercises control flow only.

import { createEngine } from '../src/engine.js';
import { SECTIONS } from '../src/schema.js';

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

// --- 1. Every question is reachable, and none is asked twice ---------------
{
  const e = createEngine();
  const seen = [];
  let guard = 0;
  while (!e.isComplete() && guard++ < 5000) {
    const q = e.current();
    if (!q) break;
    seen.push(q.path.join('/'));
    // Say yes to every loop entry exactly once, then no on the repeat.
    if (q.loopPhase === 'entry') {
      const first = q.itemNumber === 1;
      e.submit(first);
    } else if (q.type === 'yesno') {
      e.submit(true);
    } else {
      e.submit(`v_${q.id}`);
    }
  }
  check('terminates', e.isComplete(), `stopped after ${guard} steps`);
  const dupes = seen.filter((p, i) => seen.indexOf(p) !== i);
  eq('no question asked twice', dupes, []);
  check('visited every section',
    new Set(seen.map(p => p.split('/')[0])).size >= SECTIONS.length - 2);
}

// --- 2. "No" at a loop entry skips the whole group -------------------------
{
  const e = createEngine();
  while (e.current() && e.current().section !== 'medical_providers') {
    const q = e.current();
    e.submit(q.type === 'yesno' ? false : `v_${q.id}`);
  }
  const entry = e.current();
  eq('providers entry is a yesno', entry.type, 'yesno');
  e.submit(false);
  eq('providers left empty', e.answers().providers, []);
  check('moved past providers', e.current().section !== 'medical_providers',
    `still at ${e.current().section}`);
}

// --- 3. Multiple items in one loop -----------------------------------------
{
  const e = createEngine();
  while (e.current() && e.current().section !== 'medical_providers') {
    const q = e.current();
    e.submit(q.type === 'yesno' ? false : `v_${q.id}`);
  }
  for (let n = 1; n <= 3; n++) {
    e.submit(true);                       // entry / repeat -> yes
    eq(`provider ${n} first field`, e.current().id, 'name');
    // Walk whatever fields the schema defines for a provider, answering each
    // by id, so adding a column here is not a test change.
    while (e.current() && e.current().loopPhase === 'field') {
      const q = e.current();
      if (q.id === 'name') e.submit(`Dr. Number ${n}`);
      else if (q.id === 'phone') e.submit(`555000000${n}`);
      else e.submit(`${q.id}_${n}`);
    }
  }
  e.submit(false);                        // no more providers
  const items = e.answers().providers;
  eq('three providers captured', items.length, 3);
  eq('second provider name', items[1].name, 'Dr. Number 2');
  eq('third provider phone', items[2].phone, '5550000003');
}

// --- 4. askIf branches: workers' comp --------------------------------------
{
  const run = receives => {
    const e = createEngine();
    while (e.current() && e.current().id !== 'wc_receives') {
      const q = e.current();
      e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
    }
    e.submit(receives);
    return e.current().id;
  };
  eq('wc yes asks injury date', run(true), 'wc_injury_date');
  check('wc no skips the whole block', !run(false).startsWith('wc_'),
    `landed on ${run(false)}`);
}

// --- 5. askIf inside a loop item: marriage still active --------------------
{
  const e = createEngine();
  while (e.current() && e.current().section !== 'marriages') {
    const q = e.current();
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  e.submit(true);                                  // has been married
  const walk = until => {
    while (e.current() && e.current().id !== until) {
      const q = e.current();
      e.submit(q.type === 'yesno' ? true : `v_${q.id}`);
    }
  };
  walk('still_active');
  e.submit(false);                                 // not active
  eq('inactive marriage asks divorce date', e.current().id, 'divorce_date');
  e.submit('1999-01-01');
  eq('then asks if spouse died', e.current().id, 'spouse_died');
  e.submit(true);
  eq('death date is gated on spouse_died', e.current().id, 'spouse_death_date');
}
{
  const e = createEngine();
  while (e.current() && e.current().section !== 'marriages') {
    const q = e.current();
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  e.submit(true);
  while (e.current() && e.current().id !== 'still_active') e.submit(`v_${e.current().id}`);
  e.submit(true);                                  // still active
  check('active marriage skips divorce and death',
    e.current().loopPhase === 'entry',
    `landed on ${e.current().id}`);
}

// --- 6. back() rewinds and clears the answer ------------------------------
{
  const e = createEngine();
  e.submit('Dana');
  eq('advanced to last name', e.current().id, 'last_name');
  const q = e.back();
  eq('back returns to first name', q.id, 'first_name');
  eq('back cleared the answer', e.answers().first_name, undefined);
  e.submit('Danielle');
  eq('re-answer sticks', e.answers().first_name, 'Danielle');
}

// --- 7. back() over a loop entry "yes" discards the opened item ------------
{
  const e = createEngine();
  while (e.current() && e.current().section !== 'medical_providers') {
    const q = e.current();
    e.submit(q.type === 'yesno' ? false : `v_${q.id}`);
  }
  e.submit(true);
  eq('opened an item', e.answers().providers.length, 1);
  e.back();
  eq('back discarded the empty item', e.answers().providers.length, 0);
  check('back to the entry prompt', e.current().loopPhase === 'entry');
}

// --- 8. skip() leaves it blank and moves on -------------------------------
{
  const e = createEngine();
  e.skip();
  eq('skip advanced', e.current().id, 'last_name');
  eq('skipped value is null', e.answers().first_name, null);
}

// --- 9. jumpTo() for the review pass --------------------------------------
{
  const e = createEngine();
  e.submit('Dana'); e.submit('Botana');
  const q = e.jumpTo('first_name');
  eq('jumped to first_name', q.id, 'first_name');
  e.submit('Corrected');
  eq('correction recorded', e.answers().first_name, 'Corrected');
}
{
  const e = createEngine();
  while (e.current() && e.current().section !== 'medical_providers') {
    const q = e.current();
    e.submit(q.type === 'yesno' ? false : `v_${q.id}`);
  }
  const addProvider = (name, phone) => {
    e.submit(true);
    while (e.current() && e.current().loopPhase === 'field') {
      const q = e.current();
      if (q.id === 'name') e.submit(name);
      else if (q.id === 'phone') e.submit(phone);
      else e.submit(null);
    }
  };
  addProvider('Dr. A', '5550001111');
  addProvider('Dr. B', '5550002222');
  e.submit(false);
  const q = e.jumpTo('phone', 1);
  eq('jumped into loop item 1', q.itemNumber, 2);
  e.submit('5559999999');
  eq('fixed the right item', e.answers().providers[1].phone, '5559999999');
  eq('left the other item alone', e.answers().providers[0].phone, '5550001111');
}

// --- 10. missingRequired() finds blanks -----------------------------------
{
  const e = createEngine();
  e.skip();                       // first_name is required
  const missing = e.missingRequired().map(m => m.id);
  check('reports the skipped required field', missing.includes('first_name'),
    `got ${JSON.stringify(missing)}`);
}

// --- 11. Save / resume round-trips ----------------------------------------
{
  const e = createEngine();
  e.submit('Dana'); e.submit('Botana'); e.submit('1980-05-05');
  const saved = e.getState();
  const resumed = createEngine(SECTIONS, saved);
  eq('resumed at the same question', resumed.current().id, e.current().id);
  eq('resumed with the same answers', resumed.answers().first_name, 'Dana');
  resumed.submit('Austin');
  eq('resumed engine still advances', resumed.answers().birth_city, 'Austin');
}

// --- 12. A throwing askIf must not strand the interview -------------------
{
  const hostile = [{
    id: 's', title: 'S', questions: [
      { id: 'a', prompt: 'A?', type: 'text' },
      { id: 'b', prompt: 'B?', type: 'text', askIf: () => { throw new Error('boom'); } },
      { id: 'c', prompt: 'C?', type: 'text' }
    ]
  }];
  const e = createEngine(hostile);
  e.submit('x');
  eq('throwing askIf defaults to asking', e.current().id, 'b');
  e.submit('y'); e.submit('z');
  check('still completes', e.isComplete());
}

// --- 13. The worksheet columns the SSA kit asks for are all collected -------
// Each of these was a gap between questions-draft1.md and the official
// Adult Disability Starter Kit worksheet. Asserting on the schema keeps them
// from silently regressing out again.
{
  const fieldIds = loopId => {
    for (const section of SECTIONS) {
      for (const q of section.questions) {
        if (q.id === loopId && q.type === 'loop') return q.fields.map(f => f.id);
      }
    }
    return [];
  };
  const topLevelIds = SECTIONS.flatMap(s => s.questions.map(q => q.id));

  for (const id of ['name', 'address', 'phone', 'first_seen', 'last_seen']) {
    check(`providers collect ${id}`, fieldIds('providers').includes(id));
  }
  for (const id of ['name', 'reason', 'prescribed_by']) {
    check(`medications collect ${id}`, fieldIds('medications').includes(id));
  }
  for (const id of ['job_title', 'business_type']) {
    check(`jobs collect ${id}`, fieldIds('jobs').includes(id));
  }
  check('onset date is asked', topLevelIds.includes('onset_date'));
}

// --- 14. Onset date is reachable and required ------------------------------
{
  const e = createEngine();
  while (e.current() && e.current().id !== 'onset_date') {
    const q = e.current();
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  const q = e.current();
  check('onset_date is reached', !!q, 'never reached onset_date');
  eq('onset_date is a month and year', q.type, 'monthyear');
  check('onset_date is required', q.required);
  e.skip();
  check('skipped onset_date is reported missing',
    e.missingRequired().some(m => m.id === 'onset_date'));
}

console.log(failures === 0
  ? '\nAll engine checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
