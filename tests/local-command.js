// Spoken navigation words are recognized locally, and real answers are not.
//
// This runs on the voice path now, not just the typed one, so it sees whatever
// the transcriber produced — with hesitation, politeness, and punctuation. Two
// directions matter equally: a missed command costs an API call and lands the
// word in the form as an answer; a false match discards an answer the user
// actually gave.
//
// Makes no API calls.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// main.js drives the DOM at import time, so localCommand is lifted out of the
// source rather than imported. Brittle by nature; the marker comments keep it
// honest, and the extraction failing is itself a test failure.
const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
const start = src.indexOf('const LOCAL_COMMANDS');
const endMarker = '\n}\n';
const end = src.indexOf(endMarker, src.indexOf('function localCommand'));

if (start === -1 || end === -1) {
  console.error('FAIL could not extract localCommand from src/main.js');
  process.exit(1);
}

const localCommand = new Function(
  `${src.slice(start, end + endMarker.length)}\nreturn localCommand;`
)();

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const hit = (text, cmd) => check(`${JSON.stringify(text)} -> ${cmd}`,
  localCommand(text) === cmd, `got ${JSON.stringify(localCommand(text))}`);

const miss = text => check(`${JSON.stringify(text)} is not a command`,
  localCommand(text) === null, `got ${JSON.stringify(localCommand(text))}`);

// -- the bare forms still work --------------------------------------------

hit('repeat', 'repeat');
hit('go back', 'back');
hit('skip', 'skip');
hit('where am i', 'where');
hit('read back my answers', 'readback');
hit('change an answer', 'correct');
hit('save and quit', 'save_quit');
hit('start over', 'restart');
hit('help', 'help');
hit('finish', 'finish');

// -- case and punctuation from a transcriber ------------------------------

hit('Repeat.', 'repeat');
hit('Go back!', 'back');
hit('SKIP', 'skip');
hit('Where am I?', 'where');

// -- spoken hesitation and politeness -------------------------------------

hit('uh, go back', 'back');
hit('um skip this', 'skip');
hit('can you repeat that', 'repeat');
hit('could you say that again', 'repeat');
hit('please go back', 'back');
hit('go back please', 'back');
hit('ok, can you please repeat that', 'repeat');
hit('okay skip this please', 'skip');
hit('i want to start over', 'restart');
hit('where am i now', 'where');
hit('help please', 'help');
hit('one more time', 'repeat');
hit('skip it', 'skip');
hit('leave it blank', 'skip');
hit('i am done', 'finish');

// -- real answers must never be swallowed ---------------------------------
//
// Every one of these is a plausible answer to a question this form asks. A
// false match here throws away what the user said.

miss('I skip meals because of the nausea');
miss('my back hurts');
miss('back pain');
miss('lower back injury');
miss('I have chronic back pain and cannot stand for long');
miss('Dr. Back');
miss('I want to change my medication');
miss('they changed my dosage');
miss('I had to quit my job');
miss('I quit in March');
miss('save the receipts');
miss('I help my mother with groceries');
miss('progress notes from the clinic');
miss('review of systems');
miss('I was done with school in 1998');
miss('done with treatment');
miss('pass out sometimes');
miss('I pass out when I stand up too fast');
miss('my previous employer');
miss('the next appointment is in June');

// Plain answers that share no vocabulary with the command list.
miss('yes');
miss('no');
miss('123456789');
miss('March 14th 1979');
miss('John Smith');
miss('diabetes');
miss('');
miss('   ');

console.log(failures === 0 ? 'local-command: all checks passed' : `local-command: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
