// Translation report: corpus size, missing keys per language, and one
// resolved sample per channel. Run with `node tools/i18n-report.mjs`.

import { translationCorpus } from '../src/i18n/corpus.js';
import { LANGUAGES, LANGUAGE_ORDER, message, translate, sttFor } from '../src/i18n/index.js';
import frStrings from '../src/i18n/catalog/fr.strings.js';
import lnStrings from '../src/i18n/catalog/ln.strings.js';

const corpus = translationCorpus();
console.log(`corpus: ${corpus.length} strings`);

let missingTotal = 0;
for (const [lang, file] of [['fr', frStrings], ['ln', lnStrings]]) {
  const missing = corpus.filter(text => !file.strings?.[text]);
  missingTotal += missing.length;
  console.log(`${lang}: ${missing.length} missing`);
  if (missing.length && process.env.VERBOSE) for (const text of missing) console.log(`  - ${text}`);
}

const sample = {
  screen: translate('What is your legal first name?', 'fr'),
  output: message('readback_heard', { value: message('yes', {}, 'fr') }, 'fr'),
  fill: translate('Date of birth', 'ln')
};
console.log(`screen sample (fr): ${sample.screen}`);
console.log(`output sample (fr): ${sample.output}`);
console.log(`fill sample (ln): ${sample.fill}`);
for (const lang of LANGUAGE_ORDER) {
  console.log(`stt ${lang}: ${sttFor(lang).model} installed=${LANGUAGES[lang].stt.installed}`);
}

process.exit(missingTotal ? 1 : 0);
