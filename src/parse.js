// Local answer parsing, tried before the model.
//
// Most answers on this form are not a judgment call. "Yes", nine spoken
// digits, and "March 14th 1979" have exactly one correct reading, and paying a
// model to produce it adds latency and cost to the most common turns in the
// interview — loop repeats and confirmation read-backs are pure yes/no, and
// they are asked more than anything else.
//
// The contract is deliberately all-or-nothing: parseLocal() returns a result
// it is *certain* of, or null. Null means "ask the model", which is the
// behavior that existed before this file. It never returns a hedge, and it
// never returns a low-confidence guess, because the one thing worse than
// spending a fraction of a cent is writing a wrong Social Security number
// onto a benefits application.
//
// Validation is not repeated here. normalize() in llm.js already enforces
// every type's shape and stays the single place that decides what is
// well-formed; parseLocal() only turns spoken forms into something for it to
// check.

import { matchChoice } from './choice.js';

const YES = /^(y|yes|yeah|yep|yup|sure|correct|right|true|affirmative|ok|okay|that is right|thats right|that's right|uh huh)$/;
const NO = /^(n|no|nope|nah|negative|false|incorrect|wrong|that is wrong|thats wrong|that's wrong|uh uh)$/;

/** Filler that carries no meaning and appears at the head of spoken answers. */
const LEAD_FILLER = /^(um|uh|er|well|so|okay|ok|like|i think|i would say|let me see|hmm)\b[\s,]*/i;

const DIGIT_WORDS = {
  zero: '0', oh: '0', o: '0', naught: '0', nought: '0',
  one: '1', two: '2', three: '3', four: '4', for: '4', five: '5',
  six: '6', seven: '7', eight: '8', ate: '8', nine: '9', niner: '9'
};

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12
};

// -- spoken numbers inside dates -------------------------------------------
//
// Every date question now asks out loud for "the month, then the day, then
// the year", with "March fourteenth, nineteen seventy nine" as the example.
// A user who does exactly that produces words, not digits — and a recognizer
// that transcribes them faithfully used to leave the local parser with
// nothing to work with, so a key-free session could not answer a date at all.
// These tables turn what the prompt asks for back into what the parser reads.

const SMALL_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
};

const TENS_NUMBERS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

/** Ordinals name the day, and the suffix is what tells it apart from a year. */
const ORDINAL_NUMBERS = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13,
  fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30
};

const alt = obj => Object.keys(obj).join('|');

/**
 * Rewrite spoken numbers in a date phrase as digits.
 *
 * Years first, because they are the longer phrases: "nineteen seventy nine"
 * has to become 1979 before "nineteen" and "nine" are read as a day. Only
 * called from the date parsers — elsewhere "two thousand" is money, not a
 * year, and DIGIT_WORDS already handles the digit-at-a-time fields.
 */
