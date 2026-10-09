// Golden fixture generator.
//
// The Kotlin port is pinned to the JS reference by these files, which land in
// android/core/src/test/resources/golden/ and are compared as parsed JSON
// trees (never byte-for-byte). Regenerate with `node tools/golden/index.mjs`;
// CI runs tools/golden/check.mjs and fails on any diff, so a change to the
// reference is always a deliberate one.
//
// Generated in UTC whatever the machine's timezone (see below), so the files
// are the same everywhere they are made.
//
// The goldens (one per file, per the plan):
//   parse            every val/defer case, typed cases, and a generated corpus
//                    for every question and loop field, with regex-dialect probes
//   choice           matchChoice/resolveTarget/resolveDeletion/resolveAddition
//   walks            seeded engine walks, every action recorded with its
//                    arguments, so a port replays them without the generator
//   fillplans        the answer fixtures + ~200 seeded random answer sets, each
//                    plan recorded with the answers it was made from
//   metrics          pdf-lib's Helvetica metrics, the numbers Kotlin reads
//   templateManifest buildManifest() for both templates
//   fits             every box x ~40 values
//   addendum         the addendum draw lists
//   import           v1/v2/v3 export files
//   tts              every fixed spoken string -> its ttshash
//   turn             the scenario transcripts

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECTIONS, flatten, findQuestion, nodeActive as nodeIsActive } from '../../src/schema.js';
import { createEngine } from '../../src/engine.js';
import { parseLocal } from '../../src/parse.js';
import { normalize } from '../../src/validate.js';
import { matchChoice } from '../../src/choice.js';
import * as correct from '../../src/correct.js';
import { planFill, buildManifest } from '../../src/fill.js';
import { fitTextBox } from '../../src/plan.js';
import { layoutAddendum } from '../../src/addendum.js';
import { worksheetContent } from '../../src/pdf.js';
import { parseExport } from '../../src/importer.js';
import { canonical } from '../../src/ttshash.js';
import { collectCorpus } from '../tts-corpus.mjs';
import * as ssaKit from '../../src/forms/ssa-starter-kit.js';
import * as dsIntake from '../../src/forms/ds-intake.js';
import { toWinAnsi } from '../../src/forms/common.js';
import { VALUE_CASES, DEFER_CASES } from './parse-corpus.mjs';
import { runScenario, yamlParse } from '../turn-runner.mjs';

