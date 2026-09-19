// Application controller.
//
// Owns the turn loop: ask -> listen -> transcribe -> extract -> confirm ->
// commit -> advance. Every state change is announced, and every failure has a
// spoken recovery path.

import { SECTIONS, FORM_TITLES, formsOf } from './schema.js';
import { createEngine } from './engine.js';
import { initA11y, announce, focusMain, speakableValue, formatTimeRemaining } from './a11y.js';
import * as store from './store.js';
import * as audio from './audio.js';
import * as speech from './speech.js';
import * as llm from './llm.js';
import { renderSummary, summaryText, downloadJson } from './summary.js';
import {
  resolveTarget, resolveChoice, describeTarget,
  isDeletionPhrase, resolveDeletion, describeItem
} from './correct.js';
import { downloadForm } from './fill.js';
import { readExportFile, ImportError } from './importer.js';
import * as say from './phrases.js';
import { parseLocal } from './parse.js';
import * as stt from './stt.js';

const el = id => document.getElementById(id);

const ui = {};
let engine = null;
// How the app *listens* — whether it opens the recorder on its own, and where
// it puts focus after speaking. It no longer decides what the user is allowed
// to use: both the talk button and the text box are on screen for the whole
// interview, and either one can answer any question.
let mode = 'voice';               // voice | handsfree | text
// Set only when the microphone genuinely cannot be used — denied, missing, or
// the key was rejected. Everything else leaves the voice lane open.
let voiceDisabled = false;
// Which lane the last answer came from. Decides where focus lands after the
// next question so someone typing is not thrown back to the talk button, and
// someone speaking is not dropped into a text field.
let lastInputWasText = false;
let busy = false;
let pending = null;               // { question, value } awaiting confirmation
// The verbatim transcript of a voice answer, read back for a spoken yes/no
// before anything is extracted from it. See askTranscriptCheck().
let checking = null;              // { transcript, question }
let lastSpoken = '';
let lastSegments = [];            // the same utterance, unjoined, for `repeat`

// Browser speech recognition runs alongside the recorder, not instead of it.
// If it returns a transcript the recording is discarded unheard; if it returns
// nothing, the audio is already captured and the paid API takes the turn. That
// costs nothing extra and means a recognition failure never loses what the
// user just said.
let sttAttempt = null;            // { promise, controller }

// Correction state. Exactly one of these is active at a time: the user is
// naming a field, choosing between candidates, or answering the re-asked
// question. All three return to the review screen when they finish.
let correcting = null;            // { target, question } being re-asked
let choosing = null;              // { candidates } offered for disambiguation
let choosingItem = null;          // { loopId, itemLabel, candidates } to delete
let confirmingDelete = null;      // { loopId, item } awaiting a yes/no
// Deletion can start mid-interview, not only from the review screen. When it
// does, finishing has to resume the question that was open, not jump to the
// summary and strand the rest of the form.
let resumeAfterPrompt = false;
let awaitingFieldName = false;    // the "which answer?" prompt is open

// -- boot ------------------------------------------------------------------

function boot() {
  initA11y();
  // Warm the pre-synthesized clip index before the first question. play()
  // awaits it anyway; doing it here keeps that await off the first utterance.
  speech.loadManifest();
  Object.assign(ui, {
    setup: el('setup-panel'),
    interview: el('interview-panel'),
    review: el('review-panel'),
    apiKey: el('api-key'),
    start: el('start-button'),
    resumeRow: el('resume-row'),
    resumeText: el('resume-text'),
    resume: el('resume-button'),
    discard: el('discard-button'),
    sectionLabel: el('section-label'),
    progressLine: el('progress-line'),
    question: el('question-heading'),
    hint: el('hint'),
    status: el('status'),
    talk: el('talk-button'),
    textEntry: el('text-entry'),
    textAnswer: el('text-answer'),
    textSubmit: el('text-submit'),
    summary: el('summary'),
    reviewIntro: el('review-intro'),
    sttRow: el('stt-row'),
    useBrowserStt: el('use-browser-stt'),
    importFile: el('import-file'),
    importStatus: el('import-status')
  });

  if (stt.isSupported()) ui.sttRow.hidden = false;

  showSavedSession();

  ui.apiKey.value = store.getApiKey();
  ui.start.addEventListener('click', () => start(false));
  ui.resume.addEventListener('click', () => start(true));
  ui.discard.addEventListener('click', () => {
    store.clearState();
    ui.resumeRow.hidden = true;
    announce('Saved session erased. Ready to start fresh.', true);
  });
  ui.importFile?.addEventListener('change', onImportFile);

  ui.talk.addEventListener('pointerdown', onTalkDown);
  ui.talk.addEventListener('pointerup', onTalkUp);
  ui.talk.addEventListener('pointerleave', () => { if (audio.isRecording()) onTalkUp(); });
  ui.textSubmit.addEventListener('click', submitTyped);
  ui.textAnswer.addEventListener('keydown', e => { if (e.key === 'Enter') submitTyped(); });

  document.querySelectorAll('[data-command]').forEach(b =>
    b.addEventListener('click', () => runCommand(b.dataset.command)));

  el('download-all').addEventListener('click', () => exportForms([...formsOf(engine.answers())]));
  el('download-ssa').addEventListener('click', () => exportForms(['ssa']));
  el('download-ds').addEventListener('click', () => exportForms(['ds']));
  el('download-json').addEventListener('click', () => {
    downloadJson(engine.answers(), engine.getState());
    announce('Your answers were saved as a file.', true);
  });
  el('read-back').addEventListener('click', () => speech.speak(summaryText(engine.answers())));
  el('fix-answer').addEventListener('click', startReview);
  el('clear-data').addEventListener('click', clearEverything);

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  if (new URLSearchParams(location.search).get('mode') === 'text') {
    document.querySelector('input[name="mode"][value="text"]').checked = true;
  }
}

