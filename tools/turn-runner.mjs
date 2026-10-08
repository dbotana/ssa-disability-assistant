// Turn scenario runner.
//
// The scenarios in tools/turn-scenarios/*.yaml drive the dialog layer through
// its ports — no DOM, no microphone, no real clock — so the same files can
// run against the JS turn controller (tests/turn-scenarios.js) and, once it
// exists, the Kotlin TurnController.
//
// The clock is fixed at 2026-09-19 12:00 UTC and moves only on `advance`.
// Timers of a second or more (the idle lock) are fake and fire only when
// `advance` passes them; shorter ones (hands-free re-listening) run on the
// real event loop.
//
// Steps:
//   start:  { mode, confirm, resume? }   begin the interview. `resume` starts
//                                        from a saved session instead:
//                                        { fixture, answers } — the answers
//                                        of tests/fixtures/answers/<fixture>
//                                        plus `answers`, walked to the first
//                                        unanswered question and then redacted
//                                        exactly as store.js saves them, so the
//                                        sensitive numbers come back withheld
//   start-twice: { mode, confirm }       two starts at once, as a double press
//   type:   <text>                       a typed answer (or command)
//   say:    <transcript>                 a voice answer through the fake mic
//   say-quiet: <transcript>              voice answer, mic below the peak
//   press:  <key>                        Space, Enter, KeyN, Escape, KeyC...
//   quiet:  true|false                   fake mic hears speech or not
//   command: <name>                      run a command directly
//   advance: <minutes>                   move the clock, firing due timers
//   expect:
//     question:  regex on the text on screen
//     hint:      regex on the hint
//     status:    regex on the status line
//     readback:  open|closed
//     panel:     interview|review|setup
//     spoken:    regex over everything spoken since the last expect
//     unspoken:  regex that must NOT match anything spoken since then
//     spokenOnce: regex that must match exactly one spoken utterance
//     announced: regex over everything announced
//     answers:   map of expected engine answers (null: blank)
//     withheld:  [ids] the sensitive answers store.markWithheld() was told of
//     missing:   [..] required answers still blank (by prompt substring)
//   finish                              assert the interview can be finished

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SECTIONS } from '../src/schema.js';
import { createEngine } from '../src/engine.js';
import { sensitiveAnswers, redact } from '../src/store.js';
import { parseLocal } from '../src/parse.js';
import { normalize } from '../src/validate.js';
import { speakableValue } from '../src/a11y.js';
import { formatTimeRemaining } from '../src/a11y.js';
import * as correct from '../src/correct.js';
import * as say from '../src/phrases.js';
import { createTurnController } from '../src/turn.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIOS = join(REPO, 'tools', 'turn-scenarios');
const FIXTURES = join(REPO, 'tests', 'fixtures', 'answers');

/** Where every scenario's clock starts. */
export const SCENARIO_EPOCH_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
/** Timers at least this long are fake: they fire only when `advance` passes them. */
const FAKE_TIMER_MS = 1000;

// -- a YAML subset -------------------------------------------------------------
//
// Enough for the scenario files: maps, lists of maps, scalars, and one-line
// flow lists of scalars ([ssn, routing_number]). A bare list item ("- finish")
// is a key, which is how steps without arguments are written. No anchors, no
// multi-line strings, no flow maps. A dependency-free parser keeps the tools
// offline like the app.

function yamlParse(text) {
  const lines = text.split('\n')
    .map(l => ({ indent: l.match(/^\s*/)[0].length, text: l.trim() }))
    .filter(l => l.text && !l.text.startsWith('#'));
  const root = {};
  const stack = [{ obj: root, key: null, indent: -1, value: root }];

  for (let li = 0; li < lines.length; li++) {
    const { indent, text: line } = lines[li];
    const m = /^-\s*(.*)$/.exec(line);
    if (m) {
      // Pop to the list's level: the item itself is an object.
      while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
      const list = stack.at(-1).value;
      const item = {};
      list.push(item);
      if (m[1]) {
        const [k, v] = splitPair(m[1]);
        if (v === null) {
          const child = nextIsList(lines, li) ? [] : {};
          item[k] = child;
          stack.push({ obj: child, key: k, indent, value: child });
        } else {
          item[k] = scalar(v);
        }
      } else {
        stack.push({ obj: item, key: null, indent, value: item });
      }
      continue;
    }
    const [key, val] = splitPair(line);
    // Pop until an ancestor with a smaller indent.
    while (stack.length > 1 && stack.at(-1).indent >= indent) stack.pop();
    const target = stack.at(-1);
    if (val === null) {
      const child = nextIsList(lines, li) ? [] : {};
      target.obj[key] = child;
      stack.push({ obj: child, key, indent, value: child });
    } else {
      target.obj[key] = scalar(val);
    }
  }
  return root;
}

/** Is the next content line a list item at a deeper indent? */
function nextIsList(lines, i) {
  const here = lines[i].indent;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.indent <= here) return false;
    return /^-\s*/.test(l.text);
  }
  return false;
}

