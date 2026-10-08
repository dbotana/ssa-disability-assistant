// Pure fill planning: a mapping plus a template manifest produce fit
// decisions, overflow, and the addendum content. No pdf-lib here.
//
// This is the seam between the JS reference and the Android port: both sides
// run this logic against the same numbers. The metrics object is pdf-lib's
// Helvetica in the browser (and in the golden generator), and HelveticaMetrics
// — built from the golden `metrics` fixture — in Kotlin. Because both read the
// same widths, and both sum them in the same order, the doubles agree exactly.
//
// planFill() is deliberately blind to *how* a PDF is written: it knows box
// sizes and field flags from the manifest, not from a live document, so the
// Android writer can draw its own appearance streams from the same plan.
// pdf-lib's own appearance generator is what renders this plan on the web.

export const MAX_SIZE = 10;
export const MIN_SIZE = 7;
export const SEE_ATTACHED = ' (see attached)';
// Room pdf-lib keeps between the text and the box's edge, plus a margin so our
// line wrapping never produces fewer lines than pdf-lib's own does. Android
// draws inside the same inset.
export const INSET_X = 8;
export const INSET_Y = 3;

/**
 * Wrap a string to a width, returning the lines.
 *
 * Words wrap at spaces; an explicit newline ends a line. A word wider than the
 * box goes on a line of its own — pdf-lib does not break words, and neither
 * does the Android appearance writer, so measured lines match drawn lines.
 */
export function wrapLines(str, width, metrics, size) {
  const lines = [];
  for (const para of String(str).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (metrics.widthOfTextAtSize(test, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Fit a value into a box. Returns { size, text, cut, lines }.
 *
 * The value is shrunk down to MIN_SIZE; below that it would be unreadable, so
 * it is cut short, marked "(see attached)", and written out in full on an
 * addendum page. `box` is { width, height, multiline }, as the manifest
 * records it — never read from a live PDF, so the Android side never depends
 * on PDFBox's 32-bit floats.
 */
export function fitTextBox(box, rawValue, metrics) {
  // A single-line box cannot render a newline; pdf-lib throws on one.
  const value = box.multiline
    ? String(rawValue)
    : String(rawValue).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  const width = Math.max(box.width - INSET_X, 10);
  const height = Math.max(box.height - INSET_Y, 6);
  const lineHeight = size => metrics.heightAtSize(size) * 1.2;

  const fits = (str, size) => {
    if (!box.multiline) {
      return metrics.widthOfTextAtSize(str, size) <= width && metrics.heightAtSize(size) <= height;
    }
    return wrapLines(str, width, metrics, size).length * lineHeight(size) <= height;
  };

  // Single-line boxes are sized for their printed type; never go larger than
  // the box is tall.
  const top = box.multiline ? MAX_SIZE : Math.min(MAX_SIZE, Math.floor(height / 1.05));
  for (let size = top; size >= MIN_SIZE; size -= 0.5) {
    if (fits(value, size)) {
      return { size, text: value, cut: false, lines: wrapLines(value, width, metrics, size) };
    }
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
  return { size, text, cut: true, lines: wrapLines(text, width, metrics, size) };
}

/**
 * Plan one form fill.
 *
 * @param {object} mapping   a form spec's map(answers) output
 * @param {object} manifest  buildManifest() output for the template
 * @param {object} metrics   { widthOfTextAtSize, heightAtSize }
 * @returns {{
 *   fields: [{name, value, fit: {size, text, cut, lines}, label}],
 *   missing: string[],           names the mapping used that the manifest lacks
 *   overflowText: [{label, value}],
 *   radios: object, checks: string[], tables, sections
 * }}
 */
export function planFill(mapping, manifest, metrics) {
  const fields = [];
  const missing = [];
  const overflowText = [];

  for (const [name, raw] of Object.entries(mapping.text ?? {})) {
    const box = manifest?.fields?.[name];
    if (!box || box.type !== 'text') {
      missing.push(name);
      continue;
    }
    const value = String(raw).trim();
    if (!value) continue;
    const fit = fitTextBox(box, value, metrics);
    fields.push({ name, value, fit, label: mapping.labels?.[name] ?? name });
    if (fit.cut) overflowText.push({ label: mapping.labels?.[name] ?? name, value });
  }

  return {
    fields,
    missing,
    overflowText,
    radios: mapping.radios ?? {},
    checks: mapping.checks ?? [],
    tables: mapping.tables ?? [],
    sections: mapping.sections ?? []
  };
}
