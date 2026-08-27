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
  const s = clean(raw);

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return dated(+m[1], +m[2], +m[3], 1, question);

  // 3/14/79, 03-14-1979
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) return dated(expandYear(+m[3], m[3].length), +m[1], +m[2], 1, question);

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
  return dated(expandYear(+yearRaw, yearRaw.length), month, +day, confidence, question);
}

function parseMonthYear(raw, question) {
  const s = clean(raw);

  if (PRESENT.test(s) && !/\b(19|20)\d{2}\b/.test(s)) {
    return { value: 'present', confidence: 1 };
  }

  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return monthYear(+m[1], +m[2], 1, question);

  // 3/79, 03/1979
  m = /^(\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) return monthYear(expandYear(+m[2], m[2].length), +m[1], m[2].length === 4 ? 1 : 0.8, question);

  const month = findMonth(s);
  if (month === null) return null;
  const nums = [...s.matchAll(/\b(\d{2,4})\b/g)].map(x => x[1]);
  if (nums.length !== 1) return null;

  const yearRaw = nums[0];
  return monthYear(expandYear(+yearRaw, yearRaw.length), month, yearRaw.length === 4 ? 1 : 0.8, question);
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
 * Every date this form asks for is in the past: a birth date, an onset date, a
 * date of treatment or employment. So "79" is 1979 and "05" is 2005 — the most
 * recent past year with those digits, never a future one.
 */
function expandYear(year, digits) {
  if (digits === 4) return year;
  const now = new Date().getFullYear();
  const century = Math.floor(now / 100) * 100;
  const candidate = century + year;
  return candidate > now ? candidate - 100 : candidate;
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
 * No question on this worksheet asks for a future date, so a parse that lands
 * in the future means the input was misread. Deferring to the model gives the
 * user a clarification instead of a wrong answer they may never notice.
 */
function allowsFuture() {
  return false;
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
