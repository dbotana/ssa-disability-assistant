// The interview screen goes up when Start runs, not after the intro has been
// spoken, and it takes no input until the first question has been asked.
// Runs with plain `node tests/start-screen.js`. No DOM, no microphone.

import { SECTIONS } from '../src/schema.js';
import { createEngine } from '../src/engine.js';
import { sensitiveAnswers } from '../src/store.js';
import { parseLocal } from '../src/parse.js';
import { normalize } from '../src/validate.js';
import { speakableValue, formatTimeRemaining } from '../src/a11y.js';
import * as correct from '../src/correct.js';
import * as say from '../src/phrases.js';
import { createTurnController } from '../src/turn.js';
import { createAppController } from '../src/app-controller.js';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) return;
  failures++;
  console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

const settle = () => new Promise(r => setTimeout(r, 0));

/** Ports whose speech holds each utterance until `release()`. */
function harness(factory, { persisting = false } = {}) {
  const snapshots = [];
  const spoken = [];
  const waiting = [];
  let recording = false;
  const ports = {
    createEngine: (saved, opts) => createEngine(SECTIONS, saved ?? null, opts),
    say, parseLocal, normalize, speakable: speakableValue, formatTimeRemaining, correct,
    store: {
      saveState: () => true, flush: async () => {}, markWithheld: () => {}, sensitiveAnswers,
      isPersisting: () => persisting, clearState: () => {}, forgetKey: () => {},
      MAX_AGE_MS: 7 * 86400000, MIN_PIN_LENGTH: 4
    },
    speech: {
      speak: text => new Promise(resolve => { spoken.push(text); waiting.push(resolve); }),
      cancel() {}
    },
    audio: {
      async startRecording() { recording = true; },
      async stopRecording() { recording = false; return { size: 1000 }; },
      cancelRecording() { recording = false; },
      isRecording: () => recording,
      lastCaptureDurationMs: () => 1000, lastCaptureHadSpeech: () => true,
      lastCapturePeak: () => 0.5, releaseMic() {}, earcon() {}
    },
    stt: { transcribe: async () => 'starter kit' },
    announce: () => {},
    onState: s => snapshots.push(s),
    clock: () => Date.UTC(2026, 8, 19, 12, 0, 0),
    timers: { setTimeout: () => 0, clearTimeout: () => {} }
  };
  const controller = factory(ports);
  /** Let every held utterance finish, including the ones they lead to. */
  async function releaseAll() {
    for (let guard = 0; guard < 100; guard++) {
      await settle();
      if (!waiting.length) return;
      while (waiting.length) waiting.shift()();
    }
  }
  return { controller, snapshots, spoken, waiting, releaseAll, isRecording: () => recording };
}

// --- 1. The turn controller: the screen first, then the intro -----------------
{
  const h = harness(createTurnController);
  const done = h.controller.start({ mode: 'voice', confirm: true });
  await settle();

  check('a snapshot is emitted before the intro has been spoken',
    h.snapshots.length > 0 && h.waiting.length === 1, `snapshots ${h.snapshots.length}, held ${h.waiting.length}`);
  const early = h.snapshots.at(-1);
  check('it shows the interview panel', early?.panel === 'interview', early?.panel);
  check('it marks the start as under way', early?.starting === true);
  check('the first question is already on screen', /Which form/.test(early?.questionText ?? ''), early?.questionText);
  check('the section label is already on screen', early?.sectionLabel !== '', JSON.stringify(early?.sectionLabel));
  check('only the intro has been spoken so far', h.spoken.length === 1 && h.spoken[0] === say.INTRO.voice,
    JSON.stringify(h.spoken));

  // Input during the intro is held, not raced against the first question.
  await h.controller.submitTyped('starter kit');
  check('a typed answer during the intro is not taken', h.controller.snapshot().answers.forms == null);
  check('a key during the intro does nothing', (await h.controller.onKey('Space')) == null);
  await h.controller.onTalkDown();
  check('Talk during the intro does not record', !h.isRecording());
  await h.controller.runCommand('skip');
  check('a command during the intro does nothing', /Which form/.test(h.controller.snapshot().questionText));

  await h.releaseAll();
  await done;

  const last = h.snapshots.at(-1);
  check('after the first question the start is over', last.starting === false);
  check('the first question is still on screen', /Which form/.test(last.questionText), last.questionText);
  check('the intro, the no-PIN warning and the question were spoken in order',
    h.spoken[0] === say.INTRO.voice && /PIN/i.test(h.spoken[1]) && /Which form/.test(h.spoken.at(-1)),
    JSON.stringify(h.spoken));

  const answered = h.controller.submitTyped('starter kit');
  await h.releaseAll();
  await answered;
  check('after the start, a typed answer is taken', h.controller.snapshot().answers.forms === 'ssa',
    JSON.stringify(h.controller.snapshot().answers.forms));
}

// --- 2. The app controller shows no controls during the intro ----------------
{
  const h = harness(createAppController, { persisting: true });
  const done = h.controller.start({ mode: 'voice', confirm: true });
  await settle();

  const during = h.controller.snapshot();
  check('app: the interview panel is up during the intro', during.panel === 'interview', during.panel);
  check('app: no Talk button during the intro', during.controls.talk === false);
  check('app: no text field during the intro', during.controls.text === false);
  check('app: no options during the intro', during.controls.options.length === 0,
    JSON.stringify(during.controls.options));

  await h.releaseAll();
  await done;

  const after = h.controller.snapshot();
  check('app: Talk is back after the question', after.controls.talk === true);
  check('app: the text field is back after the question', after.controls.text === true);
  check('app: the form options are back after the question', after.controls.options.length > 0);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('start-screen: all checks passed');
