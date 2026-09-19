// Routing the interview by form. Runs with plain `node tests/form-routing.js`.
// Zero API calls — the engine, the schema, and what reads them.
//
// The first answer decides which of two forms (or both) the interview fills
// out. Everything after it has to agree on that: which questions are asked,
// how sections are counted, what can be corrected, what the summary shows.

import { createEngine } from '../src/engine.js';
import { SECTIONS, SCHEMA_VERSION, flatten, sectionActive } from '../src/schema.js';
import { buildTargets, resolveTarget } from '../src/correct.js';
import { buildReport } from '../src/summary.js';
import { startEngine } from './lib/walk.js';

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

const sectionForms = Object.fromEntries(SECTIONS.map(s => [s.id, s.forms ?? ['ssa', 'ds']]));
const ssaOnly = SECTIONS.filter(s => s.forms && !s.forms.includes('ds')).map(s => s.id);
const dsOnly = SECTIONS.filter(s => s.forms && !s.forms.includes('ssa')).map(s => s.id);

/**
 * Walk a whole interview: yes to every yes/no and one item per loop, a
 * placeholder otherwise, and a mid-scale rating so every explanation is asked.
 */
function walk(forms) {
  const e = createEngine();
  const asked = [];
  const progress = [];
  let guard = 0;
  while (!e.isComplete() && guard++ < 5000) {
    const q = e.current();
    if (!q) break;
    asked.push(q);
    progress.push(e.progress());
    if (q.id === 'forms') e.submit(forms);
    else if (q.loopPhase === 'entry') e.submit(q.itemNumber === 1);
    else if (q.type === 'yesno') e.submit(true);
    else if (q.type === 'choice') e.submit(q.options[1]?.value ?? q.options[0].value);
    else e.submit(`v_${q.id}`);
  }
  return { e, asked, progress };
}

// --- 1. Each choice asks only its own form's questions ----------------------
{
  const ssa = walk('ssa');
  const ds = walk('ds');
  const both = walk('both');
  const sectionsOf = run => new Set(run.asked.map(q => q.section));

  check('the Starter Kit walk finishes', ssa.e.isComplete());
  check('the DS walk finishes', ds.e.isComplete());
  check('the both walk finishes', both.e.isComplete());

  const leaked = [...sectionsOf(ssa)].filter(id => dsOnly.includes(id));
  eq('a Starter Kit interview asks no DS-only section', leaked, []);
  const leakedDs = [...sectionsOf(ds)].filter(id => ssaOnly.includes(id));
  eq('a DS interview asks no Starter-Kit-only section', leakedDs, []);

  const all = SECTIONS.map(s => s.id);
  eq('both forms reach every section', [...sectionsOf(both)].sort(), [...all].sort());

  const paths = both.asked.map(q => q.path.join('/'));
  eq('nothing is asked twice with both forms', paths.filter((p, i) => paths.indexOf(p) !== i), []);

  const ids = new Set(both.asked.map(q => q.loopId ?? q.id));
  for (const id of ['diagnoses', 'ds_jobs', 'marital_status']) {
    check(`with both forms, the DS-only ${id} is derived, not asked`, !ids.has(id));
  }
  const dsIds = new Set(ds.asked.map(q => q.loopId ?? q.id));
  for (const id of ['diagnoses', 'ds_jobs', 'marital_status']) {
    check(`without the Starter Kit, ${id} is asked`, dsIds.has(id));
  }
  for (const id of ['conditions', 'jobs', 'onset_date', 'providers', 'marriages']) {
    check(`without the Starter Kit, ${id} is not asked`, !dsIds.has(id));
  }

  // The two DS sections that the Starter Kit shares keep their SSA questions.
  const ssaIds = new Set(ssa.asked.map(q => q.id));
  for (const id of ['currently_employed', 'in_school', 'has_504_plan', 'living_arrangement']) {
    check(`the Starter Kit does not ask the DS-only ${id}`, !ssaIds.has(id));
  }
}

// --- 2. Sections are counted among the ones the chosen forms use ------------
{
  for (const forms of ['ssa', 'ds', 'both']) {
    const { progress } = walk(forms);
    const expected = SECTIONS.filter(s => sectionActive(s, { forms })).length;
    const counts = new Set(progress.slice(1).map(p => p.sectionCount));
    eq(`${forms}: one section count throughout`, [...counts], [expected]);
    const numbers = [...new Set(progress.slice(1).map(p => p.sectionNumber))];
    eq(`${forms}: sections are numbered 2 to ${expected} without gaps`,
      numbers, Array.from({ length: expected - 1 }, (_, i) => i + 2));
  }
  const first = createEngine().progress();
  eq('before the form is chosen there is no section count', first.sectionCount, null);
}

// --- 3. Loops can be skipped whole ------------------------------------------
{
  const e = startEngine('ds');
  e.submit(true);                                   // filling it out for themselves
  while (e.current() && e.current().section !== 'conditions') e.submit('x');
  eq('the DS diagnosis list replaces the Starter Kit conditions',
    [e.current().loopId, e.current().loopPhase], ['diagnoses', 'entry']);
  e.submit(false);
  check('onset date is a Starter Kit question', e.current().id !== 'onset_date', e.current().id);
  eq('conditions are never opened', e.answers().conditions, undefined);
}

