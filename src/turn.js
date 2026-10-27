// The turn controller: ask -> listen -> transcribe -> interpret -> confirm
// once -> commit -> advance, as a pure state machine over injected ports.
//
// Everything here was pulled out of main.js so the same dialog flows run on
// two implementations: the web app (main.js wires the ports to the DOM, the
// microphone, and the local transcriber) and the Android app (TurnController
// in Kotlin wires the same ports to Compose, AudioRecord and whisper.cpp).
// The shared YAML scenarios in tools/turn-scenarios/ drive both, and every
// flow is a JVM test on the Android side because nothing here touches the
// screen, the mic, or the clock directly.
//
// The turn is interpret-first: a voice answer is transcribed, gated, parsed
// and validated, and the *parsed value* is read back once — never the raw
// transcript and then the value. One confirmation, whatever produced the
// value, which is what makes room for an LLM-derived parse later without a
// second round trip.
//
// State = one base mode (Interview, Review, Correcting, Adding) times one
// overlay (ValueReadBack, ChoosingField, ChoosingItem, ConfirmDelete).
// Exactly one overlay can be open.

import { localCommand } from './commands.js';
import { SECTIONS, SENSITIVE_TYPES } from './schema.js';
import * as defaultI18n from './i18n/index.js';

export const MIN_CAPTURE_MS = 350;
export const QUIET_PEAK = 0.05;
export const DIGIT_SILENCE_MS = 3000;
export const DIGIT_MAX_CAPTURE_MS = 60000;
export const IDLE_LOCK_MS = 15 * 60 * 1000;

// What a transcriber tends to emit when handed silence or room tone. Rejected
// only when the microphone also stayed near the noise floor for the whole
// capture, so someone who genuinely says "okay" into a live mic is still heard.
const FILLER_TRANSCRIPTS = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'bye', 'okay', 'ok', 'uh', 'um', 'hmm', 'mm', 'oh', 'the'
]);

const ACCURATE_DIGIT_TYPES = new Set(['ssn', 'routing', 'account', 'phone']);

/** Is this transcript empty, punctuation, or silence-filler from a quiet mic? */
export function isEmptyTranscript(text, peak) {
  const s = String(text ?? '').trim();
  if (!s) return true;
  // Nothing but punctuation, dashes, quotes or ellipses.
  if (!/[\p{L}\p{N}]/u.test(s)) return true;
  const bare = s.toLowerCase().replace(/[.!?,\s]+$/, '').trim();
  return FILLER_TRANSCRIPTS.has(bare) && peak < QUIET_PEAK;
}

/**
 * Create the turn controller.
 *
 * @param {object} ports
 *   createEngine(savedState, { now }) -> engine instance (engine.js
 *                createEngine); `now` is the controller's clock in seconds
 *   say          phrases.js
 *   parseLocal   parse.js
 *   normalize    validate.js
 *   speakable    a11y.speakableValue(value, type, options)
 *   formatTimeRemaining  a11y.formatTimeRemaining(seconds)
 *   correct      correct.js (resolveTarget, resolveChoice, isDeletionPhrase,
 *                resolveDeletion, describeItem, isAdditionPhrase,
 *                resolveAddition, buildTargets, describeTarget)
 *   store        store.js (saveState, flush, markWithheld, sensitiveAnswers,
 *                isPersisting, clearState, forgetKey, MAX_AGE_MS, MIN_PIN_LENGTH)
 *   speech       { speak(text, {interrupt}) -> Promise, cancel() }
 *   audio        { startRecording(opts), stopRecording(), cancelRecording(),
 *                  isRecording(), lastCaptureDurationMs(), lastCaptureHadSpeech(),
 *                  lastCapturePeak(), releaseMic(), earcon(name) }
 *   stt          { transcribe(blob) -> Promise<string> }
 *   announce     (text, assertive = false) -> void
 *   onState      (snapshot) -> void   called after every state change
 *   onExport     ({ forms }) -> Promise<void>   browser/Android fills the PDFs
 *   onReadBack   (answers) -> Promise<void>     the "read back my answers" hook
 *   clock        () => milliseconds, defaults to Date.now
 *   timers       { setTimeout, clearTimeout }, defaults to the globals
 *
 * @returns the controller; see the method comments below.
 */
