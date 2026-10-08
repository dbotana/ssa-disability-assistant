// Application controller: the web adapter around turn.js.
//
// Everything the interview *decides* lives in turn.js — a pure state machine
// over injected ports that Android re-implements in Kotlin. This file is only
// what a browser needs: DOM wiring, the microphone, the local transcriber,
// session opening and PDF export. Every step runs on this device: speech is
// transcribed by localstt.js and answers are read by parse.js, and nothing is
// sent anywhere.

import { SECTIONS, FORM_TITLES, formsOf } from './schema.js';
import { createEngine } from './engine.js';
import { initA11y, announce, focusMain, speakableValue, formatTimeRemaining } from './a11y.js';
import * as store from './store.js';
import * as audio from './audio.js';
import * as speech from './speech.js';
import { normalize } from './validate.js';
import { renderSummary, summaryText, downloadJson } from './summary.js';
import * as correct from './correct.js';
import { downloadForm } from './fill.js';
import { readExportFile, ImportError } from './importer.js';
import * as say from './phrases.js';
import { parseLocal } from './parse.js';
import * as localstt from './localstt.js';
import { createTurnController } from './turn.js';

const el = id => document.getElementById(id);

const ui = {};
let turn = null;
// A session read from an imported file, held in memory only until the
// resume it sets up. It may hold sensitive answers; it is never written to
// storage as it is.
let importedSession = null;       // { savedAt, state, withheld }

// -- boot ------------------------------------------------------------------

function boot() {
  initA11y();
  // Warm the pre-synthesized clip index before the first question.
  speech.loadManifest();
  Object.assign(ui, {
    setup: el('setup-panel'),
    interview: el('interview-panel'),
    review: el('review-panel'),
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
    confirmAnswers: el('confirm-answers'),
    readbackControls: el('readback-controls'),
    acceptReadback: el('accept-readback'),
    rejectReadback: el('reject-readback'),
    importFile: el('import-file'),
    importStatus: el('import-status'),
    setupStatus: el('setup-status'),
    pin: el('save-pin'),
    showSensitive: el('show-sensitive')
  });

  // An older version saved Social Security and bank numbers in plain text.
  // Remove them from disk now, before anyone decides whether to resume.
  store.scrubLegacy();
  showSavedSession();

  ui.start.addEventListener('click', () => startOnce(false));
  ui.resume.addEventListener('click', () => startOnce(true));
  ui.discard.addEventListener('click', () => {
    store.clearState();
    importedSession = null;
    ui.resumeRow.hidden = true;
    announce('Saved session erased. Ready to start fresh.', true);
  });
  ui.importFile?.addEventListener('change', onImportFile);

  ui.talk.addEventListener('pointerdown', onTalkDown);
  ui.talk.addEventListener('pointerup', onTalkUp);
  ui.talk.addEventListener('pointerleave', () => { if (audio.isRecording()) onTalkUp(); });
  ui.textSubmit.addEventListener('click', submitTyped);
  ui.textAnswer.addEventListener('keydown', e => { if (e.key === 'Enter') submitTyped(); });

  // Deliberately not wired through [data-command]: runCommand() clears the
  // read-back state as its first act, which is exactly what these two must
  // not do.
  ui.acceptReadback?.addEventListener('click', () => turn?.acceptReadBack());
  ui.rejectReadback?.addEventListener('click', () => turn?.rejectReadBack());

  document.querySelectorAll('[data-command]').forEach(b =>
    b.addEventListener('click', () => turn?.runCommand(b.dataset.command)));

  el('download-all').addEventListener('click', () => turn?.exportForms([...formsOf(turn.snapshot().answers)]));
  el('download-ssa').addEventListener('click', () => turn?.exportForms(['ssa']));
  el('download-ds').addEventListener('click', () => turn?.exportForms(['ds']));
  el('download-json').addEventListener('click', () => {
    downloadJson(turn.snapshot().answers, turn.engineState());
    announce('Your answers were saved as a file.', true);
  });
  el('clear-data').addEventListener('click', () => {
    turn?.clearEverything();
    importedSession = null;
    if (ui.importFile) ui.importFile.value = '';
    setImportStatus('');
    ui.resumeRow.hidden = true;
  });
  el('read-back').addEventListener('click', () => speech.speak(summaryText(turn.snapshot().answers)));
  el('fix-answer').addEventListener('click', () => turn?.startReview());

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('pointerdown', () => turn?.touch());

  if (new URLSearchParams(location.search).get('mode') === 'text') {
    document.querySelector('input[name="mode"][value="text"]').checked = true;
  }
}

// -- the turn controller ports --------------------------------------------------

function makeTurn(saved) {
  turn = createTurnController({
    createEngine: (state, opts) => createEngine(SECTIONS, state ?? null, opts),
    say,
    parseLocal,
    normalize,
    speakable: speakableValue,
    formatTimeRemaining,
    correct,
    store,
    speech,
    audio,
    stt: localstt,
    announce,
    onState: render,
    onExport: async ({ forms, answers }) => {
      for (const id of forms) {
        setStatus(`Filling in the ${FORM_TITLES[id]}…`);
        await downloadForm(id, answers);
      }
    },
    onReadBack: async answers => { speech.speak(summaryText(answers)); }
  });
  return turn;
}

