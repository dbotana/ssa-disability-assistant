// Shared test helpers. Lives in tests/lib/ so the `tests/*.js` runner in CI
// does not execute it as a test of its own.

import { createEngine } from '../../src/engine.js';

/**
 * A fresh engine with the form question already answered, so a test can
 * start where the interview's content does: `ssa`, `ds`, or `both`.
 */
export function startEngine(forms = 'ssa', sections = undefined) {
  const e = createEngine(sections);
  if (e.current()?.id === 'forms') e.submit(forms);
  return e;
}

/**
 * A plausible answer for any question, for walks that only care about
 * control flow: the form choice, no to every yes/no, a placeholder string
 * otherwise.
 */
export function filler(q, forms = 'ssa') {
  if (q.id === 'forms') return forms;
  if (q.loopPhase === 'entry' || q.type === 'yesno') return false;
  if (q.type === 'choice') return q.options?.[0]?.value ?? `v_${q.id}`;
  return `v_${q.id}`;
}
