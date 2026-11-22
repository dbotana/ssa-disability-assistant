// The two form versions (src/versions.js, Step 2 item 5) and export file
// names with the version suffix (src/export-name.js, Step 2 item 8), from
// the fixed translation fixture in tests/fixtures/translations/.
//
// Makes no network requests.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The i18n tables first: they and the form specs import each other, and the
// app (main.js) and the golden generator load them in this order too.
import '../src/i18n/index.js';
import { MT_MARK, VERSION_NOTES, planVersions, overlayAnswers, lingalaFreeText, translatableFields, versionAddendum } from '../src/versions.js';
import { exportFileName } from '../src/export-name.js';
import { planFill, buildManifest } from '../src/fill.js';
import { toWinAnsi } from '../src/forms/common.js';
import * as ssaKit from '../src/forms/ssa-starter-kit.js';
import * as dsIntake from '../src/forms/ds-intake.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PDFLib = require(join(REPO, 'vendor', 'pdf-lib.min.js'));

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const both = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/answers/both.json'), 'utf8'));
const ln = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/translations/ln-both.json'), 'utf8'));
const answers = structuredClone(both);
for (const [k, v] of Object.entries(ln.answers)) {
  if (Array.isArray(answers[k])) for (const [i, item] of Object.entries(v)) Object.assign(answers[k][Number(i)], item);
  else answers[k] = v;
}
const overlay = { inputLangs: ln.inputLangs, translations: ln.translations };

// -- the flag ------------------------------------------------------------------
check('translatable fields are all text', translatableFields().length >= 25);

// -- the overlay ---------------------------------------------------------------
{
  const lingala = lingalaFreeText(answers, overlay).map(e => e.id);
  check('English answers are never Lingala free text', !lingala.includes('food_allergies'), lingala.join());
  check('Lingala answers on translatable questions are found',
    ['medication_allergies', 'living_arrangement', 'eating_explain', 'dietary_restrictions', 'volunteer_experience', 'reason']
      .every(id => lingala.includes(id)), lingala.join());

  const { answers: b, translated } = overlayAnswers(answers, overlay);
  check('a machine translation is marked [MT]', b.medication_allergies === `${MT_MARK} I am allergic to penicillin`, b.medication_allergies);
  check('a loop field is translated in place', b.medications[0].reason === `${MT_MARK} For headaches`, b.medications[0].reason);
  check('a translation a person edited has no [MT] mark', b.medications[1].reason === 'For high blood pressure', b.medications[1].reason);
  check('a stale translation is not used', b.dietary_restrictions === answers.dietary_restrictions, b.dietary_restrictions);
  check('an answer with no translation stays as given', b.volunteer_experience === answers.volunteer_experience);
  check('names are never translated', b.first_name === answers.first_name && b.medications[0].name === answers.medications[0].name);
  check('the input answers are not changed', answers.medication_allergies === ln.answers.medication_allergies);
  check('five answers are translated', translated.length === 5, String(translated.length));
}

// -- both plans ----------------------------------------------------------------
const doc = async spec => (await PDFLib.PDFDocument.load(readFileSync(join(REPO, spec.TEMPLATE)))).getForm();
const font = await (await PDFLib.PDFDocument.create()).embedFont(PDFLib.StandardFonts.Helvetica);
const metrics = {
  widthOfTextAtSize: (t, s) => font.widthOfTextAtSize(toWinAnsi(t), s),
  heightAtSize: s => font.heightAtSize(s)
};
for (const [formId, spec] of [['ssa', ssaKit], ['ds', dsIntake]]) {
  const manifest = buildManifest(await doc(spec), PDFLib);
  const planOne = a => {
    const mapping = spec.map(a, { today: new Date(Date.UTC(2026, 8, 19, 12)) });
    return planFill({ ...mapping, text: Object.fromEntries(Object.entries(mapping.text).map(([k, v]) => [k, toWinAnsi(v)])) }, manifest, metrics);
  };

  const { a, b } = planVersions(answers, overlay, planOne);
  check(`${formId}: version A opens with the interpreter note`, a.notes[0] === VERSION_NOTES.a);
  check(`${formId}: version A is the plain plan of the answers as given`, JSON.stringify(a.plan) === JSON.stringify(planOne(answers)));
  check(`${formId}: version B exists`, !!b);
  if (b) {
    check(`${formId}: version B opens with the [MT] note`, b.notes[0] === VERSION_NOTES.b);
    check(`${formId}: version B's appendix holds the Lingala originals`,
      b.appendix.some(r => r.value === ln.answers.medication_allergies), JSON.stringify(b.appendix));
    const content = versionAddendum(spec.ADDENDUM, b);
    check(`${formId}: the appendix is the addendum's last section`, content.sections.at(-1).id === 'appendix');
    check(`${formId}: the note follows the form's own intro`, content.intro.at(-1) === VERSION_NOTES.b);
    check(`${formId}: no plan B value holds Lingala that was translated`,
      !JSON.stringify(b.plan.fields).includes('Nazali na allergie'));
  }

  const english = planVersions(both, { inputLangs: [], translations: [] }, planOne);
  check(`${formId}: an English session has one version and no note`, english.b === null && english.a.notes.length === 0);
  const unchanged = planVersions(answers, {
    inputLangs: overlay.inputLangs, translations: overlay.translations.map(t => ({ ...t, text: t.source }))
  }, planOne);
  check(`${formId}: no version B when no translated field differs`, unchanged.b === null && unchanged.a.notes.length === 1);
}

// -- file names ----------------------------------------------------------------
{
  const d = new Date(2026, 8, 19);
  const ada = { first_name: 'Ada', last_name: 'Lovelace' };
  check('one version keeps today\'s name', exportFileName('ssa', ada, d) === 'ssa-starter-kit-Ada-Lovelace-2026-09-19.pdf', exportFileName('ssa', ada, d));
  check('version A is -lingala', exportFileName('ssa', ada, d, 'lingala') === 'ssa-starter-kit-Ada-Lovelace-2026-09-19-lingala.pdf');
  check('version B is -english', exportFileName('ds', ada, d, 'english') === 'maine-ds-intake-Ada-Lovelace-2026-09-19-english.pdf');
  check('no name, no name part', exportFileName('ds', {}, d) === 'maine-ds-intake-2026-09-19.pdf');
  let threw = false;
  try { exportFileName('ssa', ada, d, 'french'); } catch { threw = true; }
  check('an unknown version is refused', threw);
}

console.log(failures === 0 ? 'form-versions: all checks passed' : `form-versions: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