function splitPair(line) {
  const i = line.indexOf(':');
  if (i === -1) return [line.trim(), null];
  const key = line.slice(0, i).trim();
  const rest = line.slice(i + 1).trim();
  return rest === '' ? [key, null] : [key, rest];
}

function scalar(v) {
  if (v === '[]') return [];
  // A flow list of scalars: [ssn, routing_number].
  if (/^\[.*\]$/.test(v)) return v.slice(1, -1).split(',').map(x => scalar(x.trim())).filter(x => x !== '');
  if (/^["']/.test(v) && /["']$/.test(v) && v.length > 1) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

// -- the fake ports -----------------------------------------------------------

function harness(scenario) {
  const spoken = [];
  const announced = [];
  const record = { spoken: [], announced: [] };
  let peak = 0.5;
  let hadSpeech = true;
  let durationMs = 1000;
  let recording = false;

  const answers = { saved: null, wrote: 0, withheld: [] };

  // The real redaction, so the idle lock finds the numbers the way it does in
  // the app; persistence itself is a stub.
  const store = {
    saveState: (state) => { answers.wrote += 1; return true; },
    flush: async () => {},
    markWithheld: fields => { answers.withheld.push(...fields.map(f => f.id)); },
    sensitiveAnswers,
    isPersisting: () => true,
    clearState: () => {},
    forgetKey: () => {},
    MAX_AGE_MS: 7 * 86400000,
    MIN_PIN_LENGTH: 4
  };

  const audio = {
    async startRecording() { recording = true; },
    async stopRecording() { recording = false; return { size: 1000, text: null }; },
    cancelRecording() { recording = false; },
    isRecording: () => recording,
    lastCaptureDurationMs: () => durationMs,
    lastCaptureHadSpeech: () => hadSpeech,
    lastCapturePeak: () => peak,
    releaseMic() {},
    earcon() {}
  };

  let nextTranscript = '';
  const stt = {
    transcribe: async blob => (blob?.text ?? nextTranscript ?? '')
  };

  const state = { snapshots: [], exports: [] };

  // The fixed clock, and timers that follow it.
  let nowMs = SCENARIO_EPOCH_MS;
  const fake = new Map();
  let nextTimer = 1;
  const timers = {
    setTimeout: (fn, ms) => {
      if (ms < FAKE_TIMER_MS) { const t = setTimeout(fn, ms); t.unref?.(); return t; }
      const id = `fake-${nextTimer++}`;
      fake.set(id, { at: nowMs + ms, fn });
      return id;
    },
    clearTimeout: id => {
      if (typeof id === 'string' && id.startsWith('fake-')) fake.delete(id);
      else clearTimeout(id);
    }
  };
  const settle = () => new Promise(r => setTimeout(r, 0));
  /** Move the clock forward, running each fake timer that comes due, in order. */
  async function advance(ms) {
    const target = nowMs + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of fake) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      fake.delete(next[0]);
      nowMs = next[1].at;
      next[1].fn();
      await settle();
    }
    nowMs = target;
  }

  const turn = createTurnController({
    createEngine: (saved, opts) => createEngine(SECTIONS, saved ?? null, opts),
    say,
    parseLocal,
    normalize,
    speakable: speakableValue,
    formatTimeRemaining,
    correct,
    store,
    speech: {
      speak: async (text) => { spoken.push(text); record.spoken.push(text); },
      cancel() {}
    },
    audio,
    stt,
    timers,
    clock: () => nowMs,
    announce: (text, assertive) => { announced.push(text); record.announced.push(text); },
    onState: s => state.snapshots.push(s),
    onExport: async ({ forms }) => { state.exports.push(forms); },
    onReadBack: async () => {}
  });

  return {
    turn, spoken, announced, record, state, audio, answers, advance,
    setTranscript: t => { nextTranscript = t; },
    setQuiet: q => { hadSpeech = !q; peak = q ? 0.004 : 0.5; }
  };
}

/**
 * A saved session as store.js would hand it back: the answers walked to their
 * first unanswered question, then redacted, so the sensitive numbers are
 * missing from the state and listed as withheld.
 */
function savedSession({ fixture = null, answers = {} } = {}) {
  const base = fixture ? JSON.parse(readFileSync(join(FIXTURES, `${fixture}.json`), 'utf8')) : {};
  const engine = createEngine(SECTIONS, { answers: { ...base, ...answers } }, { now: () => SCENARIO_EPOCH_MS / 1000 });
  const { state, withheld } = redact(engine.getState());
  return { savedAt: SCENARIO_EPOCH_MS, state, withheld };
}

// -- the assertions --------------------------------------------------------------

export { yamlParse };

/**
 * @param {object} opts  { record: true } to also capture the spoken and
 *                       announced transcript and the final answers.
 */
export async function runScenario(name, steps, opts = {}) {
  const failures = [];
  const ok = (label, cond, detail = '') => {
    if (!cond) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  };
  const h = harness();
  const { turn, spoken, announced, state, record } = h;

  let last = null;
  const snap = () => state.snapshots.at(-1) ?? last;
  const flushSpoken = () => {
    last = snap();
    spoken.length = 0;
    announced.length = 0;
  };
  const settle = () => new Promise(r => setTimeout(r, 0));
  const startOpts = o => ({
    mode: o.mode ?? 'voice',
    confirm: o.confirm ?? true,
    ...(o.resume ? { saved: savedSession(o.resume) } : {})
  });

  for (const step of steps) {
    await settle();
    if (step.start) {
      await turn.start(startOpts(step.start));
    } else if (step['start-twice']) {
      const o = startOpts(step['start-twice']);
      await Promise.all([turn.start(o), turn.start(o)]);
    } else if (step.advance != null) {
      await h.advance(Number(step.advance) * 60 * 1000);
    } else if (step.type != null) {
      await turn.submitTyped(String(step.type));
    } else if (step.say != null) {
      h.setTranscript(String(step.say));
      await turn.sendAudio({ size: 1000, text: String(step.say) });
    } else if (step['say-quiet'] != null) {
      h.setQuiet(true);
      h.setTranscript(String(step['say-quiet']));
      await turn.sendAudio({ size: 1000, text: String(step['say-quiet']) });
      h.setQuiet(false);
    } else if (step.quiet != null) {
      h.setQuiet(step.quiet === true);
    } else if (step.press != null) {
      await turn.onKey(step.press, { typing: false });
    } else if (step.command != null) {
      await turn.runCommand(step.command);
    } else if (step['start-review']) {
      await turn.startReview();
    } else if (step.expect) {
      const e = step.expect;
      const s = snap();
      if (e.question != null) ok(`question matches /${e.question}/`, new RegExp(e.question).test(s.questionText ?? ''), JSON.stringify(s.questionText));
      if (e.hint != null) ok(`hint matches /${e.hint}/`, new RegExp(e.hint).test(s.hintText ?? ''), JSON.stringify(s.hintText));
      if (e.status != null) ok(`status matches /${e.status}/`, new RegExp(e.status).test(s.statusText ?? ''), JSON.stringify(s.statusText));
      if (e.readback != null) ok(`readback ${e.readback}`, (s.readbackOpen ? 'open' : 'closed') === e.readback);
      if (e.panel != null) ok(`panel ${e.panel}`, s.panel === e.panel, s.panel);
      if (e.spoken != null) {
        const all = spoken.join(' ');   // spoken since the last expect
        ok(`spoken /${e.spoken}/`, new RegExp(e.spoken).test(all), JSON.stringify(all));
      }
      if (e.unspoken != null) {
        const all = spoken.join(' ');
        ok(`not spoken /${e.unspoken}/`, !new RegExp(e.unspoken).test(all), JSON.stringify(all));
      }
      if (e.spokenOnce != null) {
        const n = spoken.filter(t => new RegExp(e.spokenOnce).test(t)).length;
        ok(`spoken once /${e.spokenOnce}/`, n === 1, `spoken ${n} times`);
      }
      if (e.withheld) {
        const want = [].concat(e.withheld);
        ok(`withheld ${JSON.stringify(want)}`,
          JSON.stringify([...new Set(h.answers.withheld)].sort()) === JSON.stringify([...want].sort()),
          JSON.stringify(h.answers.withheld));
      }
      if (e.announced != null) {
        const all = announced.join(' ');
        ok(`announced /${e.announced}/`, new RegExp(e.announced).test(all), JSON.stringify(all));
      }
      if (e.answers) {
        for (const [k, v] of Object.entries(e.answers)) {
          const got = s.answers?.[k];
          const same = v === null ? got == null : JSON.stringify(got) === JSON.stringify(v);
          ok(`answer ${k}`, same, `${JSON.stringify(got)} != ${JSON.stringify(v)}`);
        }
      }
      if (e.missing) {
        ok(`missing /${e.missing}/`, new RegExp(e.missing).test(s.missing ?? ''), JSON.stringify(s.missing));
      }
      flushSpoken();
    } else if (step.finish) {
      await turn.finishInterview();
    }
  }

  await settle();
  return opts.record
    ? { failures, transcript: { spoken: record.spoken.slice(), announced: record.announced.slice(), answers: snap().answers } }
    : failures;
}

export async function runAll() {
  const files = readdirSync(SCENARIOS).filter(f => f.endsWith('.yaml')).sort();
  let failures = 0;
  for (const file of files) {
    const doc = yamlParse(readFileSync(join(SCENARIOS, file), 'utf8'));
    const bad = await runScenario(doc.scenario ?? file, doc.steps ?? []);
    if (bad.length) {
      failures += bad.length;
      console.error(`FAIL ${file}:`);
      for (const b of bad) console.error(`  ${b}`);
    } else {
      console.log(`pass ${file}`);
    }
  }
  return failures;
}
