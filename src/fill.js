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
import { buildManifest } from './manifest.js';
import { planFill } from './plan.js';
import { exportFileName } from './export-name.js';
import { layoutAddendum } from './addendum.js';
import { loadPdfLib, downloadWorksheet, fontMetrics } from './pdf.js';
import { writeFilledPdf } from './pdf-writer.js';
import { translate } from './i18n/index.js';
import * as ssaKit from './forms/ssa-starter-kit.js';
import * as dsIntake from './forms/ds-intake.js';

export const FORMS = { ssa: ssaKit, ds: dsIntake };

/**
 * Fill a form from a plan. Returns { bytes, missing, overflowText }:
 *   bytes         the finished PDF
 *   missing       field names the mapping used that the template lacks — a
 *                 test failure, never expected at runtime
 *   overflowText  [{ label, value }] answers too long for their box
 */
export async function fillTemplate(PDFLib, templateBytes, mapping, { title, addendum = null, lang = 'en' } = {}) {
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

  const overflowText = [...plan.overflowText];
  const tables = plan.tables;
  const sections = plan.sections;
  let drawList = null;
  if (addendum && (overflowText.length || tables.length || sections.length)) {
    // The bold metrics only feed layoutAddendum; the real document still gets
    // its bold font inside the writer, at the same point it always did.
    const scratch = await PDFDocument.create();
    const boldForMetrics = await scratch.embedFont(StandardFonts.HelveticaBold);
    drawList = layoutAddendum({
      title: translate(addendum.title, lang),
      intro: (addendum.intro ?? []).map(line => translate(line, lang)),
      overflowText,
      tables,
      sections,
      footer: (addendum.footer ?? []).map(line => translate(line, lang))
    }, { ...fontMetrics(font, boldForMetrics), lang });
  }

  return writeFilledPdf(PDFLib, doc, {
    plan,
    manifest,
    drawList,
    title,
    creator: translate('Voice Assistant for Disability Forms', lang),
    font
  });
}

/** Re-exported for tests and the golden generator. */
export { planFill, layoutAddendum, buildManifest, writeFilledPdf };

// -- browser -------------------------------------------------------------------

/**
 * Fill one form and hand it to the user. Returns { filename, fallback }.
 *
 * If the official form cannot be fetched — offline with nothing cached, or a
 * page opened straight from disk — a plain worksheet of the same answers is
 * downloaded instead, and `fallback` says so. `now` supplies the date stamp
 * in the filename.
 */
export async function downloadForm(formId, answers, { now = () => new Date(), lang = 'en' } = {}) {
  const spec = FORMS[formId];
  if (!spec) throw new Error(`Unknown form: ${formId}`);

  // One version per form on the web, as before: no suffix (export-name.js).
  const filename = exportFileName(formId, answers, now());

  const PDFLib = await loadPdfLib();
  let template;
  try {
    const res = await fetch(spec.TEMPLATE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    template = await res.arrayBuffer();
  } catch {
    await downloadWorksheet(answers, filename, { lang });
    return { filename, fallback: true };
  }

  const { bytes } = await fillTemplate(PDFLib, template, spec.map(answers, { lang }), {
    title: translate(spec.TITLE, lang),
    addendum: spec.ADDENDUM,
    lang
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
