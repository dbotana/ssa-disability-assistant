#!/usr/bin/env node
// M1a's measurement table: reads the JSON records the :pdf instrumentation
// publishes beside each filled PDF, checks the size budget, and prints a
// Markdown table plus the viewer result. Plain Node, read-only.
//
//   node android/tools/pdf-spike-report.mjs <dir>
//
// <dir> is the connected_android_test_additional_output folder, or any
// ancestor; the walk finds the per-device subfolders.

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node android/tools/pdf-spike-report.mjs <dir>');
  process.exit(2);
}

/** Every file under [root], recursively. */
function walk(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.error(`pdf-spike-report: ${dir} is not a directory`);
  process.exit(1);
}

const files = walk(dir);
const pdfs = new Set(files.filter((f) => f.endsWith('.pdf')));
const jsonFiles = files.filter((f) => f.endsWith('.json')).sort();
const failures = [];
const records = [];
const viewers = [];

for (const file of jsonFiles) {
  const base = path.basename(file);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    failures.push(`${file}: not valid JSON (${e.message})`);
    continue;
  }

  if (base.startsWith('viewer-') || file.includes(`${path.sep}viewer${path.sep}`)) {
    for (const key of ['form', 'sdk', 'pages', 'planned', 'drawn']) {
      if (record[key] === undefined) failures.push(`${file}: viewer record has no ${key}`);
    }
    viewers.push({ file, record });
    continue;
  }

  const sibling = file.slice(0, -'.json'.length) + '.pdf';
  if (!pdfs.has(sibling)) continue;

  let bad = false;
  const reject = (message) => {
    failures.push(`${file}: ${message}`);
    bad = true;
  };
  if (record.timings === null || typeof record.timings !== 'object') {
    reject('no timings object');
    continue;
  }
  for (const key of ['bytes', 'templateBytes']) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || record[key] <= 0) {
      reject(`${key} is missing or not a positive number`);
    }
  }
  const t = record.timings;
  for (const key of ['loadMs', 'fillMs', 'saveMs', 'checkMs']) {
    if (typeof t[key] !== 'number' || !Number.isFinite(t[key])) {
      reject(`timings.${key} is missing or not a number`);
    }
  }
  if (bad) continue;

  const totalMs = t.loadMs + t.fillMs + t.saveMs + t.checkMs;
  const ratio = record.bytes / record.templateBytes;
  if (ratio > 2) failures.push(`${file}: output is ${ratio.toFixed(2)}x the template (limit 2.00)`);
  records.push({ file, record, totalMs, ratio });
}

if (records.length === 0) failures.push(`${dir}: no PDF records found`);

records.sort((a, b) =>
  `${a.record.case}/${a.record.form}`.localeCompare(`${b.record.case}/${b.record.form}`));

const lines = ['# PDF spike report', ''];
if (records.length > 0) {
  lines.push('| case | form | template bytes | output bytes | ratio | load ms | fill ms | save ms | check ms | total ms | addendum pages |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const { record: r, totalMs, ratio } of records) {
    const t = r.timings;
    lines.push(
      `| ${r.case} | ${r.form} | ${r.templateBytes} | ${r.bytes} | ${ratio.toFixed(2)} | ` +
      `${t.loadMs} | ${t.fillMs} | ${t.saveMs} | ${t.checkMs} | ${totalMs} | ${r.addendumPages ?? '?'} |`);
  }
  lines.push('');

  const devices = [...new Set(records.map(({ record: r }) => r.device).filter(Boolean))];
  const maxRatio = Math.max(...records.map((r) => r.ratio));
  const maxTotal = Math.max(...records.map((r) => r.totalMs));
  lines.push(`device: ${devices.join('; ') || 'unknown'}`);
  lines.push(`max ratio: ${maxRatio.toFixed(2)} (limit 2.00)`);
  lines.push(`max total ms: ${maxTotal} (3 s target, 6 s ceiling)`);
  lines.push(`size budget: ${maxRatio <= 2 ? 'ok' : 'FAILED'}`);
  lines.push(`time budget: ${maxTotal <= 3000 ? 'ok' : maxTotal <= 6000 ? 'over target' : 'FAILED'}`);
}

if (viewers.length > 0) {
  lines.push('', '## Viewer (Android PdfRenderer)', '');
  lines.push('| form | sdk | pages | drawn/planned |');
  lines.push('|---|---:|---:|---:|');
  for (const { record: r } of viewers) {
    lines.push(`| ${r.form} | ${r.sdk} | ${r.pages} | ${r.drawn}/${r.planned} |`);
  }
}

console.log(lines.join('\n'));

if (failures.length > 0) {
  console.error('');
  for (const failure of failures) console.error(`pdf-spike-report: ${failure}`);
  process.exit(1);
}