async function start(resume) {
  const key = ui.apiKey.value.trim();
  mode = document.querySelector('input[name="mode"]:checked').value;
  stt.setPermitted(ui.useBrowserStt?.checked);

  if (key) {
    store.setApiKey(key);
    setStatus('Checking your API key…');
    const check = await llm.verifyKey();
    if (!check.ok) {
      const msg = check.kind === 'auth'
        ? 'That API key was rejected. Check it and try again, or leave it blank to use typing mode.'
        : `Could not reach OpenAI: ${check.message}`;
      announce(msg, true);
      setStatus(msg);
      return;
    }
  } else if (mode !== 'text') {
    // With browser recognition allowed, a voice interview needs no key at all:
    // speech comes from the pre-synthesized clips, listening from the browser,
    // and answers from the local parser. Questions it cannot parse become a
    // re-ask rather than a model call.
    if (stt.isPermitted()) {
      speech.forceFallback(true);
      announce('No API key given. I will use your browser to listen and speak. '
        + 'Some answers may need a second try.', true);
    } else {
      mode = 'text';
      document.querySelector('input[name="mode"][value="text"]').checked = true;
      announce('No API key given, so I switched to typing mode with your browser voice.', true);
      speech.forceFallback(true);
    }
  }

  if (mode !== 'text') {
    try {
      await audio.initMic();
    } catch (err) {
      mode = 'text';
      voiceDisabled = true;
      announce(err.kind === 'denied'
        ? 'Microphone access was blocked, so I switched to typing mode. You can allow the microphone in your browser settings and reload.'
        : 'No microphone is available, so I switched to typing mode.', true);
    }
  }

  const saved = resume ? store.loadState() : null;
  if (!resume) store.clearState();
  engine = createEngine(SECTIONS, saved?.state ?? null);

  ui.setup.hidden = true;
  ui.interview.hidden = false;
  ui.review.hidden = true;
  // Both lanes, always. The mode radio picks how the interview *starts*, not
  // what stays available: a typing-mode user can hold the talk button (the
  // microphone is requested lazily on the first press), and a voice-mode user
  // can type an answer and then go straight back to speaking.
  ui.textEntry.hidden = false;
  ui.talk.hidden = voiceDisabled;
  lastInputWasText = mode === 'text';

  await speech.speak(introFor(mode));
  askCurrent({ announceSection: true });
}

function introFor(m) {
  return say.INTRO[m] ?? say.INTRO.voice;
}

// -- the turn loop ---------------------------------------------------------

async function askCurrent({ announceSection = false, prefix = '' } = {}) {
  pending = null;
  checking = null;
  const q = engine.current();

  if (!q) { await finishInterview(); return; }

  // Spoken as separate utterances rather than one concatenated string. Each
  // segment is a fixed phrase that tools/build-audio.mjs has already
  // synthesized, so each is an independent cache hit; joined into one string
  // it would be a unique combination every time and never reuse anything.
  const segments = [];
  // A correction is a detour, not progress through the form. Announcing the
  // section it happens to land in is confusing, and recording it as the
  // current section would suppress the real header on the next question.
  if (correcting) {
    ui.sectionLabel.textContent = `Changing an answer — ${q.sectionTitle}`;
  } else if (announceSection || q.section !== askCurrent.lastSection) {
    const p = engine.progress();
    // Until the form question is answered there is no section count to give:
    // it depends on which form, or both, is being filled out.
    if (p.sectionCount) {
      segments.push(`Section ${p.sectionNumber} of ${p.sectionCount}.`, `${q.sectionTitle}.`);
      ui.sectionLabel.textContent = `Section ${p.sectionNumber} of ${p.sectionCount} — ${q.sectionTitle}`;
    } else {
      segments.push(`${q.sectionTitle}.`);
      ui.sectionLabel.textContent = q.sectionTitle;
    }
    askCurrent.lastSection = q.section;
    // Offer the estimate at a section break, but only when it has actually
    // changed since the last time it was spoken. There are up to 32 sections;
    // hearing "about 40 minutes left" at four of them in a row is nagging, and
    // it is the *change* that carries information.
    const left = formatTimeRemaining(p.secondsRemaining);
    if (left && left !== askCurrent.lastSpokenEstimate) {
      segments.push(`${left} left.`);
      askCurrent.lastSpokenEstimate = left;
    }
  }
  // A correction re-asks one known field, so the section preamble and the
  // "next I will need…" warning are both noise — the user asked for this
  // question by name and has already heard its current value read back.
  updateProgressLine();
  if (q.warn && !correcting) segments.push(q.warn);
  if (!correcting && q.loopPhase === 'field' && q.itemNumber > 1 && isFirstFieldOfItem(q)) {
    segments.push(`${titleCase(q.itemLabel)} ${q.itemNumber}.`);
  }
  if (prefix) segments.push(prefix);
  segments.push(q.prompt);

  ui.question.textContent = q.prompt;
  ui.hint.textContent = q.hint || '';
  announce(segments.join(' '));
  await speakSegments(segments);

  ui.textAnswer.value = '';
  resumeListening();
}

/**
 * Hand the turn back to the user after speaking.
 *
 * Hands-free reopens the recorder; otherwise this only decides where focus
 * lands, because both lanes stay live either way. Focus follows the lane the
 * last answer came from: someone who just typed keeps their cursor in the
 * text box, and someone who just spoke keeps the talk button under the space
 * bar. Whichever way it lands, the other lane is one keystroke away.
 */
function resumeListening() {
  if (mode === 'handsfree' && !voiceDisabled) { queueListen(); return; }
  if (voiceDisabled || lastInputWasText || mode === 'text') { ui.textAnswer.focus(); return; }
  focusMain();
}

/**
 * Reopen the hands-free microphone once the current turn has let go of `busy`.
 *
 * Everything that speaks a prompt and then wants to listen again — a re-ask, a
 * value read-back, the transcript read-back — is awaited from inside
 * sendAudio(), which holds `busy` until its `finally`. Calling
 * listenHandsFree() from there hits its own guard and silently does nothing,
 * and a hands-free user is left with a question asked and no microphone open.
 * Deferring past the end of the turn is the whole fix.
 */
function queueListen(attempt = 0) {
  if (attempt > 100) return;          // ~6s; `busy` is cleared in a finally
  setTimeout(() => {
    if (busy) { queueListen(attempt + 1); return; }
    listenHandsFree();
  }, 60);
}

/**
 * Speak a sequence of fixed phrases as separate utterances.
 *
 * Each one is looked up in the pre-synthesized clip index independently, so a
 * question preceded by a section header costs nothing even though that exact
 * combination has never been spoken before. Only the first call interrupts;
 * the rest queue behind it, or they would cancel each other.
 */
