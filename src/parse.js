// Local answer parsing. In this fork it is the only parsing there is.
//
// Upstream tried this first and sent anything it was unsure of to a language
// model. Here nothing leaves the device, so there is no model to defer to:
// what this file cannot read with certainty is asked again, with the
// question's own hint about the shape it wants.
//
// The contract is still all-or-nothing: parseLocal() returns a result it is
// *certain* of, or null, and null means "ask again". It never returns a
// hedge, and it never returns a low-confidence guess, because the one thing
// worse than a second question is a wrong Social Security number on a
// benefits application.
//
// Free text is the exception, because there is nothing to be certain *of*:
// the answer is the words. parseText() only strips what a transcript wraps
// around them. The user hears it read back before it is kept.
//
// Validation is not repeated here. normalize() in validate.js enforces every
// type's shape and stays the single place that decides what is well-formed;
// parseLocal() only turns spoken forms into something for it to check.

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

// The clock. Injected, never read from Date directly: golden fixtures pin
// Dec 31, Jan 1 and Feb 29, which a live clock could never produce twice.
const defaultNow = () => new Date();

/**
 * Interpret a transcript locally.
 *
 * `typed` is for text the user typed rather than spoke. Free text is then
 * left alone (null here, and the caller keeps it as written): parseText()
 * cleans up what a transcriber wraps around speech, and applied to typed
 * text it rewrites the user's own capitals and full stops — "de la Cruz",
 * "iPhone", "Jr." — on a form where names have to be exact.
 *
 * `now` supplies the current date (expandYear's century window and the
 * future-date check); it defaults to the real clock and is overridden by
 * tests and the golden generator.
 *
 * @returns {{command:null, value:*, confidence:number, needsClarification:false,
 *            clarifyPrompt:null}|null} null when the answer should be asked again.
 */
export function parseLocal(question, transcript, { typed = false, now = defaultNow } = {}) {
  const raw = String(transcript ?? '').trim();
  if (!raw) return null;

  const value = parseByType(question, raw, typed, now);
  if (value === null) return null;

  return {
    command: null,
    value: value.value,
    confidence: value.confidence,
    needsClarification: false,
    clarifyPrompt: null
  };
}

function parseByType(question, raw, typed, now) {
  // A speaker echoes the question back: "My date of birth is March 14th,
  // 1979." The echo carries no information and must not become part of the
  // answer. Typed free text is exempt — it is taken exactly as written, and
  // the default branch below returns null for it — but a structured answer
  // typed with an echo still parses.
  //
  // That includes the sensitive digits, deliberately: "My Social Security
  // number is 123 45 6789" parses, where "my social is 123 45 6789" (no
  // echo, just a real word in front) still defers. The echo is the
  // question's own words, so nothing the user said is being guessed at, and
  // the digit-by-digit read-back still stands between the parse and the form.
  const s = stripEcho(raw, question);
  switch (question.type) {
    case 'yesno': return parseYesNo(s);
    case 'ssn':
    case 'routing':
    case 'account': return parseSensitiveDigits(s);
    case 'phone': return parsePhone(s);
    case 'zip': return parseZip(s);
    case 'email': return parseEmail(s);
    case 'choice': return parseChoice(s, question);
    case 'date': return parseDate(s, question, now);
    case 'monthyear': return parseMonthYear(s, question, now);
    case 'money':
    case 'number': return parseNumber(s, question);
    default: return typed ? null : parseText(s);
  }
}

/**
 * Strip a leading clause that echoes the question.
 *
 * "What is your date of birth?" prompts "my date of birth is …" back, and
 * that lead-in used to become the answer itself. The subject of the prompt
 * (between the question word and any trailing clause), with "your" read as
 * "my", is matched at the head of the transcript followed by a copula, and
 * removed. Nothing is stripped unless a clear "X is …" shape is present, so
 * a question whose answer really is those words is never eaten.
 */