// --- 4. Ratings ask for an explanation only when help is needed -------------
{
  const e = startEngine('ds');
  while (e.current() && e.current().id !== 'eating_level') {
    const q = e.current();
    e.submit(q.loopPhase === 'entry' || q.type === 'yesno' ? false : q.type === 'choice' ? q.options[0].value : 'x');
  }
  check('the first rating speaks the scale', /independent/i.test(e.current().warn ?? ''));
  e.submit('A');
  eq('independent skips the explanation', e.current().id, 'dressing_level');
  check('later ratings do not repeat the scale', !e.current().warn);
  e.submit('C');
  eq('anything else asks for one', e.current().id, 'dressing_explain');
}

// --- 5. Changing the form choice afterwards reaches the new questions -------
{
  // Finish a whole Starter Kit interview, then decide to do both.
  const { e } = walk('ssa');
  check('finished as a Starter Kit', e.isComplete());
  e.setAnswer('forms', 'both');
  const next = e.rewalk();
  eq('the first DS question is next', next?.id, 'for_self');
  e.submit(true);
  eq('then the next unanswered DS question, skipping what is already known', e.current()?.id, 'home_street');

  // The rest of the catch-up never re-asks an answer the Starter Kit gave.
  const answered = new Set(Object.keys(e.answers()));
  const reasked = [];
  let guard = 0;
  while (!e.isComplete() && guard++ < 2000) {
    const q = e.current();
    if (!q.loopId && answered.has(q.id)) reasked.push(q.id);
    if (q.loopId && answered.has(q.loopId) && q.loopPhase === 'entry' && q.itemNumber === 1) reasked.push(q.loopId);
    e.submit(q.loopPhase === 'entry' || q.type === 'yesno' ? false : q.type === 'choice' ? q.options[0].value : 'x');
  }
  check('the catch-up finishes', e.isComplete());
  eq('and asks nothing already answered', reasked, []);
  check('catch-up mode ends with the interview', e.getState().catchUp === false);

  // Going the other way leaves nothing new to ask.
  const { e: dsFirst } = walk('ds');
  dsFirst.setAnswer('forms', 'ds');
  eq('re-choosing the same form asks nothing', dsFirst.rewalk(), null);
}

// --- 6. The other form's questions cannot be reached or corrected ----------
{
  const e = startEngine('ssa');
  eq('jumpTo refuses a DS question on a Starter Kit interview', e.jumpTo('guardian_name'), null);
  const targets = buildTargets({ forms: 'ssa', first_name: 'Ada' }).map(t => t.id);
  check('no DS targets on a Starter Kit interview', !targets.includes('guardian_phone') && !targets.includes('home_zip'));
  const dsTargets = buildTargets({ forms: 'ds', first_name: 'Ada', has_guardian: true }).map(t => t.id);
  check('DS targets on a DS interview', dsTargets.includes('guardian_phone'));
  check('no Starter Kit targets on a DS interview', !dsTargets.includes('routing_number'));

  const r = resolveTarget("change my guardian's phone number", { forms: 'ds', has_guardian: true, guardian_phone: '2075550100' });
  eq('a DS field resolves by name', r.ok && r.target.id, 'guardian_phone');
  const job = resolveTarget('change the first job employer', {
    forms: 'ds', ds_jobs: [{ employer: 'Hannaford' }], jobs: [{ employer: 'Ignored' }]
  });
  eq('"job" means the DS job list on a DS interview', job.ok && job.target.loopId, 'ds_jobs');
}

// --- 7. The summary shows what was asked, and nothing else ------------------
{
  const report = buildReport({ forms: 'ssa', first_name: 'Ada', wc_receives: false });
  const ids = report.map(s => s.id);
  check('a Starter Kit summary has no DS sections', !ids.some(id => dsOnly.includes(id)), ids.join(', '));
  const wc = report.find(s => s.id === 'workers_comp');
  eq('a declined branch leaves no blank rows', wc.blocks.map(b => b.id), ['wc_receives']);
}

// --- 8. A session saved before the form question resumes as a Starter Kit ---
{
  // What the previous version stored: no `schema`, no `forms`, and a cursor
  // whose node index predates the form question.
  const legacy = {
    answers: { first_name: 'Ada', last_name: 'Lovelace' },
    cursor: { node: 2, phase: null, loopIndex: 0, fieldIndex: 0 },
    history: [{ node: 0, phase: null, loopIndex: 0, fieldIndex: 0 }, { node: 1, phase: null, loopIndex: 0, fieldIndex: 0 }],
    skipped: []
  };
  const e = createEngine(undefined, legacy);
  eq('it becomes a Starter Kit session', e.answers().forms, 'ssa');
  eq('it resumes at the first unanswered question', e.current()?.id, 'date_of_birth');
  eq('it is stamped with the current schema', e.getState().schema, SCHEMA_VERSION);
  eq('the stale undo history is dropped', e.getState().history, []);
}

// --- 9. The flattened schema stays consistent ------------------------------
{
  const nodes = flatten();
  const ids = nodes.map(n => n.id);
  eq('top-level ids are unique', ids.filter((id, i) => ids.indexOf(id) !== i), []);
  for (const n of nodes) {
    if (n.type === 'choice') check(`${n.id} has options`, Array.isArray(n.options) && n.options.length > 1);
    for (const f of n.fields ?? []) {
      if (f.type === 'choice') check(`${n.id}.${f.id} has options`, Array.isArray(f.options) && f.options.length > 1);
    }
  }
  check('every section is tagged for a form, apart from the form choice',
    Object.entries(sectionForms).every(([id, forms]) => id === 'forms' || forms.length));
  eq('direct deposit is still the last Starter Kit section',
    SECTIONS.filter(s => sectionActive(s, { forms: 'both' })).at(-1).id, 'direct_deposit');
}

console.log(failures === 0 ? 'form-routing: all checks passed' : `form-routing: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