function spokenNumbers(text) {
  let s = String(text ?? '');

  // "two thousand five", "two thousand and twelve", "two thousand"
  s = s.replace(
    new RegExp(`\\btwo thousand(?:\\s+and)?(?:\\s+(${alt(TENS_NUMBERS)})(?:[\\s-]+(${alt(SMALL_NUMBERS)}))?|\\s+(${alt(SMALL_NUMBERS)}))?\\b`, 'gi'),
    (_, tens, tensOnes, small) => String(2000
      + (tens ? TENS_NUMBERS[tens.toLowerCase()] : 0)
      + (tensOnes ? SMALL_NUMBERS[tensOnes.toLowerCase()] : 0)
      + (small ? SMALL_NUMBERS[small.toLowerCase()] : 0)));

  // "nineteen oh five", "twenty oh eight"
  s = s.replace(
    new RegExp(`\\b(nineteen|twenty)\\s+(?:oh|o)\\s+(${alt(SMALL_NUMBERS)})\\b`, 'gi'),
    (_, century, ones) => String(
      (century.toLowerCase() === 'nineteen' ? 1900 : 2000) + SMALL_NUMBERS[ones.toLowerCase()]));

  // "nineteen seventy nine", "twenty twenty four", "nineteen eighty"
  s = s.replace(
    new RegExp(`\\b(nineteen|twenty)\\s+(${alt(TENS_NUMBERS)})(?:[\\s-]+(${alt(SMALL_NUMBERS)}))?\\b`, 'gi'),
    (_, century, tens, ones) => String(
      (century.toLowerCase() === 'nineteen' ? 1900 : 2000)
      + TENS_NUMBERS[tens.toLowerCase()]
      + (ones ? SMALL_NUMBERS[ones.toLowerCase()] : 0)));

  // "twenty twelve", "nineteen eighteen"
  s = s.replace(
    new RegExp(`\\b(nineteen|twenty)\\s+(${alt(SMALL_NUMBERS)})\\b`, 'gi'),
    (_, century, rest) => {
      const n = SMALL_NUMBERS[rest.toLowerCase()];
      // Only a two-digit remainder is a year this way. "nineteen five" is not
      // how anyone says 1905, and reading it as one would invent a date.
      if (n < 10) return `${century} ${rest}`;
      return String((century.toLowerCase() === 'nineteen' ? 1900 : 2000) + n);
    });

  // "twenty first", "thirty first" — compound ordinal days.
  s = s.replace(
    new RegExp(`\\b(twenty|thirty)[\\s-]+(${alt(ORDINAL_NUMBERS)})\\b`, 'gi'),
    (whole, tens, ord) => {
      const n = ORDINAL_NUMBERS[ord.toLowerCase()];
      return n < 10 ? `${TENS_NUMBERS[tens.toLowerCase()] + n}th` : whole;
    });

  // "fourteenth" -> "14th". The suffix is kept: parseDate() uses it to tell a
  // day from a two-digit year.
  s = s.replace(new RegExp(`\\b(${alt(ORDINAL_NUMBERS)})\\b`, 'gi'),
    (_, w) => `${ORDINAL_NUMBERS[w.toLowerCase()]}th`);

  // "twenty one" -> "21", then any bare small number.
  s = s.replace(new RegExp(`\\b(${alt(TENS_NUMBERS)})[\\s-]+(${alt(SMALL_NUMBERS)})\\b`, 'gi'),
    (_, tens, ones) => String(TENS_NUMBERS[tens.toLowerCase()] + SMALL_NUMBERS[ones.toLowerCase()]));
  s = s.replace(new RegExp(`\\b(${alt(SMALL_NUMBERS)}|${alt(TENS_NUMBERS)})\\b`, 'gi'),
    (_, w) => String(SMALL_NUMBERS[w.toLowerCase()] ?? TENS_NUMBERS[w.toLowerCase()]));

  return s;
}

/** "Still working there" on an end date. The schema prompts for this wording. */
const PRESENT = /\b(still|ongoing|present|current(ly)?|to this day|up to now|continu\w*)\b/i;

/**
 * Interpret a transcript locally.
 *
 * @returns a result shaped like llm.extract()'s, or null to defer to the model.
 */
export function parseLocal(question, transcript) {
  const raw = String(transcript ?? '').trim();
  if (!raw) return null;

  const value = parseByType(question, raw);
  if (value === null) return null;

  return {
    command: null,
    value: value.value,
    confidence: value.confidence,
    needsClarification: false,
    clarifyPrompt: null
  };
}

function parseByType(question, raw) {
  switch (question.type) {
    case 'yesno': return parseYesNo(raw);
    case 'ssn':
    case 'routing':
    case 'account': return parseSensitiveDigits(raw);
    case 'phone': return parsePhone(raw);
    case 'zip': return parseZip(raw);
    case 'email': return parseEmail(raw);
    case 'choice': return parseChoice(raw, question);
    case 'date': return parseDate(raw, question);
    case 'monthyear': return parseMonthYear(raw, question);
    case 'money':
    case 'number': return parseNumber(raw);
    // Free text is exactly the fuzzy work the model is good at: stripping
    // filler, fixing capitalization, deciding what part of a rambling answer
    // is the answer. Nothing local would do it better.
    default: return null;
  }
}

// -- yes / no --------------------------------------------------------------

function parseYesNo(raw) {
  // Checked against the unstripped text: "uh huh" and "uh uh" begin with a
  // filler word that is part of the answer itself.
  const bare = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
  if (YES.test(bare)) return { value: true, confidence: 1 };
  if (NO.test(bare)) return { value: false, confidence: 1 };

  const s = clean(raw).replace(/[.!?,]+$/, '');

  const yes = YES.test(s);
  const no = NO.test(s);
  if (yes) return { value: true, confidence: 1 };
  if (no) return { value: false, confidence: 1 };

  // Beyond a bare yes or no, defer. A longer utterance next to a yes/no
  // question is usually a correction, a command, or an answer to a different
  // question than the one being asked, and guessing which is exactly the
  // judgment call this file exists to avoid.
  return null;
}

// -- choice ----------------------------------------------------------------

