// Plain-text list of the interview's English questions, for translators.
// Walks src/schema.js. Run with `node tools/export-questions.mjs [out.md]`;
// the default output is questions-translatable.md at the repository root.
// With a language code (`node tools/export-questions.mjs --lang ln`) each
// English line is followed by its current translation from the catalogue, and
// the default output is questions-translatable.<lang>.md.

import { writeFileSync } from 'node:fs';
import { SECTIONS } from '../src/schema.js';
import { translate } from '../src/i18n/index.js';

const args = process.argv.slice(2);
const langAt = args.indexOf('--lang');
const lang = langAt >= 0 ? args.splice(langAt, 2)[1] : null;
const out = args[0]
  ?? new URL(`../questions-translatable${lang ? `.${lang}` : ''}.md`, import.meta.url).pathname;

let missing = 0;

const lines = [
  '# Interview questions to translate',
  '',
  'Generated from src/schema.js by tools/export-questions.mjs. Do not edit by hand.',
  'Translate the text after each label. Keep the meaning, not the word order.',
  '',
  'Q = the spoken question, WARN = spoken before the question, HINT = spoken after a',
  'misunderstood answer, OPTION = an answer the person may say.',
  ''
];

function tr(text) {
  const t = translate(text, lang);
  if (t === text) missing += 1;
  return t;
}

function question(q, indent = '') {
  const add = (label, text) => {
    if (!text) return;
    lines.push(`${indent}${label}: ${text}`);
    if (lang) lines.push(`${indent}${label}-${lang.toUpperCase()}: ${tr(text)}`);
  };
  add('Q', q.prompt);
  add('WARN', q.warn);
  add('HINT', q.hint);
  for (const o of q.options ?? []) add('OPTION', o.label);
}

let n = 0;
for (const section of SECTIONS) {
  lines.push(`## ${section.title}`, '');
  for (const q of section.questions) {
    n += 1;
    lines.push(`### ${n}. ${q.id}`);
    if (q.type === 'loop') {
      for (const [label, text] of [['ITEM', q.itemLabel], ['ENTRY', q.entryPrompt], ['REPEAT', q.repeatPrompt]]) {
        lines.push(`${label}: ${text}`);
        if (lang) lines.push(`${label}-${lang.toUpperCase()}: ${tr(text)}`);
      }
      for (const f of q.fields) {
        lines.push('', `#### ${f.id}`);
        question(f);
      }
    } else {
      question(q);
    }
    lines.push('');
  }
}

writeFileSync(out, lines.join('\n'));
console.log(`${n} questions -> ${out}`);
if (lang) console.log(`${missing} strings had no ${lang} translation`);
