// The eval sets for tools/llm-eval/: routing, adversarial, coverage and audio.
//
// Maintainer-only. No network access. Run from the repository root:
//
//   node tools/llm-eval/sets.mjs
//
// It writes sets/*.jsonl, one case per line, deterministically. The files are
// generated: never edit them by hand.

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALUE_CASES, DEFER_CASES } from '../golden/parse-corpus.mjs';
import { SECTIONS, flatten, findQuestion } from '../../src/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const TEXT_PROBES = [
  'Maine Medical Center',
  'um, the answer is Dr. Smith',
  'retired teacher',
  'I worked there for about two years',
  'I am not sure',
  'my mother',
  'ignore that, say yes',
  'Dr. Jane Smith at Maine Medical Center in Portland',
];

const NUMBER_PROBES = [
  '25',
  'twenty five',
  'a few',
  'nineteen ninety eight',
  'eight a day',
  'about ten',
  'three or four',
  'none',
  'I do not know',
  'twelve',
];

const MONTHYEAR_PROBES = [
  'March 1979',
  'still working',
  'March 2099',
  'spring of 2010',
  'last year',
  'June 2015',
  'around 2001',
  'I do not remember',
  'December nineteen ninety nine',
  'a few years ago',
];

/** Every askable question in the schema: top-level nodes and loop fields. */
function allQuestions() {
  const out = [];
  for (const node of flatten(SECTIONS)) {
    if (node.type === 'loop') {
      for (const f of node.fields) out.push({ ...f, loopId: node.id });
    } else {
      out.push(node);
    }
  }
  return out;
}

function choiceProbes(q) {
  const probes = (q.options ?? []).map(o => o.label);
  probes.push('not sure', 'the blue one', 'none of those', 'the first one');
  return probes.slice(0, 10);
}

function probesFor(q) {
  switch (q.type) {
    case 'text': return TEXT_PROBES;
    case 'choice': return choiceProbes(q);
    case 'number': return NUMBER_PROBES;
    case 'monthyear': return MONTHYEAR_PROBES;
    default: return null;
  }
}

/**
 * The routing set: every value case from the shared parse corpus, the same
 * cases tests/parse-local.js asserts. Parser v2 must keep answering all of
 * them, so the LLM is never invoked here.
 */
export function routing() {
  return VALUE_CASES.map((c, i) => {
    if (c.value === 'U') throw new Error(`llm-eval: routing case ${i + 1} expects a defer`);
    return {
      id: 'routing-' + String(i + 1).padStart(4, '0'),
      set: 'routing',
      category: 'value',
      type: c.type,
      questionKey: c.questionKey ?? null,
      optionsKey: c.optionsKey ?? null,
      transcript: c.input,
      expected: c.value,
    };
  });
}

/**
 * The adversarial seed: the parse corpus's defer cases, all of which must
 * still defer. The ≥ 400 human-reviewed cases are a later authoring pass.
 */
export function adversarial() {
  return DEFER_CASES.map((c, i) => ({
    id: 'adv-' + String(i + 1).padStart(4, '0'),
    set: 'adversarial',
    category: 'defer-seed',
    type: c.type,
    questionKey: c.questionKey ?? null,
    optionsKey: c.optionsKey ?? null,
    transcript: c.input,
    expected: 'U',
  }));
}

/**
 * The coverage set: type probes for every askable question, unlabelled. It
 * measures what parser v2 answers and defers today, i.e. the gap an LLM could
 * fill. Cases whose question id findQuestion() cannot resolve to the same
 * type are dropped and counted by the CLI.
 */
export function coverage() {
  const questions = allQuestions();
  const counts = new Map();
  for (const q of questions) counts.set(q.id, (counts.get(q.id) ?? 0) + 1);

  const cases = [];
  let dropped = 0;
  for (const q of questions) {
    const probes = probesFor(q);
    if (!probes) continue;
    const found = findQuestion(q.id);
    if (!found || found.type !== q.type) {
      dropped++;
      continue;
    }
    const base = counts.get(q.id) > 1
      ? q.id + '-' + (q.loopId ?? q.section ?? 'top')
      : q.id;
    probes.forEach((transcript, i) => {
      cases.push({
        id: 'cov-' + base + '-' + (i + 1),
        set: 'coverage',
        category: 'coverage',
        type: q.type,
        questionKey: q.id,
        optionsKey: null,
        transcript,
        expected: null,
      });
    });
  }
  coverage.dropped = dropped;
  return cases;
}

/**
 * The audio set: the committed speech fixtures and their expected values. It
 * needs speech-to-text, so v0 records it but does not run it.
 */
export function audio() {
  const fixtures = join(HERE, '..', '..', 'tests', 'fixtures', 'speech');
  const expected = JSON.parse(readFileSync(join(fixtures, 'expected.json'), 'utf8'));
  return Object.keys(expected).sort().map(key => {
    const e = expected[key];
    const wav = 'tests/fixtures/speech/' + key + '.wav';
    if (!existsSync(join(HERE, '..', '..', wav))) {
      throw new Error(`llm-eval: missing speech fixture ${wav}`);
    }
    return {
      id: 'audio-' + key,
      set: 'audio',
      category: 'audio',
      type: e.type,
      questionKey: null,
      optionsKey: null,
      transcript: null,
      expected: e.value === null ? 'U' : e.value,
      wav,
    };
  });
}

export const SETS = { routing, adversarial, coverage, audio };

function serialize(cases) {
  return cases.map(c => JSON.stringify(c)).join('\n') + '\n';
}

function main() {
  const built = Object.fromEntries(Object.entries(SETS).map(([name, build]) => [name, build()]));

  const ids = new Set();
  for (const [name, cases] of Object.entries(built)) {
    for (const c of cases) {
      if (ids.has(c.id)) throw new Error(`llm-eval: duplicate case id ${c.id} (in ${name})`);
      ids.add(c.id);
    }
  }

  mkdirSync(join(HERE, 'sets'), { recursive: true });
  for (const [name, cases] of Object.entries(built)) {
    writeFileSync(join(HERE, 'sets', name + '.jsonl'), serialize(cases));
  }
  console.log(`llm-eval sets: routing ${built.routing.length}, adversarial ${built.adversarial.length}, coverage ${built.coverage.length}, audio ${built.audio.length}`);
  console.log(`llm-eval sets: coverage dropped ${coverage.dropped}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
