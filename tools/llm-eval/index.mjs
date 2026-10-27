#!/usr/bin/env node
// Run tools/llm-eval/ eval v0 against parser v2.
//
// Maintainer-only. No network access. From the repository root:
//
//   node tools/llm-eval/sets.mjs
//   node tools/llm-eval/index.mjs
//
// This writes reports/v0-parser-v2.{json,md} and prints the Markdown report.
// The optional LLM backend is not built, so v0 is the deterministic baseline.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETS } from './sets.mjs';
import { deterministicParse } from './parser.mjs';
import { summarize } from './metrics.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAMES = ['routing', 'adversarial', 'coverage', 'audio'];

const serialize = cases => cases.map(c => JSON.stringify(c)).join('\n') + '\n';

function loadSets() {
  const built = Object.fromEntries(Object.entries(SETS).map(([name, build]) => [name, build()]));
  const onDisk = {};
  for (const name of NAMES) {
    try {
      onDisk[name] = readFileSync(join(HERE, 'sets', name + '.jsonl'), 'utf8');
    } catch {
      console.error('run node tools/llm-eval/sets.mjs first');
      process.exit(2);
    }
  }
  for (const name of NAMES) {
    const want = serialize(built[name]).split('\n');
    const have = onDisk[name].split('\n');
    if (want.length !== have.length || want.some((line, i) => line !== have[i])) {
      console.error('sets are stale: run node tools/llm-eval/sets.mjs');
      process.exit(2);
    }
  }
  return built;
}

function run(cases) {
  return cases.map(c => ({ case: c, result: deterministicParse(c) }));
}

function markdown(s) {
  const gate = (v) => v === null ? 'not evaluated (needs LLM)' : (v ? 'pass' : 'FAIL');
  const lines = [
    '# LLM eval v0: parser v2 baseline',
    '',
    `Ran ${s.parser} over the routing, adversarial and coverage sets at the golden time ${s.now}. Audio was not run.`,
    '',
    '| set | total | result |',
    '| --- | ---: | --- |',
    `| routing | ${s.routing.total} | ${s.routing.correct}/${s.routing.total} correct |`,
    `| adversarial | ${s.adversarial.total} | ${s.adversarial.deferred}/${s.adversarial.total} deferred, ${s.adversarial.wrongValues.length} wrong values |`,
  ];
  for (const [type, t] of Object.entries(s.coverage.byType)) {
    lines.push(`| coverage: ${type} | ${t.total} | ${t.answered}/${t.total} answered |`);
  }
  lines.push(`| audio | ${s.audio.total} | not run (${s.audio.reason}) |`);
  lines.push('');
  lines.push('## Gates');
  lines.push('');
  lines.push(`- routingUnchanged: ${gate(s.gates.routingUnchanged)}`);
  lines.push(`- adversarialZeroWrong: ${gate(s.gates.adversarialZeroWrong)}`);
  lines.push(`- recoveredAtLeast40pct: ${gate(s.gates.recoveredAtLeast40pct)}`);
  lines.push(`- textWrongAtMostHalfPct: ${gate(s.gates.textWrongAtMostHalfPct)}`);
  lines.push(`- latency: ${gate(s.gates.latency)}`);
  lines.push('');
  lines.push(`Verdict: ${s.verdict}`);
  lines.push('');
  return lines.join('\n');
}

const built = loadSets();
const summary = summarize({
  routing: run(built.routing),
  adversarial: run(built.adversarial),
  coverage: run(built.coverage),
  audio: built.audio,
});

mkdirSync(join(HERE, 'reports'), { recursive: true });
writeFileSync(join(HERE, 'reports', 'v0-parser-v2.json'), JSON.stringify(summary, null, 2) + '\n');
const md = markdown(summary);
writeFileSync(join(HERE, 'reports', 'v0-parser-v2.md'), md);
process.stdout.write(md);

process.exit(summary.gates.routingUnchanged && summary.gates.adversarialZeroWrong ? 0 : 1);