async function speakSegments(segments) {
  lastSegments = segments.filter(Boolean);
  lastSpoken = lastSegments.join(' ');
  for (const [i, text] of lastSegments.entries()) {
    await speech.speak(text, { interrupt: i === 0 });
  }
}

/**
 * Redraw the on-screen progress line. Silent by design: it is aria-hidden and
 * outside the live regions, so it updates every question without a screen
 * reader narrating a number that barely moved. The spoken version is the
 * "where am I" command, which the user asks for when they want it.
 */
function updateProgressLine() {
  if (!ui.progressLine) return;
  const p = engine.progress();
  const left = formatTimeRemaining(p.secondsRemaining);
  ui.progressLine.textContent = left
    ? `${p.percent}% done \u00b7 ${left} left`
    : `${p.percent}% done`;
}

function isFirstFieldOfItem(q) {
  const node = SECTIONS.flatMap(s => s.questions).find(n => n.id === q.loopId);
  return node?.fields?.[0]?.id === q.id;
}

/** Handle one answer: extract, validate, confirm if needed, commit. */
async function handleTranscript(transcript) {
  // A transcript read-back is open: this turn is a yes/no about what was heard
  // last time, not an answer to the form question. Checked before everything
  // else for the same reason the delete confirmation is — a bare "no" here
  // means "that is not what I said", and must never reach the extractor.
  if (checking) { await handleTranscriptCheck(transcript); return; }

  // "Which answer would you like to change?" is matched locally, never by the
  // model — see the note at the top of correct.js.
  if (inCorrectionPrompt()) { setStatus(''); await handleFieldName(transcript); return; }

  // "Remove that last provider" mid-interview is a command, not an answer.
  // The model has no delete command to return — left to the extractor this
  // would be recorded as the value of whatever question is open — so the
  // phrase is caught locally, before extraction, and only when it names a
  // group that actually holds something.
  if (!pending && namesSomethingToDelete(transcript)) {
    setStatus('');
    resumeAfterPrompt = true;
    await beginDeletion(transcript);
    return;
  }

  // Navigation words are matched locally on the voice path too, not only when
  // typed. "Go back" is a fixed vocabulary; paying a model to recognize it
  // adds a network round trip to the least ambiguous thing a user can say.
  if (!pending) {
    const cmd = localCommand(transcript);
    if (cmd) { setStatus(''); await runCommand(cmd); return; }
  }

  const q = pending?.question ?? engine.current();
  if (!q) return;

  // A confirmation read-back is a yes/no question about the value just heard,
  // which is why it is reshaped here rather than handled separately.
  const asked = pending ? { ...q, type: 'yesno', prompt: 'Is that correct?' } : q;

  // Most turns never reach the model: yes/no, digit strings, and dates have
  // one correct reading, and parseLocal() returns it or returns null. Null
  // means it was not certain, which is the only case worth paying for.
  let result = parseLocal(asked, transcript);

  if (!result && !store.getApiKey()) {
    // No key and the local parser was not sure. A re-ask is the honest
    // outcome; there is nothing else to consult.
    await reask(asked.hint ? `${say.REASK.generic} ${asked.hint}` : say.REASK.generic);
    return;
  }

  if (!result) {
    setStatus('Thinking…');
    audio.earcon('think');
    try {
      result = await llm.extract(asked, transcript);
    } catch (err) {
      await handleLlmError(err);
      return;
    }
  } else {
    // parseLocal() produces a candidate; normalize() stays the single place
    // that decides whether a value is well formed.
    result = llm.normalize(result, asked);
  }

  if (result.command) { await runCommand(result.command); return; }

  // Awaiting a yes/no on a read-back.
  if (pending) {
    if (result.value === true) {
      const value = pending.value;
      pending = null;
      commit(value);
      return;
    }
    if (result.value === false) {
      pending = null;
      await askCurrent({ prefix: say.LET_US_TRY_AGAIN });
      return;
    }
    await reask(say.REASK.yesno);
    return;
  }

  if (result.needsClarification || result.value == null) {
    await reask(result.clarifyPrompt || say.REASK.generic);
    return;
  }

  // High-stakes fields are read back before they are committed.
  if (q.confirm) {
    pending = { question: q, value: result.value };
    const readBack = `I heard ${speakableValue(result.value, q.type, q.options)}. Is that correct?`;
    ui.question.textContent = readBack;
    announce(readBack);
    await speech.speak(readBack);
    resumeListening();
    return;
  }

  commit(result.value);
}

function commit(value) {
  setStatus('');
  // A correction writes in place and returns to review; it must not advance
  // the interview into whatever question follows the corrected one.
  if (correcting) { finishCorrection(value); return; }
  engine.submit(value);
  store.saveState(engine.getState());
  askCurrent();
}

async function reask(message) {
  const q = engine.current();
  const hint = q?.hint ? ` ${q.hint}` : '';
  announce(message + hint, true);
  await speech.speak(message + hint);
  resumeListening();
}

// -- global commands -------------------------------------------------------

