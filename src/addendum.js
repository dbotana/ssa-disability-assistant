// Addendum layout: pages of text, planned as a draw list.
//
// The official forms have fixed boxes, and some answers never fit: a ninth
// doctor, a long list of diagnoses, everything the Starter Kit's checklist
// asks you to have ready but gives you nowhere to write. Those go on addendum
// pages appended to the filled form.
//
// layoutAddendum() is pure: content plus a width-measuring function produce a
// list of typed draw operations with explicit coordinates. The web app replays
// the list through pdf-lib; Android replays it through PDPageContentStream.
// Because the draw list is data, it is golden-pinned and both renderers must
// produce it identically — L1 parity from the plan.

export const PAGE = { w: 612, h: 792 };          // US Letter
export const M = { top: 56, bottom: 56, left: 54, right: 54 };
export const CONTENT_W = PAGE.w - M.left - M.right;

export const INK = 'ink';
export const MUTED = 'muted';
export const RULE = 'rule';

const titleCase = s => String(s).replace(/^(.)/, (_, c) => c.toUpperCase());

/**
 * Wrap a string to a width, returning the lines. Matches fitTextBox's rules:
 * words wrap at spaces, a long word sits on its own line, no character
 * breaking — the same lines the replayers draw.
 */
function wrap(str, width, metrics, size) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (metrics.widthOfTextAtSize(test, size) > width && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * Plan the addendum pages.
 *
 * @param {object} content  { title, intro[], overflowText[], tables[], sections[], footer[] }
 * @param {{ regular: object, bold: object }} fonts
 *        two metrics objects ({ widthOfTextAtSize }) — Helvetica and
 *        Helvetica-Bold. The Kotlin port passes HelveticaMetrics from the
 *        golden `metrics` fixture.
 * @returns {{ pages: Array<Array<{op, ...}>> }}
 *   each page is a list of draw ops:
 *     { op:'text', x, y, text, size, font:'regular'|'bold', color:'ink'|'muted' }
 *     { op:'rule', x, y, width, thickness }
 *   Coordinates are PDF space, from the bottom-left.
 */
export function layoutAddendum(content, { regular, bold }) {
  const pages = [];
  let page = null;
  let y = 0;

  const newPage = () => {
    page = [];
    pages.push(page);
    y = PAGE.h - M.top;
  };
  const need = h => { if (!page || y - h < M.bottom) newPage(); };
  const gap = (h = 8) => { y -= h; };

  const text = (str, { x = M.left, size = 11, f = regular, color = INK }) => {
    page.push({ op: 'text', x, y, text: str, size, font: f === bold ? 'bold' : 'regular', color });
  };

  const paragraph = (str, { size = 10, f = regular, color = MUTED, gap = 4 } = {}) => {
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
    page.push({ op: 'rule', x: M.left, y, width: PAGE.w - M.right - M.left, thickness: 1 });
    y -= 16;
  };

  /** Label/value row, wrapping long values under a fixed-width label column. */
  const fieldRow = (label, value) => {
    const labelW = 190;
    const valueW = CONTENT_W - labelW - 10;
    const labelLines = wrap(label, labelW, bold, 11);
    const lines = wrap(value || '—', valueW, regular, 11);
    const rows = Math.max(lines.length, labelLines.length);
    need(Math.max(rows * 15, 15) + 4);
    for (let i = 0; i < rows; i++) {
      if (labelLines[i]) text(labelLines[i], { size: 11, f: bold });
      if (lines[i] != null) {
        page.push({
          op: 'text', x: M.left + labelW + 10, y,
          text: lines[i], size: 11, font: 'regular', color: value ? INK : MUTED
        });
      }
      if (i < rows - 1) { y -= 15; need(15); }
    }
    y -= 19;
  };

  /**
   * Tabular block. Wide loops (more columns than fit legibly across the page)
   * are rendered as stacked records instead.
   */
  const table = (columns, rows, label, { startAt = 1 } = {}) => {
    if (columns.length > 4) return records(columns, rows, label, { startAt });

    // Give each column a share of the width proportional to its content.
    const weights = columns.map((col, i) => {
      const longest = Math.max(
        bold.widthOfTextAtSize(col.label, 9),
        ...rows.map(r => regular.widthOfTextAtSize(r[i] || '—', 10))
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
          page.push({ op: 'text', x, y: y - li * 11, text: line, size: 9, font: 'bold', color: INK });
        });
        x += colW[i];
      });
      y -= headH;
      page.push({ op: 'rule', x: M.left, y: y + 6, width: PAGE.w - M.right - M.left, thickness: 0.75 });
      y -= 4;
    };

    drawHeader();

    for (const row of rows) {
      const cells = row.map((cell, i) => wrap(cell || '—', colW[i] - 8, regular, 10));
      const rowH = Math.max(...cells.map(c => c.length)) * 13 + 8;
      if (y - rowH < M.bottom) { newPage(); drawHeader(); }
      let x = M.left;
      cells.forEach((lines, i) => {
        lines.forEach((line, li) => {
          page.push({ op: 'text', x, y: y - li * 13, text: line, size: 10, font: 'regular', color: row[i] ? INK : MUTED });
        });
        x += colW[i];
      });
      y -= rowH;
      page.push({ op: 'rule', x: M.left, y: y + 6, width: PAGE.w - M.right - M.left, thickness: 0.4 });
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

  if (content.title) title(content.title);
  for (const line of content.intro ?? []) { paragraph(line, { size: 10 }); }
  if (content.prepared) { paragraph(content.prepared, { size: 9 }); }

  if ((content.overflowText?.length ?? 0) || (content.tables?.length ?? 0)) {
    heading('Continued from the form');
    for (const { label, value } of content.overflowText ?? []) fieldRow(label, value);
    for (const t of content.tables ?? []) {
      paragraph(t.title, { size: 11 });
      gap(2);
      table(t.columns, t.rows, t.itemLabel ?? 'row', { startAt: t.startAt ?? 1 });
    }
  }
  if (content.sections?.length) report(content.sections);

  // Footers are stamped on pages this layout created, in the replayer: the
  // draw list records them so both renderers agree. Carried alongside so the
  // replayer needs only the draw list.
  finish(content.footer ?? [], pages);

  return { pages };
}

function finish(footerLines, pages) {
  const [first, second] = footerLines;
  pages.forEach((page, i) => {
    page.push({
      op: 'text', x: M.left, y: 32,
      text: `${first ?? 'Additional information'} — page ${i + 1} of ${pages.length}`,
      size: 8, font: 'regular', color: MUTED
    });
    if (second) {
      page.push({ op: 'text', x: M.left, y: 21, text: second, size: 8, font: 'regular', color: MUTED });
    }
  });
}

/** The colors the replayers resolve 'ink', 'muted' and 'rule' to. */
export const COLORS = {
  ink: { r: 0.07, g: 0.09, b: 0.12 },
  muted: { r: 0.42, g: 0.46, b: 0.52 },
  rule: { r: 0.75, g: 0.79, b: 0.84 }
};