/** Render the controller's snapshot onto the page. */
function render(s) {
  ui.setup.hidden = s.panel !== 'setup';
  ui.interview.hidden = s.panel !== 'interview';
  ui.review.hidden = s.panel !== 'review';
  ui.textEntry.hidden = false;
  ui.talk.hidden = s.voiceDisabled;

  ui.sectionLabel.textContent = s.sectionLabel;
  ui.question.textContent = s.questionText;
  ui.hint.textContent = s.hintText;
  setStatus(s.statusText);
  ui.progressLine.textContent = s.progressText;
  ui.reviewIntro.textContent = s.reviewIntro;
  ui.readbackControls.hidden = !s.readbackOpen;
  if (ui.textAnswer?.classList) {
    if (s.inputMasked) ui.textAnswer.classList.add('masked');
    else ui.textAnswer.classList.remove('masked');
  }

  if (s.panel === 'review') {
    renderSummary(ui.summary, s.answers, { reveal: s.revealSensitive });
    showDownloadButtons();
  }
  if (s.focus === 'download') firstDownloadButton()?.focus();
  else if (s.focus === 'fix') el('fix-answer')?.focus();
  else if (s.lane === 'text' || s.voiceDisabled) ui.textAnswer.focus();
  else focusMain();
}

function showDownloadButtons() {
  const chosen = formsOf(turn.snapshot().answers);
  el('download-all').hidden = chosen.size < 2;
  el('download-ssa').hidden = !chosen.has('ssa');
  el('download-ds').hidden = !chosen.has('ds');
}

function firstDownloadButton() {
  return ['download-all', 'download-ssa', 'download-ds'].map(el).find(b => b && !b.hidden) ?? null;
}

function setStatus(text) { if (ui.status) ui.status.textContent = text; }

// start() derives the PIN's key and loads the speech model before the setup
// panel goes away, which can take seconds. A second press in that time would
// run a second start over the first.
let starting = false;

async function startOnce(resume) {
  if (starting) return;
  starting = true;
  try {
    await start(resume);
  } finally {
    starting = false;
  }
}

async function start(resume) {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const confirmEachAnswer = ui.confirmAnswers?.checked !== false;
  const revealSensitive = ui.showSensitive?.checked === true;

  // The saved session, and the key that protects what is saved from here on.
  let saved;
  try {
    saved = await openSession(resume, ui.pin?.value ?? '');
  } catch (err) {
    const msg = err instanceof store.StoreError ? err.message : 'Your saved answers could not be opened.';
    setSetupStatus(msg);
    announce(msg, true);
    ui.pin?.focus();
    return;
  }
  if (ui.pin) ui.pin.value = '';
  setSetupStatus('');

  if (mode !== 'text') {
    try {
      await audio.initMic();
    } catch (err) {
      const msg = err.kind === 'denied'
        ? 'Microphone access was blocked, so I switched to typing mode. You can allow the microphone in your browser settings and reload.'
        : 'No microphone is available, so I switched to typing mode.';
      announce(msg, true);
      makeTurn(saved);
      await turn.start({ mode: 'text', confirm: confirmEachAnswer, reveal: revealSensitive, saved });
      return;
    }
  }

  // The speech model loads before the first question, so the first answer is
  // not the one that waits for it.
  if (mode !== 'text') {
    try {
      await loadSpeechModel();
    } catch (err) {
      speechModelFailed(err);
    }
  } else {
    loadSpeechModel().catch(() => {});
  }

  makeTurn(saved);
  await turn.start({ mode, confirm: confirmEachAnswer, reveal: revealSensitive, saved });
  turn.setConfirmEachAnswer(confirmEachAnswer);
}

/**
 * Open the session this interview continues, and set up how it is saved.
 * Throws StoreError with a message meant for the user.
 */
async function openSession(resume, pin) {
  if (pin && pin.length < store.MIN_PIN_LENGTH) {
    throw new store.StoreError(
      `A PIN needs at least ${store.MIN_PIN_LENGTH} characters. Longer is safer.`, 'pin');
  }
  store.forgetKey();
  let saved = null;
  if (resume && importedSession) {
    saved = importedSession;
    importedSession = null;
    store.clearState();
  } else if (resume) {
    if (store.savedSessionInfo()?.locked) {
      if (!pin) {
        throw new store.StoreError(
          'Your saved answers are protected. Enter your PIN, then select Resume.', 'pin');
      }
      setSetupStatus('Opening your saved answers…');
      return store.unlock(pin);
    }
    saved = store.takeLegacy();
  } else {
    importedSession = null;
    store.clearState();
  }
  if (pin) {
    setSetupStatus('Protecting your answers with your PIN…');
    await store.usePin(pin);
  }
  return saved;
}

function setSetupStatus(text) {
  if (ui.setupStatus) ui.setupStatus.textContent = text;
}

