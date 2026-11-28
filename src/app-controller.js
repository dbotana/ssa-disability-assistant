// The app controller: the turn controller plus the screen it drives.
//
// createTurnController emits a bare UI snapshot; the app layer adds the three
// controller-level fields the UI renders but the dialog does not own:
//   controls    which lanes/buttons the screen shows, with translated options
//   exportList  the forms this answer set fills
//   runs        each on-screen string wrapped as a text run with its language
//
// `chooseLanguage` records a per-channel language choice and `start` folds the
// chosen languages over the start options, so a language picked on the setup
// screen reaches the next start. Everything else forwards to the turn.

import { createTurnController } from './turn.js';
import { formsOf } from './schema.js';
import * as defaultI18n from './i18n/index.js';

export function createAppController(ports) {
  const turn = createTurnController(ports);
  const i18n = ports.i18n ?? defaultI18n;
  const chosen = {};

  function uiState() {
    const s = turn.snapshot();
    const screen = s.languages?.screen ?? 'en';
    const q = turn.displayQuestion();
    const run = text => [{ text: text ?? '', lang: screen }];
    // While the intro is spoken the interview screen is up but takes no
    // input, so it shows no controls (turn.js, `starting`).
    const live = s.panel === 'interview' && !s.starting;
    return {
      ...s,
      controls: {
        talk: live && !s.voiceDisabled,
        text: live,
        yes: s.readbackOpen,
        no: s.readbackOpen,
        options: s.starting ? [] : (q?.options ?? []).map(o => ({ value: o.value, label: i18n.translate(o.label, screen) }))
      },
      exportList: [...formsOf(s.answers)],
      runs: {
        questionText: run(s.questionText),
        hintText: run(s.hintText),
        statusText: run(s.statusText),
        sectionLabel: run(s.sectionLabel),
        reviewIntro: run(s.reviewIntro),
        progressText: run(s.progressText)
      }
    };
  }

  function chooseLanguage(channel, lang) {
    chosen[channel] = lang;
  }

  function submitOption(value) {
    return turn.submitTyped(String(value));
  }

  async function start(opts = {}) {
    const langs = { ...(opts.languages ?? {}), ...chosen };
    return turn.start(Object.keys(langs).length ? { ...opts, languages: langs } : opts);
  }

  return { ...turn, snapshot: uiState, chooseLanguage, submitOption, start };
}
