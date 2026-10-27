// The screen channel: translate the static page and fill the language selects.
//
// English is left untouched, so the markup inside a paragraph (strong, kbd,
// em) survives for the language the page was written in. Any other language
// replaces the element's text with its translation, which is plain text by
// design: translating words is safe, translating markup is not.

import { LANGUAGES, LANGUAGE_ORDER } from './languages.js';
import { UI } from './ui.js';
import { translate, message, sttFor } from './index.js';

// The authored HTML, kept per element so switching back to English restores
// the inline markup (strong, kbd) that a translation replaced with plain text.
const originals = new WeakMap();

/**
 * Apply a screen language to every `[data-i18n]` element under `root`, and
 * say in the page language whether typed answers can be spoken in `inputLang`.
 */
export function applyUi(root, screenLang = 'en', inputLang = 'en') {
  const doc = root?.ownerDocument ?? root ?? globalThis.document;
  const lang = LANGUAGES[screenLang] ? screenLang : 'en';
  const nodes = root?.querySelectorAll ? root.querySelectorAll('[data-i18n]') : [];

  for (const el of nodes) {
    const key = el.dataset?.i18n;
    const source = UI[key];
    if (typeof source !== 'string') continue;
    if (!originals.has(el)) originals.set(el, el.innerHTML);
    if (lang === 'en') {
      // Put back the authored markup and spacing, not a plain-text copy.
      el.innerHTML = originals.get(el);
      continue;
    }
    el.textContent = translate(source, lang);
  }

  if (doc?.title !== undefined && typeof UI['page.title'] === 'string') {
    doc.title = translate(UI['page.title'], lang);
  }
  if (doc?.documentElement) doc.documentElement.lang = LANGUAGES[lang].htmlLang;

  for (const channel of ['input', 'output', 'screen', 'fill']) {
    const select = doc?.getElementById?.(`lang-${channel}`);
    if (!select) continue;
    if (!select.options?.length) {
      for (const code of LANGUAGE_ORDER) {
        const option = doc.createElement('option');
        option.value = code;
        option.textContent = LANGUAGES[code].autonym;
        select.add(option);
      }
    }
  }

  // main.js sets each select's own value. Here we only make sure a fresh page
  // has four usable options.
  const note = doc?.getElementById?.('stt-note');
  if (note) {
    note.textContent = sttFor(inputLang).installed
      ? ''
      : message('stt_unavailable', {}, lang);
  }
}
