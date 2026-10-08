// Filling the official PDF forms.
//
// Both forms are real AcroForms: the Starter Kit has text fields for its
// worksheet and checkboxes for its checklist, and the DS Intake Application
// has a field for every blank. So the download is the agency's own document
// with the answers typed into it, not a look-alike.
//
// The thinking lives in plan.js (pure: fit decisions, overflow, addendum
// content) and addendum.js (pure: page layout as a draw list). This module
// only applies a plan to a pdf-lib document: set text, size, radios, checks,
// fix the default appearances, and replay the addendum draw list. The Android
// port runs the same plan through its own writer (AcroFormWriter), so the two
// implementations are pinned to each other by golden fixtures rather than by
// sharing code.
//
// Fields are left editable rather than flattened, so a caregiver can fix a
// typo in any PDF reader, and the signature lines stay blank for a real
// signature.

import { toWinAnsi } from './forms/common.js';
import { buildManifest, parseDa } from './manifest.js';
import { planFill } from './plan.js';
import { layoutAddendum } from './addendum.js';
import { loadPdfLib, downloadWorksheet, fontMetrics, renderAddendum } from './pdf.js';
import * as ssaKit from './forms/ssa-starter-kit.js';
import * as dsIntake from './forms/ds-intake.js';

export const FORMS = { ssa: ssaKit, ds: dsIntake };

/**
 * The font resource a field's appearance is allowed to name: the one its own
 * DA already uses. pdf-lib's updateFieldAppearances() rewrites every DA with
 * the name of the font it was handed — "/Helvetica" — which the DS form's
 * /DR does not contain, leaving viewers without a font to regenerate the
 * appearance. Both forms' /DR contain /Helv, so a field that named /Helv
 * keeps naming /Helv. A field with no DA at all (the DS form has 27) gets
 * /Helv, which is the name fill.js has always written for those.
 */
function daFontFor(fieldEntry) {
  return fieldEntry?.da?.font ?? fieldEntry?.widgets?.find(w => w?.da?.font)?.da?.font ?? '/Helv';
}

/**
 * Fill a form from a plan. Returns { bytes, missing, overflowText }:
 *   bytes         the finished PDF
 *   missing       field names the mapping used that the template lacks — a
 *                 test failure, never expected at runtime
 *   overflowText  [{ label, value }] answers too long for their box
 */
export async function fillTemplate(PDFLib, templateBytes, mapping, { title, addendum = null } = {}) {
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.load(templateBytes);
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const metrics = fontMetrics(font, font);

  // Everything headed for a PDF goes through toWinAnsi first, exactly as the
  // Android port's FormSpecs do — one name typed with a character outside it
  // must not fail the whole download.
  const planMapping = {
    ...mapping,
    text: Object.fromEntries(Object.entries(mapping.text ?? {}).map(([k, v]) => [k, toWinAnsi(v)]))
  };

  // The manifest is read from this template, and planFill() consumes it, so
  // the web fill and the Android fill plan from the same shape.
  const manifest = buildManifest(form, PDFLib);
  const plan = planFill(planMapping, manifest, metrics.regular);

  const missing = [...plan.missing];
  const overflowText = [...plan.overflowText];

  for (const pf of plan.fields) {
    let field;
    try { field = form.getTextField(pf.name); } catch { missing.push(pf.name); continue; }
    // A few fields on the DS form were authored with no default appearance,
    // and pdf-lib cannot size text without one.
    if (!field.acroField.getDefaultAppearance()) field.acroField.setDefaultAppearance('/Helv 0 Tf 0 g');
    field.setFontSize(pf.fit.size);
    field.setText(pf.fit.text);

    // A widget's own DA overrides the field's: without this, pdf-lib lays the
    // appearance out at the widget's printed size (8) instead of the fitted
    // one (8.5). Rewrite every widget DA to the fitted size before the
    // appearances are generated, keeping its original font name.
    const entry = manifest.fields[pf.name];
    const name = daFontFor(entry);
    field.acroField.getWidgets().forEach(w => {
      if (w.getDefaultAppearance()) w.setDefaultAppearance(`${name} ${pf.fit.size} Tf 0 g`);
    });
    if (field.acroField.getDefaultAppearance()) {
      field.acroField.setDefaultAppearance(`${name} ${pf.fit.size} Tf 0 g`);
    }
  }

  for (const [name, option] of Object.entries(plan.radios)) {
    if (option == null || option === '') continue;
    try { form.getRadioGroup(name).select(option); } catch { missing.push(name); }
  }

  for (const name of plan.checks) {
    try { form.getCheckBox(name).check(); } catch { missing.push(name); }
  }

  form.updateFieldAppearances(font);

  // updateFieldAppearances() rewrites every DA with the name of the font it
  // drew with ("/Helvetica") — including blank fields it still touched, like
  // the DS form's signature dates. Put the original names back everywhere,
  // keeping the size pdf-lib just wrote, so the DA font always exists in the
  // form's /DR and Acrobat can regenerate any appearance.
  for (const field of form.getFields()) {
    if (!(field instanceof PDFLib.PDFTextField)) continue;
    const entry = manifest.fields[field.getName()];
    const name = daFontFor(entry);
    field.acroField.getWidgets().forEach(w => {
      const current = parseDa(w.getDefaultAppearance());
      if (current) w.setDefaultAppearance(`${name} ${current.size} Tf 0 g`);
    });
    const current = parseDa(field.acroField.getDefaultAppearance());
    if (current) field.acroField.setDefaultAppearance(`${name} ${current.size} Tf 0 g`);
  }

  const tables = plan.tables;
  const sections = plan.sections;
  if (addendum && (overflowText.length || tables.length || sections.length)) {
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const drawList = layoutAddendum({
      title: addendum.title,
      intro: addendum.intro ?? [],
      overflowText,
      tables,
      sections,
      footer: addendum.footer ?? []
    }, fontMetrics(font, bold));
    renderAddendum(doc, PDFLib, drawList, { font, bold });
  }

  if (title) doc.setTitle(title);
  doc.setCreator('Voice Assistant for Disability Forms');

  return { bytes: await doc.save(), missing, overflowText };
}

/** Re-exported for tests and the golden generator. */
export { planFill, layoutAddendum, buildManifest };

// -- browser -------------------------------------------------------------------

/** Filename-safe version of the applicant's name. */
const slug = s => String(s ?? '').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');

/**
 * Fill one form and hand it to the user. Returns { filename, fallback }.
 *
 * If the official form cannot be fetched — offline with nothing cached, or a
 * page opened straight from disk — a plain worksheet of the same answers is
 * downloaded instead, and `fallback` says so. `now` supplies the date stamp
 * in the filename.
 */
export async function downloadForm(formId, answers, { now = () => new Date() } = {}) {
  const spec = FORMS[formId];
  if (!spec) throw new Error(`Unknown form: ${formId}`);

  const who = slug([answers.first_name, answers.last_name].filter(Boolean).join(' '));
  const d = now();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const filename = `${spec.FILE_PREFIX}${who ? `-${who}` : ''}-${stamp}.pdf`;

  const PDFLib = await loadPdfLib();
  let template;
  try {
    const res = await fetch(spec.TEMPLATE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    template = await res.arrayBuffer();
  } catch {
    await downloadWorksheet(answers, filename);
    return { filename, fallback: true };
  }

  const { bytes } = await fillTemplate(PDFLib, template, spec.map(answers), {
    title: spec.TITLE,
    addendum: spec.ADDENDUM
  });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { filename, fallback: false };
}