async function runCommand(cmd) {
  pending = null;
  checking = null;

  // While one answer is being corrected, the forward-walk commands would
  // resume the interview from the middle of the form: engine.skip() submits
  // and advances, and back() steps to whatever preceded the corrected
  // question. In a correction both simply mean "leave it as it was".
  if (correcting && (cmd === 'back' || cmd === 'skip')) {
    await returnToReview(say.UNCHANGED);
    return;
  }
  // Leaving the correction flow by any other route abandons it cleanly.
  if ((correcting || inCorrectionPrompt()) && cmd !== 'repeat' && cmd !== 'help') {
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
      store.saveState(engine.getState());
      await askCurrent({ prefix: say.GOING_BACK });
      return;
    case 'skip':
      engine.skip();
      store.saveState(engine.getState());
      await askCurrent();
      return;
    case 'where': {
      const p = engine.progress();
      // The estimate is the useful half of this answer once it exists — a
      // percentage does not tell someone whether they can finish before they
      // have to leave. It is still read after the percentage rather than
      // instead of it, since the percentage is the number that never moves
      // backward and is the one worth trusting.
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
      await speech.speak(summaryText(engine.answers()));
      if (mode === 'handsfree') queueListen();
      return;
    case 'correct':
      await askWhichField();
      return;
    case 'save_quit':
      store.saveState(engine.getState());
      await speech.speak(say.SAVED);
      setStatus('Saved. Your place is kept on this device.');
      return;
    case 'restart':
      engine.reset();
      store.clearState();
      await speech.speak(say.STARTING_OVER);
      await askCurrent({ announceSection: true });
      return;
    case 'clear_data':
      clearEverything();
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

// -- input: voice, hands free, typing --------------------------------------

async function onTalkDown(e) {
  e?.preventDefault();
  // Not gated on `mode`. Someone who chose typing at the start, or who just
  // typed an answer, can still press and hold to speak — the microphone is
  // requested here, lazily, on the first press. Only a microphone that has
  // actually failed closes this lane.
  if (busy || voiceDisabled || audio.isRecording()) return;
  lastInputWasText = false;
  setStatus('Listening…');
  ui.talk.dataset.recording = 'true';
  ui.talk.textContent = 'Listening — release to send';
  announce('Listening', true);
  try {
    await audio.startRecording();
    beginSttAttempt();
  } catch (err) {
    resetTalkButton();
    announce('The microphone is not available. Switching to typing.', true);
    disableVoice();
  }
}

async function onTalkUp(e) {
  e?.preventDefault();
  if (!audio.isRecording()) return;
  resetTalkButton();
  const blob = await audio.stopRecording();
  await sendAudio(blob);
}

async function listenHandsFree() {
  if (busy || voiceDisabled || mode !== 'handsfree') return;
  setStatus('Listening…');
  ui.talk.dataset.recording = 'true';
  ui.talk.textContent = 'Listening — speak now';
  try {
    await audio.startRecording({
      autoStop: true,
      onAutoStop: async () => {
        resetTalkButton();
        const blob = await audio.stopRecording();
        await sendAudio(blob);
      }
    });
    beginSttAttempt();
  } catch {
    resetTalkButton();
    disableVoice();
  }
}

/**
 * Start listening with the browser's recognizer, if the user allowed it.
 *
 * Fire and forget: sendAudio() awaits whatever this produced, and a null
 * result simply means the paid path handles the turn.
 */
function beginSttAttempt() {
  if (!stt.isPermitted()) { sttAttempt = null; return; }
  const controller = new AbortController();
  sttAttempt = { controller, promise: stt.listen({ signal: controller.signal }) };
}

/** Collect whatever the browser recognizer heard, and clear the attempt. */
async function takeSttResult() {
  const attempt = sttAttempt;
  sttAttempt = null;
  if (!attempt) return null;
  attempt.controller.abort();
  try { return await attempt.promise; } catch { return null; }
}

async function sendAudio(blob) {
  // Four cheap filters before paying to transcribe. The size check catches a
  // recorder that produced nothing; the duration check catches a bumped space
  // bar; the level check catches a turn that captured only room tone, whether
  // it auto-stopped on a cough or the user pressed and released without
  // saying anything. All four end the same way — ask again — because the one
  // thing that must not happen is the form moving on from a question the user
  // never actually answered.
  if (!blob || blob.size < 800
      || audio.lastCaptureDurationMs() < MIN_CAPTURE_MS
      || !audio.lastCaptureHadSpeech()) {
    takeSttResult();
    await reask(say.REASK.nothingHeard);
    return;
  }
  busy = true;
  setStatus('Transcribing…');
  try {
    const q = checking?.question ?? pending?.question ?? engine.current();
    // While a read-back is open the expected answer is yes or no, whatever the
    // underlying field happens to be. Shaping it that way keeps the digit
    // gate below from forcing a paid transcription of the word "yes" just
    // because the question it belongs to asks for a Social Security number.
    const asked = (pending || checking) ? { ...q, type: 'yesno' } : q;

    let transcript = await takeSttResult();

    // The browser recognizer has no equivalent of the transcription hint that
    // primes the paid API for digit strings, and these are the fields where a
    // misread digit does lasting damage. When it returns something that is not
    // cleanly a number of the right shape, spend the money rather than lean on
    // the read-back to catch it.
    if (transcript && needsAccurateDigits(asked) && !parseLocal(asked, transcript)) {
      transcript = null;
    }

    if (!transcript && !store.getApiKey()) {
      // Nothing heard and nothing to fall back to.
      await reask(say.REASK.nothingHeard);
      return;
    }
    if (!transcript) {
      transcript = await llm.transcribe(blob, { hint: llm.hintFor(asked) });
    }

    // A transcriber handed near-silence does not return nothing; it returns a
    // short plausible phrase. Reject those rather than record them.
    if (isEmptyTranscript(transcript)) {
      await reask(say.REASK.nothingHeard);
      return;
    }

    setStatus(`You said: ${transcript}`);

    if (needsTranscriptCheck(transcript)) {
      await askTranscriptCheck(transcript);
      return;
    }
    await handleTranscript(transcript);
  } catch (err) {
    // "I heard nothing" is a re-ask, not an error: no earcon, no lecture, and
    // the question stays open.
    if (err?.kind === 'empty') { await reask(say.REASK.nothingHeard); return; }
    await handleLlmError(err);
  } finally {
    busy = false;
  }
}

/** Shorter than this and the space bar was bumped, not spoken into. */
const MIN_CAPTURE_MS = 350;

// What a transcriber tends to emit when handed silence or room tone. Rejected
// only when the microphone also stayed near the noise floor for the whole
// capture, so someone who genuinely says "okay" into a live mic is still heard.
const FILLER_TRANSCRIPTS = new Set([
  'you', 'thank you', 'thanks', 'thanks for watching', 'thank you for watching',
  'bye', 'okay', 'ok', 'uh', 'um', 'hmm', 'mm', 'oh', 'the'
]);
const QUIET_PEAK = 0.05;

/** Is this transcript empty, punctuation, or silence-filler from a quiet mic? */
function isEmptyTranscript(text) {
  const s = String(text ?? '').trim();
  if (!s) return true;
  // Nothing but punctuation, dashes, quotes or ellipses.
  if (!/[\p{L}\p{N}]/u.test(s)) return true;
  const bare = s.toLowerCase().replace(/[.!?,\s]+$/, '').trim();
  return FILLER_TRANSCRIPTS.has(bare) && audio.lastCapturePeak() < QUIET_PEAK;
}

/**
 * Should this voice answer be read back for a spoken yes/no before it is used?
 *
 * Everything the user dictates, yes. What is excluded is only what is already
 * a confirmation or a command, where a second yes/no would be noise:
 *
 *   - a yes/no answering a read-back that is already open;
 *   - a navigation word, or a request to delete an entry (which confirms
 *     itself, by name, before anything is erased);
 *   - a reply to one of the correction prompts, which re-prompt on their own
 *     when they cannot match what was said;
 *   - a question marked `confirm` — SSN, bank details. Those get the stronger
 *     read-back of the *parsed value*, spoken digit by digit, a few lines
 *     further on. Reading the raw transcript first would ask the same question
 *     twice and bury the version that actually catches a wrong digit.
 */
function needsTranscriptCheck(transcript) {
  if (pending || checking) return false;
  if (inCorrectionPrompt() || choosing) return false;
  if (localCommand(transcript)) return false;
  if (namesSomethingToDelete(transcript)) return false;
  const q = correcting?.question ?? engine.current();
  if (!q || q.confirm) return false;
  return true;
}

/** Read back what was heard, verbatim, and wait for yes or no. */
async function askTranscriptCheck(transcript) {
  const q = correcting?.question ?? engine.current();
  checking = { transcript, question: q };

  ui.question.textContent = `I heard: ${transcript}`;
  ui.hint.textContent = 'Say yes to keep it, or no to answer again.';
  announce(`I heard: ${transcript}. ${say.TRANSCRIPT_CHECK}`);
  // Two segments: the transcript is unique to this answer, the prompt after it
  // is fixed and comes from the clip index.
  await speakSegments([`I heard: ${transcript}.`, say.TRANSCRIPT_CHECK]);
  resumeListening();
}

/** Yes uses the transcript; no throws it away and reopens the same question. */
async function handleTranscriptCheck(text) {
  const s = String(text ?? '').trim();
  // Tested before the command table, not after: "correct" is both a way to say
  // yes and the name of the change-an-answer command, and here it plainly
  // means the first one.
  const yes = /^(y|yes|yeah|yep|yup|correct|right|that is right|thats right|sure|ok|okay)\b/i.test(s);
  const no = /^(n|no|nope|nah|wrong|incorrect|not right|that is wrong|thats wrong)\b/i.test(s);

  // Otherwise a command still wins — someone who answers the read-back with
  // "skip" or "go back" means it, and should not have to say no first.
  if (!yes && !no) {
    const cmd = localCommand(text);
    if (cmd) { checking = null; await runCommand(cmd); return; }
  }

  if (yes) {
    const { transcript } = checking;
    checking = null;
    setStatus('');
    await handleTranscript(transcript);
    return;
  }

  if (no) {
    checking = null;
    setStatus('');
    // Deliberately does not re-ask the question. The user knows what was
    // asked — they just answered it — and hearing the whole prompt again
    // before every retry is what makes a misheard answer feel expensive.
    // Restore the prompt on screen for anyone reading it, and reopen the mic.
    const q = correcting?.question ?? engine.current();
    if (q) { ui.question.textContent = q.prompt; ui.hint.textContent = q.hint || ''; }
    announce(say.ANSWER_AGAIN, true);
    await speakSegments([say.ANSWER_AGAIN]);
    // Leave `repeat` pointing at the question rather than at "go ahead" — that
    // is what someone asking to hear it again at this point actually wants.
    if (q) { lastSegments = [q.prompt]; lastSpoken = q.prompt; }
    resumeListening();
    return;
  }

  await sayAndListen(say.REASK.yesnoTranscript);
}

/** Types where an unnoticed digit error is worth paying to avoid. */
const ACCURATE_DIGIT_TYPES = new Set(['ssn', 'routing', 'account', 'phone']);
const needsAccurateDigits = q => ACCURATE_DIGIT_TYPES.has(q?.type);

async function submitTyped() {
  const text = ui.textAnswer.value.trim();
  if (!text) return;
  ui.textAnswer.value = '';
  lastInputWasText = true;
  busy = true;
  try {
    // A transcript read-back can be answered by typing yes or no, the same as
    // by saying it — the two lanes are interchangeable at every prompt.
    if (checking) { await handleTranscriptCheck(text); return; }

    // While naming a field to correct, the words are a field name, not a
    // navigation command — "back" there means "never mind", not "previous
    // question", and it is handled inside handleFieldName().
    if (inCorrectionPrompt()) { await handleFieldName(text); return; }

    // handleTranscript() matches navigation words locally before anything
    // else, so the typed path only needs its own check on the key-free route.
    if (store.getApiKey()) await handleTranscript(text);
    else await handleTypedDirect(text);
  } finally {
    busy = false;
  }
}

// Navigation commands, matched locally on both the typed and the spoken path.
//
// Anchored, so a command word appearing inside a real answer is not mistaken
// for a command: "I skip meals" is an answer, "skip" is a command. What sits
// outside the anchors is only politeness and hesitation — the words people
// actually put around a spoken instruction — never anything that could carry
// meaning of its own.
const LOCAL_COMMANDS = [
  [/^(repeat|repeat that|say (that )?again|again|one more time)$/, 'repeat'],
  [/^(back|go back|previous|last question|go back a question)$/, 'back'],
  [/^(skip|skip (this|it|that)|pass|leave (it |this )?blank|next)$/, 'skip'],
  [/^(where|where am i|progress|how far|how much (is )?(left|to go))$/, 'where'],
  [/^(read back|read back my answers|read my answers|review)$/, 'readback'],
  [/^(change|change an answer|correct|correct an answer|fix|fix an answer|edit)$/, 'correct'],
  [/^(save|save and quit|quit|stop for now)$/, 'save_quit'],
  [/^(start over|restart|start again)$/, 'restart'],
  [/^(help|\?|what can i say)$/, 'help'],
  [/^(finish|done|finish early|that is all|thats all|i am done|im done)$/, 'finish']
];

/** Politeness and hesitation around a spoken command; carries no meaning. */
const COMMAND_FILLER = {
  lead: /^(um|uh|er|ok|okay|well|hey|please|can you|could you|would you|i want to|i would like to|let us|lets)\b[\s,]*/,
  tail: /[\s,]*\b(please|now|thanks|thank you)\b[\s.!?]*$/
};

function localCommand(text) {
  let s = String(text ?? '').toLowerCase().trim().replace(/[.!?]+$/, '');
  // Strip filler repeatedly: "ok, can you please repeat that" stacks three.
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(COMMAND_FILLER.lead, '').replace(COMMAND_FILLER.tail, '').trim();
    if (s === before) break;
  }
  if (!s) return null;
  for (const [re, cmd] of LOCAL_COMMANDS) if (re.test(s)) return cmd;
  return null;
}

/** Typing mode with no API key: parse locally so the app works key-free. */
async function handleTypedDirect(text) {
  const cmd = localCommand(text);
  if (cmd) { await runCommand(cmd); return; }

  if (!pending && namesSomethingToDelete(text)) {
    resumeAfterPrompt = true;
    await beginDeletion(text);
    return;
  }

  const q = pending?.question ?? engine.current();
  if (!q) return;

  if (pending) {
    const yes = /^(y|yes|yeah|correct|right)$/i.test(text);
    const no = /^(n|no|nope|wrong)$/i.test(text);
    if (yes) { const v = pending.value; pending = null; commit(v); return; }
    if (no) { pending = null; await askCurrent({ prefix: 'Let us try again.' }); return; }
    await reask(say.REASK.yesno);
    return;
  }

  const result = llm.normalize(
    { command: null, value: text, confidence: 1, needsClarification: false, clarifyPrompt: null },
    q
  );
  if (result.needsClarification || result.value == null) {
    await reask(result.clarifyPrompt || say.REASK.notRight);
    return;
  }
  if (q.confirm) {
    pending = { question: q, value: result.value };
    const readBack = `I have ${speakableValue(result.value, q.type, q.options)}. Is that correct? Type yes or no.`;
    ui.question.textContent = readBack;
    announce(readBack);
    await speech.speak(readBack);
    resumeListening();
    return;
  }
  commit(result.value);
}

/**
 * Close the voice lane for good.
 *
 * Only for a microphone that cannot work — permission denied, no device, or an
 * API key the transcriber rejected. Everything else leaves the talk button on
 * screen, because a user who typed one answer has not given up on speaking.
 */
function disableVoice() {
  takeSttResult();
  voiceDisabled = true;
  mode = 'text';
  lastInputWasText = true;
  ui.textEntry.hidden = false;
  ui.talk.hidden = true;
  ui.textAnswer.focus();
}

/** Put the cursor in the text box without closing the voice lane. */
function useTextLane() {
  lastInputWasText = true;
  ui.textEntry.hidden = false;
  ui.textAnswer.focus();
  announce(say.TYPING_LANE, true);
}

/** Leave the text box so the space bar talks again. */
function useVoiceLane() {
  if (voiceDisabled) { ui.textAnswer.focus(); return; }
  lastInputWasText = false;
  focusMain();
  announce(say.VOICE_LANE, true);
}

function resetTalkButton() {
  ui.talk.dataset.recording = 'false';
  ui.talk.textContent = 'Hold to talk';
}

// -- keyboard --------------------------------------------------------------

let spaceHeld = false;

function onKeyDown(e) {
  if (ui.interview?.hidden) return;
  const typing = e.target === ui.textAnswer || e.target === ui.apiKey;

  // Push to talk works in every mode, not only 'voice' — the only thing that
  // suppresses it is a cursor sitting in a text field, where a space is a
  // space. Escape leaves that field, which is how someone who typed an answer
  // gets the space bar back.
  if (e.code === 'Space' && !typing && !voiceDisabled) {
    if (spaceHeld || e.repeat) return;
    spaceHeld = true;
    e.preventDefault();
    onTalkDown();
    return;
  }
  if (typing) {
    if (e.code === 'Escape' && e.target === ui.textAnswer) { e.preventDefault(); useVoiceLane(); }
    return;
  }

  const map = { Enter: 'repeat', KeyB: 'back', KeyS: 'skip', KeyW: 'where', KeyR: 'readback', KeyC: 'correct' };
  if (e.code === 'Escape' && audio.isRecording()) {
    audio.cancelRecording();
    // Stop the recognizer too, and drop whatever it heard. Left running, its
    // result would arrive on whatever turn happens to be open next.
    takeSttResult();
    resetTalkButton();
    setStatus('Cancelled.');
    announce('Cancelled', true);
    return;
  }
  if (e.code === 'KeyT') { useTextLane(); return; }
  if (e.code === 'KeyH' && !voiceDisabled) {
    mode = mode === 'handsfree' ? 'voice' : 'handsfree';
    announce(mode === 'handsfree' ? 'Hands free mode on' : 'Hands free mode off', true);
    if (mode === 'handsfree') queueListen();
    return;
  }
  if (map[e.code]) { e.preventDefault(); runCommand(map[e.code]); }
}

function onKeyUp(e) {
  if (e.code === 'Space' && spaceHeld) {
    spaceHeld = false;
    e.preventDefault();
    onTalkUp();
  }
}

// -- errors ----------------------------------------------------------------

async function handleLlmError(err) {
  audio.earcon('error');
  const kind = err?.kind ?? 'unknown';
  const msg = say.ERRORS[kind] ?? say.ERRORS.unknown;
  setStatus(msg);
  announce(msg, true);
  if (kind === 'auth' || kind === 'network') speech.forceFallback(true);
  await speech.speak(msg);
  if (kind === 'auth') disableVoice();
  else if (mode === 'handsfree') queueListen();
}

// -- finish, review, export ------------------------------------------------

async function finishInterview() {
  store.saveState(engine.getState());
  ui.interview.hidden = true;
  ui.review.hidden = false;
  audio.earcon('done');

  const missing = engine.missingRequired();
  const intro = missing.length
    ? `Your answers are ready. ${missing.length} required ${missing.length === 1 ? 'answer is' : 'answers are'} still blank: ${missing.map(m => m.prompt).join(' ')} You can change an answer, or download your forms as they are.`
    : say.ALL_DONE;

  ui.reviewIntro.textContent = intro;
  renderSummary(ui.summary, engine.answers());
  showDownloadButtons();
  announce(intro, true);
  // Two utterances: the completion line varies with what is missing, but the
  // download instructions are fixed and come from the clip index.
  await speakSegments([intro, say.DOWNLOAD_HINT]);
  firstDownloadButton()?.focus();
}

/** One download button per chosen form, plus "both" when there are two. */
function showDownloadButtons() {
  const chosen = formsOf(engine.answers());
  el('download-all').hidden = chosen.size < 2;
  el('download-ssa').hidden = !chosen.has('ssa');
  el('download-ds').hidden = !chosen.has('ds');
}

function firstDownloadButton() {
  return ['download-all', 'download-ssa', 'download-ds'].map(el).find(b => b && !b.hidden) ?? null;
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
      ui.review.hidden = true;
      ui.interview.hidden = false;
      clearCorrectionState();
      await askCurrent({ prefix: say.FILL_IN_MISSING });
      return;
    }
  }
  await askWhichField();
}

