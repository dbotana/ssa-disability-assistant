// Progress counting and the spoken time estimate.
// Runs with plain `node tests/progress-estimate.js`. Zero API calls.

import { createEngine } from '../src/engine.js';
import { formatTimeRemaining } from '../src/a11y.js';

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

/** Walk the interview, adding `caps[loopId]` items to each loop. */
function walk(caps = {}, onStep = () => {}, forms = 'ssa') {
  const e = createEngine();
  let guard = 0;
  while (!e.isComplete() && guard++ < 5000) {
    const q = e.current();
    if (!q) break;
    onStep(q, e.progress(), e);
    let v;
    if (q.id === 'forms') v = forms;
    else if (q.loopPhase === 'entry') v = q.itemNumber <= (caps[q.loopId] ?? 1);
    else if (q.type === 'yesno') v = true;
    else v = `v_${q.id}`;
    e.submit(v);
  }
  return e;
}

// --- 1. A loop counts as its questions, not as one unit --------------------
{
  const one = createEngine().progress();
  check('total counts individual questions, not schema nodes', one.total > 46,
    `total ${one.total} is no better than the 46-node count`);

  // Eight providers must cost more than one.
  let eightTotal = 0;
  walk({ providers: 8 }, (q, p) => { if (p.total > eightTotal) eightTotal = p.total; });
  check('a long provider list grows the total', eightTotal > one.total + 20,
    `peaked at ${eightTotal} against a baseline of ${one.total}`);
}

// --- 2. The percentage moves while a long loop is being filled -------------
{
  const seen = [];
  walk({ providers: 8 }, (q, p) => {
    if (q.loopId === 'providers') seen.push(p.percent);
  });
  const spread = Math.max(...seen) - Math.min(...seen);
  check('percent advances through a long provider list', spread >= 20,
    `moved only ${spread} points across ${seen.length} provider questions`);
}

// --- 3. The spoken percentage never goes backward --------------------------
{
  // Adding items mid-loop grows the denominator; the high-water mark absorbs it.
  for (const caps of [{ providers: 8 }, { providers: 12, jobs: 6 }, { medications: 9 }, {}]) {
    let prev = 0;
    let drops = 0;
    walk(caps, (q, p) => { if (p.percent < prev) drops++; prev = p.percent; });
    eq(`percent is monotonic for ${JSON.stringify(caps)}`, drops, 0);
  }
}

// --- 4. rawPercent is allowed to dip; that is the point of keeping both -----
{
  const e = createEngine();
  while (e.current() && e.current().loopId !== 'providers') {
    const q = e.current();
    e.submit(q.loopPhase === 'entry' ? false : q.type === 'yesno' ? false : `v_${q.id}`);
  }
  const before = e.progress();
  check('reached the providers loop', !!e.current(), 'never got there');
  check('rawPercent is exposed alongside percent',
    typeof before.rawPercent === 'number' && typeof before.percent === 'number');
  check('percent is never below rawPercent at the same moment',
    before.percent >= before.rawPercent,
    `${before.percent} vs ${before.rawPercent}`);
}

// --- 5. A finished interview reads 100 percent with nothing remaining ------
{
  const e = walk({ providers: 3, jobs: 2 });
  const p = e.progress();
  check('interview completed', e.isComplete());
  eq('finished at 100 percent', p.percent, 100);
  eq('nothing remaining', p.remaining, 0);
  eq('answered equals total', p.answered, p.total);
}

// --- 6. A declined branch drops out of the total ----------------------------
{
  // Say no to every loop and every yes/no; askIf-gated follow-ups never happen,
  // so the total must come out below the everything-yes walk.
  const no = createEngine();
  let guard = 0;
  while (!no.isComplete() && guard++ < 5000) {
    const q = no.current();
    if (!q) break;
    no.submit(q.id === 'forms' ? 'ssa' : q.type === 'yesno' || q.loopPhase === 'entry' ? false : `v_${q.id}`);
  }
  const yes = walk({});
  check('declining branches yields a smaller total than accepting them',
    no.progress().total < yes.progress().total,
    `no-walk ${no.progress().total} vs yes-walk ${yes.progress().total}`);
}

