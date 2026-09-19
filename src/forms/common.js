// Formatting shared by the form mappings.
//
// Answers are stored in the shapes the engine validates (ISO dates, bare
// digits, booleans). A paper form wants them the way a person writes them:
// 03/14/1979, 555-123-4567, Yes. These helpers do that conversion, and
// nothing here knows which form it is writing for.

/** "1979-03-14" -> "03/14/1979". Anything else passes through. */
export function mdy(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : text(value);
}

/** "2023-05" -> "05/2023", "present" -> "Present". */
export function my(value) {
  if (String(value ?? '').toLowerCase() === 'present') return 'Present';
  const m = /^(\d{4})-(\d{2})$/.exec(String(value ?? ''));
  return m ? `${m[2]}/${m[1]}` : text(value);
}

/** Month/year or full date, whichever the value is. */
export function anyDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? mdy(value) : my(value);
}

export function yesNo(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return '';
}

export function phone(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : text(value);
}

export function ssn(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : text(value);
}

export function zip(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d.length === 9 ? `${d.slice(0, 5)}-${d.slice(5)}` : text(value);
}

export function money(value) {
  if (value == null || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toLocaleString('en-US')}` : text(value);
}

/** A stored value as a trimmed string, with null and undefined as ''. */
export function text(value) {
  if (value == null) return '';
  return String(value).trim();
}

/** Join the non-empty parts. */
export function join(parts, sep = ', ') {
  return parts.map(text).filter(Boolean).join(sep);
}

/** The items of a loop answer, never null. */
export function items(answers, loopId) {
  return Array.isArray(answers?.[loopId]) ? answers[loopId] : [];
}

// -- WinAnsi -----------------------------------------------------------------
//
// pdf-lib's standard fonts (Helvetica) can only draw the WinAnsi character
// set, and it throws on anything else — one name typed with a character
// outside it would fail the whole download. Every string headed for a PDF
// goes through toWinAnsi() first.

const WIN_ANSI_EXTRAS = new Set([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ']);

function encodable(ch) {
  const c = ch.codePointAt(0);
  if (c === 0x0a) return true;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xff) return true;
  return WIN_ANSI_EXTRAS.has(ch);
}

/** Letters with a stroke have no Unicode decomposition to fall back on. */
const STROKED = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŧ: 'T', ŧ: 't' };

/**
 * The closest thing to `value` that Helvetica can draw. Accented letters
 * outside Latin-1 lose their accent (ő -> o, Ł -> L); anything with no close
 * equivalent becomes "?". Tabs and carriage returns become spaces.
 */
export function toWinAnsi(value) {
  let out = '';
  for (const ch of String(value ?? '').replace(/[\t\r]/g, ' ')) {
    if (encodable(ch)) { out += ch; continue; }
    if (STROKED[ch]) { out += STROKED[ch]; continue; }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += [...base].every(encodable) && base ? base : '?';
  }
  return out;
}