// -- the speech model -----------------------------------------------------------

function loadSpeechModel() {
  const show = text => {
    setStatus(text);
    if (ui.setupStatus) ui.setupStatus.textContent = text;
  };
  show('Loading the speech model…');
  announce('Loading the speech model.', true);
  let lastPct = -1;
  return localstt.load(({ file, loaded, total }) => {
    if (!total || !/\.onnx$/.test(file ?? '')) return;
    const pct = Math.floor((loaded / total) * 10) * 10;
    if (pct !== lastPct) { lastPct = pct; show(`Loading the speech model… ${pct}%`); }
  }).finally(() => {
    if (ui.status?.textContent.startsWith('Loading the speech model')) setStatus('');
    if (ui.setupStatus) ui.setupStatus.textContent = '';
  });
}

function speechModelFailed() {
  const msg = 'The speech model could not start, so I switched to typing mode.';
  setStatus(msg);
  announce(msg, true);
  turn?.disableVoice();
}

// -- input: voice, typing, keys -----------------------------------------------------

function onTalkDown(e) {
  e?.preventDefault();
  if (!ui.talk.hidden) {
    ui.talk.dataset.recording = 'true';
    ui.talk.textContent = 'Listening — release to send';
  }
  turn?.onTalkDown();
}

function onTalkUp(e) {
  e?.preventDefault();
  if (!audio.isRecording()) return;
  resetTalkButton();
  turn?.onTalkUp();
}

function submitTyped() {
  const text = ui.textAnswer.value;
  if (!text.trim()) return;
  ui.textAnswer.value = '';
  turn?.submitTyped(text);
}

let spaceHeld = false;

async function onKeyDown(e) {
  if (ui.interview?.hidden) return;
  const typing = e.target === ui.textAnswer;
  const result = await turn?.onKey(e.code, { typing });

  if (result?.accepted || result?.rejected) {
    if (e.code === 'Space') spaceHeld = true;
    e.preventDefault();
    return;
  }
  if (result?.startTalk) {
    if (spaceHeld || e.repeat) return;
    spaceHeld = true;
    e.preventDefault();
    turn?.onTalkDown();
    return;
  }
  if (result?.leaveTextLane && typing) {
    e.preventDefault();
    useTextLane();
    return;
  }
  if (result?.cancelled) {
    resetTalkButton();
    return;
  }
  if (result?.useTextLane) { useTextLane(); return; }
  if (typing) return;
  if (result?.ranCommand) e.preventDefault();
}

function onKeyUp(e) {
  if (e.code === 'Space' && spaceHeld) {
    spaceHeld = false;
    e.preventDefault();
    if (audio.isRecording()) onTalkUp(e);
  }
}

function useTextLane() {
  ui.textEntry.hidden = false;
  ui.textAnswer.focus();
  announce(say.TYPING_LANE, true);
}

function resetTalkButton() {
  ui.talk.dataset.recording = 'false';
  ui.talk.textContent = 'Hold to talk';
}

// -- importing a saved file ---------------------------------------------------------

function showSavedSession() {
  const info = importedSession
    ? { savedAt: importedSession.savedAt, imported: true }
    : store.savedSessionInfo();
  if (!info) { ui.resumeRow.hidden = true; return; }
  const when = info.savedAt ? new Date(info.savedAt).toLocaleString() : null;
  let text;
  if (info.imported) {
    text = `Your answers are loaded from your file${when ? `, saved on ${when}` : ''}.`;
  } else {
    text = `You have a saved session from ${when}.`
      + (info.locked
        ? ' It is protected: enter your PIN above, then select Resume.'
        : ' An older version saved it without a PIN. Enter one above to protect it from now on.')
      + ' Your Social Security and bank numbers are never saved, so you will be asked for them again.'
      + ` Saved sessions are deleted after ${Math.round(store.MAX_AGE_MS / 86400000)} days.`;
  }
  ui.resumeText.textContent = text;
  ui.resumeRow.hidden = false;
}

function setImportStatus(text) {
  if (ui.importStatus) ui.importStatus.textContent = text;
}

async function onImportFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setImportStatus('Reading your file\u2026');
  try {
    const { state, savedAt, rebuiltCursor } = await readExportFile(file);
    importedSession = { savedAt, state, withheld: [] };
    showSavedSession();
    const when = savedAt ? new Date(savedAt).toLocaleString() : null;
    const msg = 'Your answers were loaded'
      + (when ? ` from the file you saved on ${when}` : '')
      + '. '
      + (rebuiltCursor
        ? 'That file did not record where you left off, so I will start at the first question you have not answered. '
        : '')
      + 'Choose how you want to answer, and a PIN if you want them saved, then select Resume my saved session.';
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
    event.target.value = '';
  }
}

// -- misc ------------------------------------------------------------------

window.addEventListener('error', e => {
  announce(store.isPersisting()
    ? 'Something went wrong. Your answers are saved on this device.'
    : 'Something went wrong.', true);
  console.error(e.error ?? e.message);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
