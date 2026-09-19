// PDF layout: pages of text written with pdf-lib.
//
// The official forms are filled in by fill.js, but a form has a fixed number
// of rows and fixed-width boxes, and some answers never fit: a ninth doctor,
// a long list of diagnoses, and everything the Starter Kit's checklist asks
// you to have ready but gives you nowhere to write. Those go on addendum pages
// appended to the filled form, and this module lays them out. It paginates to
// fit any number of entries and repeats table headers across page breaks.
//
// It also builds a plain worksheet from scratch, used only when an official
// form cannot be loaded, so a download never fails outright.
//
// pdf-lib is loaded as a UMD bundle from vendor/, so it lands on window.PDFLib.

import { buildReport, triggerDownload } from './summary.js';
import { toWinAnsi } from './forms/common.js';

const PAGE = { w: 612, h: 792 };          // US Letter
const M = { top: 56, bottom: 56, left: 54, right: 54 };
const CONTENT_W = PAGE.w - M.left - M.right;

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
 * A writer that appends text pages to `doc`.
 *
 * Every page it creates is remembered, so footers are stamped on those pages
 * only and never over the artwork of a form the pages were appended to.
 */
export async function createWriter(doc, PDFLib, fonts = {}) {
  const { StandardFonts, rgb } = PDFLib;
  const font = fonts.font ?? await doc.embedFont(StandardFonts.Helvetica);
  const bold = fonts.bold ?? await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.09, 0.12);
  const muted = rgb(0.42, 0.46, 0.52);
  const rule = rgb(0.75, 0.79, 0.84);

  const added = [];
  let page = null;
  let y = 0;

  const newPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    added.push(page);
    y = PAGE.h - M.top;
  };
  const need = h => { if (!page || y - h < M.bottom) newPage(); };

  const text = (str, { x = M.left, size = 11, f = font, color = ink } = {}) => {
    page.drawText(toWinAnsi(str), { x, y, size, font: f, color });
  };

  /** Wrap a string to a width, returning the lines. */
  const wrap = (str, width, f, size) => {
    const words = toWinAnsi(str).split(/\s+/).filter(Boolean);
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

  const title = str => {
    need(40);
    for (const line of wrap(str, CONTENT_W, bold, 20)) {
      need(26);
      text(line, { size: 20, f: bold });
      y -= 26;
    }
    y -= 6;
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
    const labelLines = wrap(label, labelW, bold, 11);
    const lines = wrap(value || '—', valueW, font, 11);
    const rows = Math.max(lines.length, labelLines.length);
    need(Math.max(rows * 15, 15) + 4);
    for (let i = 0; i < rows; i++) {
      if (labelLines[i]) text(labelLines[i], { size: 11, f: bold });
      if (lines[i] != null) {
        page.drawText(lines[i], {
          x: M.left + labelW + 10, y, size: 11, font,
          color: value ? ink : muted
        });
      }
      if (i < rows - 1) { y -= 15; need(15); }
    }
    y -= 19;
  };

  /**
   * Tabular block. Wide loops (more columns than fit legibly across the page)
   * are rendered as stacked records instead — a 6-column table at Letter width
   * shreds its headers into unreadable fragments, which is worse than useless
   * on a document someone will read at an appointment.
   */
  const table = (columns, rows, label, { startAt = 1 } = {}) => {
    if (columns.length > 4) return records(columns, rows, label, { startAt });

    // Give each column a share of the width proportional to its content.
    const weights = columns.map((col, i) => {
      const longest = Math.max(
        bold.widthOfTextAtSize(toWinAnsi(col.label), 9),
        ...rows.map(r => font.widthOfTextAtSize(toWinAnsi(r[i] || '—'), 10))
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
  const records = (columns, rows, label, { startAt = 1 } = {}) => {
    rows.forEach((row, idx) => {
      need(34);
      text(`${titleCase(label)} ${startAt + idx}`, { size: 11, f: bold });
      y -= 17;
      columns.forEach((col, i) => fieldRow(col.label, row[i]));
      y -= 4;
    });
  };

  /** Sections shaped like buildReport()'s output. */
  const report = sections => {
    for (const section of sections) {
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
  };

  /** Stamp a footer on every page this writer added. */
  const finish = (lines = []) => {
    added.forEach((p, i) => {
      const [first, second] = lines;
      p.drawText(toWinAnsi(`${first ?? 'Additional information'} — page ${i + 1} of ${added.length}`), {
        x: M.left, y: 32, size: 8, font, color: muted
      });
      if (second) {
        p.drawText(toWinAnsi(second), { x: M.left, y: 21, size: 8, font, color: muted });
      }
    });
  };

  const gap = (h = 8) => { y -= h; };

  return { title, heading, paragraph, fieldRow, table, records, report, finish, gap, pageCount: () => added.length };
}

const titleCase = s => String(s).replace(/^(.)/, (_, c) => c.toUpperCase());

/**
 * A plain worksheet of every answer, built from nothing.
 *
 * The fallback for when an official form cannot be fetched — offline with an
 * empty cache, or a page opened from disk. Better a worksheet than an error.
 */
export async function buildWorksheet(PDFLib, answers, { heading = 'Disability Forms Worksheet' } = {}) {
  const doc = await PDFLib.PDFDocument.create();
  doc.setTitle(heading);
  doc.setSubject('Preparation worksheet — not an application');
  doc.setCreator('Voice Assistant for Disability Forms');

  const w = await createWriter(doc, PDFLib);
  w.title(heading);
  w.paragraph(
    'This worksheet was prepared by voice. The official form could not be '
    + 'loaded, so your answers are listed here instead. It is NOT an application '
    + 'and has not been sent to anyone.',
    { size: 10 }
  );
  w.gap(4);
  w.paragraph(
    'HANDLE WITH CARE: this document may contain your Social Security number '
    + 'and bank account numbers. Store it somewhere safe and shred it when you '
    + 'no longer need it.',
    { size: 10 }
  );
  w.paragraph(`Prepared ${new Date().toLocaleDateString()}`, { size: 9 });
  w.report(buildReport(answers));
  w.finish(['Disability prep worksheet', 'Not an application. Prepared on the applicant\'s own device.']);

  return doc.save();
}

/** Build the fallback worksheet and hand it to the user. Returns the filename. */
export async function downloadWorksheet(answers, filename) {
  const PDFLib = await loadPdfLib();
  const bytes = await buildWorksheet(PDFLib, answers);
  triggerDownload(new Blob([bytes], { type: 'application/pdf' }), filename);
  return filename;
}
