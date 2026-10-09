#!/usr/bin/env node
// Re-read the PDFs the Android writer filled, with the JS reference.
//
//   node tools/golden/crosscheck.mjs <dir>
//
// <dir> holds what :pdf's instrumented spike publishes through TestStorage:
// <case>-<form>.pdf beside <case>-<form>.json (the answers, the Kotlin plan,
// the addendum page count). It is searched recursively, so the AGP output
// folder (connected_android_test_additional_output/) can be passed whole.
// Fixture answers only — these are never a real claimant's.
//
// For each pair, two independent checks:
//   1. The JS reference plans the same answers (spec.map → toWinAnsi →
//      planFill against a manifest read from the template here) and must get
//      exactly the Kotlin plan. So the PDF was filled from the plan the web
//      app would have made.
//   2. pdf-lib opens the Android PDF and reads it back: every planned value,
//      checkbox and radio; nothing else filled; the field set (116 / 126);
//      pages = template + addendum; every filled widget has an /AP /N and a
//      DA whose font is in /DR; no NeedAppearances; signatures blank; and
//      pdf-lib can save it again.
// Exits 1 on any mismatch, naming the file, the field and the check.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { planFill, buildManifest } from '../../src/fill.js';
import { parseDa } from '../../src/manifest.js';
import { toWinAnsi } from '../../src/forms/common.js';
import * as ssaKit from '../../src/forms/ssa-starter-kit.js';
import * as dsIntake from '../../src/forms/ds-intake.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PDFLib = createRequire(import.meta.url)('../../vendor/pdf-lib.min.js');
const SPECS = { ssa: ssaKit, ds: dsIntake };
const FIELD_COUNT = { ssa: 116, ds: 126 };

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/golden/crosscheck.mjs <dir with <case>-<form>.pdf and .json>');
  process.exit(2);
}

function walk(d) {
  return readdirSync(d).flatMap(name => {
    const p = join(d, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const records = walk(dir).filter(p => p.endsWith('.json') && walk(dirname(p)).includes(p.replace(/\.json$/, '.pdf')));
if (!records.length) {
  console.error(`crosscheck: no <case>-<form>.json/.pdf pairs under ${dir}`);
  process.exit(1);
}

const doc0 = await PDFLib.PDFDocument.create();
const font = await doc0.embedFont(PDFLib.StandardFonts.Helvetica);
const metrics = {
  widthOfTextAtSize: (text, size) => font.widthOfTextAtSize(toWinAnsi(text), size),
  heightAtSize: size => font.heightAtSize(size)
};

const templates = {};
async function template(formId) {
  if (!templates[formId]) {
    const bytes = readFileSync(join(REPO, SPECS[formId].TEMPLATE));
    const doc = await PDFLib.PDFDocument.load(bytes);
    templates[formId] = { pages: doc.getPageCount(), manifest: buildManifest(doc.getForm(), PDFLib) };
  }
  return templates[formId];
}

let failures = 0;
let checked = 0;

for (const jsonPath of records.sort()) {
  const rec = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const name = basename(jsonPath, '.json');
  const fail = (what, detail = '') => { failures++; console.error(`FAIL  ${name}: ${what}${detail ? ` — ${detail}` : ''}`); };
  const spec = SPECS[rec.form];
  if (!spec) { fail(`unknown form ${rec.form}`); continue; }
  const tpl = await template(rec.form);

  // 1. The JS reference's plan for the same answers.
  const today = new Date(`${rec.today}T12:00:00Z`);
  const mapping = spec.map(rec.answers, { today });
  const planMapping = {
    ...mapping,
    text: Object.fromEntries(Object.entries(mapping.text ?? {}).map(([k, v]) => [k, toWinAnsi(v)]))
  };
  const jsPlan = JSON.parse(JSON.stringify(planFill(planMapping, tpl.manifest, metrics)));
  if (!isDeepStrictEqual(jsPlan, rec.plan)) {
    const where = Object.keys(jsPlan).find(k => !isDeepStrictEqual(jsPlan[k], rec.plan[k]));
    fail('the Kotlin plan is not the JS reference plan', `differs in "${where}"`);
  }

  // 2. pdf-lib reads the Android PDF back.
  let doc;
  try {
    doc = await PDFLib.PDFDocument.load(readFileSync(jsonPath.replace(/\.json$/, '.pdf')));
  } catch (e) {
    fail('pdf-lib cannot open it', e.message);
    continue;
  }
  const form = doc.getForm();
  const fields = form.getFields();
  const names = new Set(fields.map(f => f.getName()));
  if (fields.length !== FIELD_COUNT[rec.form]) fail(`has ${fields.length} fields, expected ${FIELD_COUNT[rec.form]}`);
  for (const n of Object.keys(tpl.manifest.fields)) if (!names.has(n)) fail(`lost field "${n}"`);

  const expectedPages = tpl.pages + rec.addendumPages;
  if (doc.getPageCount() !== expectedPages) fail(`has ${doc.getPageCount()} pages, expected ${expectedPages}`);

  const acro = doc.catalog.lookup(PDFLib.PDFName.of('AcroForm'));
  if (acro.get(PDFLib.PDFName.of('NeedAppearances'))?.toString() === 'true') fail('sets NeedAppearances');
  const drFonts = acro.lookup(PDFLib.PDFName.of('DR'))?.lookup(PDFLib.PDFName.of('Font'));
  const drNames = new Set((drFonts?.keys() ?? []).map(k => k.toString()));

  const planned = new Map(rec.plan.fields.map(f => [f.name, f]));
  const checks = new Set(rec.plan.checks);
  const radios = Object.fromEntries(Object.entries(rec.plan.radios).filter(([, v]) => v));

  for (const field of fields) {
    const fname = field.getName();
    if (field instanceof PDFLib.PDFTextField) {
      const text = field.getText();
      const pf = planned.get(fname);
      if (!pf) {
        if (text) fail(`"${fname}" is filled but not planned`);
        continue;
      }
      if (text !== pf.fit.text) fail(`"${fname}" reads back differently from its plan`);
      const da = parseDa(field.acroField.getDefaultAppearance());
      if (!da || !drNames.has(da.font)) fail(`"${fname}" DA font is not in /DR`);
      if (da && da.size !== pf.fit.size) fail(`"${fname}" DA size ${da.size}, planned ${pf.fit.size}`);
      for (const w of field.acroField.getWidgets()) {
        if (!w.getAppearances()?.normal) fail(`"${fname}" widget has no /AP /N`);
      }
    } else if (field instanceof PDFLib.PDFCheckBox) {
      if (field.isChecked() !== checks.has(fname)) fail(`"${fname}" checked=${field.isChecked()}, planned ${checks.has(fname)}`);
    } else if (field instanceof PDFLib.PDFRadioGroup) {
      const want = radios[fname];
      if ((field.getSelected() ?? undefined) !== want) fail(`"${fname}" selected ${field.getSelected()}, planned ${want}`);
    } else if (field instanceof PDFLib.PDFSignature) {
      if (field.acroField.dict.get(PDFLib.PDFName.of('V'))) fail(`signature "${fname}" has a value`);
    }
  }
  for (const n of planned.keys()) if (!names.has(n)) fail(`planned field "${n}" is missing`);

  try { await doc.save(); } catch (e) { fail('pdf-lib cannot save it again', e.message); }
  checked++;
}

console.log(`crosscheck: ${checked} PDFs re-read with pdf-lib, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