/**
 * One of a question's options, named clearly, or null. The matcher itself
 * lives in choice.js so that normalize() applies exactly the same rules to
 * whatever the model returns.
 */
function parseChoice(raw, question) {
  const option = matchChoice(question.options, raw);
  return option ? { value: option.value, confidence: 1 } : null;
}

// -- digits ----------------------------------------------------------------

/**
 * Social Security, routing, and account numbers.
 *
 * The strictest path in the file, because it is the one where being wrong
 * matters most. The transcript must be digits and nothing else — no stray
 * words, no arithmetic, no shorthand. "double seven" and "seventeen" are
 * ambiguous (77 or 7-7? 1-7 or 17?) and go to the model rather than being
 * resolved by a guess here.
 */
function parseSensitiveDigits(raw) {
  const digits = digitsFrom(raw);
  if (digits === null) return null;
  // normalize() enforces the exact length. Anything it would reject should
  // reach it as a clarification, not be silently dropped here.
  return { value: digits, confidence: 1 };
}

function parsePhone(raw) {
  const digits = digitsFrom(raw);
  if (digits === null) return null;
  // Only the two lengths normalize() accepts. Anything else is as likely to
  // be a misheard answer to a different question as a phone number, and the
  // model gets a chance to say so.
  if (digits.length === 10) return { value: digits, confidence: 1 };
  if (digits.length === 11 && digits.startsWith('1')) return { value: digits, confidence: 1 };
  return null;
}

/**
 * Digits from a transcript, or null if anything ambiguous is present.
 *
 * Accepts written digits, spoken digit words, and the separators people say
 * out loud ("dash", "and"). Rejects any other word, and rejects the
 * multiplier forms that have two readings.
 */
function digitsFrom(raw) {
  let s = clean(raw)
    .replace(/[.,!?]+$/, '')
    .replace(/[-–—()+]/g, ' ')
    .replace(/\bdash\b|\bhyphen\b|\band\b/g, ' ');

  // "double seven" / "triple oh" — no single correct reading. Defer.
  if (/\b(double|triple|twice|thrice)\b/.test(s)) return null;

  const tokens = s.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  let out = '';
  for (const token of tokens) {
    if (/^\d+$/.test(token)) { out += token; continue; }
    const word = DIGIT_WORDS[token];
    if (word === undefined) return null;   // a real word: not a pure digit string
    out += word;
  }
  return out || null;
}

/** A five or nine digit ZIP code, and nothing else. */
function parseZip(raw) {
  const digits = digitsFrom(raw);
  if (digits === null) return null;
  return digits.length === 5 || digits.length === 9 ? { value: digits, confidence: 1 } : null;
}

// -- email -----------------------------------------------------------------

/**
 * Typed addresses, and spoken ones in the only form that has one reading:
 * "jane dot doe at example dot com". Anything with words that are not part of
 * an address defers.
 */
function parseEmail(raw) {
  const s = String(raw ?? '').trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (EMAIL.test(s)) return { value: s, confidence: 1 };
  const spoken = s
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+(underscore)\s+/g, '_')
    .replace(/\s+(dash|hyphen)\s+/g, '-');
  if (/\s/.test(spoken)) return null;
  return EMAIL.test(spoken) ? { value: spoken, confidence: 1 } : null;
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

// -- numbers and money -----------------------------------------------------

function parseNumber(raw) {
  const s = clean(raw)
    .replace(/[.,!?]+$/, '')
    .replace(/\bdollars?\b|\bbucks?\b|\bper month\b|\ba month\b|\bmonthly\b|\bapprox\w*\b|\babout\b|\baround\b/g, ' ')
    .replace(/[$,]/g, '')
    .trim();

  // A range or a list has no single value. "Eight hundred to a thousand" is a
  // question for the user, not a number to pick from.
  if (/\b(to|or|between|and)\b/.test(s)) return null;

  const numeric = s.match(/-?\d+(\.\d+)?/g);
  if (numeric?.length === 1 && /^[\s\d.$-]*$/.test(s)) {
    return { value: Number(numeric[0]), confidence: 1 };
  }
  if (numeric?.length > 1) return null;

  return null;
}

// -- dates -----------------------------------------------------------------

