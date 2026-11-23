// Formatting shared by the form mappings.
//
// Answers are stored in the shapes the engine validates (ISO dates, bare
// digits, booleans). A paper form wants them the way a person writes them:
// 03/14/1979, 555-123-4567, Yes. These helpers do that conversion, and
// nothing here knows which form it is writing for.

import { translate } from '../i18n/index.js';

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

export function yesNo(value, lang = 'en') {
  if (value === true) return translate('Yes', lang);
  if (value === false) return translate('No', lang);
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

export { toWinAnsi } from '../winansi.js';

