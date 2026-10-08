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
    speech, audio, stt, announce, onState, onExport = async () => {}, onReadBack = async () => {}
  } = ports;
  let engine = null;
  const clock = ports.clock ?? (() => Date.now());
  const timers = ports.timers ?? { setTimeout, clearTimeout };
  // Every reader of the time goes through `clock`, so a scenario or a golden
  // that pins it pins the parser's century window and the engine's pacing
  // too. The three disagree on units: milliseconds here, seconds for the
  // engine, a Date for the parser.
  const parseNow = () => new Date(clock());
  const parse = (question, text, opts = {}) => parseLocal(question, text, { ...opts, now: parseNow });

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
      hintText: readBackOpen() || panel === 'review' ? hintText() : (q?.hint ?? hintText()),
      statusText: statusText,
      readbackOpen: readBackOpen(),
      inputMasked: !revealSensitive && isSensitive(q),
      voiceDisabled,
      progressText: progressText(),
      reviewIntro,
      answers: engine.answers(),
      revealSensitive,
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
      sectionLabel = `Changing an answer — ${q.sectionTitle}`;
    } else if (adding) {
      sectionLabel = `Adding a ${adding.itemLabel} — ${q.sectionTitle}`;
    } else if (announceSection || q.section !== lastSection) {
      const p = engine.progress();
      if (p.sectionCount) {
        segments.push(`Section ${p.sectionNumber} of ${p.sectionCount}.`, `${q.sectionTitle}.`);
        sectionLabel = `Section ${p.sectionNumber} of ${p.sectionCount} — ${q.sectionTitle}`;
      } else {
        segments.push(`${q.sectionTitle}.`);
        sectionLabel = q.sectionTitle;
      }
      lastSection = q.section;
      const left = formatTimeRemaining(p.secondsRemaining);
      if (left && left !== lastSpokenEstimate) {
        segments.push(`${left} left.`);
        lastSpokenEstimate = left;
      }
    }
    if (q.warn && !correcting) segments.push(q.warn);
    if (!correcting && q.loopPhase === 'field' && q.itemNumber > 1 && isFirstFieldOfItem(q)) {
      segments.push(`${titleCase(q.itemLabel)} ${q.itemNumber}.`);
    }
    if (prefix) segments.push(prefix);
    segments.push(q.prompt);

    questionTextContent = q.prompt;
    hintTextContent = q.hint || '';
    reviewIntro = '';
    await speakSegments(segments);

    resumeListening();
  }

  async function speakSegments(segments) {
    lastSegments = segments.filter(Boolean);
    lastSpoken = lastSegments.join(' ');
    for (const [i, text] of lastSegments.entries()) {
      await speech.speak(text, { interrupt: i === 0 });
    }
  }

  function progressText() {
    const p = engine.progress();
    const left = formatTimeRemaining(p.secondsRemaining);
    return left ? `${p.percent}% done · ${left} left` : `${p.percent}% done`;
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

  async function startNow({ mode: startMode = 'voice', confirm = true, reveal = false, saved = null, withheldFrom = null } = {}) {
    mode = startMode;
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

    await speech.speak(introFor(mode));
    if (!store.isPersisting()) {
      const msg = 'You did not set a PIN, so nothing is being saved. '
        + 'If you close this page, your answers will be lost.';
      announce(msg, true);
      await speech.speak(msg);
    }
    if (withheld.length) {
      const msg = 'For your security, your Social Security and bank numbers were not saved when you '
        + 'stopped last time. I will ask for them again before your forms are ready.';
      announce(msg, true);
      await speech.speak(msg);
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
    statusText = 'Listening…';
    emit({});
    try {
      await audio.startRecording({});
    } catch {
      announce('The microphone is not available. Switching to typing.', true);
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
    statusText = 'Listening…';
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
    statusText = 'Transcribing…';
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
      if (needsAccurateDigits(asked) && !localCommand(transcript)
          && !namesSomethingToDelete(transcript)
          && !digitsSurviveNormalize(asked, transcript)) {
        statusText = `You said: ${transcript}`;
        emit({});
        await reask(say.REASK.unsure);
        return;
      }

      statusText = `You said: ${transcript}`;
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
      const cmd = localCommand(transcript);
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
      const cmd = localCommand(transcript);
      if (cmd) { statusText = ''; await runCommand(cmd); return; }
      await reask(say.REASK.yesno);
      return;
    }

    const local = parse(q, transcript);
    if (!local) {
      await reask(q.hint ? `${say.REASK.generic} ${q.hint}` : say.REASK.generic);
      return;
    }
    const result = normalize(local, q);

    if (result.command) { await runCommand(result.command); return; }

    if (result.needsClarification || result.value == null) {
      await reask(result.clarifyPrompt || say.REASK.generic);
      return;
    }

    // One confirmation, for everything the user spoke (or for the fields that
    // demand it). The read-back speaks the parsed value, digit by digit where
    // that is how a misheard digit is caught.
    if (q.confirm || confirmEachAnswer) {
      pending = { question: q, value: result.value };
      const readBack = `I heard ${speakable(result.value, q.type, q.options)}. Is that correct?`;
      questionTextContent = readBack;
      hintTextContent = ACCEPT_HINT;
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
      ? `Recorded: ${speakable(value, asked.type, asked.options)}`
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
    const hint = q?.hint ? ` ${q.hint}` : '';
    announce(message + hint, true);
    await speech.speak(message + hint);
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
    questionTextContent = q.prompt;
    hintTextContent = q.hint || '';
    announce(say.ANSWER_AGAIN, true);
    await speakSegments([say.ANSWER_AGAIN]);
    lastSegments = [q.prompt];
    lastSpoken = q.prompt;
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
        const yes = /^(y|yes|yeah|correct|right)$/i.test(t);
        const no = /^(n|no|nope|wrong)$/i.test(t);
        if (yes) { await acceptReadBack(); return; }
        if (no) { await rejectReadBack(); return; }
        // As on the spoken path: a command still wins over the read-back.
        const cmd = localCommand(t);
        if (cmd) { await runCommand(cmd); return; }
        await reask(say.REASK.yesno);
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
    const cmd = localCommand(text);
    if (cmd) { await runCommand(cmd); return; }

    if (!pending && namesSomethingToDelete(text)) {
      await deleteMidInterview(text);
      return;
    }

    const q = pending?.question ?? engine.current();
    if (!q) return;

    if (pending) {
      const yes = /^(y|yes|yeah|correct|right)$/i.test(text);
      const no = /^(n|no|nope|wrong)$/i.test(text);
      if (yes) { await acceptReadBack(); return; }
      if (no) { await rejectReadBack(); return; }
      await reask(say.REASK.yesno);
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
      await reask(result.clarifyPrompt || say.REASK.notRight);
      return;
    }
    if (q.confirm) {
      pending = { question: q, value: result.value };
      const readBack = `I have ${speakable(result.value, q.type, q.options)}. Is that correct? Type yes or no.`;
      questionTextContent = readBack;
      hintTextContent = ACCEPT_HINT;
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
      await returnToReview(say.UNCHANGED);
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
        await askCurrent({ prefix: say.GOING_BACK });
        return;
      case 'skip':
        engine.skip();
        saveSession();
        if (adding && !stillAdding()) { await finishAddition(); return; }
        await askCurrent();
        return;
      case 'where': {
        const p = engine.progress();
        const left = formatTimeRemaining(p.secondsRemaining);
        const where = p.sectionCount
          ? `You are in section ${p.sectionNumber} of ${p.sectionCount}, ${p.sectionTitle}.`
          : 'You are at the start, choosing which form to fill out.';
        const msg = `${where} About ${p.percent} percent done`
          + (left ? `, ${left} left at the pace you have been going.` : '.');
        announce(msg, true);
        await speech.speak(msg);
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
          await speech.speak(say.SAVED);
          statusText = 'Saved, encrypted with your PIN. Your place is kept on this device.';
          emit({});
        } else {
          const msg = 'Nothing is being saved, because no PIN was set when you started. '
            + 'If you close this page, your answers will be lost.';
          statusText = msg;
          announce(msg, true);
          await speech.speak(msg);
        }
        return;
      case 'restart':
        engine.reset();
        store.clearState();
        withheld = [];
        await speech.speak(say.STARTING_OVER);
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
        await speech.speak(say.HELP);
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

    sectionLabel = 'Changing an answer';
    const msg = say.WHICH_FIELD;
    questionTextContent = 'Which answer would you like to change?';
    hintTextContent = 'Name a field, such as "my date of birth" or "the first job\'s employer". '
      + 'To put a new entry on a list, say "add another condition". '
      + 'To delete a whole entry, say "remove the second provider".';
    lastSpoken = msg;
    announce(msg);
    await speech.speak(msg);
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
      await returnToReview('No changes made.');
      return;
    }

    // Answering "which one did you want to delete?"
    if (choosingItem) {
      const picked = pickItem(text, choosingItem.candidates);
      if (!picked) {
        await sayAndListen('I did not catch which one. ' + itemOptions(choosingItem));
        return;
      }
      const { loopId } = choosingItem;
      choosingItem = null;
      await confirmDelete(loopId, picked);
      return;
    }

    // Answering "did you mean A or B?"
    if (choosing) {
      const picked = correct.resolveChoice(text, choosing.candidates);
      if (!picked) {
        await sayAndListen('I did not catch which one. '
          + optionsSentence(choosing.candidates));
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

    const result = correct.resolveTarget(text, engine.answers());

    if (result.ok) { await beginCorrection(result.target); return; }

    if (result.reason === 'ambiguous') {
      choosing = { candidates: result.candidates };
      await sayAndListen(`I found more than one answer like that. ${optionsSentence(result.candidates)}`);
      return;
    }

    await sayAndListen('I could not find an answer by that name. '
      + 'You can name it the way I asked it, for example, my date of birth, '
      + 'or say never mind to go back.');
  }

  function optionsSentence(candidates) {
    const list = candidates
      .map((c, i) => `${i + 1}. ${correct.describeTarget(c)}`)
      .join('. ');
    return `Did you mean: ${list}. Say the number, or the name.`;
  }

  // -- adding a loop entry ------------------------------------------------------

  async function beginAddition(add) {
    if (add.reason === 'ambiguous') {
      const names = add.candidates.map(c => c.itemLabel);
      await sayAndListen(`I can add to more than one list. Did you mean a `
        + `${names.join(', or a ')}? Say which one, or say never mind to go back.`);
      return;
    }
    if (add.reason === 'full') {
      await sayAndListen(`That is as many ${add.itemLabel} entries as I can take. `
        + 'You can change one of them instead, or say never mind to go back.');
      return;
    }

    const { loopId, itemLabel, nextNumber } = add;
    if (!engine.jumpTo(loopId)) {
      await sayAndListen('I could not open that list. Try naming a different one, or say never mind.');
      return;
    }
    const q = engine.submit(true);
    if (!q || q.loopId !== loopId || q.loopPhase !== 'field') {
      await sayAndListen(`I could not start a new ${itemLabel}. `
        + 'Try naming a different one, or say never mind.');
      return;
    }

    awaitingFieldName = false;
    choosing = null;
    adding = { loopId, itemLabel, startCount: nextNumber - 1 };
    saveSession();

    await askCurrent(q.itemNumber > 1 ? {} : { prefix: `Adding a new ${itemLabel}.` });
  }

  async function finishAddition() {
    const { loopId, itemLabel, startCount } = adding;
    const added = (engine.answers()[loopId]?.length ?? 0) - startCount;
    adding = null;
    saveSession();
    await returnToReview(
      added === 1 ? `I added ${itemLabel} ${startCount + 1}.`
        : added > 1 ? `I added ${added} entries.`
          : `No ${itemLabel} was added.`
    );
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
      await sayAndListen(`There is no ${r.itemLabel} recorded to remove. `
        + 'You can name something else, or say never mind to go back.');
      return;
    }

    if (r.reason === 'ambiguous') {
      choosingItem = { loopId: r.loopId, itemLabel: r.itemLabel, candidates: r.candidates };
      await sayAndListen(`Which ${r.itemLabel} should I remove? ${itemOptions(choosingItem)}`);
      return;
    }

    await sayAndListen('I could not tell what to remove. You can say, for example, '
      + 'remove the second provider, or delete that last job. Say never mind to go back.');
  }

  function itemOptions({ candidates }) {
    const list = candidates.map(c => correct.describeItem(c)).join('. ');
    return `${list}. Say the number, or the name.`;
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

    const what = correct.describeItem(item);
    const msg = `Remove ${what}? This erases every answer recorded for that `
      + `${item.itemLabel}, and I cannot bring it back. Say yes to remove it, or no to keep it.`;
    questionTextContent = `Remove ${what}?`;
    hintTextContent = 'Say yes to remove it, or no to keep it.';
    await sayAndListen(msg);
  }

  async function handleDeleteConfirmation(text) {
    const s = text.trim();
    const yes = /^(y|yes|yeah|yep|correct|right|do it|remove it|delete it)\b/i.test(s);
    const no = /^(n|no|nope|nah|keep it|cancel|never ?mind|stop)\b/i.test(s);

    if (!yes && !no) {
      await sayAndListen('Please say yes to remove it, or no to keep it.');
      return;
    }

    const { loopId, item } = confirmingDelete;
    confirmingDelete = null;

    if (no) {
      await returnToReview(`I kept ${correct.describeItem(item)}.`);
      return;
    }

    const removed = engine.removeItem(loopId, item.index);
    saveSession();
    await returnToReview(removed
      ? `I removed ${correct.describeItem(item)}.`
      : 'That entry could not be removed.');
  }

  // -- correcting an answer ---------------------------------------------------------

  async function beginCorrection(target) {
    const restore = engine.cursorSnapshot();
    const q = engine.jumpTo(target.id, target.loopIndex ?? 0, target.loopId ?? null);
    if (!q) {
      await sayAndListen('I could not open that answer. Try naming a different one, or say never mind.');
      return;
    }

    awaitingFieldName = false;
    correcting = { target, question: q, restore };
    pending = null;

    const current = target.value;
    const heard = current == null || current === ''
      ? `${correct.describeTarget(target)} is blank right now.`
      : `Right now ${correct.describeTarget(target)} is ${speakable(current, target.type, target.options)}.`;

    await askCurrent({ prefix: `${heard} What should it be instead?` });
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
        speech.speak(say.FORMS_CHANGED);
        askCurrent({ announceSection: true });
        return;
      }
    }

    saveSession();

    const what = correct.describeTarget(t);
    returnToReview(ok
      ? `${titleCase(what)} is now ${speakable(value, t.type, t.options)}.`
      : 'That answer could not be changed.', { about: t });
  }

  async function returnToReview(note, { about = null } = {}) {
    if (resumeAfterPrompt) {
      clearCorrectionState();
      saveSession();
      await askCurrent({ prefix: `${note} Back to your question.` });
      return;
    }
    if (await askNextWithheld(note)) return;

    clearCorrectionState();
    panel = 'review';

    const missing = engine.missingRequired();
    const tail = missing.length
      ? ` ${missing.length} required ${missing.length === 1 ? 'answer is' : 'answers are'} still blank.`
      : '';
    const msg = `${note}${tail} You can change another answer, or download your forms.`;
    reviewIntro = `${note}${tail} You can change another answer, or download your forms.`;
    announce(msg, true);
    await speech.speak(msg);
    emit({ focus: 'fix' });
  }

  async function sayAndListen(msg) {
    lastSpoken = msg;
    announce(msg, true);
    await speech.speak(msg);
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
      ? `Your answers are ready. ${missing.length} required ${missing.length === 1 ? 'answer is' : 'answers are'} still blank: ${missing.map(m => m.prompt).join(' ')} You can change an answer, or download your forms as they are.`
      : say.ALL_DONE;

    reviewIntro = intro;
    announce(intro, true);
    await speakSegments([intro, say.DOWNLOAD_HINT]);
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
        ? 'I cleared this while the page was not in use.'
        : 'This was not saved when you stopped last time, for your security.';
      const which = target.loopId ? ` This one is for ${target.itemLabel} ${target.itemNumber}.` : '';
      await askCurrent({ prefix: `${note ? `${note} ` : ''}${why}${which}` });
      return true;
    }
    return false;
  }

  /** Fill the chosen forms. Returns the controller to the review screen. */
  async function exportForms(ids) {
    touchActivity();
    if (await askNextWithheld('Before I fill in your forms, I need a number again.')) return;
    const answers = engine.answers();
    try {
      await onExport({ forms: ids, answers });
      const erase = 'When you have checked your forms, select Erase everything to remove your '
        + 'answers from this computer. The downloaded forms stay in your downloads folder.';
      const msg = `Downloaded ${ids.join(' and ')}. ${erase}`;
      statusText = msg;
      announce(msg, true);
      await speakSegments([ids.length > 1 ? say.BOTH_DOWNLOADED : say.DOWNLOADED, erase]);
      emit({});
    } catch {
      const msg = 'The PDF could not be created. Your answers are safe — try saving them as a file instead.';
      statusText = msg;
      announce(msg, true);
    }
  }

  async function clearEverything() {
    store.clearState();
    store.forgetKey();
    withheld = [];
    timers.clearTimeout(idleTimer);
    engine.reset();
    audio.releaseMic?.();
    const msg = 'Everything has been erased from this device.';
    announce(msg, true);
    speech.speak(msg);
    statusText = msg;
    panel = 'setup';
    emit({});
  }

  // -- errors --------------------------------------------------------------------

  async function handleSttError(err) {
    audio.earcon?.('error');
    const kind = err?.kind ?? 'unknown';
    const msg = say.ERRORS[kind] ?? say.ERRORS.unknown;
    statusText = msg;
    announce(msg, true);
    await speech.speak(msg);
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

    const msg = 'For your security, I cleared your Social Security and bank numbers from this page '
      + `after ${Math.round(IDLE_LOCK_MS / 60000)} minutes without activity. `
      + 'I will ask for them again before your forms are ready.';

    if (panel === 'review') {
      reviewIntro = msg;
      announce(msg, true);
      await speech.speak(msg);
      emit({});
      return;
    }
    if (midAnswer) {
      if (correcting) { await returnToReview(msg); return; }
      pending = null;
      await askCurrent({ prefix: msg });
      return;
    }
    announce(msg, true);
    await speech.speak(msg);
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
      statusText = 'Cancelled.';
      announce('Cancelled', true);
      emit({});
      return { cancelled: true };
    }
    if (code === 'KeyT') return { useTextLane: true };
    if (code === 'KeyH' && !voiceDisabled) {
      mode = mode === 'handsfree' ? 'voice' : 'handsfree';
      announce(mode === 'handsfree' ? 'Hands free mode on' : 'Hands free mode off', true);
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
        await askCurrent({ prefix: say.FILL_IN_MISSING });
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
