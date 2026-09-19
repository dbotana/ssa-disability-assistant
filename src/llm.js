// OpenAI calls, made directly from the browser with the user's own key.
//
// Design note: the model does NOT conduct the interview. engine.js owns all
// control flow, and the model does exactly one narrow job per turn — turn a
// spoken transcript into a typed value for a single known question. A chat
// agent handed the whole script drifts, invents follow-ups, silently skips
// questions, and leaves nowhere to hook validation. None of that is acceptable
// when the output is a benefits application.

import { getApiKey } from './store.js';
import { matchChoice, optionsSentence } from './choice.js';

const BASE = 'https://api.openai.com/v1';

const MODELS = {
  transcribe: 'gpt-4o-transcribe',
  extract: 'gpt-4o-mini',
  tts: 'gpt-4o-mini-tts'
};

export class LlmError extends Error {
  constructor(message, { kind = 'unknown', status = 0, retryAfter = 0 } = {}) {
    super(message);
    this.kind = kind;           // auth | rate | network | server | empty | unknown
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function classify(status, body) {
  if (status === 401 || status === 403) {
    return new LlmError('Your API key was rejected.', { kind: 'auth', status });
  }
  if (status === 429) {
    return new LlmError('Too many requests right now.', { kind: 'rate', status });
  }
  if (status >= 500) {
    return new LlmError('OpenAI had a server error.', { kind: 'server', status });
  }
  const detail = body?.error?.message ? ` ${body.error.message}` : '';
  return new LlmError(`Request failed.${detail}`, { kind: 'unknown', status });
}

async function request(path, init, { retries = 2 } = {}) {
  const key = getApiKey();
  if (!key) throw new LlmError('No API key is set.', { kind: 'auth' });

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, ...(init.headers || {}) }
      });
    } catch {
      lastError = new LlmError('Could not reach OpenAI. You may be offline.', { kind: 'network' });
      if (attempt < retries) { await sleep(400 * 2 ** attempt); continue; }
      throw lastError;
    }

    if (res.ok) return res;

    let body = null;
    try { body = await res.clone().json(); } catch { /* not json */ }
    const err = classify(res.status, body);

    // Auth failures never get better by retrying.
    if (err.kind === 'auth' || attempt === retries) throw err;
    if (err.kind === 'rate' || err.kind === 'server') {
      const hinted = Number(res.headers.get('retry-after')) * 1000;
      await sleep(hinted || 700 * 2 ** attempt);
      lastError = err;
      continue;
    }
    throw err;
  }
  throw lastError ?? new LlmError('Request failed.', {});
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// -- transcription ---------------------------------------------------------

/** File extension the API will accept for a given recorder mime type. */
function extensionFor(mime) {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg')) return 'mp3';
  return 'webm';
}

/**
 * Speech to text. The `prompt` hint carries what kind of answer is expected,
 * which measurably improves digit strings and proper nouns.
 */
export async function transcribe(blob, { hint = '' } = {}) {
  const form = new FormData();
  form.append('file', blob, `speech.${extensionFor(blob.type)}`);
  form.append('model', MODELS.transcribe);
  form.append('response_format', 'text');
  if (hint) form.append('prompt', hint);

  const res = await request('/audio/transcriptions', { method: 'POST', body: form });
  const text = (await res.text()).trim();
  if (!text) throw new LlmError('I did not hear anything.', { kind: 'empty' });
  return text;
}

/** Transcription hints, per question type. */
export function hintFor(question) {
  const base = 'This is an answer to a question on a disability application form.';
  switch (question.type) {
    case 'ssn':
    case 'routing':
    case 'account':
      return `${base} The answer is a string of digits, possibly spoken one digit at a time.`;
    case 'phone':
      return `${base} The answer is a ten digit US phone number.`;
    case 'zip':
      return `${base} The answer is a five digit US ZIP code.`;
    case 'email':
      return `${base} The answer is an email address, possibly spoken with "at" and "dot".`;
    case 'choice':
      return `${base} The answer is one of: ${optionsSentence(question.options)}.`;
    case 'date':
    case 'monthyear':
      return `${base} The answer is a date, such as March 14th 1979.`;
    case 'money':
      return `${base} The answer is a dollar amount.`;
    case 'yesno':
      return `${base} The answer is yes or no.`;
    default:
      return `${base} Question: ${question.prompt}`;
  }
}

// -- structured extraction -------------------------------------------------

export const COMMANDS = [
  'repeat', 'back', 'skip', 'where', 'readback', 'correct', 'restart', 'save_quit', 'help', 'clear_data'
];

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: ['string', 'null'], enum: [...COMMANDS, null] },
    value: { type: ['string', 'boolean', 'number', 'null'] },
    confidence: { type: 'number' },
    needsClarification: { type: 'boolean' },
    clarifyPrompt: { type: ['string', 'null'] }
  },
  required: ['command', 'value', 'confidence', 'needsClarification', 'clarifyPrompt']
};

