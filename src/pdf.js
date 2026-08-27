// Generated worksheet PDF.
//
// The official Adult Disability Starter Kit PDF has no fillable form fields —
// it is flat artwork with drawn table borders — so there is nothing to fill.
// Stamping text at measured coordinates would also break the moment a user has
// more providers or jobs than the printed rows allow. Instead we generate a
// clean document that mirrors the kit's section structure and paginates to fit
// any number of loop entries.
//
// pdf-lib is loaded as a UMD bundle from vendor/, so it lands on window.PDFLib.

import { buildReport } from './summary.js';
import { triggerDownload } from './summary.js';

const PAGE = { w: 612, h: 792 };          // US Letter
const M = { top: 56, bottom: 56, left: 54, right: 54 };
const CONTENT_W = PAGE.w - M.left - M.right;

let pdfLibPromise = null;

/** Load the vendored UMD bundle once. */
function loadPdfLib() {
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
 * Build the worksheet. Returns a Blob.
 * @param {object} answers raw engine answers
 */
export async function buildPdf(answers) {
  const PDFLib = await loadPdfLib();
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  const doc = await PDFDocument.create();
  doc.setTitle('Social Security Disability Application Worksheet');
  doc.setSubject('Preparation worksheet — not an application');
  doc.setCreator('Voice Assistant for Social Security Disability Prep');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.09, 0.12);
  const muted = rgb(0.42, 0.46, 0.52);
  const rule = rgb(0.75, 0.79, 0.84);

  // -- cursor / pagination -------------------------------------------------
  let page = doc.addPage([PAGE.w, PAGE.h]);
  let y = PAGE.h - M.top;

  const newPage = () => { page = doc.addPage([PAGE.w, PAGE.h]); y = PAGE.h - M.top; };
  const need = h => { if (y - h < M.bottom) newPage(); };

  const text = (str, { x = M.left, size = 11, f = font, color = ink } = {}) => {
    page.drawText(String(str), { x, y, size, font: f, color });
  };

  /** Wrap a string to a width, returning the lines. */
  const wrap = (str, width, f, size) => {
    const words = String(str).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (f.widthOfTextAtSize(test, size) > width && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  };

  const paragraph = (str, { size = 10, f = font, color = muted, gap = 4 } = {}) => {
    for (const line of wrap(str, CONTENT_W, f, size)) {
      need(size + gap);
      text(line, { size, f, color });
      y -= size + gap;
    }
  };

  const heading = str => {
    need(46);
    y -= 14;
    text(str, { size: 14, f: bold });
    y -= 6;
    page.drawLine({
      start: { x: M.left, y }, end: { x: PAGE.w - M.right, y },
      thickness: 1, color: rule
    });
    y -= 16;
  };

  /** Label/value row, wrapping long values under a fixed-width label column. */
  const fieldRow = (label, value) => {
    const labelW = 190;
    const valueW = CONTENT_W - labelW - 10;
    const lines = wrap(value || '—', valueW, font, 11);
    need(Math.max(lines.length * 15, 15) + 4);
    text(label, { size: 11, f: bold });
    lines.forEach((line, i) => {
      page.drawText(line, {
        x: M.left + labelW + 10, y, size: 11, font,
        color: value ? ink : muted
      });
      if (i < lines.length - 1) { y -= 15; need(15); }
    });
    y -= 19;
  };

  /**
   * Tabular block. Wide loops (more columns than fit legibly across the page)
   * are rendered as stacked records instead — a 6-column table at Letter width
   * shreds its headers into unreadable fragments, which is worse than useless
   * on a document someone will read at an SSA appointment.
   */
  const table = (columns, rows, label) => {
    if (columns.length > 4) return records(columns, rows, label);

    // Give each column a share of the width proportional to its content.
    const weights = columns.map((col, i) => {
      const longest = Math.max(
        bold.widthOfTextAtSize(col.label, 9),
        ...rows.map(r => font.widthOfTextAtSize(String(r[i] || '—'), 10))
      );
      return Math.max(longest, 60);
    });
    const totalW = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map(w => Math.max((w / totalW) * CONTENT_W, 70));
    const scale = CONTENT_W / colW.reduce((a, b) => a + b, 0);
    colW.forEach((w, i) => { colW[i] = w * scale; });

    const drawHeader = () => {
      const headLines = columns.map((col, i) => wrap(col.label, colW[i] - 8, bold, 9));
      const headH = Math.max(...headLines.map(l => l.length)) * 11 + 10;
      need(headH + 20);
      let x = M.left;
      headLines.forEach((lines, i) => {
        lines.forEach((line, li) => {
          page.drawText(line, { x, y: y - li * 11, size: 9, font: bold, color: ink });
        });
        x += colW[i];
      });
      y -= headH;
      page.drawLine({
        start: { x: M.left, y: y + 6 }, end: { x: PAGE.w - M.right, y: y + 6 },
        thickness: 0.75, color: rule
      });
      y -= 4;
    };

    drawHeader();

    for (const row of rows) {
      const cells = row.map((cell, i) => wrap(cell || '—', colW[i] - 8, font, 10));
      const rowH = Math.max(...cells.map(c => c.length)) * 13 + 8;
      if (y - rowH < M.bottom) { newPage(); drawHeader(); }
      let x = M.left;
      cells.forEach((lines, i) => {
        lines.forEach((line, li) => {
          page.drawText(line, { x, y: y - li * 13, size: 10, font, color: row[i] ? ink : muted });
        });
        x += colW[i];
      });
      y -= rowH;
      page.drawLine({
        start: { x: M.left, y: y + 6 }, end: { x: PAGE.w - M.right, y: y + 6 },
        thickness: 0.4, color: rule
      });
      y -= 4;
    }
    y -= 6;
  };

  /** Stacked record rendering for wide loops (jobs, marriages). */
  const records = (columns, rows, label) => {
    rows.forEach((row, idx) => {
      need(34);
      text(`${titleCase(label)} ${idx + 1}`, { size: 11, f: bold });
      y -= 17;
      columns.forEach((col, i) => fieldRow(col.label, row[i]));
      y -= 4;
    });
  };

  const titleCase = s => String(s).replace(/^(.)/, (_, c) => c.toUpperCase());

  // -- cover block ---------------------------------------------------------
  text('Social Security Disability', { size: 22, f: bold });
  y -= 26;
  text('Application Worksheet', { size: 22, f: bold });
  y -= 30;

  paragraph(
    'This worksheet was prepared by voice to help you get ready to apply for '
    + 'Social Security disability benefits at www.ssa.gov/apply or at your '
    + 'appointment. It is NOT an application and has not been sent to the '
    + 'Social Security Administration.',
    { size: 10 }
  );
  y -= 4;
  paragraph(
    'HANDLE WITH CARE: this document may contain your Social Security number '
    + 'and bank account numbers. Store it somewhere safe and shred it when you '
    + 'no longer need it.',
    { size: 10, f: bold, color: ink }
  );
  y -= 4;
  paragraph(`Prepared ${new Date().toLocaleDateString()}`, { size: 9 });
  y -= 8;

  // -- sections ------------------------------------------------------------
  for (const section of buildReport(answers)) {
    heading(section.title);
    for (const block of section.blocks) {
      if (block.kind === 'table') {
        if (block.empty) {
          paragraph(`No ${block.label} recorded.`, { size: 10 });
          y -= 4;
          continue;
        }
        table(block.columns, block.rows, block.label);
        continue;
      }
      fieldRow(block.label, block.value);
    }
  }

  // -- footer, every page --------------------------------------------------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    p.drawText(`Disability prep worksheet — page ${i + 1} of ${pages.length}`, {
      x: M.left, y: 32, size: 8, font, color: muted
    });
    p.drawText('Not an application. Prepared on the applicant\'s own device.', {
      x: M.left, y: 21, size: 8, font, color: muted
    });
  });

  const bytes = await doc.save();
  return new Blob([bytes], { type: 'application/pdf' });
}

/** Build and hand the file to the user. Returns the filename. */
export async function downloadPdf(answers, answersName = null) {
  const blob = await buildPdf(answers);
  const stamp = new Date().toISOString().slice(0, 10);
  const who = (answersName || '').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  const filename = `disability-worksheet${who ? `-${who}` : ''}-${stamp}.pdf`;
  triggerDownload(blob, filename);
  return filename;
}