/**
 * Is one of the correction-flow prompts open and waiting for a spoken reply?
 *
 * All of them route to handleFieldName(), which dispatches on which is set.
 * A delete confirmation counts: its "yes" must not fall through to the
 * answer-extraction path and get recorded as a form value.
 */
function inCorrectionPrompt() {
  return awaitingFieldName || !!choosingItem || !!confirmingDelete;
}

/**
 * Drop every in-flight correction and deletion prompt.
 *
 * These are mutually exclusive states, and a stale one left set would route
 * the next answer into the wrong handler — a spoken "yes" landing on an
 * abandoned delete confirmation is the case that matters.
 */
function clearCorrectionState() {
  correcting = null;
  choosing = null;
  choosingItem = null;
  confirmingDelete = null;
  awaitingFieldName = false;
  resumeAfterPrompt = false;
  pending = null;
  checking = null;
}

/** Open the "which answer do you want to change?" prompt. */
async function askWhichField() {
  clearCorrectionState();
  awaitingFieldName = true;

  ui.review.hidden = true;
  ui.interview.hidden = false;
  ui.sectionLabel.textContent = 'Changing an answer';

  const msg = say.WHICH_FIELD;
  ui.question.textContent = 'Which answer would you like to change?';
  ui.hint.textContent = 'Name a field, such as "my date of birth" or "the first job\'s employer". '
    + 'To delete a whole entry, say "remove the second provider".';
  lastSpoken = msg;
  announce(msg);
  await speech.speak(msg);

  ui.textAnswer.value = '';
  resumeListening();
}

