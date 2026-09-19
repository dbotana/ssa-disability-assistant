// Filling the official PDF forms.
//
// Both forms are real AcroForms: the Starter Kit has text fields for its
// worksheet and checkboxes for its checklist, and the DS Intake Application
// has a field for every blank. So the download is the agency's own document
// with the answers typed into it, not a look-alike.
//
// A form's boxes are fixed in size, and answers are not. Each value is shrunk
// to fit its box, down to MIN_SIZE; below that it would be unreadable, so the
// value is cut short, marked "(see attached)", and written out in full on an
// addendum page. Rows past a table's printed capacity go to the addendum too.
// Nothing an applicant said is silently dropped.
//
// Fields are left editable rather than flattened, so a caregiver can fix a
// typo in any PDF reader, and the signature lines stay blank for a real
// signature.
//
// fillTemplate() takes pdf-lib and the template bytes as arguments, so tests
// can run it in Node against the real forms. downloadForm() is the browser
// wrapper around it.

import { toWinAnsi } from './forms/common.js';
import { createWriter, loadPdfLib, downloadWorksheet } from './pdf.js';
import { triggerDownload } from './summary.js';
import * as ssaKit from './forms/ssa-starter-kit.js';
import * as dsIntake from './forms/ds-intake.js';

export const FORMS = { ssa: ssaKit, ds: dsIntake };

const MAX_SIZE = 10;
const MIN_SIZE = 7;
const SEE_ATTACHED = ' (see attached)';
// Room pdf-lib keeps between the text and the box's edge, plus a margin so our
// line wrapping never produces fewer lines than pdf-lib's own does.
const INSET_X = 8;
const INSET_Y = 3;

/**
 * Fill a form. Returns { bytes, missing, overflowText }:
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

  const missing = [];
  const overflowText = [];

  for (const [name, raw] of Object.entries(mapping.text ?? {})) {
    const value = toWinAnsi(raw).trim();
    if (!value) continue;
    let field;
    try { field = form.getTextField(name); } catch { missing.push(name); continue; }
    // A few fields on the DS form were authored with no default appearance,
    // and pdf-lib cannot size text without one.
    if (!field.acroField.getDefaultAppearance()) field.acroField.setDefaultAppearance('/Helv 0 Tf 0 g');
    const fit = fitText(field, value, font);
    field.setFontSize(fit.size);
    field.setText(fit.text);
    if (fit.cut) overflowText.push({ label: mapping.labels?.[name] ?? name, value });
  }

  for (const [name, option] of Object.entries(mapping.radios ?? {})) {
    if (option == null || option === '') continue;
    try { form.getRadioGroup(name).select(option); } catch { missing.push(name); }
  }

  for (const name of mapping.checks ?? []) {
    try { form.getCheckBox(name).check(); } catch { missing.push(name); }
  }

  form.updateFieldAppearances(font);

  const tables = mapping.tables ?? [];
  const sections = mapping.sections ?? [];
  if (addendum && (overflowText.length || tables.length || sections.length)) {
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const w = await createWriter(doc, PDFLib, { font, bold });
    w.title(addendum.title);
    for (const line of addendum.intro ?? []) { w.paragraph(line, { size: 10 }); w.gap(4); }

    if (overflowText.length || tables.length) {
      w.heading('Continued from the form');
      for (const { label, value } of overflowText) w.fieldRow(label, value);
      for (const t of tables) {
        w.paragraph(t.title, { size: 11 });
        w.gap(2);
        w.table(t.columns, t.rows, t.itemLabel ?? 'row', { startAt: t.startAt ?? 1 });
      }
    }
    if (sections.length) w.report(sections);
    w.finish(addendum.footer ?? []);
  }

  if (title) doc.setTitle(title);
  doc.setCreator('Voice Assistant for Disability Forms');

  return { bytes: await doc.save(), missing, overflowText };
}

// -- fitting text to a box ----------------------------------------------------

function fitText(field, value, font) {
  const rect = field.acroField.getWidgets()[0].getRectangle();
  const width = Math.max(rect.width - INSET_X, 10);
  const height = Math.max(rect.height - INSET_Y, 6);
  const multiline = field.isMultiline();
  const lineHeight = size => font.heightAtSize(size) * 1.2;

  const fits = (str, size) => {
    if (!multiline) {
      return font.widthOfTextAtSize(str, size) <= width && font.heightAtSize(size) <= height;
    }
    return wrap(str, width, font, size).length * lineHeight(size) <= height;
  };

  // Single-line boxes are sized for their printed type; never go larger than
  // the box is tall.
  const top = multiline ? MAX_SIZE : Math.min(MAX_SIZE, Math.floor(height / 1.05));
  for (let size = top; size >= MIN_SIZE; size -= 0.5) {
    if (fits(value, size)) return { size, text: value, cut: false };
  }

  // Too long at the smallest legible size: keep what fits, point to the rest.
  const size = MIN_SIZE;
  let keep = value;
  while (keep && !fits(`${keep}…${SEE_ATTACHED}`, size)) {
    const lastSpace = keep.lastIndexOf(' ');
    keep = lastSpace > keep.length / 2 ? keep.slice(0, lastSpace) : keep.slice(0, -1);
    keep = keep.replace(/[\s,;:.-]+$/, '');
  }
  const text = keep ? `${keep}…${SEE_ATTACHED}` : SEE_ATTACHED.trim();
  return { size, text, cut: true };
}

/** Word wrap for measuring. Honors explicit line breaks. */
function wrap(str, width, font, size) {
  const lines = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > width && line) { lines.push(line); line = word; }
      else line = test;
      // A single word wider than the box wraps by character in pdf-lib; count it.
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line);
  }
  return lines;
}

// -- browser -------------------------------------------------------------------

/** Filename-safe version of the applicant's name. */
const slug = s => String(s ?? '').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');

/**
 * Fill one form and hand it to the user. Returns { filename, fallback }.
 *
 * If the official form cannot be fetched — offline with nothing cached, or a
 * page opened straight from disk — a plain worksheet of the same answers is
 * downloaded instead, and `fallback` says so.
 */
export async function downloadForm(formId, answers) {
  const spec = FORMS[formId];
  if (!spec) throw new Error(`Unknown form: ${formId}`);

  const who = slug([answers.first_name, answers.last_name].filter(Boolean).join(' '));
  const d = new Date();
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
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), filename);
  return { filename, fallback: false };
}
