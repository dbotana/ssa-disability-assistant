// A capture with nothing in it must never become an answer.
//
// This is the bug the filter exists for: press and release the space bar
// without speaking, and a transcriber handed room tone does not return an
// empty string — it returns a short, plausible phrase. Recorded as the answer,
// that phrase commits and the form advances past a question the user never
// answered. There is no way back except noticing it on the review screen.
//
// main.js drives the DOM at import time, so isEmptyTranscript is lifted out of
// the source the same way tests/local-command.js lifts localCommand. Brittle
// by nature; the extraction failing is itself a test failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');

const start = src.indexOf('// What a transcriber tends to emit');
const endMarker = '\n}\n';
const end = src.indexOf(endMarker, src.indexOf('function isEmptyTranscript'));

if (start === -1 || end === -1) {
  console.error('FAIL could not extract isEmptyTranscript from src/main.js');
  process.exit(1);
}

// The real one reads the microphone through the audio module; the stub lets
// each case say how loud the capture actually was.
let peak = 0;
const isEmptyTranscript = new Function(
  'audio',
  `${src.slice(start, end + endMarker.length)}\nreturn isEmptyTranscript;`
)({ lastCapturePeak: () => peak });

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const empty = (text, level = 0.004) => {
  peak = level;
  check(`${JSON.stringify(text)} at peak ${level} is empty`,
    isEmptyTranscript(text) === true);
};
const kept = (text, level = 0.004) => {
  peak = level;
  check(`${JSON.stringify(text)} at peak ${level} is kept`,
    isEmptyTranscript(text) === false);
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