/** The user named a field (or answered a disambiguation question). */
async function handleFieldName(text) {
  // A delete confirmation is checked before the general cancel words, because
  // "no" is a valid answer to "remove this?" and means keep it — it must be
  // handled there rather than read as "never mind, take me back".
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
    const picked = resolveChoice(text, choosing.candidates);
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
  // phone" edits one field. Only an explicit removal verb takes this branch.
  if (isDeletionPhrase(text)) { await beginDeletion(text); return; }

  const result = resolveTarget(text, engine.answers());

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
    .map((c, i) => `${i + 1}. ${describeTarget(c)}`)
    .join('. ');
  return `Did you mean: ${list}. Say the number, or the name.`;
}

// -- deleting a loop entry -------------------------------------------------

/**
 * Does this phrase ask to delete a loop entry that actually exists?
 *
 * Both halves matter. Without the verb check an ordinary answer containing
 * "remove" would hijack the turn; without resolving it, "delete that" while
 * no loop is named would swallow an answer to the open question.
 */
function namesSomethingToDelete(text) {
  if (!isDeletionPhrase(text)) return false;
  return resolveDeletion(text, engine.answers()).reason !== 'none';
}

/**
 * Resolve a spoken deletion and, when it names one item, ask to confirm.
 *
 * Deleting throws away every answer recorded for that item and cannot be
 * undone from the review screen, so nothing is removed until the user says
 * yes to a prompt that names exactly what is about to go.
 */
