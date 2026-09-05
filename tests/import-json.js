// Re-importing a saved answers file. Runs with plain `node tests/import-json.js`.
// Zero API calls — the export parser and the engine it feeds.

import { parseExport, ImportError } from '../src/importer.js';
import { createEngine } from '../src/engine.js';
import { flatten } from '../src/schema.js';

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
function throws(label, fn) {
  try { fn(); } catch (err) { check(label, err instanceof ImportError, `threw ${err.name}`); return; }
  check(label, false, 'did not throw');
}

const nodes = flatten();

/** Answer `n` questions on a fresh engine, then export what it holds. */
function engineAfter(n) {
  const e = createEngine();
  for (let i = 0; i < n && e.current(); i++) {
    const q = e.current();
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  return e;
}

function exportFrom(engine, version = 2) {
  const payload = { version, savedAt: '2026-01-02T03:04:05.000Z', answers: engine.answers() };
  if (version === 2) payload.state = engine.getState();
  return JSON.stringify(payload, null, 2);
}

// -- a v2 file round-trips exactly ------------------------------------------

{
  const source = engineAfter(6);
  const before = source.current();
  const { state, savedAt, rebuiltCursor } = parseExport(exportFrom(source));
  eq('v2 cursor preserved', state.cursor, source.getState().cursor);
  eq('v2 answers preserved', state.answers, source.answers());
  eq('v2 savedAt read', savedAt, '2026-01-02T03:04:05.000Z');
  check('v2 cursor not rebuilt', rebuiltCursor === false);

  const restored = createEngine(undefined, state);
  eq('v2 resumes at the same question', restored.current()?.id, before?.id);
}

// -- a v1 file (answers only) still imports, with a rebuilt cursor ----------

{
  const source = engineAfter(6);
  const expected = source.current();
  const { state, rebuiltCursor } = parseExport(exportFrom(source, 1));
  check('v1 cursor rebuilt', rebuiltCursor === true);
  eq('v1 answers preserved', state.answers, source.answers());

  const restored = createEngine(undefined, state);
  eq('v1 lands on the first unanswered question', restored.current()?.id, expected?.id);
}

// -- a cursor the current schema cannot honour is rebuilt, not trusted ------

{
  const source = engineAfter(6);
  const payload = JSON.parse(exportFrom(source));

  payload.state.cursor = { node: nodes.length + 50, phase: null, loopIndex: 0, fieldIndex: 0 };
  check('out-of-range node rebuilt', parseExport(JSON.stringify(payload)).rebuiltCursor === true);

  payload.state.cursor = { node: 0, phase: 'nonsense', loopIndex: 0, fieldIndex: 0 };
  check('nonsense phase rebuilt',
    parseExport(JSON.stringify(payload)).rebuiltCursor === true);

  payload.state.cursor = { node: 0, phase: null, loopIndex: 4, fieldIndex: 9 };
  eq('stray loop offsets on a plain question zeroed',
    parseExport(JSON.stringify(payload)).state.cursor,
    { node: 0, phase: null, loopIndex: 0, fieldIndex: 0 });

  const loopIdx = nodes.findIndex(n => n.type === 'loop');
  payload.state.cursor = { node: loopIdx, phase: 'field', loopIndex: 99, fieldIndex: 0 };
  check('loop cursor past the last item rebuilt',
    parseExport(JSON.stringify(payload)).rebuiltCursor === true);
}

// -- a finished interview keeps its end-of-schema cursor -------------------

{
  const e = createEngine();
  let guard = 0;
  while (e.current() && guard++ < 2000) {
    const q = e.current();
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  check('walked to the end', e.isComplete());
  const { state } = parseExport(exportFrom(e));
  check('finished interview imports as complete', createEngine(undefined, state).isComplete());
}

// -- junk is dropped rather than handed to the engine ----------------------

{
  const source = engineAfter(6);
  const payload = JSON.parse(exportFrom(source));
  payload.answers.not_a_real_question = 'hello';
  payload.answers.first_name = { evil: true };          // wrong shape for a scalar
  const loopId = nodes.find(n => n.type === 'loop').id;
  payload.answers[loopId] = [{ name: 'ok', bogus_field: 'x' }, 'not an object'];

  const { state } = parseExport(JSON.stringify(payload));
  check('unknown id dropped', state.answers.not_a_real_question === undefined);
  check('non-scalar scalar dropped', state.answers.first_name === undefined);
  eq('loop items filtered to known fields', state.answers[loopId], [{ name: 'ok' }]);

  payload.state.skipped = ['a', 7, 'b'];
  payload.state.pace = { samples: [3, 'x', -1, 9], peak: 'nope' };
  const cleaned = parseExport(JSON.stringify(payload)).state;
  eq('skipped filtered to strings', cleaned.skipped, ['a', 'b']);
  eq('pace samples filtered', cleaned.pace.samples, [3, 9]);
  eq('pace peak defaulted', cleaned.pace.peak, 0);
  eq('history is never imported', cleaned.history, []);
}

// -- files that are not ours are refused with a spoken sentence -------------

throws('not JSON', () => parseExport('this is not json'));
throws('JSON but not an object', () => parseExport('[1,2,3]'));
throws('object with no answers', () => parseExport('{"version":2}'));
throws('answers present but all unknown',
  () => parseExport('{"version":2,"answers":{"nope":"x"}}'));

console.log(failures ? `\n${failures} failure(s)` : 'import-json: all checks passed');
process.exit(failures ? 1 : 0);
