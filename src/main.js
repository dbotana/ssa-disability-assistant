// Application controller.
//
// Owns the turn loop: ask -> listen -> transcribe -> extract -> confirm ->
// commit -> advance. Every state change is announced, and every failure has a
// spoken recovery path.

import { SECTIONS } from './schema.js';
import { createEngine } from './engine.js';
import { initA11y, announce, focusMain, speakableValue } from './a11y.js';
import * as store from './store.js';
import * as audio from './audio.js';
import * as speech from './speech.js';
import * as llm from './llm.js';
import { renderSummary, summaryText, downloadJson } from './summary.js';
import {
  resolveTarget, resolveChoice, describeTarget,
  isDeletionPhrase, resolveDeletion, describeItem
} from './correct.js';
import { downloadPdf } from './pdf.js';

const el = id => document.getElementById(id);

const ui = {};
let engine = null;
let mode = 'voice';               // voice | handsfree | text
let busy = false;
let pending = null;               // { question, value } awaiting confirmation
let lastSpoken = '';

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
    question: el('question-heading'),
    hint: el('hint'),
    status: el('status'),
    talk: el('talk-button'),
    textEntry: el('text-entry'),
    textAnswer: el('text-answer'),
    textSubmit: el('text-submit'),
    summary: el('summary'),
    reviewIntro: el('review-intro')
  });

  const saved = store.loadState();
  if (saved) {
    const when = new Date(saved.savedAt).toLocaleString();
    ui.resumeText.textContent = `You have a saved session from ${when}.`;
    ui.resumeRow.hidden = false;
  }

  ui.apiKey.value = store.getApiKey();
  ui.start.addEventListener('click', () => start(false));
  ui.resume.addEventListener('click', () => start(true));
  ui.discard.addEventListener('click', () => {
    store.clearState();
    ui.resumeRow.hidden = true;
    announce('Saved session erased. Ready to start fresh.', true);
  });

  ui.talk.addEventListener('pointerdown', onTalkDown);
  ui.talk.addEventListener('pointerup', onTalkUp);
  ui.talk.addEventListener('pointerleave', () => { if (audio.isRecording()) onTalkUp(); });
  ui.textSubmit.addEventListener('click', submitTyped);
  ui.textAnswer.addEventListener('keydown', e => { if (e.key === 'Enter') submitTyped(); });

  document.querySelectorAll('[data-command]').forEach(b =>
    b.addEventListener('click', () => runCommand(b.dataset.command)));

  el('download-pdf').addEventListener('click', exportPdf);
  el('download-json').addEventListener('click', () => {
    downloadJson(engine.answers());
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
    mode = 'text';
    document.querySelector('input[name="mode"][value="text"]').checked = true;
    announce('No API key given, so I switched to typing mode with your browser voice.', true);
    speech.forceFallback(true);
  }

  if (mode !== 'text') {
    try {
      await audio.initMic();
    } catch (err) {
      mode = 'text';
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
  ui.textEntry.hidden = mode !== 'text';
  ui.talk.hidden = mode === 'text';

  await speech.speak(introFor(mode));
  askCurrent({ announceSection: true });
}

function introFor(m) {
  if (m === 'text') return 'Typing mode. I will ask a question, you type the answer and press Enter. You can type skip, back, or repeat at any time.';
  if (m === 'handsfree') return 'Hands free mode. I will ask a question, then start listening on my own. Just answer when you hear the tone. Say repeat, go back, or skip at any time.';
  return 'Voice mode. Hold the space bar while you answer, and let go when you are done. Say repeat, go back, or skip at any time.';
}

// -- the turn loop ---------------------------------------------------------

async function askCurrent({ announceSection = false, prefix = '' } = {}) {
  pending = null;
  const q = engine.current();

  if (!q) { await finishInterview(); return; }

  let spoken = '';
  // A correction is a detour, not progress through the form. Announcing the
  // section it happens to land in is confusing, and recording it as the
  // current section would suppress the real header on the next question.
  if (correcting) {
    ui.sectionLabel.textContent = `Changing an answer — ${q.sectionTitle}`;
  } else if (announceSection || q.section !== askCurrent.lastSection) {
    const p = engine.progress();
    spoken += `Section ${p.sectionNumber} of ${p.sectionCount}. ${q.sectionTitle}. `;
    ui.sectionLabel.textContent = `Section ${p.sectionNumber} of ${p.sectionCount} — ${q.sectionTitle}`;
    askCurrent.lastSection = q.section;
  }
  // A correction re-asks one known field, so the section preamble and the
  // "next I will need…" warning are both noise — the user asked for this
  // question by name and has already heard its current value read back.
  if (q.warn && !correcting) spoken += `${q.warn} `;
  if (!correcting && q.loopPhase === 'field' && q.itemNumber > 1 && isFirstFieldOfItem(q)) {
    spoken += `${titleCase(q.itemLabel)} ${q.itemNumber}. `;
  }
  spoken += prefix ? `${prefix} ${q.prompt}` : q.prompt;

  ui.question.textContent = q.prompt;
  ui.hint.textContent = q.hint || '';
  lastSpoken = spoken;

  announce(spoken);
  await speech.speak(spoken);

  if (mode === 'text') { ui.textAnswer.value = ''; ui.textAnswer.focus(); }
  else if (mode === 'handsfree') listenHandsFree();
  else focusMain();
}

function isFirstFieldOfItem(q) {
  const node = SECTIONS.flatMap(s => s.questions).find(n => n.id === q.loopId);
  return node?.fields?.[0]?.id === q.id;
}

/** Handle one answer: extract, validate, confirm if needed, commit. */
async function handleTranscript(transcript) {
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

  const q = pending?.question ?? engine.current();
  if (!q) return;

  setStatus('Thinking…');
  audio.earcon('think');

  let result;
  try {
    result = await llm.extract(pending ? { ...q, type: 'yesno', prompt: 'Is that correct?' } : q, transcript);
  } catch (err) {
    await handleLlmError(err);
    return;
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
      await askCurrent({ prefix: 'Let us try again.' });
      return;
    }
    await reask('Please answer yes or no. Is that correct?');
    return;
  }

  if (result.needsClarification || result.value == null) {
    await reask(result.clarifyPrompt || 'I did not catch that. Could you say it again?');
    return;
  }

  // High-stakes fields are read back before they are committed.
  if (q.confirm) {
    pending = { question: q, value: result.value };
    const readBack = `I heard ${speakableValue(result.value, q.type)}. Is that correct?`;
    ui.question.textContent = readBack;
    announce(readBack);
    await speech.speak(readBack);
    if (mode === 'text') ui.textAnswer.focus();
    else if (mode === 'handsfree') listenHandsFree();
    else focusMain();
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
  if (mode === 'text') ui.textAnswer.focus();
  else if (mode === 'handsfree') listenHandsFree();
  else focusMain();
}

// -- global commands -------------------------------------------------------

async function runCommand(cmd) {
  pending = null;

  // While one answer is being corrected, the forward-walk commands would
  // resume the interview from the middle of the form: engine.skip() submits
  // and advances, and back() steps to whatever preceded the corrected
  // question. In a correction both simply mean "leave it as it was".
  if (correcting && (cmd === 'back' || cmd === 'skip')) {
    await returnToReview('That answer was left unchanged.');
    return;
  }
  // Leaving the correction flow by any other route abandons it cleanly.
  if ((correcting || inCorrectionPrompt()) && cmd !== 'repeat' && cmd !== 'help') {
    clearCorrectionState();
  }

  switch (cmd) {
    case 'repeat':
      announce(lastSpoken);
      await speech.speak(lastSpoken);
      if (mode === 'handsfree') listenHandsFree();
      return;
    case 'back':
      engine.back();
      store.saveState(engine.getState());
      await askCurrent({ prefix: 'Going back.' });
      return;
    case 'skip':
      engine.skip();
      store.saveState(engine.getState());
      await askCurrent();
      return;
    case 'where': {
      const p = engine.progress();
      const msg = `You are in section ${p.sectionNumber} of ${p.sectionCount}, ${p.sectionTitle}. About ${p.percent} percent done.`;
      announce(msg, true);
      await speech.speak(msg);
      if (mode === 'handsfree') listenHandsFree();
      return;
    }
    case 'readback':
      await speech.speak(summaryText(engine.answers()));
      if (mode === 'handsfree') listenHandsFree();
      return;
    case 'correct':
      await askWhichField();
      return;
    case 'save_quit':
      store.saveState(engine.getState());
      await speech.speak('Saved. You can close this page and come back to finish later.');
      setStatus('Saved. Your place is kept on this device.');
      return;
    case 'restart':
      engine.reset();
      store.clearState();
      await speech.speak('Starting over.');
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
      await speech.speak('You can say: repeat that, go back, skip this, where am I, read back my answers, change an answer, remove an entry, save and quit, or start over.');
      if (mode === 'handsfree') listenHandsFree();
  }
}

// -- input: voice, hands free, typing --------------------------------------

async function onTalkDown(e) {
  e?.preventDefault();
  if (busy || mode === 'text') return;
  setStatus('Listening…');
  ui.talk.dataset.recording = 'true';
  ui.talk.textContent = 'Listening — release to send';
  announce('Listening', true);
  try {
    await audio.startRecording();
  } catch (err) {
    resetTalkButton();
    announce('The microphone is not available. Switching to typing.', true);
    switchToText();
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
  if (busy || mode !== 'handsfree') return;
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
  } catch {
    resetTalkButton();
    switchToText();
  }
}

async function sendAudio(blob) {
  if (!blob || blob.size < 800) {
    await reask('I did not hear anything. Please try again, or say skip.');
    return;
  }
  busy = true;
  setStatus('Transcribing…');
  try {
    const q = pending?.question ?? engine.current();
    const transcript = await llm.transcribe(blob, { hint: llm.hintFor(q) });
    setStatus(`You said: ${transcript}`);
    await handleTranscript(transcript);
  } catch (err) {
    await handleLlmError(err);
  } finally {
    busy = false;
  }
}

async function submitTyped() {
  const text = ui.textAnswer.value.trim();
  if (!text) return;
  ui.textAnswer.value = '';
  busy = true;
  try {
    // While naming a field to correct, the words are a field name, not a
    // navigation command — "back" there means "never mind", not "previous
    // question", and it is handled inside handleFieldName().
    if (inCorrectionPrompt()) { await handleFieldName(text); return; }

    // Typed navigation words are handled locally, so typing mode needs no key.
    const cmd = localCommand(text);
    if (cmd) { await runCommand(cmd); return; }
    if (store.getApiKey()) await handleTranscript(text);
    else await handleTypedDirect(text);
  } finally {
    busy = false;
  }
}

const LOCAL_COMMANDS = [
  [/^(repeat|repeat that|say again|again)$/i, 'repeat'],
  [/^(back|go back|previous)$/i, 'back'],
  [/^(skip|skip this|pass)$/i, 'skip'],
  [/^(where|where am i|progress)$/i, 'where'],
  [/^(read back|read back my answers|review)$/i, 'readback'],
  [/^(change|change an answer|correct|correct an answer|fix|fix an answer|edit)$/i, 'correct'],
  [/^(save|save and quit|quit)$/i, 'save_quit'],
  [/^(start over|restart)$/i, 'restart'],
  [/^(help|\?)$/i, 'help'],
  [/^(finish|done|finish early)$/i, 'finish']
];

function localCommand(text) {
  for (const [re, cmd] of LOCAL_COMMANDS) if (re.test(text)) return cmd;
  return null;
}

/** Typing mode with no API key: parse locally so the app works key-free. */
async function handleTypedDirect(text) {
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
    await reask('Please answer yes or no. Is that correct?');
    return;
  }

  const result = llm.normalize(
    { command: null, value: text, confidence: 1, needsClarification: false, clarifyPrompt: null },
    q
  );
  if (result.needsClarification || result.value == null) {
    await reask(result.clarifyPrompt || 'That does not look right. Could you try again?');
    return;
  }
  if (q.confirm) {
    pending = { question: q, value: result.value };
    const readBack = `I have ${speakableValue(result.value, q.type)}. Is that correct? Type yes or no.`;
    ui.question.textContent = readBack;
    announce(readBack);
    await speech.speak(readBack);
    ui.textAnswer.focus();
    return;
  }
  commit(result.value);
}

function switchToText() {
  mode = 'text';
  ui.textEntry.hidden = false;
  ui.talk.hidden = true;
  ui.textAnswer.focus();
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

  if (e.code === 'Space' && !typing && mode === 'voice') {
    if (spaceHeld || e.repeat) return;
    spaceHeld = true;
    e.preventDefault();
    onTalkDown();
    return;
  }
  if (typing) return;

  const map = { Enter: 'repeat', KeyB: 'back', KeyS: 'skip', KeyW: 'where', KeyR: 'readback', KeyC: 'correct' };
  if (e.code === 'Escape' && audio.isRecording()) {
    audio.cancelRecording();
    resetTalkButton();
    setStatus('Cancelled.');
    announce('Cancelled', true);
    return;
  }
  if (e.code === 'KeyT') { switchToText(); announce('Typing mode', true); return; }
  if (e.code === 'KeyH' && mode !== 'text') {
    mode = mode === 'handsfree' ? 'voice' : 'handsfree';
    announce(mode === 'handsfree' ? 'Hands free mode on' : 'Hands free mode off', true);
    if (mode === 'handsfree') listenHandsFree();
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
  const messages = {
    auth: 'Your API key was rejected. Reload the page and enter a valid key, or continue in typing mode.',
    rate: 'OpenAI is rate limiting the request. Give it a moment and try again.',
    network: 'I cannot reach OpenAI right now. Check your connection and try again.',
    server: 'OpenAI had a server error. Please try that answer again.',
    empty: 'I did not hear anything. Please try again, or say skip.'
  };
  const msg = messages[kind] ?? 'Something went wrong. Please try that answer again.';
  setStatus(msg);
  announce(msg, true);
  if (kind === 'auth' || kind === 'network') speech.forceFallback(true);
  await speech.speak(msg);
  if (kind === 'auth') switchToText();
  else if (mode === 'handsfree') listenHandsFree();
}

// -- finish, review, export ------------------------------------------------

async function finishInterview() {
  store.saveState(engine.getState());
  ui.interview.hidden = true;
  ui.review.hidden = false;
  audio.earcon('done');

  const missing = engine.missingRequired();
  const intro = missing.length
    ? `Your worksheet is ready. ${missing.length} required ${missing.length === 1 ? 'answer is' : 'answers are'} still blank: ${missing.map(m => m.prompt).join(' ')} You can change an answer, or download the worksheet as it is.`
    : 'All done. Your worksheet is ready to download.';

  ui.reviewIntro.textContent = intro;
  renderSummary(ui.summary, engine.answers());
  announce(intro, true);
  await speech.speak(`${intro} Press the download button to save your PDF worksheet, or press read my answers to hear everything back.`);
  el('download-pdf').focus();
}

/**
 * Start a correction. Missing required answers come first, since those block
 * a complete worksheet; otherwise ask which answer to change.
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
      await askCurrent({ prefix: 'Let us fill in what is missing.' });
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
}

/** Open the "which answer do you want to change?" prompt. */
async function askWhichField() {
  clearCorrectionState();
  awaitingFieldName = true;

  ui.review.hidden = true;
  ui.interview.hidden = false;
  ui.sectionLabel.textContent = 'Changing an answer';

  const msg = 'Which answer would you like to change? You can name the field, '
    + 'for example, my phone number, or the second provider\'s address. '
    + 'You can also remove a whole entry, by saying something like '
    + 'remove that last provider. Say never mind to go back.';
  ui.question.textContent = 'Which answer would you like to change?';
  ui.hint.textContent = 'Name a field, such as "my date of birth" or "the first job\'s employer". '
    + 'To delete a whole entry, say "remove the second provider".';
  lastSpoken = msg;
  announce(msg);
  await speech.speak(msg);

  if (mode === 'text') { ui.textAnswer.value = ''; ui.textAnswer.focus(); }
  else if (mode === 'handsfree') listenHandsFree();
  else focusMain();
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
    : `Right now ${describeTarget(target)} is ${speakableValue(current, target.type)}.`;

  await askCurrent({ prefix: `${heard} What should it be instead?` });
}

/** Finish a correction and go back to the review screen. */
async function finishCorrection(value) {
  const t = correcting.target;
  const ok = engine.setAnswer(t.id, value, { loopId: t.loopId ?? null, loopIndex: t.loopIndex ?? 0 });
  correcting = null;
  pending = null;
  store.saveState(engine.getState());

  const what = describeTarget(t);
  await returnToReview(ok
    ? `${titleCase(what)} is now ${speakableValue(value, t.type)}.`
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

  const missing = engine.missingRequired();
  const tail = missing.length
    ? ` ${missing.length} required ${missing.length === 1 ? 'answer is' : 'answers are'} still blank.`
    : '';
  const msg = `${note}${tail} You can change another answer, or download your worksheet.`;
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
  if (mode === 'text') ui.textAnswer.focus();
  else if (mode === 'handsfree') listenHandsFree();
  else focusMain();
}

async function exportPdf() {
  try {
    setStatus('Building your PDF…');
    const name = [engine.answers().first_name, engine.answers().last_name].filter(Boolean).join(' ');
    const filename = await downloadPdf(engine.answers(), name);
    const msg = `Your worksheet was downloaded as ${filename}.`;
    setStatus(msg);
    announce(msg, true);
    await speech.speak('Your worksheet has been downloaded. Check your downloads folder.');
  } catch (err) {
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
