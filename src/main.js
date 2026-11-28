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
import {
  CHANNELS, LANGUAGES, UI, loadSettings, saveSettings, normalizeSettings,
  translate, message, sttFor
} from './i18n/index.js';
import { applyUi } from './i18n/dom.js';

const el = id => document.getElementById(id);

const ui = {};
let turn = null;
let languages = loadSettings();
// A session read from an imported file, held in memory only until the
// resume it sets up. It may hold sensitive answers; it is never written to
// storage as it is.
let importedSession = null;       // { savedAt, state, withheld }

// -- languages -------------------------------------------------------------

/** Show the saved choice in each of the four selects. */
function syncLanguageSelects() {
  for (const channel of CHANNELS) {
    const select = el(`lang-${channel}`);
    if (select) select.value = languages[channel];
  }
}

/**
 * A channel changed. Save it, then repaint the page in the screen language
 * (the speech-model note depends on the input language too). The interview
 * reads `languages` when it starts, so this is only useful on the setup panel.
 */
function onLanguageChange(event) {
  const channel = event.target?.id?.replace(/^lang-/, '');
  if (!CHANNELS.includes(channel)) return;
  languages = normalizeSettings({ ...languages, [channel]: event.target.value });
  saveSettings(languages);
  applyUi(document, languages.screen, languages.input);
  syncLanguageSelects();
}

/** The screen language, for text this browser adapter writes itself. */
const uiLang = () => languages.screen;
const spokenLang = () => languages.output;
const uiMessage = (key, vars) => message(key, vars, uiLang());
const spokenMessage = (key, vars) => message(key, vars, spokenLang());

// -- boot ------------------------------------------------------------------

function boot() {
  applyUi(document, languages.screen, languages.input);
  syncLanguageSelects();
  initA11y();
  // Warm the pre-synthesized clip index before the first question. Only
  // English has a clip pack; other languages use an on-device voice, and
  // speech.js fetches the manifest the first time English is spoken.
  if (languages.output === 'en') speech.loadManifest();
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
    showSensitive: el('show-sensitive'),
    commandButtons: [...document.querySelectorAll('#interview-panel [data-command]')]
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
    announce(spokenMessage('discard_announce'), true);
  });
  ui.importFile?.addEventListener('change', onImportFile);

  for (const channel of CHANNELS) {
    el(`lang-${channel}`)?.addEventListener('change', onLanguageChange);
  }

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
    announce(spokenMessage('saved_file_announce'), true);
  });
  el('clear-data').addEventListener('click', () => {
    turn?.clearEverything();
    importedSession = null;
    if (ui.importFile) ui.importFile.value = '';
    setImportStatus('');
    ui.resumeRow.hidden = true;
  });
  el('read-back').addEventListener('click', () => {
    const lang = turn.snapshot().languages?.output ?? spokenLang();
    speech.speak(summaryText(turn.snapshot().answers, { lang }), { lang });
  });
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
    onExport: async ({ forms, answers, languages: chosen }) => {
      const screen = chosen?.screen ?? uiLang();
      const fill = chosen?.fill ?? languages.fill;
      for (const id of forms) {
        setStatus(message('filling_form', {
          form: translate(FORM_TITLES[id], screen)
        }, screen));
        await downloadForm(id, answers, { lang: fill });
      }
    },
    onReadBack: async answers => {
      const lang = turn.snapshot().languages?.output ?? spokenLang();
      speech.speak(summaryText(answers, { lang }), { lang });
    }
  });
  return turn;
}

/** Render the controller's snapshot onto the page. */
function render(s) {
  ui.setup.hidden = s.panel !== 'setup';
  ui.interview.hidden = s.panel !== 'interview';
  ui.review.hidden = s.panel !== 'review';
  // While the intro is spoken the interview panel is up but takes no input
  // (turn.js, `starting`), so its controls stay hidden until the question.
  ui.textEntry.hidden = s.starting;
  ui.talk.hidden = s.voiceDisabled || s.starting;
  for (const b of ui.commandButtons) b.disabled = s.starting;

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
    renderSummary(ui.summary, s.answers, {
      reveal: s.revealSensitive,
      lang: s.languages?.screen ?? uiLang()
    });
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
    const msg = err instanceof store.StoreError ? err.message : uiMessage('session_open_failed');
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
      const msg = uiMessage(err.kind === 'denied' ? 'mic_blocked' : 'no_mic');
      announce(msg, true);
      makeTurn(saved);
      await turn.start({
        mode: 'text', confirm: confirmEachAnswer, reveal: revealSensitive, saved, languages
      });
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
  await turn.start({ mode, confirm: confirmEachAnswer, reveal: revealSensitive, saved, languages });
  turn.setConfirmEachAnswer(confirmEachAnswer);
}

