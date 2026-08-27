// Every fixed string the app speaks.
//
// These live here rather than inline at their call sites for one reason:
// tools/build-audio.mjs pre-synthesizes them, and a string that exists in two
// places will eventually differ in one of them. A drifted copy does not fail
// loudly — it just misses the audio cache forever and quietly bills the user
// for speech that is already on disk. One definition, imported by both.
//
// Anything containing a user's answer belongs at its call site instead; it is
// synthesized at runtime and cached per-listener.

export const INTRO = {
  text: 'Typing mode. I will ask a question, you type the answer and press Enter. You can type skip, back, or repeat at any time.',
  handsfree: 'Hands free mode. I will ask a question, then start listening on my own. Just answer when you hear the tone. Say repeat, go back, or skip at any time.',
  voice: 'Voice mode. Hold the space bar while you answer, and let go when you are done. Say repeat, go back, or skip at any time.'
};

export const SAVED = 'Saved. You can close this page and come back to finish later.';
export const STARTING_OVER = 'Starting over.';
export const DOWNLOADED = 'Your worksheet has been downloaded. Check your downloads folder.';
export const ALL_DONE = 'All done. Your worksheet is ready to download.';
export const DOWNLOAD_HINT = 'Press the download button to save your PDF worksheet, or press read my answers to hear everything back.';

export const HELP = 'You can say: repeat that, go back, skip this, where am I, '
  + 'read back my answers, change an answer, remove an entry, save and quit, or start over.';

export const WHICH_FIELD = 'Which answer would you like to change? You can name the field, '
  + 'for example, my phone number, or the second provider\'s address. '
  + 'You can also remove a whole entry, by saying something like '
  + 'remove that last provider. Say never mind to go back.';

export const UNCHANGED = 'That answer was left unchanged.';

// Reask and clarification prompts. The model can author its own clarifyPrompt,
// which is dynamic and synthesized at runtime; these are the fixed fallbacks
// used when it does not, and they are by far the common case.
export const REASK = {
  generic: 'I did not catch that. Could you say it again?',
  yesno: 'Please answer yes or no. Is that correct?',
  nothingHeard: 'I did not hear anything. Please try again, or say skip.',
  notRight: 'That does not look right. Could you try again?',
  unsure: 'I am not sure I heard that correctly. Could you say it again?'
};

// Spoken recovery for each LlmError kind. Keyed to match err.kind.
export const ERRORS = {
  auth: 'Your API key was rejected. Reload the page and enter a valid key, or continue in typing mode.',
  rate: 'OpenAI is rate limiting the request. Give it a moment and try again.',
  network: 'I cannot reach OpenAI right now. Check your connection and try again.',
  server: 'OpenAI had a server error. Please try that answer again.',
  empty: 'I did not hear anything. Please try again, or say skip.',
  unknown: 'Something went wrong. Please try that answer again.'
};

export const LET_US_TRY_AGAIN = 'Let us try again.';
export const GOING_BACK = 'Going back.';
export const FILL_IN_MISSING = 'Let us fill in what is missing.';

/**
 * Every fixed string, flattened. The build script walks this; nothing else
 * should need it.
 */
export function allPhrases() {
  return [
    ...Object.values(INTRO),
    SAVED, STARTING_OVER, DOWNLOADED, ALL_DONE, DOWNLOAD_HINT,
    HELP, WHICH_FIELD, UNCHANGED,
    ...Object.values(REASK),
    ...Object.values(ERRORS),
    LET_US_TRY_AGAIN, GOING_BACK, FILL_IN_MISSING
  ];
}