async function beginDeletion(text) {
  const r = resolveDeletion(text, engine.answers());

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
  const list = candidates.map(c => describeItem(c)).join('. ');
  return `${list}. Say the number, or the name.`;
}

/** Match a spoken reply against the offered items. */
function pickItem(text, candidates) {
  const picked = resolveChoice(text, candidates.map(c => ({
    // resolveChoice scores against label/prompt, so give it the item's name.
    id: `__item_${c.index}`,
    label: c.title ?? `${c.itemLabel} ${c.number}`,
    prompt: `${c.itemLabel} ${c.number}`,
    index: c.index
  })));
  if (!picked) return null;
  return candidates.find(c => c.index === picked.index) ?? null;
}

/** Ask for an explicit yes before removing anything. */
async function confirmDelete(loopId, item) {
  choosingItem = null;
  confirmingDelete = { loopId, item };

  const what = describeItem(item);
  const msg = `Remove ${what}? This erases every answer recorded for that `
    + `${item.itemLabel}, and I cannot bring it back. Say yes to remove it, or no to keep it.`;
  ui.question.textContent = `Remove ${what}?`;
  ui.hint.textContent = 'Say yes to remove it, or no to keep it.';
  await sayAndListen(msg);
}

/** Yes removes the item; anything else keeps it. */
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
    await returnToReview(`I kept ${describeItem(item)}.`);
    return;
  }

  const removed = engine.removeItem(loopId, item.index);
  store.saveState(engine.getState());
  await returnToReview(removed
    ? `I removed ${describeItem(item)}.`
    : 'That entry could not be removed.');
}

/** Jump to the resolved target and re-ask it. */
async function beginCorrection(target) {
  const q = engine.jumpTo(target.id, target.loopIndex ?? 0, target.loopId ?? null);
  if (!q) {
    await sayAndListen('I could not open that answer. Try naming a different one, or say never mind.');
    return;
  }

  awaitingFieldName = false;
  correcting = { target, question: q };
  pending = null;

  const current = target.value;
  const heard = current == null || current === ''
    ? `${describeTarget(target)} is blank right now.`
    : `Right now ${describeTarget(target)} is ${speakableValue(current, target.type, target.options)}.`;

  await askCurrent({ prefix: `${heard} What should it be instead?` });
}

