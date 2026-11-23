// The generated iOS writer bundle: fresh, network-free, and byte-identical to
// the ESM writer when both fill the same plan.
//
// Makes no network requests. It loads vendor/pdf-lib.min.js and
// vendor/ssa-pdf-writer.js inside a bare node:vm context, which is the closest
// Node comes to JavaScriptCore: no window, no document, no timers except what
// the bundle's setTimeout shim supplies.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { buildIosWriter } from '../tools/build-ios-writer.mjs';
import { fillFromPlan } from '../src/pdf-writer.js';
import * as dsIntake from '../src/forms/ds-intake.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const PDFLib = require(join(ROOT, 'vendor', 'pdf-lib.min.js'));

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

const bundle = buildIosWriter();
check('the bundle matches the committed vendor copy', bundle === readFileSync(join(ROOT, 'vendor', 'ssa-pdf-writer.js'), 'utf8'));

const ctx = vm.createContext({});
vm.runInContext(readFileSync(join(ROOT, 'vendor', 'pdf-lib.min.js'), 'utf8'), ctx);
vm.runInContext(bundle, ctx);
check('fetch, XMLHttpRequest and WebSocket are undefined',
  vm.runInContext('[typeof fetch, typeof XMLHttpRequest, typeof WebSocket].join()', ctx) === 'undefined,undefined,undefined');

const fillplans = JSON.parse(readFileSync(join(ROOT, 'android/core/src/commonTest/resources/golden/fillplans.json'), 'utf8'));
const entry = fillplans.versions.find(v => v.fixture === 'ln-both' && v.form === 'ds');
check('the ln-both DS version exists', !!entry);
const b = entry?.b;
check('the ln-both DS version has a B plan', !!b);
const templateBytes = readFileSync(join(ROOT, dsIntake.TEMPLATE));

if (b) {
  const VmU8 = vm.runInContext('Uint8Array', ctx);
  const vmInput = new VmU8(templateBytes);
  const vmResult = await ctx.SsaPdfWriter.fillForHost(
    vmInput,
    JSON.stringify(b.plan),
    JSON.stringify({ pages: b.pages }),
    'T', 'C', false
  );

  const esmResult = await fillFromPlan(PDFLib, templateBytes, {
    plan: b.plan,
    drawList: { pages: b.pages },
    title: 'T',
    creator: 'C',
    updateMetadata: false
  });

  check('the vm writer reports no missing fields', vmResult.missing.length === 0, JSON.stringify(vmResult.missing));
  check('the ESM writer reports no missing fields', esmResult.missing.length === 0, JSON.stringify(esmResult.missing));
  check('the vm and ESM writers produce identical bytes',
    Buffer.compare(Buffer.from(vmResult.bytes), Buffer.from(esmResult.bytes)) === 0,
    `vm ${vmResult.bytes.length} bytes vs esm ${esmResult.bytes.length} bytes`);
}

if (failures) {
  console.error(`ios-writer-bundle: ${failures} failure(s)`);
  process.exit(1);
}
console.log('ios-writer-bundle: all checks passed');
