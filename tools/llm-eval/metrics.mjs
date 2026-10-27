// Ship-gate metrics for one tools/llm-eval/ run.
//
// Maintainer-only. No network access. Called by tools/llm-eval/index.mjs.
// Each argument is an array of { case, result }, where result is a
// deterministicParse output or null (parser v2 deferred).

import { NOW, LLM_UNAVAILABLE, llmAvailable } from './parser.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function sortedByType(map) {
  return Object.fromEntries(Object.keys(map).sort().map(k => [k, map[k]]));
}

export function summarize({ routing, adversarial, coverage, audio }) {
  const routingWrong = [];
  const routingDeferred = [];
  let routingCorrect = 0;
  for (const { case: c, result } of routing) {
    if (result === null) routingDeferred.push(c.id);
    else if (same(result.value, c.expected)) routingCorrect++;
    else routingWrong.push(c.id);
  }

  const advWrong = [];
  let advDeferred = 0;
  const advByType = {};
  for (const { case: c, result } of adversarial) {
    const t = advByType[c.type] ?? (advByType[c.type] = { total: 0, deferred: 0 });
    t.total++;
    if (result === null) {
      advDeferred++;
      t.deferred++;
    } else {
      advWrong.push(c.id);
    }
  }

  const covByType = {};
  for (const { case: c, result } of coverage) {
    const t = covByType[c.type] ?? (covByType[c.type] = { total: 0, answered: 0, deferred: 0 });
    t.total++;
    if (result === null) t.deferred++;
    else t.answered++;
  }

  return {
    eval: 'v0',
    parser: 'parser v2 (src/parse.js parseLocal)',
    now: NOW().toISOString(),
    routing: {
      total: routing.length,
      correct: routingCorrect,
      wrong: routingWrong,
      deferred: routingDeferred,
    },
    adversarial: {
      total: adversarial.length,
      deferred: advDeferred,
      wrongValues: advWrong,
      recovered: 0,
      byType: sortedByType(advByType),
    },
    coverage: {
      byType: sortedByType(covByType),
      labelled: false,
    },
    audio: {
      total: audio.length,
      runnable: false,
      reason: 'needs speech-to-text; run tools/stt-eval.mjs',
    },
    llm: {
      available: llmAvailable(),
      reason: LLM_UNAVAILABLE,
    },
    gates: {
      routingUnchanged: routingCorrect === routing.length,
      adversarialZeroWrong: advWrong.length === 0,
      recoveredAtLeast40pct: null,   // needs the LLM
      textWrongAtMostHalfPct: null,  // needs labelled coverage + the LLM
      latency: null,                 // needs the LLM
    },
    verdict: 'baseline only: LLM go/no-go not decided (no backend)',
  };
}
