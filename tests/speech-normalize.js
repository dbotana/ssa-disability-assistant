// The Lingala speech normalizer (src/speech-normalize.js): everything a
// Lingala session may speak reaches Simba-TTS-lin as symbols its 39-symbol
// vocabulary has, with no digit left over. Plan section 4.3, Step 2 item 3.
//
// Makes no network requests.

import {
  SIMBA_SYMBOLS, NUMBER_WORDS, DEFAULT_NUMBER_LANGUAGE, normalizeForSpeech,
  speechSegments, unknownSymbols, lingalaSpeechCorpus
} from '../src/speech-normalize.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

check('the vocabulary has 39 symbols', SIMBA_SYMBOLS.length === 39, String(SIMBA_SYMBOLS.length));
check('the vocabulary has no x and no 9', !SIMBA_SYMBOLS.includes('x') && !SIMBA_SYMBOLS.includes('9'));
check('Lingala number words are the default', DEFAULT_NUMBER_LANGUAGE === 'ln');
check('both number languages are data, ten words each',
  Object.values(NUMBER_WORDS).every(w => w.length === 10));

const corpus = lingalaSpeechCorpus();
check('the corpus covers the catalogue', corpus.length > 700, String(corpus.length));
for (const numberLanguage of Object.keys(NUMBER_WORDS)) {
  const bad = [];
  for (const text of corpus) {
    for (const out of [normalizeForSpeech(text, { numberLanguage }), ...speechSegments(text, { numberLanguage })]) {
      const unknown = unknownSymbols(out);
      if (unknown.length || /[0-9]/.test(out)) bad.push(`${JSON.stringify(text)} -> ${JSON.stringify(out)} (${unknown.join('')})`);
    }
  }
  check(`every corpus string is speakable (${numberLanguage} numbers)`, bad.length === 0, bad.slice(0, 5).join('\n     '));
}

const cases = [
  ['987-65-4329', {}, 'libwa mwambe nsambo - motoba mitano - minei misato mibale libwa'],
  ['987', { numberLanguage: 'fr' }, 'neuf huit sept'],
  ['26', { numberLanguage: 'fr' }, 'deu ks si ks'],
  ['Maxine', {}, 'ma ks ine'],
  ['Kopɛtɛ nzoto', {}, 'kopete nzoto'],
  ['Bɔkɔ́', {}, 'boko'],
  ['O’Brien—Dix', {}, "o'brien-di ks"],
  ['naʼyo', {}, 'naʼyo'],
  ['Ɛɛ, iyo!', {}, 'ee iyo'],
  ['', {}, '']
];
for (const [input, options, want] of cases) {
  const got = normalizeForSpeech(input, options);
  check(`normalize ${JSON.stringify(input)}`, got === want, `${JSON.stringify(got)} != ${JSON.stringify(want)}`);
}

{
  const got = speechSegments('Mbote. Ozali malamu? Iyo!');
  check('segments split at sentence ends', JSON.stringify(got) === JSON.stringify(['mbote', 'ozali malamu', 'iyo']), JSON.stringify(got));
  const long = Array.from({ length: 60 }, (_, i) => `liloba${i % 9}`).join(' ');
  const pieces = speechSegments(long, { maxLength: 50 });
  check('a long sentence is cut at word gaps', pieces.length > 1 && pieces.every(p => p.length <= 120), JSON.stringify(pieces));
  check('segments drop pieces that normalize to nothing', JSON.stringify(speechSegments('!!! . ?')) === '[]',
    JSON.stringify(speechSegments('!!! . ?')));
}

console.log(failures === 0 ? 'speech-normalize: all checks passed' : `speech-normalize: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