// Every golden is generated in UTC. The parser and the DS mapping read the
// date through local-time getters, so a generator run on a machine in another
// timezone would pin a different "today" — and CI runs in UTC. Node applies
// a TZ assigned at runtime to every Date made after it.
process.env.TZ = 'UTC';
if (new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset() !== 0) {
  throw new Error('golden generator: could not switch to UTC');
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST = join(REPO, 'android', 'core', 'src', 'test', 'resources', 'golden');
// The goldens the app itself reads at runtime (the Helvetica metrics and the
// template manifests — box sizes never come from PDFBox), shipped as :core
// main resources rather than test fixtures.
const MAIN_DEST = join(REPO, 'android', 'core', 'src', 'main', 'resources', 'golden');
mkdirSync(DEST, { recursive: true });
mkdirSync(MAIN_DEST, { recursive: true });

const require = createRequire(import.meta.url);
const PDFLib = require(join(REPO, 'vendor', 'pdf-lib.min.js'));

// Goldens are compared as parsed JSON trees, never as text, and git keeps
// every committed version — so the two largest (walks, fillplans) are written
// compact rather than pretty-printed. That roughly halves them; the pretty
// diff was only ever a convenience for humans, who still get it for the rest.
const write = (name, value, { compact = false, main = false } = {}) => {
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  writeFileSync(join(DEST, `${name}.json`), text + '\n');
  if (main) writeFileSync(join(MAIN_DEST, `${name}.json`), text + '\n');
  console.log(`golden ${name}.json (${text.length} bytes)${main ? ' (+ main copy)' : ''}`);
};

/** Deterministic PRNG: same seed, same sequence, on every machine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fixture = name =>
  JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures', 'answers', `${name}.json`), 'utf8'));

// A fixed "today", as an instant: 2026-09-19 12:00 UTC.
const NOW = () => new Date(Date.UTC(2026, 8, 19, 12, 0, 0));
const FIXED_TICKS = Array.from({ length: 4000 }, (_, i) => 1_000_000 + i * 7000);   // ms

/**
 * The question a corpus case runs against, exactly as tests/parse-local.js
 * builds it: a real schema question for `questionKey`, otherwise a bare one of
 * its type — with the options of `optionsKey` when it names one, and no
 * prompt. The Kotlin test builds the same thing from the recorded fields.
 */
function caseQuestion({ type, optionsKey, questionKey }) {
  if (questionKey) {
    const real = findQuestion(questionKey);
    if (!real || real.type !== type) throw new Error(`corpus: ${questionKey} is not a ${type} question`);
    return real;
  }
  const options = optionsKey ? findQuestion(optionsKey)?.options : undefined;
  return { type, ...(options ? { options } : {}) };
}

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

/**
 * The fields of current() a port must reproduce, with JS's absent values as
 * null — so a missing section, a string where JS has a number in the path, or
 * a wrong hint fails the comparison instead of passing unseen.
 */
function currentView(q) {
  if (!q) return null;
  return {
    id: q.id,
    type: q.type,
    prompt: q.prompt ?? null,
    path: q.path,
    section: q.section ?? null,
    sectionTitle: q.sectionTitle ?? null,
    loopId: q.loopId ?? null,
    loopPhase: q.loopPhase ?? null,
    itemLabel: q.itemLabel ?? null,
    itemNumber: q.itemNumber ?? null,
    required: !!q.required,
    confirm: !!q.confirm,
    allowFuture: !!q.allowFuture,
    per: q.per ?? null,
    kind: q.kind ?? null,
    hint: q.hint ?? null,
    warn: q.warn ?? null,
    options: q.options ? q.options.map(o => o.value) : null
  };
}

// ---------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------

async function goldenParse() {
  const cases = [];

  for (const c of [...VALUE_CASES, ...DEFER_CASES]) {
    const r = parseLocal(caseQuestion(c), c.input, { now: NOW });
    cases.push({
      type: c.type,
      input: c.input,
      optionsKey: c.optionsKey ?? null,
      questionKey: c.questionKey ?? null,
      result: r === null ? null : { value: r.value, confidence: r.confidence }
    });
  }

  // Typed input: free text is left as written (null), a structured answer
  // still parses, and an echo is still stripped from it.
  const typed = [];
  for (const [type, input, optionsKey, questionKey] of [
    ['text', 'de la Cruz'], ['text', 'Smith Jr.'], ['text', 'Acme Tools, Inc.'],
    ['date', 'March 14th 1979'], ['date', 'My date of birth is March 14th, 1979', null, 'date_of_birth'],
    ['number', 'a few'], ['money', '$1,200'], ['choice', 'both', 'forms'], ['yesno', 'yes']
  ]) {
    const c = { type, optionsKey, questionKey };
    const r = parseLocal(caseQuestion(c), input, { typed: true, now: NOW });
    typed.push({
      type, input, optionsKey: optionsKey ?? null, questionKey: questionKey ?? null,
      result: r === null ? null : { value: r.value, confidence: r.confidence }
    });
  }

  // A generated corpus per question — every top-level question and every
  // loop field, which carries its own prompt, `per` and `kind`.
  const perQuestion = [];

  const typeInputs = {
    text: ['test answer', 'um, test answer', 'a longer answer with several words in it', 'Line one\nline two'],
    yesno: ['yes', 'no', 'yes I do', 'yes I do not', 'maybe'],
    ssn: ['123 45 6789', '9, 8, 7, 6, 5, 4, 3, 2, 1', 'double seven'],
    phone: ['555 123 4567', '(207) 555-0142'],
    zip: ['04101', '04101-1234'],
    email: ['ada@example.com', 'ada dot lovelace at example dot com', 'ada\u00a0@example.com'],
    date: ['March 14th 1979', '3/14/79', '14/3/1979', 'next Tuesday'],
    monthyear: ['March 1979', 'still working', 'March 2099'],
    money: ['1200', '$20 an hour', 'twelve hundred', 'twelve hundred a month', 'three fifty'],
    number: ['25', 'twenty five', 'a few', 'nineteen ninety eight', 'eight a day'],
    choice: ['first option', 'letter b', 'not any of them']
  };

  const record = (node, input, withNormalized) => {
    const r = parseLocal(node, input, { now: NOW });
    const entry = {
      id: node.id,
      loopId: node.loopId ?? null,
      type: node.type,
      input,
      result: r === null ? null : { value: r.value, confidence: r.confidence }
    };
    if (withNormalized) {
      entry.normalized = r === null ? null : (() => {
        const n = normalize({ ...r }, node);
        return { value: n.value, needsClarification: n.needsClarification, clarifyPrompt: n.clarifyPrompt };
      })();
    }
    perQuestion.push(entry);
  };

  const questions = allQuestions();
  for (const node of questions) {
    for (const input of typeInputs[node.type] ?? ['x']) record(node, input, true);
  }

  // Noise every question sees, including the characters where the regex
  // dialects part ways: JS \s is Unicode and \w, \b, \d are ASCII, while
  // Android's ICU makes all four Unicode. Non-breaking and other spaces, a
  // newline, curly quotes, accents and combining marks, emoji, a Kelvin sign
  // (which case-folds to k under Unicode rules), and Arabic-Indic and
  // full-width digits (which are \d under ICU and not in JS).
  const probes = [
    'abc', 'zéro', 'no', 'yes', '3.5', 'seventeen', '(207) 555-0142', '— em dash', 'e\u0301',
    '\u00a0non-breaking', 'yes\u00a0I do', 'no\u2009I don\u2019t', 'it\u2019s fine', '\u201cquoted\u201d',
    'Line\none', 'two\r\nlines', 'Zo\u00eb \u00c9lise', 'caf\u00e9', '\ud83d\ude00 smile', '\ud83d\udc4d',
    '\u212aelvin', '\u0661\u0662\u0663\u0664', '\uff11\uff12\uff13\uff14\uff15', '\u0967\u0968\u0969',
    'March\u00a014th 1979', '04101\u00a0', 'twelve\u00a0hundred'
  ];
  for (const node of questions) {
    for (const input of probes) record(node, input, false);
  }

  write('parse', { now: NOW().toISOString(), cases, typed, perQuestion });
}

// ---------------------------------------------------------------------------
// choice / correct / add / delete
// ---------------------------------------------------------------------------

async function goldenChoice() {
  const answersBoth = fixture('both');
  const answersSsa = fixture('starter-kit');

  const choices = [];
  for (const node of flatten(SECTIONS)) {
    if (node.type !== 'choice' || !node.options) continue;
    const inputs = new Set();
    for (const o of node.options) {
      inputs.add(o.value);
      inputs.add(o.label);
      for (const a of o.aliases ?? []) inputs.add(a);
    }
    inputs.add('not ' + (node.options[0]?.label ?? ''));
    inputs.add('');
    inputs.add('a little help sometimes');
    for (const input of inputs) {
      const hit = matchChoice(node.options, input);
      choices.push({ id: node.id, input, value: hit?.value ?? null });
    }
  }

  const correctCases = [];
  const phrases = [
    'change my phone number', 'my date of birth', 'the second provider', 'change my name',
    'my social security number', 'change the first job', 'my email address',
    'the guardian name', 'change my address', 'change the onset date', 'my marital status',
    'change the last provider', 'the second condition', 'change my birth city',
    'my first name', 'change my doctors phone', 'the landlord phone number',
    'change the third medication', 'my routing number', 'change the account number',
    'nonsense phrase that names nothing'
  ];
  // One shape for every case: a target, or a reason and the candidates (an
  // empty list when there are none), so a port is never excused a field.
  const resolution = r => (r.ok
    ? { target: { id: r.target.id, loopId: r.target.loopId ?? null, loopIndex: r.target.loopIndex ?? null, label: r.target.label } }
    : { reason: r.reason, candidates: (r.candidates ?? []).map(c => ({ id: c.id, loopId: c.loopId ?? null, label: c.label })) });
  for (const phrase of phrases) {
    correctCases.push({ phrase, forms: 'both', result: resolution(correct.resolveTarget(phrase, answersBoth)) });
  }
  for (const phrase of ['my date of birth', 'change my phone number']) {
    correctCases.push({ phrase, forms: 'ssa', result: resolution(correct.resolveTarget(phrase, answersSsa)) });
  }

  const additions = [];
  for (const phrase of ['add another condition', 'add a provider', 'add a job', 'one more medication', 'add nothing', 'add a marriage', 'add an income source']) {
    const r = correct.resolveAddition(phrase, answersBoth);
    additions.push({ phrase, result: r.reason !== 'none' ? { loopId: r.loopId ?? null, reason: r.reason, nextNumber: r.nextNumber ?? null } : { reason: 'none' } });
  }

  const deletions = [];
  for (const phrase of ['remove the second provider', 'delete that last job', 'remove the first condition', 'remove the provider', 'delete a medication', 'remove the third provider', 'remove something else']) {
    const r = correct.resolveDeletion(phrase, answersBoth);
    deletions.push({
      phrase,
      result: r.reason !== 'none'
        ? { loopId: r.loopId ?? null, reason: r.reason, loopIndex: r.loopIndex ?? null, number: r.number ?? null }
        : { reason: 'none' }
    });
  }

  write('choice', {
    fixtures: { both: answersBoth, ssa: answersSsa },
    choices, correct: correctCases, additions, deletions
  });
}

// ---------------------------------------------------------------------------
// walks
// ---------------------------------------------------------------------------

async function goldenWalks() {
  // Each walk records every action it took, with its arguments, so a port
  // replays the list and needs no copy of this random generator. The
  // generator only decides which walk gets recorded.
  const walks = [];

  const answerPool = {
    text: ['Maine Medical Center', 'Dr. Smith', 'Portland', 'Augusta', 'Tuscumbia', 'Alabama', 'English'],
    yesno: [true, false],
    ssn: ['123456789', '987654321'],
    phone: ['2075550100'],
    zip: ['04101'],
    email: ['ada@example.com'],
    date: ['1979-03-14', '1995-12-10', '2005-01-01'],
    monthyear: ['2019-11', 'present'],
    money: [1200, 20],
    number: [25, 3]
  };

  for (let w = 0; w < 6; w++) {
    const seed = 0x5EED + w;
    const rng = mulberry32(seed);
    const tick = (i => () => FIXED_TICKS[i++] / 1000)(w * 500);
    const engine = createEngine(SECTIONS, null, { now: tick });
    const actions = [];
    const pick = (q, roll) => {
      // A yes/no entry prompt opens an item three times in four. An entry asked
      // as the loop's first field gets a value instead, which opens one too.
      if (q.loopPhase === 'entry' && q.type === 'yesno') return roll < 0.75;
      if (q.type === 'choice' && q.options) return q.options[Math.floor(roll * q.options.length)]?.value;
      const pool = answerPool[q.type] ?? answerPool.text;
      return pool[Math.floor(roll * pool.length)];
    };
    // A top-level question already answered, to correct or detour to.
    const answeredTopLevel = () => {
      const a = engine.answers();
      return flatten(SECTIONS).filter(n => n.type !== 'loop' && a[n.id] !== undefined && nodeIsActive(n, a));
    };
    const loopsWithItems = () => {
      const a = engine.answers();
      return flatten(SECTIONS).filter(n => n.type === 'loop' && Array.isArray(a[n.id]) && a[n.id].length);
    };

    let guard = 0;
    while (!engine.isComplete() && guard++ < 700) {
      const q = engine.current();
      if (!q) break;
      const roll = rng();
      const action = {};

      if (roll < 0.10) {
        engine.skip();
        action.action = 'skip';
      } else if (roll < 0.14 && engine.getState().history.length > 0) {
        engine.back();
        action.action = 'back';
      } else if (roll < 0.17 && answeredTopLevel().length) {
        // A correction: jump, write in place, put the walk back.
        const pool = answeredTopLevel();
        const target = pool[Math.floor(rng() * pool.length)];
        const value = pick(target, rng());
        const restore = engine.cursorSnapshot();
        engine.jumpTo(target.id);
        engine.setAnswer(target.id, value);
        engine.restoreCursor(restore);
        Object.assign(action, { action: 'correct', id: target.id, value });
      } else if (roll < 0.19 && answeredTopLevel().length) {
        // A save made in the middle of a correction: the state as it will be
        // once the detour is put back (getState's returnTo), then put back.
        const pool = answeredTopLevel();
        const target = pool[Math.floor(rng() * pool.length)];
        const restore = engine.cursorSnapshot();
        engine.jumpTo(target.id);
        action.savedState = engine.getState({ returnTo: restore });
        engine.restoreCursor(restore);
        Object.assign(action, { action: 'saveMidCorrection', id: target.id });
      } else if (roll < 0.21 && loopsWithItems().length) {
        const loops = loopsWithItems();
        const loop = loops[Math.floor(rng() * loops.length)];
        const index = Math.floor(rng() * engine.answers()[loop.id].length);
        const removed = engine.removeItem(loop.id, index);
        Object.assign(action, { action: 'remove', loopId: loop.id, loopIndex: index, removed });
      } else {
        const value = pick(q, rng());
        engine.submit(value);
        Object.assign(action, { action: 'submit', value: value ?? null });
      }

      actions.push({
        ...action,
        current: currentView(engine.current()),
        progress: engine.progress(),
        missing: engine.missingRequired().map(m => ({ id: m.id, loopId: m.loopId ?? null, loopIndex: m.loopIndex ?? null })),
        state: engine.getState()
      });
    }
    walks.push({ seed, actions });
  }

  write('walks', { walks }, { compact: true });
}

// ---------------------------------------------------------------------------
// fillplans + templateManifest + metrics + fits + addendum
// ---------------------------------------------------------------------------

async function goldenPdf() {
  const loadFont = async () => {
    const doc = await PDFLib.PDFDocument.create();
    return {
      regular: await doc.embedFont(PDFLib.StandardFonts.Helvetica),
      bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold)
    };
  };
  const fonts = await loadFont();

  const metricsOf = f => ({
    widthOfTextAtSize: (text, size) => f.widthOfTextAtSize(toWinAnsi(text), size),
    heightAtSize: size => f.heightAtSize(size)
  });

  // -- metrics golden: the numbers the Kotlin HelveticaMetrics reads ---------
  const dumpMetrics = f => ({
    CharWidths: f.embedder.font.CharWidths,
    KernPairXAmounts: f.embedder.font.KernPairXAmounts,
    Ascender: f.embedder.font.Ascender,
    Descender: f.embedder.font.Descender,
    CapHeight: f.embedder.font.CapHeight,
    XHeight: f.embedder.font.XHeight,
    FontBBox: f.embedder.font.FontBBox
  });
  // Probes pin the Kotlin HelveticaMetrics against pdf-lib directly: for
  // known texts and sizes, the width (over the WinAnsi text, as every caller
  // measures it) and the height. The `ansi` string is recorded, so the Kotlin
  // side measures exactly what pdf-lib measured without needing toWinAnsi to
  // agree first.
  const probes = [];
  const probeTexts = [
    '', 'A', 'Ada', 'Portland', '123456789', 'Maine Medical Center',
    'A very long answer that will not fit in any box on the form at all, no matter how small it gets',
    'José Ñúñez', 'Łukasz Wałęsa', 'x'.repeat(300)
  ];
  for (const size of [7, 8, 9, 10, 11, 14, 20]) {
    for (const text of probeTexts) {
      const ansi = toWinAnsi(text);
      for (const [name, f] of [['helvetica', fonts.regular], ['helveticaBold', fonts.bold]]) {
        probes.push({
          font: name, text, ansi, size,
          width: f.widthOfTextAtSize(ansi, size),
          height: f.heightAtSize(size)
        });
      }
    }
  }
  // toWinAnsi over every code point of the blocks names and addresses use
  // (Latin, general punctuation, currency, letterlike), plus samples of what
  // must become "?" or lose an accent. [text, ansi] pairs.
  const winAnsi = [];
  for (const [a, b] of [[0x00, 0x2FF], [0x2000, 0x206F], [0x20A0, 0x20CF], [0x2100, 0x215F]]) {
    for (let cp = a; cp <= b; cp++) {
      const t = String.fromCodePoint(cp);
      winAnsi.push([t, toWinAnsi(t)]);
    }
  }
  for (const t of ['😀', '中文', 'e\u0301', 'Å\u030A', 'a\tb\rc\nd', 'Zoë “Zo” O’Brien-Łukasiewicz', 'ﬁle ½ ™', 'Ǆ ǅ']) {
    winAnsi.push([t, toWinAnsi(t)]);
  }
  write('winansi', { cases: winAnsi }, { compact: true });

  write('metrics', {
    helvetica: dumpMetrics(fonts.regular),
    helveticaBold: dumpMetrics(fonts.bold),
    probes
  }, { main: true });

  // -- templateManifest -------------------------------------------------------
  const manifests = {};
  for (const [formId, spec] of Object.entries({ ssa: ssaKit, ds: dsIntake })) {
    const bytes = readFileSync(join(REPO, spec.TEMPLATE));
    const doc = await PDFLib.PDFDocument.load(bytes);
    manifests[formId] = buildManifest(doc.getForm(), PDFLib);
  }
  write('templateManifest', manifests, { main: true });

  // -- fillplans ---------------------------------------------------------------
  const plans = [];
  const answersList = [
    ['both.json', fixture('both')],
    ['starter-kit.json', fixture('starter-kit')],
    ['ds-only.json', fixture('ds-only')],
    ['minimal.json', fixture('minimal')]
  ];

  const planFor = (formId, answers) => {
    const spec = formId === 'ssa' ? ssaKit : dsIntake;
    const mapping = spec.map(answers, { today: NOW() });
    return planFill(mapping, manifests[formId], metricsOf(fonts.regular));
  };

  // Each plan records the answers it was made from, so a port re-plans the
  // same input rather than reconstructing it.
  for (const [name, answers] of answersList) {
    for (const formId of ['ssa', 'ds']) {
      plans.push({ fixture: name, form: formId, answers, plan: planFor(formId, answers) });
    }
  }

  // ~200 seeded random answer sets.
  const rng = mulberry32(0xF11E);
  const nodes = flatten(SECTIONS);
  for (let i = 0; i < 200; i++) {
    const forms = ['ssa', 'ds', 'both'][Math.floor(rng() * 3)];
    const answers = { forms };
    for (const node of nodes) {
      if (rng() < 0.35) continue;
      if (node.type === 'loop') {
        const items = [];
        const n = Math.floor(rng() * 4);
        for (let k = 0; k < n; k++) {
          const item = {};
          for (const f of node.fields) {
            if (rng() < 0.7) item[f.id] = randomValue(f, rng);
          }
          items.push(item);
        }
        answers[node.id] = items;
      } else {
        answers[node.id] = randomValue(node, rng);
      }
    }
    for (const formId of ['ssa', 'ds']) {
      plans.push({ fixture: `random-${i}`, form: formId, answers, plan: planFor(formId, answers) });
    }
  }
  write('fillplans', { plans }, { compact: true });

  // -- fits: every box x ~40 values ---------------------------------------------
  const fits = [];
  const valuePool = [
    '', 'A', 'Ada', 'Portland', '123456789', 'Maine Medical Center',
    'A very long answer that will not fit in any box on the form at all, no matter how small it gets',
    'First line\nSecond line', 'José Ñúñez', 'Łukasz Wałęsa',
    '12345-6789', '$1,200', 'March 14, 1979', 'x'.repeat(300),
    ...Array.from({ length: 26 }, (_, i) => `value ${i}`)
  ];
  // Where pdf-lib's own text-field appearance would put each of the fit's
  // lines: its bounds (inset by the border width plus 1) and its line origins,
  // from pdf-lib's layout functions with the real font. The Android writer
  // draws exactly fit.lines, so it is pinned here to pdf-lib's positions for
  // those same lines rather than to its own arithmetic.
  const layoutOf = (entry, fit) => {
    const inset = (entry.borderWidth ?? 0) + 1;
    const bounds = { x: inset, y: inset, width: entry.width - 2 * inset, height: entry.height - 2 * inset };
    const opts = { alignment: entry.quadding ?? 0, fontSize: fit.size, font: fonts.regular, bounds };
    const placed = entry.multiline
      ? PDFLib.layoutMultilineText(fit.lines.join('\n'), opts).lines
      : [PDFLib.layoutSinglelineText(fit.lines[0] ?? '', opts).line];
    const texts = placed.map(l => l.text);
    if (JSON.stringify(texts) !== JSON.stringify(entry.multiline ? fit.lines : fit.lines.slice(0, 1))) {
      throw new Error(`pdf-lib would lay out ${JSON.stringify(fit.lines)} as ${JSON.stringify(texts)}`);
    }
    return { bounds, lines: placed.map(({ text, x, y }) => ({ text, x, y })) };
  };

  for (const [formId, manifest] of Object.entries(manifests)) {
    for (const [name, entry] of Object.entries(manifest.fields)) {
      if (entry.type !== 'text') continue;
      const box = { width: entry.width, height: entry.height, multiline: entry.multiline };
      const appearance = { quadding: entry.quadding ?? 0, borderWidth: entry.borderWidth ?? 0 };
      // The recorded value is the one that was fitted.
      const out = valuePool.map((value, i) => {
        const v = i < 14 ? value : `${value} #${i}`;
        const fit = fitTextBox(box, toWinAnsi(v), metricsOf(fonts.regular));
        return { value: v, fit, layout: layoutOf(entry, fit) };
      });
      fits.push({ form: formId, field: name, box, appearance, fits: out });
    }
  }
  write('fits', { fits }, { compact: true });

  // -- addendum draw lists -------------------------------------------------------
  // The content layoutAddendum was called with is recorded alongside the pages,
  // so the Kotlin AddendumLayout replays the same input rather than rebuilding
  // it through the form specs (which the fillplans golden already pins).
  const addendum = {};
  const overflowBoth = { ...fixture('both'), conditions: Array.from({ length: 14 }, (_, i) => ({ name: `A fairly long diagnosis name number ${i}` })) };
  for (const [formId, spec] of Object.entries({ ssa: ssaKit, ds: dsIntake })) {
    const mapping = spec.map(formId === 'ssa' ? fixture('both') : overflowBoth, { today: NOW() });
    const plan = planFill(mapping, manifests[formId], metricsOf(fonts.regular));
    const content = {
      title: spec.ADDENDUM.title,
      intro: spec.ADDENDUM.intro ?? [],
      overflowText: plan.overflowText,
      tables: plan.tables,
      sections: plan.sections,
      footer: spec.ADDENDUM.footer ?? []
    };
    const drawList = layoutAddendum(content, {
      regular: metricsOf(fonts.regular),
      bold: metricsOf(fonts.bold)
    });
    addendum[formId] = { pages: drawList.pages, content };
  }
  // The fallback worksheet goes through the same layout, from buildReport().
  {
    const content = worksheetContent(fixture('both'), { now: NOW });
    const drawList = layoutAddendum(content, { regular: metricsOf(fonts.regular), bold: metricsOf(fonts.bold) });
    addendum.worksheet = { pages: drawList.pages, content };
  }
  write('addendum', addendum);
}