/**
 * Open the session this interview continues, and set up how it is saved.
 * Throws StoreError with a message meant for the user.
 */
async function openSession(resume, pin) {
  if (pin && pin.length < store.MIN_PIN_LENGTH) {
    throw new store.StoreError(
      uiMessage('pin_too_short', { count: store.MIN_PIN_LENGTH }), 'pin');
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
        throw new store.StoreError(uiMessage('saved_protected'), 'pin');
      }
      setSetupStatus(uiMessage('opening_saved'));
      return store.unlock(pin);
    }
    saved = store.takeLegacy();
  } else {
    importedSession = null;
    store.clearState();
  }
  if (pin) {
    setSetupStatus(uiMessage('protecting_answers'));
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
  show(uiMessage('loading_model'));
  announce(spokenMessage('loading_model_announce'), true);
  let lastPct = -1;
  let showing = true;
  return localstt.load(({ file, loaded, total }) => {
    if (!total || !/\.onnx$/.test(file ?? '')) return;
    const pct = Math.floor((loaded / total) * 10) * 10;
    if (pct !== lastPct) {
      lastPct = pct;
      show(uiMessage('loading_model_pct', { percent: pct }));
    }
  }, languages.input).finally(() => {
    if (showing) setStatus('');
    showing = false;
    if (ui.setupStatus) ui.setupStatus.textContent = '';
  });
}

function speechModelFailed() {
  const msg = uiMessage('speech_model_failed');
  setStatus(msg);
  announce(msg, true);
  turn?.disableVoice();
}

// -- input: voice, typing, keys -----------------------------------------------------

function onTalkDown(e) {
  e?.preventDefault();
  if (!ui.talk.hidden) {
    ui.talk.dataset.recording = 'true';
    ui.talk.textContent = uiMessage('listening_release');
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
  announce(translate(say.TYPING_LANE, spokenLang()), true);
}

function resetTalkButton() {
  ui.talk.dataset.recording = 'false';
  ui.talk.textContent = translate(UI['interview.talk'], uiLang());
}

// -- importing a saved file ---------------------------------------------------------

function showSavedSession() {
  const info = importedSession
    ? { savedAt: importedSession.savedAt, imported: true }
    : store.savedSessionInfo();
  if (!info) { ui.resumeRow.hidden = true; return; }
  const when = info.savedAt ? new Date(info.savedAt).toLocaleString() : null;
  const lang = uiLang();
  let text;
  if (info.imported) {
    text = message('loaded_from_file', {
      when: when ? message('saved_on', { when }, lang) : ''
    }, lang);
  } else {
    text = message('saved_session_from', { when }, lang)
      + message(info.locked ? 'saved_locked' : 'saved_legacy', {}, lang)
      + message('saved_sensitive', {}, lang)
      + message('saved_expiry', { days: Math.round(store.MAX_AGE_MS / 86400000) }, lang);
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
  setImportStatus(uiMessage('import_reading'));
  try {
    const { state, savedAt, rebuiltCursor } = await readExportFile(file);
    importedSession = { savedAt, state, withheld: [] };
    showSavedSession();
    const lang = uiLang();
    const when = savedAt ? new Date(savedAt).toLocaleString() : null;
    const msg = message('import_loaded', {
      when: when ? message('import_loaded_when', { when }, lang) : '',
      cursor: rebuiltCursor ? message('import_cursor', {}, lang) : ''
    }, lang);
    setImportStatus(msg);
    announce(msg, true);
    ui.resume.focus();
  } catch (err) {
    const msg = err instanceof ImportError ? err.message : uiMessage('import_failed');
    setImportStatus(msg);
    announce(msg, true);
  } finally {
    event.target.value = '';
  }
}

// -- misc ------------------------------------------------------------------

window.addEventListener('error', e => {
  announce(spokenMessage(store.isPersisting() ? 'error_saved' : 'error_plain'), true);
  console.error(e.error ?? e.message);
});

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
