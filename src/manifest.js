// The template manifest: everything planFill needs to know about a template's
// fields, read from the PDF once.
//
// The Android port never trusts PDFBox's 32-bit reals for box sizes; it reads
// this manifest from the `templateManifest` golden instead. So the shape here
// is the contract between the two implementations, and the golden generator
// (tools/golden/templateManifest.mjs) pins it. A contract test fails if a
// template revision adds comb fields, MaxLen or /Opt — none of which either
// form has today.

const DA_RE = /(\/[\w-]+)[\s\S]*?([\d.]+)\s+Tf/;

/** Parse a default-appearance string like "/Helv 10 Tf 0 g" or null. */
export function parseDa(da) {
  const s = String(da ?? '');
  const m = DA_RE.exec(s);
  if (!m) return null;
  const size = Number(m[2]);
  return { font: m[1], size: Number.isFinite(size) ? size : null, raw: s };
}

/**
 * Read every field of a template into the manifest shape.
 *
 * @param {object} form   a pdf-lib PDFForm
 * @param {object} PDFLib the pdf-lib namespace (for class checks)
 * @returns {{ fields: { [name]: { type, width, height, multiline, quadding,
 *                                 comb, maxLen, da, widgets, onStates } } }}
 */
export function buildManifest(form, PDFLib) {
  const fields = {};
  for (const field of form.getFields()) {
    const entry = {};
    if (field instanceof PDFLib.PDFTextField) {
      entry.type = 'text';
      const rect = field.acroField.getWidgets()[0].getRectangle();
      entry.width = rect.width;
      entry.height = rect.height;
      entry.multiline = field.isMultiline();
      entry.quadding = field.acroField.getQuadding();
      entry.comb = field.isCombed();
      entry.maxLen = field.getMaxLength() ?? null;
    } else if (field instanceof PDFLib.PDFCheckBox) {
      entry.type = 'checkbox';
      entry.onStates = field.acroField.getWidgets()
        .map(w => w.getOnValue()?.decodeText() ?? null);
    } else if (field instanceof PDFLib.PDFRadioGroup) {
      entry.type = 'radio';
      entry.onStates = field.getOptions();
    } else if (field instanceof PDFLib.PDFSignature) {
      entry.type = 'signature';
    } else {
      entry.type = 'other';
    }

    entry.da = parseDa(field.acroField.getDefaultAppearance());
    entry.widgets = field.acroField.getWidgets().map(w => ({
      da: parseDa(w.getDefaultAppearance())
    }));
    fields[field.getName()] = entry;
  }
  return { fields };
}