export function createTurnController(ports) {
  const {
    createEngine, say, parseLocal, normalize, speakable, formatTimeRemaining, correct, store,
    speech, audio, stt, announce, onState, onExport = async () => {}, onReadBack = async () => {},
    i18n = defaultI18n
  } = ports;
  let engine = null;
  const clock = ports.clock ?? (() => Date.now());
  const timers = ports.timers ?? { setTimeout, clearTimeout };
  // Every reader of the time goes through `clock`, so a scenario or a golden
  // that pins it pins the parser's century window and the engine's pacing
  // too. The three disagree on units: milliseconds here, seconds for the
  // engine, a Date for the parser.
  const parseNow = () => new Date(clock());

  // -- languages ---------------------------------------------------------------
  //
  // Four channels, resolved independently (D2). `languages` is set on start;
  // until then English keeps every path exactly as it was.
  let languages = i18n.normalizeSettings();
  const screen = text => i18n.translate(text, languages.screen);
  const out = text => i18n.translate(text, languages.output);
  const msg = (key, vars = {}, channel = 'output') =>
    i18n.message(key, vars, languages[channel]);
  const inputLang = () => languages.input;
  const outputLang = () => languages.output;

  const parse = (question, text, opts = {}) =>
    parseLocal(question, text, { ...opts, now: parseNow, lang: inputLang() });
  const command = text => localCommand(text, inputLang());
  const speakValue = (value, type, options) =>
    speakable(value, type, options, outputLang());
  const screenValue = (value, type, options) =>
    speakable(value, type, options, languages.screen);
  /** A message pair for text that is both spoken and shown (review notes). */
  const pair = (key, vars, screenVars = vars) => ({
    spoken: msg(key, vars),
    shown: msg(key, screenVars, 'screen')
  });
  const sayPair = text => ({ spoken: out(text), shown: screen(text) });

  // -- state -----------------------------------------------------------------

  let mode = 'voice';              // voice | handsfree | text
  let voiceDisabled = false;
  let lastInputWasText = false;
  let busy = false;
  let confirmEachAnswer = true;
  let revealSensitive = false;

  // The one overlay a value read-back opens, awaiting yes or no.
  let pending = null;              // { question, value } awaiting confirmation
  // Correction state. Exactly one of these is active at a time.
  let correcting = null;           // { target, question, restore }
  let choosing = null;             // { candidates }
  let choosingItem = null;         // { loopId, itemLabel, candidates }
  let confirmingDelete = null;     // { loopId, item }
  let adding = null;               // { loopId, itemLabel, startCount }
  let resumeAfterPrompt = false;
  let awaitingFieldName = false;

  let withheld = [];               // [{ id, loopId?, loopIndex?, idle? }]
  let lastSpoken = '';
  let lastSegments = [];
  let lastSection = null;
  let lastSpokenEstimate = null;
  let idleTimer = null;
  let panel = 'interview';         // interview | review

  const isSensitive = q => SENSITIVE_TYPES.has(q?.type);

  // -- UI snapshot -------------------------------------------------------------
  //
  // The controller never touches the screen; it emits the screen. main.js and
  // the Android UI render this shape, which the scenario tests also assert on.

  function snapshot({ focus = null } = {}) {
    const q = displayQuestion();
    return {
      panel,
      sectionLabel,
      questionText: q ? questionText() : '',
      hintText: readBackOpen() || panel === 'review' || !q?.hint ? hintText() : screen(q.hint),
      statusText: statusText,
      readbackOpen: readBackOpen(),
      inputMasked: !revealSensitive && isSensitive(q),
      voiceDisabled,
      progressText: progressText(),
      reviewIntro,
      answers: engine.answers(),
      revealSensitive,
      languages: { ...languages },
      sttUnavailable: !i18n.sttFor(languages.input).installed,
      lane: lastInputWasText || mode === 'text' ? 'text' : 'voice',
      focus: focus ?? (panel === 'review' ? 'fix' : null),
      section: engine.progress(),
      missing: engine.missingRequired().map(m => m.prompt).join(' | ')
    };
  }

  let sectionLabel = '';
  let statusText = '';
  let questionTextContent = '';
  let hintTextContent = '';
  let reviewIntro = '';

  const questionText = () => questionTextContent;
  const hintText = () => hintTextContent;
  const emit = () => onState(snapshot());

  // -- small helpers -----------------------------------------------------------

  /** The question whatever is on screen right now is about. */
  function displayQuestion() {
    return pending?.question ?? correcting?.question ?? engine.current() ?? null;
  }

  function readBackOpen() {
    return !!pending;
  }

  const sameField = (a, b) => a.id === b.id && (a.loopId ?? null) === (b.loopId ?? null)
    && (a.loopIndex ?? 0) === (b.loopIndex ?? 0);

  /** Where an answer lives, as `withheld` and the store record it. */
  const fieldOf = f => (f.loopId ? { id: f.id, loopId: f.loopId, loopIndex: f.loopIndex ?? 0 } : { id: f.id });

  function isAnswered({ id, loopId = null, loopIndex = 0 }) {
    const answers = engine.answers();
    const v = loopId ? answers[loopId]?.[loopIndex]?.[id] : answers[id];
    return v != null && v !== '';
  }

  function saveSession() {
    return store.saveState(engine.getState({ returnTo: correcting?.restore }), {});
  }

  function touchActivity() {
    timers.clearTimeout(idleTimer);
    idleTimer = timers.setTimeout(() => { lockSensitive().catch(() => {}); }, IDLE_LOCK_MS);
  }

  const isFirstFieldOfItem = q => {
    if (!q?.loopId) return false;
    const node = SECTIONS.flatMap(s => s.questions).find(n => n.id === q.loopId);
    return node?.fields?.[0]?.id === q.id;
  };

  // -- the ask ------------------------------------------------------------------

  async function askCurrent({ announceSection = false, prefix = '' } = {}) {
    pending = null;
    const q = engine.current();

    if (!q) { await finishInterview(); return; }

    const segments = [];
    if (correcting) {
      sectionLabel = msg('changing_answer', { section: screen(q.sectionTitle) }, 'screen');
    } else if (adding) {
      sectionLabel = msg('adding_item', {
        item: screen(adding.itemLabel), section: screen(q.sectionTitle)
      }, 'screen');
    } else if (announceSection || q.section !== lastSection) {
      const p = engine.progress();
      if (p.sectionCount) {
        segments.push(msg('section_of', { number: p.sectionNumber, count: p.sectionCount }));
        segments.push(`${out(q.sectionTitle)}.`);
        sectionLabel = msg('section_label_with_count', {
          number: p.sectionNumber, count: p.sectionCount, title: screen(q.sectionTitle)
        }, 'screen');
      } else {
        segments.push(`${out(q.sectionTitle)}.`);
        sectionLabel = screen(q.sectionTitle);
      }
      lastSection = q.section;
      const left = formatTimeRemaining(p.secondsRemaining, outputLang());
      if (left && left !== lastSpokenEstimate) {
        segments.push(msg('time_left', { time: left }));
        lastSpokenEstimate = left;
      }
    }
    if (q.warn && !correcting) segments.push(out(q.warn));
    if (!correcting && q.loopPhase === 'field' && q.itemNumber > 1 && isFirstFieldOfItem(q)) {
      segments.push(msg('item_number', { item: out(titleCase(q.itemLabel)), number: q.itemNumber }));
    }
    if (prefix) segments.push(prefix);
    segments.push(out(q.prompt));

    questionTextContent = screen(q.prompt);
    hintTextContent = q.hint ? screen(q.hint) : '';
    reviewIntro = '';
    await speakSegments(segments);

    resumeListening();
  }

  async function speakSegments(segments) {
    lastSegments = segments.filter(Boolean);
    lastSpoken = lastSegments.join(' ');
    for (const [i, text] of lastSegments.entries()) {
      await speech.speak(text, { interrupt: i === 0, lang: outputLang() });
    }
  }

  function progressText() {
    const p = engine.progress();
    const left = formatTimeRemaining(p.secondsRemaining, languages.screen);
    return left
      ? msg('progress_line', { percent: p.percent, time: left }, 'screen')
      : msg('progress_only', { percent: p.percent }, 'screen');
  }

  function resumeListening() {
    if (mode === 'handsfree' && !voiceDisabled) { queueListen(); return; }
    emit({});
  }

  function queueListen(attempt = 0) {
    if (attempt > 100) return;
    timers.setTimeout(() => {
      if (busy) { queueListen(attempt + 1); return; }
      listenHandsFree();
    }, 60);
  }

  // -- starting ------------------------------------------------------------------

  // A second start while the first is still under way — a double press of
  // Start or Resume while the intro is being spoken — joins the first rather
  // than running over it. main.js guards the setup panel the same way
  // (startOnce); this is the guard every front end gets.
  let starting = null;

  function start(opts = {}) {
    if (starting) return starting;
    starting = startNow(opts).finally(() => { starting = null; });
    return starting;
  }

  async function startNow({ mode: startMode = 'voice', confirm = true, reveal = false, saved = null, withheldFrom = null, languages: chosen = null } = {}) {
    mode = startMode;
    languages = i18n.normalizeSettings(chosen ?? undefined);
    confirmEachAnswer = confirm;
    revealSensitive = reveal;
    engine = createEngine(saved?.state ?? null, { now: () => clock() / 1000 });
    // The numbers a resumed session did not save. `withheldFrom` overrides the
    // saved list only when a caller passes one: defaulting it to [] would
    // throw the saved list away, and a resumed session would never ask for
    // the Social Security and bank numbers again.
    withheld = (withheldFrom ?? saved?.withheld ?? []).filter(w => !isAnswered(w));
    if (saved) saveSession();
    panel = 'interview';
    lastInputWasText = mode === 'text';

    // A language whose speech pack is not installed keeps typed answers and
    // closes the voice lane, with an explanation (D5/decision 1). The input,
    // screen and output languages remain independent even here.
    if (!i18n.sttFor(languages.input).installed && mode !== 'text') {
      voiceDisabled = true;
      mode = 'text';
      lastInputWasText = true;
      const unavailable = msg('stt_unavailable');
      announce(unavailable, true);
      await speech.speak(unavailable, { lang: outputLang() });
    }

    await speech.speak(out(introFor(mode)), { lang: outputLang() });
    if (!store.isPersisting()) {
      const noPin = msg('no_pin_warning');
      announce(noPin, true);
      await speech.speak(noPin, { lang: outputLang() });
    }
    if (withheld.length) {
      const msgText = msg('withheld_warning');
      announce(msgText, true);
      await speech.speak(msgText, { lang: outputLang() });
    }
    touchActivity();
    await askCurrent({ announceSection: true });
    emit({});
  }

  function introFor(m) {
    return say.INTRO[m] ?? say.INTRO.voice;
  }

  // -- input: voice ----------------------------------------------------------------

  async function onTalkDown() {
    if (busy || voiceDisabled || audio.isRecording()) return;
    lastInputWasText = false;
    statusText = msg('listening', {}, 'screen');
    emit({});
    try {
      await audio.startRecording({});
    } catch {
      announce(msg('microphone_unavailable'), true);
      disableVoice();
    }
  }

  async function onTalkUp() {
    if (!audio.isRecording()) return;
    const blob = await audio.stopRecording();
    await sendAudio(blob);
  }

  async function listenHandsFree() {
    if (busy || voiceDisabled || mode !== 'handsfree') return;
    statusText = msg('listening', {}, 'screen');
    emit({});
    // Nobody reads out nine digits without breathing. Digit fields get a
    // silence window long enough to group them in.
    const digits = needsAccurateDigits(askedQuestion());
    try {
      await audio.startRecording({
        autoStop: true,
        silenceMs: digits ? DIGIT_SILENCE_MS : undefined,
        maxMs: digits ? DIGIT_MAX_CAPTURE_MS : undefined,
        onAutoStop: async () => {
          const blob = await audio.stopRecording();
          await sendAudio(blob);
        }
      });
    } catch {
      disableVoice();
    }
  }

  /**
   * The question a capture starting right now would be answering. While a
   * read-back is open the expected answer is yes or no.
   */
  function askedQuestion() {
    const q = displayQuestion();
    if (!q) return null;
    return pending ? { ...q, type: 'yesno' } : q;
  }

  async function sendAudio(blob) {
    touchActivity();
    // Four cheap filters before transcribing: nothing recorded, a bumped
    // button, or a capture of only room tone. All end the same way — ask
    // again — because the one thing that must not happen is the form moving
    // on from a question the user never answered.
    if (!blob || blob.size < 800
        || audio.lastCaptureDurationMs() < MIN_CAPTURE_MS
        || !audio.lastCaptureHadSpeech()) {
      await reask(say.REASK.nothingHeard);
      return;
    }
    busy = true;
    statusText = msg('transcribing', {}, 'screen');
    emit({});
    try {
      const asked = askedQuestion();
      if (!asked) return;

      const transcript = await stt.transcribe(blob);

      // A transcriber handed near-silence does not return nothing; it returns a
      // short plausible phrase. Reject those rather than record them.
      if (isEmptyTranscript(transcript, audio.lastCapturePeak())) {
        await reask(say.REASK.nothingHeard);
        return;
      }

      // These are the fields where a misread digit does lasting damage. A
      // transcript that is not cleanly a number of the right shape is asked
      // again rather than read back — and "the right shape" includes the
      // length, because a capture that ended after the first group of an SSN
      // is a clean, parseable "555".
      if (needsAccurateDigits(asked) && !command(transcript)
          && !namesSomethingToDelete(transcript)
          && !digitsSurviveNormalize(asked, transcript)) {
        statusText = msg('you_said', { text: transcript }, 'screen');
        emit({});
        await reask(out(say.REASK.unsure));
        return;
      }

      statusText = msg('you_said', { text: transcript }, 'screen');
      emit({});
      await handleTranscript(transcript);
    } catch (err) {
      if (err?.kind === 'empty') { await reask(say.REASK.nothingHeard); return; }
      await handleSttError(err);
    } finally {
      busy = false;
    }
  }

  const needsAccurateDigits = q => ACCURATE_DIGIT_TYPES.has(q?.type);

  function digitsSurviveNormalize(question, transcript) {
    const local = parse(question, transcript);
    return !!local && !normalize(local, question).needsClarification;
  }

  /**
   * Handle one answer: extract, validate, confirm once, commit.
   *
   * The turn is interpret-first: the transcript is parsed immediately, and
   * what is read back — if anything — is the parsed value. There is no
   * separate read-back of the raw transcript.
   */
  async function handleTranscript(transcript) {
    // "Which answer would you like to change?" is matched by correct.js, not
    // by the answer parser.
    if (inCorrectionPrompt()) { statusText = ''; await handleFieldName(transcript); return; }

    // "Remove that last provider" mid-interview is a command, not an answer.
    if (!pending && namesSomethingToDelete(transcript)) {
      statusText = '';
      await deleteMidInterview(transcript);
      return;
    }

    // Navigation words are matched on the voice path too, not only when typed.
    if (!pending) {
      const cmd = command(transcript);
      if (cmd) { statusText = ''; await runCommand(cmd); return; }
    }

    const q = pending?.question ?? engine.current();
    if (!q) return;

    // A confirmation read-back is a yes/no question about the value just
    // heard. Yes and no are matched first — "correct" is both a way to say
    // yes and the name of the change-an-answer command, and here it plainly
    // means the first. Otherwise a command still wins: someone who answers
    // the read-back with "skip" or "go back" means it, and should not have
    // to say no first.
    if (pending) {
      const yn = parse({ ...q, type: 'yesno', prompt: 'Is that correct?' }, transcript);
      if (yn?.value === true) { await acceptReadBack(); return; }
      if (yn?.value === false) { await rejectReadBack(); return; }
      const cmd = command(transcript);
      if (cmd) { statusText = ''; await runCommand(cmd); return; }
      await reask(out(say.REASK.yesno));
      return;
    }

    const local = parse(q, transcript);
    if (!local) {
      await reask(q.hint ? `${out(say.REASK.generic)} ${out(q.hint)}` : out(say.REASK.generic));
      return;
    }
    const result = normalize(local, q);

    if (result.command) { await runCommand(result.command); return; }

    if (result.needsClarification || result.value == null) {
      await reask(result.clarifyPrompt ? out(result.clarifyPrompt) : out(say.REASK.generic));
      return;
    }

    // One confirmation, for everything the user spoke (or for the fields that
    // demand it). The read-back speaks the parsed value, digit by digit where
    // that is how a misheard digit is caught.
    if (q.confirm || confirmEachAnswer) {
      pending = { question: q, value: result.value };
      const readBack = msg('readback_heard', { value: speakValue(result.value, q.type, q.options) });
      questionTextContent = msg('readback_heard', { value: screenValue(result.value, q.type, q.options) }, 'screen');
      hintTextContent = msg('accept_hint', {}, 'screen');
      announce(readBack);
      // Through speakSegments, so `repeat` replays the read-back rather than
      // the question it is about.
      await speakSegments([readBack]);
      emit({});
      resumeListening();
      return;
    }

    commit(result.value);
  }

  const ACCEPT_HINT = 'Press the space bar to keep it, or N to answer again. '
    + 'You can also say yes or no.';

  function commit(value) {
    touchActivity();
    const asked = correcting?.question ?? engine.current();
    statusText = !confirmEachAnswer && asked && value != null
      ? msg('recorded', { value: screenValue(value, asked.type, asked.options) }, 'screen')
      : '';
    if (correcting) { finishCorrection(value); return; }
    engine.submit(value);
    saveSession();
    if (adding && !stillAdding()) { finishAddition(); return; }
    askCurrent();
  }

  function stillAdding() {
    return !!adding && engine.current()?.loopId === adding.loopId;
  }

  async function reask(message) {
    const q = engine.current();
    const hint = q?.hint ? ` ${out(q.hint)}` : '';
    announce(message + hint, true);
    await speech.speak(message + hint, { lang: outputLang() });
    resumeListening();
  }

  async function acceptReadBack() {
    if (!readBackOpen()) return;
    if (audio.isRecording()) audio.cancelRecording();
    const value = pending.value;
    pending = null;
    commit(value);
  }

  async function rejectReadBack() {
    if (!readBackOpen()) return;
    if (audio.isRecording()) audio.cancelRecording();
    const q = pending.question;
    pending = null;
    // The same question reopens without its prompt being read again. The
    // user heard it a moment ago and is only fixing what was heard, and
    // repeating the whole prompt before every retry is what makes a misheard
    // answer feel expensive. The question goes back on screen, and `repeat`
    // replays it rather than "go ahead".
    questionTextContent = screen(q.prompt);
    hintTextContent = q.hint ? screen(q.hint) : '';
    announce(out(say.ANSWER_AGAIN), true);
    await speakSegments([out(say.ANSWER_AGAIN)]);
    lastSegments = [out(q.prompt)];
    lastSpoken = out(q.prompt);
    resumeListening();
  }

  // -- input: typing -----------------------------------------------------------------

  async function submitTyped(text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    lastInputWasText = true;
    busy = true;
    try {
      if (pending) {
        const yn = parse({ ...pending.question, type: 'yesno', prompt: 'Is that correct?' }, t);
        if (yn?.value === true) { await acceptReadBack(); return; }
        if (yn?.value === false) { await rejectReadBack(); return; }
        // As on the spoken path: a command still wins over the read-back.
        const cmd = command(t);
        if (cmd) { await runCommand(cmd); return; }
        await reask(out(say.REASK.yesno));
        return;
      }

      // While naming a field to correct, the words are a field name, not a
      // navigation command.
      if (inCorrectionPrompt()) { await handleFieldName(t); return; }

      await handleTypedDirect(t);
    } finally {
      busy = false;
    }
  }

  /** A typed answer: parsed locally, or taken as written for free text. */
  async function handleTypedDirect(text) {
    const cmd = command(text);
    if (cmd) { await runCommand(cmd); return; }

    if (!pending && namesSomethingToDelete(text)) {
      await deleteMidInterview(text);
      return;
    }

    const q = pending?.question ?? engine.current();
    if (!q) return;

    if (pending) {
      const yn = parse({ ...q, type: 'yesno', prompt: 'Is that correct?' }, text);
      if (yn?.value === true) { await acceptReadBack(); return; }
      if (yn?.value === false) { await rejectReadBack(); return; }
      await reask(out(say.REASK.yesno));
      return;
    }

    // Through the local parser first, the same way a spoken answer goes.
    // Free text is the exception: `typed` keeps it exactly as written.
    const local = parse(q, text, { typed: true });
    const result = normalize(
      local ?? { command: null, value: text, confidence: 1, needsClarification: false, clarifyPrompt: null },
      q
    );
    if (result.command) { await runCommand(result.command); return; }
    if (result.needsClarification || result.value == null) {
      await reask(result.clarifyPrompt ? out(result.clarifyPrompt) : out(say.REASK.notRight));
      return;
    }
    if (q.confirm) {
      pending = { question: q, value: result.value };
      const readBack = msg('readback_typed', { value: speakValue(result.value, q.type, q.options) });
      questionTextContent = msg('readback_typed', { value: screenValue(result.value, q.type, q.options) }, 'screen');
      hintTextContent = msg('accept_hint', {}, 'screen');
      announce(readBack);
      await speakSegments([readBack]);
      emit({});
      resumeListening();
      return;
    }
    commit(result.value);
  }

  // -- commands -----------------------------------------------------------------

  const KEEPS_CORRECTION = new Set(['repeat', 'help', 'where', 'readback', 'save_quit']);

  async function runCommand(cmd) {
    if (cmd === 'repeat' && readBackOpen()) {
      announce(lastSpoken);
      await speakSegments(lastSegments.length ? lastSegments : [lastSpoken]);
      resumeListening();
      return;
    }

    pending = null;

    if (correcting && (cmd === 'back' || cmd === 'skip')) {
      await returnToReview(sayPair(say.UNCHANGED));
      return;
    }
    if ((correcting || inCorrectionPrompt()) && !KEEPS_CORRECTION.has(cmd)) {
      clearCorrectionState();
    }

    switch (cmd) {
      case 'repeat':
        announce(lastSpoken);
        await speakSegments(lastSegments.length ? lastSegments : [lastSpoken]);
        if (mode === 'handsfree') queueListen();
        return;
      case 'back':
        engine.back();
        saveSession();
        if (adding && !stillAdding()) { await finishAddition(); return; }
        await askCurrent({ prefix: out(say.GOING_BACK) });
        return;
      case 'skip':
        engine.skip();
        saveSession();
        if (adding && !stillAdding()) { await finishAddition(); return; }
        await askCurrent();
        return;
      case 'where': {
        const p = engine.progress();
        const left = formatTimeRemaining(p.secondsRemaining, outputLang());
        const where = p.sectionCount
          ? msg('where_section', { number: p.sectionNumber, count: p.sectionCount, title: out(p.sectionTitle) })
          : msg('where_start');
        const message = left
          ? msg('where_done_left', { where, percent: p.percent, time: left })
          : msg('where_done', { where, percent: p.percent });
        announce(message, true);
        await speech.speak(message, { lang: outputLang() });
        if (mode === 'handsfree') queueListen();
        return;
      }
      case 'readback':
        await onReadBack(engine.answers());
        if (mode === 'handsfree') queueListen();
        return;
      case 'correct':
        await askWhichField();
        return;
      case 'save_quit':
        if (saveSession()) {
          await store.flush();
          const saved = out(say.SAVED);
          await speech.speak(saved, { lang: outputLang() });
          statusText = msg('saved_ok', {}, 'screen');
          emit({});
        } else {
          const nothing = msg('nothing_saved');
          statusText = msg('nothing_saved', {}, 'screen');
          announce(nothing, true);
          await speech.speak(nothing, { lang: outputLang() });
        }
        return;
      case 'restart':
        engine.reset();
        store.clearState();
        withheld = [];
        await speech.speak(out(say.STARTING_OVER), { lang: outputLang() });
        await askCurrent({ announceSection: true });
        return;
      case 'clear_data':
        await clearEverything();
        return;
      case 'finish':
        await finishInterview();
        return;
      case 'help':
      default:
        await speech.speak(out(say.HELP), { lang: outputLang() });
        if (mode === 'handsfree') queueListen();
    }
  }

  // -- correction flow --------------------------------------------------------

  function inCorrectionPrompt() {
    return awaitingFieldName || !!choosingItem || !!confirmingDelete;
  }

  function clearCorrectionState() {
    if (correcting?.restore) engine?.restoreCursor(correcting.restore);
    correcting = null;
    adding = null;
    choosing = null;
    choosingItem = null;
    confirmingDelete = null;
    awaitingFieldName = false;
    resumeAfterPrompt = false;
    pending = null;
  }

  async function askWhichField() {
    clearCorrectionState();
    awaitingFieldName = true;

    sectionLabel = msg('change_answer_label', {}, 'screen');
    const message = out(say.WHICH_FIELD);
    questionTextContent = msg('which_answer', {}, 'screen');
    hintTextContent = msg('which_answer_hint', {}, 'screen');
    lastSpoken = message;
    announce(message);
    await speech.speak(message, { lang: outputLang() });
    emit({});
    resumeListening();
  }

  /** The user named a field (or answered a disambiguation question). */
  async function handleFieldName(text) {
    if (confirmingDelete) {
      await handleDeleteConfirmation(text);
      return;
    }

    if (/^(never ?mind|cancel|nothing|stop|go back|back|done|no)\b/i.test(text.trim())) {
      await returnToReview(pair('no_changes'));
      return;
    }

    // Answering "which one did you want to delete?"
    if (choosingItem) {
      const picked = pickItem(text, choosingItem.candidates);
      if (!picked) {
        await sayAndListen(msg('did_not_catch_options', { options: itemOptions(choosingItem) }));
        return;
      }
      const { loopId } = choosingItem;
      choosingItem = null;
      await confirmDelete(loopId, picked);
      return;
    }

    // Answering "did you mean A or B?"
    if (choosing) {
      const picked = correct.resolveChoice(text, choosing.candidates, { lang: inputLang() });
      if (!picked) {
        await sayAndListen(msg('did_not_catch_options', { options: optionsSentence(choosing.candidates) }));
        return;
      }
      choosing = null;
      await beginCorrection(picked);
      return;
    }

    // "Remove that last provider" deletes a whole item; "change the provider's
    // phone" edits one field.
    if (correct.isDeletionPhrase(text)) { await beginDeletion(text); return; }

    // "Add another condition" grows the list.
    if (correct.isAdditionPhrase(text)) {
      const add = correct.resolveAddition(text, engine.answers());
      if (add.reason !== 'none') { await beginAddition(add); return; }
    }

    const result = correct.resolveTarget(text, engine.answers(), { lang: inputLang() });

    if (result.ok) { await beginCorrection(result.target); return; }

    if (result.reason === 'ambiguous') {
      choosing = { candidates: result.candidates };
      await sayAndListen(msg('did_you_mean', { list: optionsList(result.candidates) }));
      return;
    }

    await sayAndListen(msg('not_found_answer'));
  }

  function optionsList(candidates) {
    return candidates.map((c, i) => `${i + 1}. ${out(correct.describeTarget(c))}`).join('. ');
  }

  function optionsSentence(candidates) {
    return msg('did_you_mean', { list: optionsList(candidates) });
  }

  // -- adding a loop entry ------------------------------------------------------

  async function beginAddition(add) {
    if (add.reason === 'ambiguous') {
      const names = add.candidates.map(c => out(c.itemLabel));
      await sayAndListen(msg('add_ambiguous', { names: names.join(', or a ') }));
      return;
    }
    if (add.reason === 'full') {
      await sayAndListen(msg('add_full', { item: out(add.itemLabel) }));
      return;
    }

    const { loopId, itemLabel, nextNumber } = add;
    if (!engine.jumpTo(loopId)) {
      await sayAndListen(msg('add_open_failed'));
      return;
    }
    const q = engine.submit(true);
    if (!q || q.loopId !== loopId || q.loopPhase !== 'field') {
      await sayAndListen(msg('add_start_failed', { item: out(itemLabel) }));
      return;
    }

    awaitingFieldName = false;
    choosing = null;
    adding = { loopId, itemLabel, startCount: nextNumber - 1 };
    saveSession();

    await askCurrent(q.itemNumber > 1 ? {} : { prefix: msg('adding_new', { item: out(itemLabel) }) });
  }

  async function finishAddition() {
    const { loopId, itemLabel, startCount } = adding;
    const added = (engine.answers()[loopId]?.length ?? 0) - startCount;
    adding = null;
    saveSession();
    const number = startCount + 1;
    const addedNote = added === 1
      ? pair('added_one', { item: out(itemLabel), number },
          { item: screen(itemLabel), number })
      : added > 1 ? pair('added_many', { count: added })
        : pair('added_none', { item: out(itemLabel) }, { item: screen(itemLabel) });
    await returnToReview(addedNote);
  }

  // -- deleting a loop entry -------------------------------------------------------

  function namesSomethingToDelete(text) {
    if (!correct.isDeletionPhrase(text)) return false;
    return correct.resolveDeletion(text, engine.answers()).reason !== 'none';
  }

  async function deleteMidInterview(text) {
    if (correcting) clearCorrectionState();
    resumeAfterPrompt = true;
    await beginDeletion(text);
  }

  async function beginDeletion(text) {
    const r = correct.resolveDeletion(text, engine.answers());

    if (r.ok) { await confirmDelete(r.loopId, r); return; }

    if (r.reason === 'empty') {
      await sayAndListen(msg('no_item_to_remove', { item: out(r.itemLabel) }));
      return;
    }

    if (r.reason === 'ambiguous') {
      choosingItem = { loopId: r.loopId, itemLabel: r.itemLabel, candidates: r.candidates };
      await sayAndListen(msg('which_item_remove', { item: out(r.itemLabel), options: itemOptions(choosingItem) }));
      return;
    }

    await sayAndListen(msg('could_not_tell_remove'));
  }

  function itemOptions({ candidates }) {
    const list = candidates.map(c => out(correct.describeItem(c))).join('. ');
    return msg('say_number_or_name', { list });
  }

  function pickItem(text, candidates) {
    const picked = correct.resolveChoice(text, candidates.map(c => ({
      id: `__item_${c.index}`,
      label: c.title ?? `${c.itemLabel} ${c.number}`,
      prompt: `${c.itemLabel} ${c.number}`,
      index: c.index
    })));
    if (!picked) return null;
    return candidates.find(c => c.index === picked.index) ?? null;
  }

  async function confirmDelete(loopId, item) {
    choosingItem = null;
    confirmingDelete = { loopId, item };

    const what = out(correct.describeItem(item));
    const shownWhat = screen(correct.describeItem(item));
    const message = msg('remove_confirm', { what, item: out(item.itemLabel) });
    questionTextContent = msg('remove_question', { what: shownWhat }, 'screen');
    hintTextContent = msg('remove_hint', {}, 'screen');
    await sayAndListen(message);
  }

  async function handleDeleteConfirmation(text) {
    const s = text.trim();
    const yn = parse({ type: 'yesno', prompt: 'Is that correct?' }, text);
    const yes = yn?.value === true
      || /^(y|yes|yeah|yep|correct|right|do it|remove it|delete it)\b/i.test(s);
    const no = yn?.value === false
      || /^(n|no|nope|nah|keep it|cancel|never ?mind|stop)\b/i.test(s);

    if (!yes && !no) {
      await sayAndListen(msg('keep_or_remove'));
      return;
    }

    const { loopId, item } = confirmingDelete;
    confirmingDelete = null;

    if (no) {
      await returnToReview(pair('kept_item',
        { what: out(correct.describeItem(item)) },
        { what: screen(correct.describeItem(item)) }));
      return;
    }

    const removed = engine.removeItem(loopId, item.index);
    saveSession();
    await returnToReview(removed
      ? pair('removed_item',
          { what: out(correct.describeItem(item)) },
          { what: screen(correct.describeItem(item)) })
      : pair('remove_failed'));
  }

  // -- correcting an answer ---------------------------------------------------------

  async function beginCorrection(target) {
    const restore = engine.cursorSnapshot();
    const q = engine.jumpTo(target.id, target.loopIndex ?? 0, target.loopId ?? null);
    if (!q) {
      await sayAndListen(msg('could_not_open_answer'));
      return;
    }

    awaitingFieldName = false;
    correcting = { target, question: q, restore };
    pending = null;

    const current = target.value;
    const what = out(correct.describeTarget(target));
    const heard = current == null || current === ''
      ? msg('target_blank', { what })
      : msg('target_current', { what, value: speakValue(current, target.type, target.options) });

    await askCurrent({ prefix: msg('what_instead', { heard }) });
  }

  function finishCorrection(value) {
    const { target: t, restore } = correcting;
    const ok = engine.setAnswer(t.id, value, { loopId: t.loopId ?? null, loopIndex: t.loopIndex ?? 0 });
    engine.restoreCursor(restore);
    correcting = null;
    pending = null;

    if (ok && t.id === 'forms' && !t.loopId) {
      const next = engine.rewalk();
      saveSession();
      if (next) {
        clearCorrectionState();
        speech.speak(out(say.FORMS_CHANGED), { lang: outputLang() });
        askCurrent({ announceSection: true });
        return;
      }
    }

    saveSession();

    const what = out(correct.describeTarget(t));
    const spokenValue = speakValue(value, t.type, t.options);
    const shownValue = screenValue(value, t.type, t.options);
    returnToReview(ok
      ? pair('now_value',
          { what: titleCase(what), value: spokenValue },
          { what: titleCase(screen(correct.describeTarget(t))), value: shownValue })
      : pair('change_failed'), { about: t });
  }

  async function returnToReview(note, { about = null } = {}) {
    const spokenNote = typeof note === 'string' ? note : note?.spoken ?? '';
    const screenNote = typeof note === 'string' ? note : note?.shown ?? spokenNote;

    if (resumeAfterPrompt) {
      clearCorrectionState();
      saveSession();
      await askCurrent({ prefix: msg('back_to_question', { note: spokenNote }) });
      return;
    }
    if (await askNextWithheld(spokenNote)) return;

    clearCorrectionState();
    panel = 'review';

    const missing = engine.missingRequired();
    const tailKey = missing.length === 1 ? 'missing_tail_one' : 'missing_tail_many';
    const tail = missing.length ? msg(tailKey, { count: missing.length }) : '';
    const shownTail = missing.length ? msg(tailKey, { count: missing.length }, 'screen') : '';
    const message = msg('review_note', { note: spokenNote, tail });
    reviewIntro = msg('review_note', { note: screenNote, tail: shownTail }, 'screen');
    announce(message, true);
    await speech.speak(message, { lang: outputLang() });
    emit({ focus: 'fix' });
  }

  async function sayAndListen(message) {
    lastSpoken = message;
    announce(message, true);
    await speech.speak(message, { lang: outputLang() });
    resumeListening();
  }

  // -- finishing ---------------------------------------------------------------------

  async function finishInterview() {
    if (await askNextWithheld()) return;
    saveSession();
    panel = 'review';
    audio.earcon?.('done');

    const missing = engine.missingRequired();
    const intro = missing.length
      ? msg(missing.length === 1 ? 'finish_missing_one' : 'finish_missing_many', {
        count: missing.length,
        prompts: missing.map(m => out(m.prompt)).join(' ')
      })
      : out(say.ALL_DONE);

    reviewIntro = missing.length
      ? msg(missing.length === 1 ? 'finish_missing_one' : 'finish_missing_many', {
        count: missing.length,
        prompts: missing.map(m => screen(m.prompt)).join(' ')
      }, 'screen')
      : screen(say.ALL_DONE);
    announce(intro, true);
    await speakSegments([intro, out(say.DOWNLOAD_HINT)]);
    emit({ focus: 'download' });
  }

  /**
   * Ask for the next sensitive answer that a resumed session did not have.
   * Asked as a correction — written in place, then back to the review.
   */
  async function askNextWithheld(note = '') {
    while (withheld.length) {
      const w = withheld.shift();
      if (isAnswered(w)) continue;
      const target = correct.buildTargets(engine.answers()).find(t => sameField(t, w));
      if (!target) continue;
      clearCorrectionState();
      const restore = engine.cursorSnapshot();
      const q = engine.jumpTo(target.id, target.loopIndex ?? 0, target.loopId ?? null);
      if (!q) continue;
      correcting = { target, question: q, restore };
      panel = 'interview';
      const why = w.idle
        ? msg('cleared_idle')
        : msg('not_saved_again');
      const which = target.loopId
        ? msg('this_one_is', { item: out(target.itemLabel), number: target.itemNumber })
        : '';
      await askCurrent({ prefix: `${note ? `${note} ` : ''}${why}${which}` });
      return true;
    }
    return false;
  }

  /** Fill the chosen forms. Returns the controller to the review screen. */
  async function exportForms(ids) {
    touchActivity();
    if (await askNextWithheld(msg('before_fill'))) return;
    const answers = engine.answers();
    try {
      await onExport({ forms: ids, answers, languages: { ...languages } });
      const erase = msg('erase_advice');
      const shownErase = msg('erase_advice', {}, 'screen');
      const message = msg('downloaded', {
        forms: ids.join(msg('forms_joiner')), erase
      });
      statusText = msg('downloaded', {
        forms: ids.join(msg('forms_joiner', {}, 'screen')), erase: shownErase
      }, 'screen');
      announce(message, true);
      await speakSegments([ids.length > 1 ? out(say.BOTH_DOWNLOADED) : out(say.DOWNLOADED), erase]);
      emit({});
    } catch {
      const message = msg('pdf_failed');
      statusText = msg('pdf_failed', {}, 'screen');
      announce(message, true);
    }
  }

  async function clearEverything() {
    store.clearState();
    store.forgetKey();
    withheld = [];
    timers.clearTimeout(idleTimer);
    engine.reset();
    audio.releaseMic?.();
    const message = msg('erased_everything');
    announce(message, true);
    speech.speak(message, { lang: outputLang() });
    statusText = msg('erased_everything', {}, 'screen');
    panel = 'setup';
    emit({});
  }

  // -- errors --------------------------------------------------------------------

  async function handleSttError(err) {
    audio.earcon?.('error');
    const kind = err?.kind ?? 'unknown';
    const message = out(say.ERRORS[kind] ?? say.ERRORS.unknown);
    statusText = screen(say.ERRORS[kind] ?? say.ERRORS.unknown);
    announce(message, true);
    await speech.speak(message, { lang: outputLang() });
    if (mode === 'handsfree') queueListen();
  }

  function disableVoice() {
    voiceDisabled = true;
    mode = 'text';
    lastInputWasText = true;
    emit({});
  }

  // -- the idle lock -----------------------------------------------------------------

  async function lockSensitive() {
    const held = store.sensitiveAnswers(engine.getState());
    const midAnswer = isSensitive(displayQuestion()) && readBackOpen();
    if (!held.length && !midAnswer) return;

    const dropped = held.map(fieldOf);
    if (midAnswer && correcting) dropped.push(fieldOf(correcting.target));
    for (const a of held) {
      engine.setAnswer(a.id, null, { loopId: a.loopId ?? null, loopIndex: a.loopIndex ?? 0 });
    }
    for (const w of dropped) {
      if (!withheld.some(x => sameField(x, w))) withheld.push({ ...w, idle: true });
    }
    store.markWithheld(dropped);
    saveSession();
    statusText = '';

    const message = msg('idle_cleared', { minutes: Math.round(IDLE_LOCK_MS / 60000) });

    if (panel === 'review') {
      reviewIntro = msg('idle_cleared', { minutes: Math.round(IDLE_LOCK_MS / 60000) }, 'screen');
      announce(message, true);
      await speech.speak(message, { lang: outputLang() });
      emit({});
      return;
    }
    if (midAnswer) {
      if (correcting) {
        await returnToReview(pair('idle_cleared', { minutes: Math.round(IDLE_LOCK_MS / 60000) }));
        return;
      }
      pending = null;
      await askCurrent({ prefix: message });
      return;
    }
    announce(message, true);
    await speech.speak(message, { lang: outputLang() });
    // The last snapshot the screen holds carries the answers, numbers
    // included; replace it, or the cleared number lives on in the UI's copy.
    emit({});
  }

  // -- keys ------------------------------------------------------------------------

  async function onKey(code, { typing = false } = {}) {
    touchActivity();
    if (panel !== 'interview') return;

    // While an answer is being read back the space bar keeps it.
    if (!typing && readBackOpen()) {
      if (code === 'Space' || code === 'Enter') {
        await acceptReadBack();
        return { accepted: true };
      }
      if (code === 'KeyN' || code === 'Escape') {
        await rejectReadBack();
        return { rejected: true };
      }
    }

    if (code === 'Space' && !typing && !voiceDisabled) {
      return { startTalk: true };
    }
    if (typing) {
      if (code === 'Escape') return { leaveTextLane: true };
      return null;
    }
    if (code === 'Escape' && audio.isRecording()) {
      audio.cancelRecording();
      statusText = msg('cancelled', {}, 'screen');
      announce(msg('cancelled'), true);
      emit({});
      return { cancelled: true };
    }
    if (code === 'KeyT') return { useTextLane: true };
    if (code === 'KeyH' && !voiceDisabled) {
      mode = mode === 'handsfree' ? 'voice' : 'handsfree';
      announce(msg(mode === 'handsfree' ? 'handsfree_on' : 'handsfree_off'), true);
      if (mode === 'handsfree') queueListen();
      return null;
    }
    const cmd = { Enter: 'repeat', KeyB: 'back', KeyS: 'skip', KeyW: 'where', KeyR: 'readback', KeyC: 'correct' }[code];
    if (cmd) { await runCommand(cmd); return { ranCommand: true }; }
    return null;
  }

  /**
   * Start a correction. Missing required answers come first, since those block
   * a complete form; otherwise ask which answer to change.
   */
  async function startReview() {
    const missing = engine.missingRequired();
    const target = missing[0];
    if (target) {
      const landed = engine.jumpTo(target.id, target.loopIndex ?? 0, target.loopId ?? null);
      if (landed) {
        panel = 'interview';
        clearCorrectionState();
        await askCurrent({ prefix: out(say.FILL_IN_MISSING) });
        return;
      }
    }
    await askWhichField();
  }

  // -- public surface -----------------------------------------------------------------

  return {
    start,
    onTalkDown,
    onTalkUp,
    sendAudio,
    submitTyped,
    acceptReadBack,
    rejectReadBack,
    runCommand,
    onKey,
    askWhichField,
    startReview,
    exportForms,
    clearEverything,
    finishInterview,
    snapshot,
    displayQuestion,
    readBackOpen,
    engineState: () => engine.getState({ returnTo: correcting?.restore }),
    touch: touchActivity,
    disableVoice,
    isRecording: () => audio.isRecording(),
    voiceDisabled: () => voiceDisabled,
    mode: () => mode,
    setConfirmEachAnswer: v => { confirmEachAnswer = v; },
    setRevealSensitive: v => { revealSensitive = v; emit({}); }
  };
}

function titleCase(s) {
  return String(s ?? '').replace(/^(.)/, (_, c) => c.toUpperCase());
}
