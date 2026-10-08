// The injected clock.
//
// Three call sites read the wall clock — parse.js (the century window and the
// future-date check), engine.js (pacing samples), and the DS mapping (the date
// written at the top of page 1). All three take it as a parameter now, so the
// goldens can pin Dec 31, Jan 1 and Feb 29, which a live clock could never
// produce twice, and so the Kotlin port can run the exact same fixtures.
//
// Makes no network requests.

import { parseLocal } from '../src/parse.js';
import { createEngine } from '../src/engine.js';
import { SECTIONS } from '../src/schema.js';
import * as dsIntake from '../src/forms/ds-intake.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const at = (iso) => () => new Date(iso);
const q = (type, extra = {}) => ({ type, prompt: `test ${type}`, ...extra });

// -- parse.js: the century window on the year boundary -----------------------

{
  // Dec 31 1999: "99" is 1999 — the century window ends today.
  const d = parseLocal(q('date'), '6/28/99', { now: at('1999-12-31T12:00:00') });
  check('Dec 31 1999: "99" is 1999', d?.value === '1999-06-28', JSON.stringify(d?.value));

  // Jan 1 2000: "99" is still 1999 — the candidate 2099 is in the future.
  const d2 = parseLocal(q('date'), '6/28/99', { now: at('2000-01-01T00:00:00') });
  check('Jan 1 2000: "99" is 1999', d2?.value === '1999-06-28', JSON.stringify(d2?.value));

  // A question that allows the future reads the near-future year.
  const d3 = parseLocal(q('date', { allowFuture: true }), '6/28/28', { now: at('2025-01-01T00:00:00') });
  check('allowFuture: "6/28/28" is 2028, not 1928', d3?.value === '2028-06-28', JSON.stringify(d3?.value));
  const d4 = parseLocal(q('date'), '6/28/28', { now: at('2025-01-01T00:00:00') });
  check('without allowFuture: "6/28/28" is 1928', d4?.value === '1928-06-28', JSON.stringify(d4?.value));

  // Feb 29 parses in a leap year and defers otherwise — the validYmd check
  // uses the input year, not today.
  const leap = parseLocal(q('date'), '2/29/2024', { now: at('2026-01-01T00:00:00') });
  check('Feb 29 2024 is a valid date', leap?.value === '2024-02-29', JSON.stringify(leap?.value));
  const notLeap = parseLocal(q('date'), '2/29/2023', { now: at('2026-01-01T00:00:00') });
  check('Feb 29 2023 defers', notLeap === null, JSON.stringify(notLeap?.value));

  // A future date is refused unless the question allows it, and "today"
  // itself is not future.
  const today = parseLocal(q('date'), '3/14/1979', { now: at('1979-03-14T12:00:00') });
  check('today is not future', today?.value === '1979-03-14', JSON.stringify(today?.value));
  const tomorrow = parseLocal(q('date'), '3/15/1979', { now: at('1979-03-14T12:00:00') });
  check('tomorrow is future and defers', tomorrow === null, JSON.stringify(tomorrow?.value));
}

// -- engine.js: pacing samples ------------------------------------------------

{
  const ticks = [1000, 1010, 1025, 1040];   // seconds
  let i = 0;
  const e = createEngine(SECTIONS, null, { now: () => ticks[Math.min(i++, ticks.length - 1)] });
  e.submit('ssa');      // the form choice
  e.submit('Ann');      // first_name
  e.submit('Adams');    // last_name
  const pace = e.getState().pace;
  check('two samples recorded', pace.samples.length === 2, JSON.stringify(pace.samples));
  check('sample is the wall-clock gap', pace.samples[0] === 10 && pace.samples[1] === 15,
    JSON.stringify(pace.samples));
}

// -- DS mapping: the date at the top of page 1 ---------------------------------

{
  const answers = { first_name: 'Ann', last_name: 'Adams' };
  const m = dsIntake.map(answers, { today: new Date(2024, 1, 29) });   // Feb 29 2024
  check('DS page-1 date comes from the injected today', m.text.Date === '02/29/2024',
    JSON.stringify(m.text.Date));
}

console.log(failures === 0 ? 'clock-injection: all checks passed' : `clock-injection: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