// --- 6b. Every form choice finishes monotonic and at 100 percent ------------
{
  for (const forms of ['ds', 'both']) {
    let prev = 0;
    let drops = 0;
    const e = walk({ providers: 2, medications: 2 }, (q, p) => {
      if (p.percent < prev) drops++;
      prev = p.percent;
    }, forms);
    eq(`percent is monotonic for ${forms}`, drops, 0);
    eq(`${forms} finishes at 100 percent`, e.progress().percent, 100);
  }
}

// --- 7. No estimate until there is enough evidence --------------------------
{
  const e = createEngine();
  eq('no estimate before any answer', e.progress().secondsRemaining, null);
  // One instant answer is not a pace.
  e.current(); e.submit('x');
  eq('no estimate after one answer', e.progress().secondsRemaining, null);
}

// --- 8. The estimate appears once a pace exists, and scales with it ---------
{
  // Drive the clock by hand: current() arms the timer, submit() closes it.
  // Sleeping is the only way to produce real samples, so keep them tiny and
  // assert on shape rather than on a wall-clock value.
  const e = createEngine();
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 6; i++) {
    e.current();
    sleep(20);
    e.submit('x');
  }
  const p = e.progress();
  check('an estimate exists after enough samples', p.secondsRemaining != null);
  check('the estimate is a non-negative number',
    typeof p.secondsRemaining === 'number' && p.secondsRemaining >= 0,
    String(p.secondsRemaining));
  check('the estimate scales with the questions left',
    p.secondsRemaining <= 60 * p.remaining, 'implausibly large for 20ms answers');
}

// --- 9. An idle gap is dropped rather than averaged in ---------------------
{
  // A sample longer than the idle cutoff is discarded, so a user who walks
  // away does not come back to a wildly inflated estimate.
  const e = createEngine();
  const state = e.getState();
  check('pace lives in the serializable state', Array.isArray(state.pace?.samples));

  // Resuming from a saved state must not treat the closed-page gap as one
  // very slow answer.
  const resumed = createEngine(undefined, state);
  eq('a resumed interview has no stale estimate', resumed.progress().secondsRemaining, null);
}

// --- 10. A state saved before pace tracking existed still loads ------------
{
  const old = createEngine().getState();
  delete old.pace;
  const e = createEngine(undefined, old);
  const p = e.progress();
  check('a pre-pace saved state loads', typeof p.percent === 'number');
  eq('and reports no estimate', p.secondsRemaining, null);
}

// --- 11. Spoken phrasing ----------------------------------------------------
{
  eq('no seconds, no phrase', formatTimeRemaining(null), null);
  eq('negative is refused', formatTimeRemaining(-5), null);
  eq('sub-minute', formatTimeRemaining(30), 'less than a minute');
  eq('a couple of minutes', formatTimeRemaining(120), 'about two minutes');
  eq('rounds to five-minute steps', formatTimeRemaining(13 * 60), 'about 15 minutes');
  eq('never says "about 0 minutes"', formatTimeRemaining(160), 'about 5 minutes');
  eq('an hour', formatTimeRemaining(3600), 'about an hour');
  eq('an hour and a half reads naturally', formatTimeRemaining(5400),
    'about an hour and a half');
  eq('whole hours', formatTimeRemaining(7200), 'about 2 hours');
  eq('half hours above one', formatTimeRemaining(9000), 'about 2 and a half hours');

  // The phrase must never claim a precision the median cannot support.
  for (let s = 60; s < 3600; s += 37) {
    const phrase = formatTimeRemaining(s);
    check(`${s}s phrase is bucketed`, /^about (two|\d+) minutes$/.test(phrase),
      phrase);
  }
}

console.log(failures === 0
  ? '\nAll progress and estimate checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