/** Type-specific normalization rules. Only the relevant line is sent. */
const TYPE_RULES = {
  date: '- Return the date as YYYY-MM-DD.',
  monthyear: '- Return the month as YYYY-MM. If the user says "still working", "still seeing them",\n  "ongoing", or "present" for an end date, return the string "present".',
  ssn: '- Return digits only, no spaces or dashes.',
  routing: '- Return digits only, no spaces or dashes.',
  account: '- Return digits only, no spaces or dashes.',
  phone: '- Return exactly 10 digits, no formatting.',
  zip: '- Return the 5 or 9 digit ZIP code, digits only.',
  email: '- Return the email address in lowercase with no spaces. Spoken "at" is @ and "dot" is a period.',
  yesno: '- Return boolean true or false.',
  money: '- Return a plain number, no currency symbol or commas.',
  number: '- Return a plain number, no currency symbol or commas.',
  text: '- Return the answer only, cleaned of filler words, with proper capitalization.'
};

const SENSITIVE = new Set(['ssn', 'routing', 'account']);

/** The one normalization rule for this question. Choices list their values. */
function ruleFor(question) {
  if (question.type === 'choice' && Array.isArray(question.options)) {
    const allowed = question.options.map(o => `"${o.value}" (${o.label})`).join(', ');
    return `- Return exactly one of these values: ${allowed}. If the answer does not clearly pick one, set needsClarification.`;
  }
  return TYPE_RULES[question.type] ?? TYPE_RULES.text;
}

/**
 * The instruction for one turn.
 *
 * Deliberately short. Every call re-sends this in full — there is no
 * conversation to amortize it against, and at a few hundred tokens it sits
 * well under the 1024-token minimum for automatic prompt caching, so length
 * here is a cost paid on every single turn with nothing reclaiming it.
 * Shipping the other ten types' rules on a question that has one type was the
 * bulk of it.
 *
 * Note for anyone who later tries to make this cacheable: the interpolated
 * question would have to move to the very end. A prefix that changes per call
 * is a prefix that never matches.
 */
function systemPrompt(question) {
  const lines = [
    'Extract the answer to one question on a disability application form. Return JSON only.',
    '',
    `Question: ${question.prompt}`,
    `Expected type: ${question.type}`,
    '',
    ruleFor(question),
    '',
    'Set confidence between 0 and 1. Set needsClarification true when the transcript is',
    'empty, off topic, ambiguous, or is not an answer of the expected type, and write a',
    'short spoken clarifyPrompt asking for exactly what is missing.'
  ];

  if (SENSITIVE.has(question.type)) {
    lines.push(
      'Never guess: if the digits are incomplete or unclear, set needsClarification',
      'rather than returning a value.'
    );
  }

  // Navigation words are matched locally before this is ever called, so the
  // full vocabulary does not need explaining — only the fact that a command
  // is possible, for the phrasings the local matcher does not cover.
  lines.push(
    '',
    `If the transcript is a navigation request rather than an answer, set command to one of: ${COMMANDS.join(', ')}, and set value to null.`
  );

  return lines.join('\n');
}

/**
 * Interpret one transcript for one question.
 * @returns {{command:string|null, value:*, confidence:number,
 *            needsClarification:boolean, clarifyPrompt:string|null}}
 */
export async function extract(question, transcript) {
  const res = await request('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELS.extract,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt(question) },
        { role: 'user', content: transcript }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: EXTRACT_SCHEMA }
      }
    })
  });

  const body = await res.json();
  const raw = body?.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { command: null, value: null, confidence: 0, needsClarification: true,
      clarifyPrompt: 'Sorry, I did not understand that. Could you say it again?' };
  }
  return normalize(parsed, question);
}

/**
 * Defense in depth. The model is instructed to normalize, but a malformed value
 * reaching the worksheet is worse than a re-ask, so every typed field is
 * validated locally too.
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
      // The model is told the exact values, but a label or a paraphrase coming
      // back is still mapped the same way a spoken answer would be.
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
      const n = Number(String(out.value).replace(/[^0-9.\-]/g, ''));
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

// -- text to speech --------------------------------------------------------

/** Synthesize speech. Returns an ArrayBuffer of MP3 audio. */
export async function synthesize(text, { voice = 'alloy' } = {}) {
  const res = await request('/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODELS.tts,
      voice,
      input: text,
      response_format: 'mp3',
      instructions: 'Speak clearly and unhurriedly, in a warm and patient tone, as if helping someone fill out an important government form.'
    })
  }, { retries: 1 });
  return res.arrayBuffer();
}

/** Cheap credential check used at setup, so a bad key fails before the interview. */
export async function verifyKey() {
  try {
    await request('/models', { method: 'GET' }, { retries: 0 });
    return { ok: true };
  } catch (err) {
    return { ok: false, kind: err.kind, message: err.message };
  }
}
