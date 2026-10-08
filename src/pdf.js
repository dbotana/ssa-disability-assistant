// PDF writing: replaying addendum draw lists through pdf-lib, and the plain
// worksheet fallback.
//
// Layout itself lives in addendum.js as a pure draw list; this module only
// replays that list onto a pdf-lib document (the Android side replays the
// same list through PDPageContentStream). The official forms are filled by
// fill.js; a worksheet is built from scratch here only when an official form
// cannot be loaded, so a download never fails outright.

import { buildReport } from './summary.js';
import { toWinAnsi } from './forms/common.js';
import { layoutAddendum, COLORS } from './addendum.js';

let pdfLibPromise = null;

/** Load the vendored UMD bundle once. */
export function loadPdfLib() {
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/pdf-lib.min.js';
    s.onload = () => window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib failed to initialize'));
    s.onerror = () => reject(new Error('Could not load the PDF library'));
    document.head.append(s);
  });
  return pdfLibPromise;
}

/**
 * A metrics pair over pdf-lib fonts, the JS side of the `metrics` golden.
 * Both font objects carry Helvetica's standard metrics; the widths are the
 * numbers the Kotlin HelveticaMetrics reads from the golden.
 */
export function fontMetrics(font, boldFont) {
  return {
    regular: {
      widthOfTextAtSize: (text, size) => font.widthOfTextAtSize(toWinAnsi(text), size),
      heightAtSize: size => font.heightAtSize(size)
    },
    bold: {
      widthOfTextAtSize: (text, size) => boldFont.widthOfTextAtSize(toWinAnsi(text), size),
      heightAtSize: size => boldFont.heightAtSize(size)
    }
  };
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
 * A plain worksheet of every answer, built from nothing.
 *
 * The fallback for when an official form cannot be fetched. Better a
 * worksheet than an error. `now` supplies the "prepared on" date.
 */
export async function buildWorksheet(PDFLib, answers, {
  heading = 'Disability Forms Worksheet', now = () => new Date()
} = {}) {
  const doc = await PDFLib.PDFDocument.create();
  doc.setTitle(heading);
  doc.setSubject('Preparation worksheet — not an application');
  doc.setCreator('Voice Assistant for Disability Forms');

  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const drawList = layoutAddendum({
    title: heading,
    intro: [
      'This worksheet was prepared by voice. The official form could not be '
      + 'loaded, so your answers are listed here instead. It is NOT an application '
      + 'and has not been sent to anyone.',
      'HANDLE WITH CARE: this document may contain your Social Security number '
      + 'and bank account numbers. Store it somewhere safe and shred it when you '
      + 'no longer need it.'
    ],
    prepared: `Prepared ${now().toLocaleDateString()}`,
    sections: buildReport(answers),
    footer: ['Disability prep worksheet', 'Not an application. Prepared on the applicant\'s own device.']
  }, fontMetrics(font, bold));

  renderAddendum(doc, PDFLib, drawList, { font, bold });
  return doc.save();
}

/** Build the fallback worksheet and hand it to the user. Returns the filename. */
export async function downloadWorksheet(answers, filename) {
  const PDFLib = await loadPdfLib();
  const bytes = await buildWorksheet(PDFLib, answers);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return filename;
}
