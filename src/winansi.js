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
const STROKED = {
  Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', Ħ: 'H', ħ: 'h', ı: 'i', Ŧ: 'T', ŧ: 't',
  // Lingala's open vowels (D7) have no WinAnsi form; "e"/"o" is how they are
  // commonly written when the character set is limited.
  ɛ: 'e', Ɛ: 'E', ɔ: 'o', Ɔ: 'O'
};

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