function stripEcho(raw, question) {
  const prompt = String(question?.prompt ?? '').toLowerCase();
  let subject = prompt.replace(/\?.*$/, '').trim();
  subject = subject.replace(
    /^(what is|what was|what are|which|who is|who was|when is|when was|where is|where was|where are|how many|how much|how often|how old|what|who|when|where|how)\b[ ,]*/i, '');
  subject = subject.replace(/\byour\b/g, 'my').trim();
  subject = subject.replace(/^my\s+/, '');
  if (!subject) return raw;
  const re = new RegExp(`^(?:my |the |our )?${escapeRe(subject)} (?:is|was|are|were)[, ]+`, 'i');
  const m = String(raw).match(re);
  if (!m) return raw;
  const rest = String(raw).slice(m[0].length).trim();
  return rest ? rest : raw;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// -- free text -------------------------------------------------------------

/**
 * Hesitation and lead-ins that are never part of a free-text answer.
 *
 * Narrower than LEAD_FILLER on purpose. That list is safe for a date or a
 * number, where "well" or "so" cannot be the answer; here it could be the
 * start of one ("Well Street", "So-Young"). Each alternative must be followed
 * by a comma or a space, and is only removed when something is left after it.
 */
const TEXT_LEAD = /^(?:(?:um+|uh+|er+|erm|hmm+|mm+)[\s,.]+|(?:my answer is|the answer is)[\s,:]+)/i;

/**
 * Free text as spoken: drop lead-in filler and the full stop a transcriber
 * adds to every utterance, and start with a capital. "um, the Maine Medical
 * Center." becomes "The Maine Medical Center".
 */
function parseText(raw) {
  let s = raw.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(TEXT_LEAD, '').trim();
    if (!next || next === s) break;
    s = next;
  }
  s = s.replace(/[.!?\s]+$/, '').trim();
  if (!s || !/[\p{L}\p{N}]/u.test(s)) return null;
  return { value: s.charAt(0).toUpperCase() + s.slice(1), confidence: 1 };
}

// -- yes / no --------------------------------------------------------------

