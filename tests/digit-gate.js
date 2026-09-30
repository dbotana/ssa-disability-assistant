// The gate that decides whether a digit transcript is worth reading back.
//
// Nobody says nine digits in one breath, and a capture that ended after the
// first pause holds "555" — a clean, parseable number that is a third of an
// SSN. main.js asks again instead of reading that back, and decides using the
// same two pure functions it is built from here: parseLocal() and
// normalize(). A digit string normalize() would reject must not be trusted.
//
// Ported from upstream's stt-gate.js, where the same rule decided whether to
// pay for a second transcription. Makes no network requests.

import { parseLocal } from '../src/parse.js';
import { normalize } from '../src/validate.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const survives = (question, transcript) => {
  const local = parseLocal(question, transcript);
  return !!local && !normalize(local, question).needsClarification;
};

{
  const ssn = { id: 'ssn', type: 'ssn' };
  check('a truncated SSN is not trusted', !survives(ssn, 'five five five'));
  check('and neither is one digit short', !survives(ssn, '5 5 5 1 1 2 2 3'));
  check('a full SSN is trusted', survives(ssn, 'five five five one one two two three three'));
  // What Whisper actually returns for a grouped SSN.
  check('a hyphenated SSN is trusted', survives(ssn, '987-65-4321'));
  check('an SSN split oddly by the transcriber is trusted', survives(ssn, '987 6 5 4329'));

  const phone = { id: 'p', type: 'phone' };
  check('a truncated phone number is not trusted', !survives(phone, 'five five five'));
  check('a full phone number is trusted', survives(phone, '5551112222'));
  check('a phone number with a country code is trusted', survives(phone, '1 5 5 5 1 1 1 2 2 2 2'));
  check('a hyphenated phone number is trusted', survives(phone, '207-555-0142'));

  const routing = { id: 'r', type: 'routing' };
  check('a truncated routing number is not trusted', !survives(routing, 'one two three'));
  check('a full routing number is trusted', survives(routing, '123456789'));
}

console.log(failures === 0 ? 'digit-gate: all checks passed' : `digit-gate: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