function randomValue(question, rng) {
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  switch (question.type) {
    case 'yesno': return rng() < 0.5;
    case 'ssn': return pick(['123456789', '987654321', '555123456']);
    case 'phone': return pick(['2075550100', '5551234567']);
    case 'zip': return pick(['04101', '041011234']);
    case 'email': return pick(['ada@example.com', 'test@example.org']);
    case 'date': return pick(['1979-03-14', '1995-12-10', '2005-01-01', '2023-02-14']);
    case 'monthyear': return pick(['2019-11', 'present', '2021-03']);
    case 'money': return pick([1200, 20, 24000, 8500]);
    case 'number': return pick([25, 3, 8, 12]);
    case 'choice': return question.options?.length ? pick(question.options).value : null;
    default: return pick(['Maine Medical Center', 'Dr. Smith', 'Portland', 'Augusta', 'Test answer', 'English']);
  }
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

async function goldenImport() {
  const both = fixture('both');
  const ssa = fixture('starter-kit');

  const v1 = { version: 1, savedAt: '2025-01-01T10:00:00.000Z', answers: ssa };
  const engine = createEngine(SECTIONS, { schema: 3, answers: ssa, cursor: null, history: [], skipped: [], pace: { samples: [], peak: 0 } });
  const v2 = { version: 2, savedAt: '2025-06-01T10:00:00.000Z', answers: ssa, state: engine.getState() };
  const v3 = { version: 3, savedAt: '2026-01-01T10:00:00.000Z', answers: both, state: engine.getState() };

  const results = {};
  const inputs = {};
  for (const [name, file] of Object.entries({ v1, v2, v3 })) {
    const text = JSON.stringify(file);
    inputs[name] = text;
    const r = parseExport(text);
    results[name] = { state: r.state, savedAt: r.savedAt, rebuiltCursor: r.rebuiltCursor };
  }

  // A broken file: not JSON, no answers, wrong types. The inputs are recorded
  // so the Kotlin importer parses the same bytes.
  const broken = {};
  const brokenInputs = {
    notJson: 'not json at all',
    empty: '{"version":3,"answers":{}}',
    badAnswers: '{"version":3,"answers":{"first_name":42,"forms":"weird"}}'
  };
  for (const [name, text] of Object.entries(brokenInputs)) {
    try {
      parseExport(text);
      broken[name] = 'accepted (bad)';
    } catch (err) {
      broken[name] = err.message;
    }
  }

  write('import', { results, broken, inputs: { ...inputs, ...brokenInputs } });
}

// ---------------------------------------------------------------------------
// tts
// ---------------------------------------------------------------------------

async function goldenTts() {
  // The same corpus build-audio.mjs synthesizes from — one definition, two
  // consumers — so every fixed spoken string is pinned to its ttshash.
  const strings = collectCorpus();

  const hashText = text => {
    const bytes = Buffer.from(canonical(text), 'utf8');
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  };

  const hashes = [...strings].sort().map(text => ({ text, hash: hashText(text) }));

  // Every hash the build produced must have a clip in audio/.
  const manifest = JSON.parse(readFileSync(join(REPO, 'audio', 'manifest.json'), 'utf8'));
  const missing = hashes.filter(h => !manifest.hashes.includes(h.hash)).map(h => h.text);
  if (missing.length) {
    console.error('tts golden: strings without a pre-synthesized clip:');
    for (const m of missing.slice(0, 10)) console.error('  -', m);
    process.exitCode = 1;
  }

  write('tts', { hashes });
}

// ---------------------------------------------------------------------------
// turn transcripts
// ---------------------------------------------------------------------------

async function goldenTurn() {
  const dir = join(REPO, 'tools', 'turn-scenarios');
  const files = readdirSync(dir).filter(f => f.endsWith('.yaml')).sort();
  const transcripts = [];
  for (const file of files) {
    const doc = yamlParse(readFileSync(join(dir, file), 'utf8'));
    const { failures, transcript } = await runScenario(doc.scenario ?? file, doc.steps ?? [], { record: true });
    if (failures.length) {
      console.error(`goldenTurn: scenario ${file} failed:`, failures);
      process.exitCode = 1;
      continue;
    }
    transcripts.push({ scenario: doc.scenario ?? file, ...transcript });
  }
  write('turn', { transcripts });
}

// ---------------------------------------------------------------------------

async function main() {
  await goldenParse();
  await goldenChoice();
  await goldenWalks();
  await goldenPdf();
  await goldenImport();
  await goldenTts();
  await goldenTurn();
  console.log('all goldens written to', DEST);
}

main().catch(err => { console.error(err); process.exit(1); });