/** Finish a correction and go back to the review screen. */
async function finishCorrection(value) {
  const t = correcting.target;
  const ok = engine.setAnswer(t.id, value, { loopId: t.loopId ?? null, loopIndex: t.loopIndex ?? 0 });
  correcting = null;
  pending = null;

  // A different choice of forms can add questions that sit behind the cursor,
  // where the forward walk will never reach them. Go and ask those now rather
  // than offering a half-filled form for download.
  if (ok && t.id === 'forms' && !t.loopId) {
    const next = engine.rewalk();
    store.saveState(engine.getState());
    if (next) {
      clearCorrectionState();
      ui.review.hidden = true;
      ui.interview.hidden = false;
      await speech.speak(say.FORMS_CHANGED);
      await askCurrent({ announceSection: true });
      return;
    }
  }

  store.saveState(engine.getState());

  const what = describeTarget(t);
  await returnToReview(ok
    ? `${titleCase(what)} is now ${speakableValue(value, t.type, t.options)}.`
    : 'That answer could not be changed.');
}

/** Show the review screen again, with a spoken note about what just happened. */
async function returnToReview(note) {
  // Started mid-interview: report what happened and carry on where we were,
  // rather than dropping the user on the summary with the form unfinished.
  if (resumeAfterPrompt) {
    clearCorrectionState();
    store.saveState(engine.getState());
    await askCurrent({ prefix: `${note} Back to your question.` });
    return;
  }

  clearCorrectionState();

  ui.interview.hidden = true;
  ui.review.hidden = false;
  renderSummary(ui.summary, engine.answers());
  showDownloadButtons();

  const missing = engine.missingRequired();
  const tail = missing.length
    ? ` ${missing.length} required ${missing.length === 1 ? 'answer is' : 'answers are'} still blank.`
    : '';
  const msg = `${note}${tail} You can change another answer, or download your forms.`;
  ui.reviewIntro.textContent = msg;
  announce(msg, true);
  await speech.speak(msg);
  el('fix-answer').focus();
}

/** Speak a recovery prompt and keep listening in the correction flow. */
async function sayAndListen(msg) {
  lastSpoken = msg;
  announce(msg, true);
  await speech.speak(msg);
  resumeListening();
}

/**
 * Fill in the official PDF for each form id and download it.
 *
 * Two forms are two files, because they go to two different agencies. A
 * browser may ask before allowing the second download from one click, which
 * is why the spoken confirmation for both mentions it.
 */
async function exportForms(ids) {
  const answers = engine.answers();
  const saved = [];
  let fellBack = false;
  try {
    for (const id of ids) {
      setStatus(`Filling in the ${FORM_TITLES[id]}…`);
      const { filename, fallback } = await downloadForm(id, answers);
      saved.push(filename);
      fellBack = fellBack || fallback;
    }
    const msg = `Downloaded ${saved.join(' and ')}.`;
    setStatus(msg);
    announce(msg, true);
    const spoken = fellBack ? [say.WORKSHEET_FALLBACK] : [];
    spoken.push(saved.length > 1 ? say.BOTH_DOWNLOADED : say.DOWNLOADED);
    await speakSegments(spoken);
  } catch (err) {
    console.error(err);
    const msg = 'The PDF could not be created. Your answers are safe — try saving them as a file instead.';
    setStatus(msg);
    announce(msg, true);
  }
}

function clearEverything() {
  store.clearState();
  store.clearApiKey();
  engine?.reset();
  audio.releaseMic();
  const msg = 'Everything has been erased from this device.';
  announce(msg, true);
  speech.speak(msg);
  setStatus(msg);
  ui.review.hidden = true;
  ui.interview.hidden = true;
  ui.setup.hidden = false;
  ui.resumeRow.hidden = true;
  ui.apiKey.value = '';
  if (ui.importFile) ui.importFile.value = '';
  setImportStatus('');
}

// -- importing a saved file -------------------------------------------------

/** Offer the resume row whenever localStorage holds a session. */
function showSavedSession() {
  const saved = store.loadState();
  if (!saved) { ui.resumeRow.hidden = true; return; }
  const when = new Date(saved.savedAt).toLocaleString();
  ui.resumeText.textContent = `You have a saved session from ${when}.`;
  ui.resumeRow.hidden = false;
}

function setImportStatus(text) {
  if (ui.importStatus) ui.importStatus.textContent = text;
}

/**
 * Load a file written by "Save my answers as a file" into this device's saved
 * session, then offer it on the resume row. The file is not started straight
 * away: the mode, microphone and API key still have to be settled first, and
 * those are the same choices the resume button already runs through.
 */
async function onImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setImportStatus('Reading your file\u2026');
  try {
    const { state, savedAt, rebuiltCursor } = await readExportFile(file);
    if (!store.saveState(state)) {
      throw new ImportError('Your browser would not let this page save the file. '
        + 'Private browsing blocks it. Try a normal window.');
    }
    showSavedSession();
    const when = savedAt ? new Date(savedAt).toLocaleString() : null;
    const msg = 'Your answers were loaded'
      + (when ? ` from the file you saved on ${when}` : '')
      + '. '
      + (rebuiltCursor
        ? 'That file did not record where you left off, so I will start at the first question you have not answered. '
        : '')
      + 'Choose how you want to answer, then select Resume my saved session.';
    setImportStatus(msg);
    announce(msg, true);
    ui.resume.focus();
  } catch (err) {
    const msg = err instanceof ImportError
      ? err.message
      : 'That file could not be loaded. Choose the file you saved from this page.';
    setImportStatus(msg);
    announce(msg, true);
  } finally {
    // Let the same file be chosen again after a failure.
    event.target.value = '';
  }
}

// -- misc ------------------------------------------------------------------

function setStatus(text) { if (ui.status) ui.status.textContent = text; }
function titleCase(s) { return String(s ?? '').replace(/^(.)/, (_, c) => c.toUpperCase()); }

window.addEventListener('error', e => {
  announce('Something went wrong. Your answers are saved on this device.', true);
  console.error(e.error ?? e.message);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
