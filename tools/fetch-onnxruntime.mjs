#!/usr/bin/env node
// Fetch ONNX Runtime's iOS build into android/models/third_party/, for maintainers only.
//
// The app never downloads anything. The Android AAR and the desktop jar come
// from Maven Central through Gradle, which checks them against the pins in
// android/models/onnxruntime.SHA256SUMS. The iOS xcframework has no working
// official download: the CocoaPods URL (download.onnxruntime.ai) serves an HTML
// "Page not found" page. Microsoft's NuGet package Microsoft.ML.OnnxRuntime
// carries the same build at runtimes/ios/native/onnxruntime.xcframework.zip,
// so this script fetches that package over verified TLS, checks its SHA-512
// against the packageHash nuget.org publishes, and extracts the zip.
//
//   node tools/fetch-onnxruntime.mjs            fetch, check, extract
//   node tools/fetch-onnxruntime.mjs --verify   re-hash what is on disk
//
// The extracted zip is also pinned by SHA-256 in android/models/onnxruntime.SHA256SUMS.
// The folder is git-ignored: the archive is too large to commit.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.22.0';
// nuget.org's catalog packageHash for this version (SHA-512, base64).
const NUPKG_SHA512 = 'zb3eqkL6hHPGzZgArsuTH9VWdUs4ooKTJHBXF6ZZfQsPvzModaAEv3u69zwtqKuwUJ/DPc8i+uKoyXMzdwqrPg==';
const NUPKG_URL = `https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/${VERSION}/microsoft.ml.onnxruntime.${VERSION}.nupkg`;
const ENTRY = 'runtimes/ios/native/onnxruntime.xcframework.zip';
const DEST = join(ROOT, 'android', 'models', 'third_party');
const OUT = join(DEST, 'onnxruntime.xcframework.zip');
const PINS = join(ROOT, 'android', 'models', 'onnxruntime.SHA256SUMS');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function pinned() {
  const text = await readFile(PINS, 'utf8');
  const m = text.match(/^([0-9a-f]{64}) [ *]onnxruntime\.xcframework\.zip$/m);
  if (!m) throw new Error(`${PINS} has no line for onnxruntime.xcframework.zip`);
  return m[1];
}

const want = await pinned();

if (process.argv.includes('--verify')) {
  let got = null;
  try { got = sha256(await readFile(OUT)); } catch { /* missing */ }
  if (got !== want) {
    console.error(`MISMATCH ${OUT}${got ? `\n  got  ${got}\n  want ${want}` : ' (missing)'}`);
    process.exit(1);
  }
  console.log('onnxruntime.xcframework.zip matches onnxruntime.SHA256SUMS.');
  process.exit(0);
}

process.stdout.write(`Microsoft.ML.OnnxRuntime ${VERSION} … `);
const res = await fetch(NUPKG_URL);
if (!res.ok) throw new Error(`HTTP ${res.status} for ${NUPKG_URL}`);
const nupkg = Buffer.from(await res.arrayBuffer());
const got512 = createHash('sha512').update(nupkg).digest('base64');
if (got512 !== NUPKG_SHA512) throw new Error(`nupkg SHA-512 ${got512} does not match nuget.org's ${NUPKG_SHA512}`);
console.log(`${(nupkg.length / 1e6).toFixed(1)} MB, SHA-512 verified`);

// unzip reads the package from a file, so it goes through a temp copy.
const tmp = join(DEST, '.nupkg.tmp');
await mkdir(DEST, { recursive: true });
await writeFile(tmp, nupkg);
let zip;
try { zip = execFileSync('unzip', ['-p', tmp, ENTRY], { maxBuffer: 1 << 29 }); }
finally { execFileSync('rm', ['-f', tmp]); }
const got = sha256(zip);
if (got !== want) throw new Error(`${ENTRY} SHA-256 ${got} does not match ${PINS} (${want})`);
await writeFile(OUT, zip);
console.log(`Wrote ${OUT} (${zip.length} bytes, SHA-256 verified)`);
