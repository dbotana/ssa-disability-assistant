// A capture with nothing in it must never become an answer.
//
// This is the bug the filter exists for: press and release the space bar
// without speaking, and a transcriber handed room tone does not return an
// empty string — it returns a short, plausible phrase. Recorded as the answer,
// that phrase commits and the form advances past a question the user never
// answered. There is no way back except noticing it on the review screen.
//

// isEmptyTranscript moved to src/turn.js with the turn controller; the peak
// is now a parameter, so each case says how loud the capture actually was.

import { isEmptyTranscript } from '../src/turn.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const empty = (text, level = 0.004) => {
  check(`${JSON.stringify(text)} at peak ${level} is empty`,
    isEmptyTranscript(text, level) === true);
};
const kept = (text, level = 0.004) => {
  check(`${JSON.stringify(text)} at peak ${level} is kept`,
    isEmptyTranscript(text, level) === false);
};

// -- nothing at all, at any level -----------------------------------------

empty('');
empty('   ');
empty(null);
empty(undefined);
empty('...');
empty('.', 0.4);
empty(' -- ', 0.4);
empty('…', 0.4);
empty('"" ', 0.4);

// -- the filler a transcriber invents for silence -------------------------

empty('you');
empty('You.');
empty('Thank you.');
empty('Thanks for watching!');
empty('  Okay ');
empty('um');

// -- the same words, actually spoken, are answers -------------------------
//
// The level is the whole point of the second half of the test. Filler is only
// filler when the microphone stayed at the noise floor for the entire capture;
// a user who says "okay" out loud is heard.

kept('okay', 0.2);
kept('you', 0.2);
kept('Thank you.', 0.2);

// -- ordinary answers are never touched -----------------------------------

kept('March 14th 1979');
kept('no');
kept('yes');
kept('5 5 5 1 2 3 4 5 6 7');
kept('Doctor Alvarez at the clinic on Third Street');
// A real answer that merely starts with a filler word.
kept('okay so it started in about 2019');
kept('yes, that is right');

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('empty-transcript: all checks passed');
