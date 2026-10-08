// Local validation of a parsed answer. Nothing in this file touches the
// network.
//
// Upstream, this module also made the OpenAI calls — transcription, answer
// extraction and speech synthesis. This fork has no model on the other end of
// a wire: speech is transcribed on the device (localstt.js) and answers are
// read by the local parser (parse.js). What is left is the part that was
// always local: the single place that decides whether a value is well formed
// enough to write onto a benefits application.

import { matchChoice, optionsSentence } from './choice.js';

/**
 * The last check before a value is kept. parseLocal() produces a candidate;
 * this decides whether it is well formed, because a malformed value reaching
 * the form is worse than a re-ask.
 */
export function normalize(result, question) {
  const out = {
    command: result.command ?? null,
    value: result.value ?? null,
    confidence: typeof result.confidence === 'number' ? result.confidence : 0,
    needsClarification: !!result.needsClarification,
    clarifyPrompt: result.clarifyPrompt ?? null
  };
  if (out.command) { out.value = null; return out; }
  if (out.value == null || out.value === '') {
    out.needsClarification = true;
    return out;
  }

  const digits = String(out.value).replace(/\D/g, '');
  const fail = msg => {
    out.needsClarification = true;
    out.clarifyPrompt = out.clarifyPrompt || msg;
    out.value = null;
  };

  switch (question.type) {
    case 'yesno':
      if (typeof out.value !== 'boolean') {
        const s = String(out.value).trim().toLowerCase();
        if (/^(yes|yeah|yep|correct|right|true)$/.test(s)) out.value = true;
        else if (/^(no|nope|nah|false)$/.test(s)) out.value = false;
        else fail('Please answer yes or no.');
      }
      break;
    case 'ssn':
      if (digits.length !== 9) fail('I need all nine digits of the Social Security number. You can say them one at a time.');
      else out.value = digits;
      break;
    case 'routing':
      if (digits.length !== 9) fail('A routing number has nine digits. You can say them one at a time.');
      else out.value = digits;
      break;
    case 'account':
      if (digits.length < 4) fail('I did not get the full account number. You can say the digits one at a time.');
      else out.value = digits;
      break;
    case 'phone':
      if (digits.length === 11 && digits.startsWith('1')) out.value = digits.slice(1);
      else if (digits.length !== 10) fail('I need a ten digit phone number, including the area code.');
      else out.value = digits;
      break;
    case 'zip':
      if (digits.length !== 5 && digits.length !== 9) fail('A zip code has five digits. You can say them one at a time.');
      else out.value = digits;
      break;
    case 'email': {
      const email = String(out.value).trim().toLowerCase().replace(/\s+/g, '');
      if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) {
        fail('I did not get a complete email address. You can spell it out, or say skip.');
      } else out.value = email;
      break;
    }
    case 'choice': {
      // A label or a paraphrase is mapped the same way a spoken answer would
      // be, so what is stored is always one of the option values.
      const option = matchChoice(question.options, String(out.value));
      if (!option) fail(`Please choose one: ${optionsSentence(question.options)}.`);
      else out.value = option.value;
      break;
    }
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(out.value))) fail('Could you give me the month, day, and year?');
      break;
    case 'monthyear':
      if (String(out.value).toLowerCase() === 'present') out.value = 'present';
      else if (!/^\d{4}-\d{2}$/.test(String(out.value))) fail('Could you give me the month and the year?');
      break;
    case 'money':
    case 'number': {
      // Number('') is 0, so a typed "a few" or "none" — nothing numeric in it
      // at all — would otherwise be committed as zero.
      const numeric = String(out.value).replace(/[^0-9.\-]/g, '');
      const n = /\d/.test(numeric) ? Number(numeric) : NaN;
      if (!Number.isFinite(n)) fail('Could you say that as a number?');
      else out.value = n;
      break;
    }
    default:
      out.value = String(out.value).trim();
      if (!out.value) fail('I did not catch that. Could you say it again?');
  }

  // A low-confidence read on a sensitive field is a re-ask, not a guess.
  if (!out.needsClarification && out.confidence < 0.5 && question.confirm) {
    out.needsClarification = true;
    out.clarifyPrompt = out.clarifyPrompt || 'I am not sure I heard that correctly. Could you say it again?';
  }
  return out;
}