function parseDate(raw, question) {
  const s = spokenNumbers(clean(raw));

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return dated(+m[1], +m[2], +m[3], 1, question);

  // 3/14/79, 03-14-1979
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) return dated(expandYear(+m[3], m[3].length, question), +m[1], +m[2], 1, question);

  // March 14th 1979 · the 14th of March, 1979 · March 14 1979
  const month = findMonth(s);
  if (month === null) return null;
  const matches = [...s.matchAll(/\b(\d{1,4})(st|nd|rd|th)?\b/g)];
  const nums = matches.map(x => x[1]);
  if (nums.length !== 2) return null;

  // The year is whichever number cannot be a day of the month.
  const [a, b] = nums;
  let day, yearRaw;
  if (a.length === 4) { yearRaw = a; day = b; }
  else if (b.length === 4) { yearRaw = b; day = a; }
  else if (+a > 31) { yearRaw = a; day = b; }
  else if (+b > 31) { yearRaw = b; day = a; }
  // "January 1st 05": neither number settles it by size, but the ordinal
  // suffix names the day outright, so the other one is the year.
  else if (matches[0][2] && !matches[1][2]) { day = a; yearRaw = b; }
  else if (matches[1][2] && !matches[0][2]) { day = b; yearRaw = a; }
  else return null;   // "3 14" with no century — ambiguous, defer

  const confidence = yearRaw.length === 4 ? 1 : 0.8;
  return dated(expandYear(+yearRaw, yearRaw.length, question), month, +day, confidence, question);
}

function parseMonthYear(raw, question) {
  const s = spokenNumbers(clean(raw));

  if (PRESENT.test(s) && !/\b(19|20)\d{2}\b/.test(s)) {
    return { value: 'present', confidence: 1 };
  }

  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return monthYear(+m[1], +m[2], 1, question);

  // 3/79, 03/1979
  m = /^(\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) return monthYear(expandYear(+m[2], m[2].length, question), +m[1], m[2].length === 4 ? 1 : 0.8, question);

  const month = findMonth(s);
  if (month === null) return null;
  const nums = [...s.matchAll(/\b(\d{2,4})\b/g)].map(x => x[1]);
  if (nums.length !== 1) return null;

  const yearRaw = nums[0];
  return monthYear(expandYear(+yearRaw, yearRaw.length, question), month, yearRaw.length === 4 ? 1 : 0.8, question);
}

function findMonth(s) {
  for (const [name, n] of Object.entries(MONTHS)) {
    if (new RegExp(`\\b${name}\\b`).test(s)) return n;
  }
  return null;
}

/**
 * Two-digit years.
 *
 * Almost every date these forms ask for is in the past: a birth date, an onset
 * date, a date of treatment or employment. So "79" is 1979 and "05" is 2005 —
 * the most recent past year with those digits. A question that allows future
 * dates (an expected graduation) reads a near-future year as itself, so
 * "June 28" is not taken to mean 1928.
 */
function expandYear(year, digits, question) {
  if (digits === 4) return year;
  const now = new Date().getFullYear();
  const century = Math.floor(now / 100) * 100;
  const candidate = century + year;
  if (candidate <= now) return candidate;
  if (allowsFuture(question) && candidate <= now + 20) return candidate;
  return candidate - 100;
}

function dated(year, month, day, confidence, question) {
  if (!validYmd(year, month, day)) return null;
  if (isFuture(year, month, day) && !allowsFuture(question)) return null;
  const iso = `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  return { value: iso, confidence };
}

function monthYear(year, month, confidence, question) {
  if (!validYmd(year, month, 1)) return null;
  if (isFuture(year, month, 1) && !allowsFuture(question)) return null;
  return { value: `${pad4(year)}-${pad2(month)}`, confidence };
}

/** Rejects February 30 and friends rather than rolling them over silently. */
function validYmd(year, month, day) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= new Date(year, month, 0).getDate();
}

function isFuture(year, month, day) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(year, month - 1, day) > today;
}

/**
 * Most dates on these forms are in the past — a birth, an onset, a visit — so
 * a parse that lands in the future usually means the input was misread, and
 * deferring gives the user a clarification instead of a wrong answer they may
 * never notice. The exceptions (a scheduled test, an expected graduation) say
 * so with `allowFuture`.
 */
function allowsFuture(question) {
  return !!question?.allowFuture;
}

// -- shared ----------------------------------------------------------------

function clean(raw) {
  const s = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  // "okay" and "uh" are filler in "okay, March 14th" but the entire answer in
  // "okay" and "uh huh". Only strip a lead-in when something survives it.
  const stripped = s.replace(LEAD_FILLER, '').trim();
  return stripped ? stripped : s;
}

const pad2 = n => String(n).padStart(2, '0');
const pad4 = n => String(n).padStart(4, '0');