// A yes or no said as a full clause: "yes I do", "no she doesn't". The
// subject and auxiliary are part of the answer, and the polarity is the word
// at the head — the auxiliary alone would not settle it ("I do not" is not
// "yes I do").
//
// Both are anchored at the end. The clause has to be the whole answer: "yes
// I do not", "yes I did but not anymore" and "yes I do, no wait" all carry a
// second polarity after the first, and a read-back that hears "yes" in them
// would commit a Social Security number the user just rejected.
const YES_PHRASE = /^(yes|yeah|yep|yup)\b[ ,]+(i|you|he|she|we|they|it)\s+(do|does|did|am|are|is|was|were|have|has|had|would|will|can|could|should)$/i;
const NO_PHRASE = /^(no|nope|nah)\b[ ,]+(i|you|he|she|we|they|it)\s+(do not|don'?t|does not|doesn'?t|did not|didn'?t|am not|are not|aren'?t|is not|isn'?t|was not|wasn'?t|were not|weren'?t|have not|haven'?t|has not|hasn'?t|had not|hadn'?t|would not|wouldn'?t|will not|won'?t|can not|cannot|can'?t|could not|couldn'?t|should not|shouldn'?t)$/i;

function parseYesNo(raw) {
  // Checked against the unstripped text: "uh huh" and "uh uh" begin with a
  // filler word that is part of the answer itself. A transcriber's curly
  // apostrophe ("doesn’t", "that’s right") reads as the straight one.
  const bare = String(raw ?? '').toLowerCase().replace(/’/g, "'")
    .replace(/\s+/g, ' ').trim().replace(/[.!?,]+$/, '');
  if (YES.test(bare)) return { value: true, confidence: 1 };
  if (NO.test(bare)) return { value: false, confidence: 1 };

  // The full-clause forms, checked before lead filler is stripped.
  if (YES_PHRASE.test(bare)) return { value: true, confidence: 1 };
  if (NO_PHRASE.test(bare)) return { value: false, confidence: 1 };

  const s = clean(raw).replace(/’/g, "'").replace(/[.!?,]+$/, '');

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
 * out loud ("dash", "and"), plus the commas and periods a transcriber drops
 * between spoken digit groups ("9, 8, 7, …"). Rejects any other word, and
 * rejects the multiplier forms that have two readings.
 */
function digitsFrom(raw) {
  let s = clean(raw)
    .replace(/[.,!?]+/g, ' ')
    .replace(/[-–—()+]/g, ' ')
    .replace(/\bdash\b|\bhyphen\b|\band\b/g, ' ');

  // "double seven" / "triple oh" — no single correct reading. Defer.
  if (/\b(double|triple|twice|thrice)\b/.test(s)) return null;

  const tokens = s.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  let out = '';
  for (const token of tokens) {
    if (/^\d+$/.test(token)) { out += token; continue; }
    // Own keys only: a bare lookup finds "constructor" on the prototype, and
    // "1234 constructor" would read as an account number.
    if (!Object.prototype.hasOwnProperty.call(DIGIT_WORDS, token)) return null;   // a real word
    const word = DIGIT_WORDS[token];
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

const UNIT_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9
};
const TEEN_WORDS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
};

/**
 * Number words to a value, or null unless they are one number said the way a
 * number is said.
 *
 * "twelve hundred", "two thousand five", "two thousand five hundred thirty",
 * "a hundred and five", "eighty five hundred". The grammar is the spoken one:
 * below a hundred is a unit, a teen, or a tens word with at most one unit
 * after it; "hundred" multiplies a number below a hundred (or "a") in front
 * of it; "thousand" multiplies a number below a thousand. Anything else is
 * not one number, and summing it would invent one: "nineteen ninety eight"
 * is a year, not 117; "three fifty" is $3.50 or 350, not 53; "one two three"
 * is digits. Those defer. An "and" is only part of the number right after a
 * scale word — "five and six" is two numbers, not 56.
 */
function wordsToNumber(s) {
  const tokens = String(s).split(/[\s-]+/).filter(Boolean);
  let i = 0;

  // Own keys only: `in` would also find "constructor" on the prototype.
  const has = (table, t) => t != null && Object.prototype.hasOwnProperty.call(table, t);

  // 1–99, or null without consuming anything.
  const belowHundred = () => {
    const t = tokens[i];
    if (has(UNIT_WORDS, t)) { i++; return UNIT_WORDS[t]; }
    if (has(TEEN_WORDS, t)) { i++; return TEEN_WORDS[t]; }
    if (has(TENS_NUMBERS, t)) {
      i++;
      if (has(UNIT_WORDS, tokens[i])) return TENS_NUMBERS[t] + UNIT_WORDS[tokens[i++]];
      return TENS_NUMBERS[t];
    }
    return null;
  };

  // A run below a scale word: "five", "twelve hundred", "a hundred and five".
  // Returns the value, or null when the words do not form one.
  const group = () => {
    let lead;
    if (tokens[i] === 'a' && (tokens[i + 1] === 'hundred' || tokens[i + 1] === 'thousand')) {
      i++;
      lead = 1;
    } else {
      lead = belowHundred();
      if (lead === null) return null;
    }
    if (tokens[i] !== 'hundred') return lead;
    i++;
    let value = lead * 100;
    if (tokens[i] === 'and') {
      i++;
      const rest = belowHundred();
      if (rest === null) return null;   // "a hundred and" says nothing more
      value += rest;
    } else if (i < tokens.length && tokens[i] !== 'thousand') {
      const rest = belowHundred();
      if (rest === null) return null;
      value += rest;
    }
    return value;
  };

  if (!tokens.length) return null;
  let total = group();
  if (total === null) return null;
  if (tokens[i] === 'thousand') {
    // "twelve hundred thousand" is not how anyone says 1.2 million.
    if (total >= 1000) return null;
    i++;
    total *= 1000;
    if (i < tokens.length) {
      if (tokens[i] === 'and') i++;
      const rest = group();
      if (rest === null || rest >= 1000) return null;
      total += rest;
    }
  }
  return i === tokens.length ? total : null;
}

/**
 * The pay periods a speaker attaches to an amount, and the period each names.
 * Longer phrases first: "every two weeks" is not "a week", and "twice a
 * month" is not "a month".
 */
const PERIOD_PHRASES = [
  [/\bevery (?:two|2|other) weeks?\b|\bbi ?weekly\b/g, 'biweekly'],
  [/\btwice (?:a|per) month\b|\bsemi ?monthly\b/g, 'twice_month'],
  [/\b(?:an?|per|each|every) hour\b|\bhourly\b|\bby the hour\b/g, 'hour'],
  [/\b(?:an?|per|each|every) day\b|\bdaily\b/g, 'day'],
  [/\b(?:an?|per|each|every) week\b|\bweekly\b/g, 'week'],
  [/\b(?:an?|per|each|every) month\b|\bmonthly\b/g, 'month'],
  [/\b(?:an?|per|each|every) year\b|\byearly\b|\bannually\b|\bper annum\b/g, 'year'],
  [/\b(?:an?|per|each) paycheck\b/g, 'paycheck']
];

/**
 * A number, or null.
 *
 * A period said with the amount ("$20 an hour", "twelve hundred a month") is
 * checked against the question rather than thrown away. The schema's `per`
 * says what the question asks for: `'any'` where the next question asks for
 * the period itself (a job's pay), a period name where the question already
 * fixes one ("What is the approximate monthly amount?"). A period that
 * contradicts the question defers — "$20 an hour" is not a monthly income —
 * and so does any period on a question that has none.
 *
 * `kind: 'year'` marks a number question that asks for a year, where
 * "nineteen ninety eight" is 1998 rather than an ambiguous run of words.
 */
function parseNumber(raw, question) {
  let s = clean(raw)
    .replace(/[.,!?]+$/, '')
    .replace(/\bdollars?\b|\bbucks?\b/g, ' ')
    .replace(/[$,]/g, '')
    .trim();

  const periods = new Set();
  for (const [re, period] of PERIOD_PHRASES) {
    s = s.replace(re, () => { periods.add(period); return ' '; });
  }
  if (periods.size) {
    const per = question?.per;
    if (per !== 'any' && !(periods.size === 1 && periods.has(per))) return null;
  }

  s = s.replace(/\b(approx\w*|about|around|roughly)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;

  // A range or a list has no single value. "Eight hundred to a thousand" is a
  // question for the user, not a number to pick from. "Two thousand and five"
  // is not a range — wordsToNumber settles that below, so only the digit path
  // needs the guard.
  const wordValue = wordsToNumber(s);
  if (wordValue !== null) return { value: wordValue, confidence: 1 };

  if (question?.kind === 'year') {
    const year = spokenNumbers(s).trim();
    if (/^\d{4}$/.test(year)) return { value: Number(year), confidence: 1 };
  }

  if (/\b(to|or|between|and)\b/.test(s)) return null;

  const numeric = s.match(/-?\d+(\.\d+)?/g);
  if (numeric?.length === 1 && /^[\s\d.$-]*$/.test(s)) {
    return { value: Number(numeric[0]), confidence: 1 };
  }
  if (numeric?.length > 1) return null;

  return null;
}

// -- dates -----------------------------------------------------------------

function parseDate(raw, question, now) {
  const s = spokenNumbers(clean(raw));

  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return dated(+m[1], +m[2], +m[3], 1, question, now);

  // 3/14/79, 03-14-1979
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) return dated(expandYear(+m[3], m[3].length, question, now), +m[1], +m[2], 1, question, now);

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
  return dated(expandYear(+yearRaw, yearRaw.length, question, now), month, +day, confidence, question, now);
}

function parseMonthYear(raw, question, now) {
  const s = spokenNumbers(clean(raw));

  if (PRESENT.test(s) && !/\b(19|20)\d{2}\b/.test(s)) {
    return { value: 'present', confidence: 1 };
  }

  let m = /^(\d{4})-(\d{2})$/.exec(s);
  if (m) return monthYear(+m[1], +m[2], 1, question, now);

  // 3/79, 03/1979
  m = /^(\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) return monthYear(expandYear(+m[2], m[2].length, question, now), +m[1], m[2].length === 4 ? 1 : 0.8, question, now);

  const month = findMonth(s);
  if (month === null) return null;
  const nums = [...s.matchAll(/\b(\d{2,4})\b/g)].map(x => x[1]);
  if (nums.length !== 1) return null;

  const yearRaw = nums[0];
  return monthYear(expandYear(+yearRaw, yearRaw.length, question, now), month, yearRaw.length === 4 ? 1 : 0.8, question, now);
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
function expandYear(year, digits, question, now) {
  if (digits === 4) return year;
  const current = now().getFullYear();
  const century = Math.floor(current / 100) * 100;
  const candidate = century + year;
  if (candidate <= current) return candidate;
  if (allowsFuture(question) && candidate <= current + 20) return candidate;
  return candidate - 100;
}

function dated(year, month, day, confidence, question, now) {
  if (!validYmd(year, month, day)) return null;
  if (isFuture(year, month, day, now) && !allowsFuture(question)) return null;
  const iso = `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  return { value: iso, confidence };
}

function monthYear(year, month, confidence, question, now) {
  if (!validYmd(year, month, 1)) return null;
  if (isFuture(year, month, 1, now) && !allowsFuture(question)) return null;
  return { value: `${pad4(year)}-${pad2(month)}`, confidence };
}

/** Rejects February 30 and friends rather than rolling them over silently. */
function validYmd(year, month, day) {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= new Date(year, month, 0).getDate();
}

function isFuture(year, month, day, now) {
  const today = now();
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
