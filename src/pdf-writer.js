// The PDF writing half of fill.js, split out so the iOS app can run it inside
// JavaScriptCore without the browser-side download and planning code.
//
// Everything here takes a finished plan and a draw list, exactly as Android's
// AcroFormWriter does, and applies them to a pdf-lib document. The planning
// half (planFill, layoutAddendum, buildManifest) stays in the modules that own
// it; this module only draws.

import { toWinAnsi } from './winansi.js';
import { parseDa, buildManifest } from './manifest.js';
import { COLORS } from './addendum-colors.js';

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
 * Replay an addendum draw list onto `doc` with `PDFLib`.
 *
 * Every page the list describes is added by this function, so nothing the
 * replayer draws ever lands over the artwork of a form the pages were
 * appended to.
 */
export function renderAddendum(doc, PDFLib, drawList, { font, bold }) {
  const { rgb } = PDFLib;
  const fonts = { regular: font, bold };
  const colors = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, rgb(c.r, c.g, c.b)]));

  for (const items of drawList.pages) {
    const page = doc.addPage([612, 792]);
    for (const item of items) {
      if (item.op === 'text') {
        page.drawText(toWinAnsi(item.text), {
          x: item.x, y: item.y, size: item.size,
          font: fonts[item.font], color: colors[item.color]
        });
      } else if (item.op === 'rule') {
        page.drawLine({
          start: { x: item.x, y: item.y },
          end: { x: item.x + item.width, y: item.y },
          thickness: item.thickness, color: colors.rule
        });
      }
    }
  }
  return drawList.pages.length;
}

/**
 * Apply a finished plan and an optional addendum draw list to a loaded
 * pdf-lib document. Returns { bytes, missing, overflowText }.
 */
export async function writeFilledPdf(PDFLib, doc, { plan, manifest, drawList = null, title = null, creator = null, font = null }) {
  const { StandardFonts } = PDFLib;
  const form = doc.getForm();
  font = font ?? await doc.embedFont(StandardFonts.Helvetica);

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

  if (drawList && drawList.pages.length) {
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    renderAddendum(doc, PDFLib, drawList, { font, bold });
  }

  if (title) doc.setTitle(title);
  if (creator) doc.setCreator(creator);

  return { bytes: await doc.save(), missing, overflowText };
}

/**
 * Load a template and fill it from a finished plan. The iOS entry point: the
 * host hands in the template bytes, the plan and (optionally) the addendum
 * draw list, and gets the finished PDF bytes back.
 */
export async function fillFromPlan(PDFLib, templateBytes, { plan, drawList = null, title = null, creator = null, updateMetadata = true }) {
  const { PDFDocument, StandardFonts } = PDFLib;
  const doc = await PDFDocument.load(templateBytes, { updateMetadata });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const manifest = buildManifest(doc.getForm(), PDFLib);
  return writeFilledPdf(PDFLib, doc, { plan, manifest, drawList, title, creator, font });
}
