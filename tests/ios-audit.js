// The iOS binary network audit (mirror plan, spike 3c): when its inputs are
// built, the clean set passes ios/tools/audit-binary.sh and the NetCanary
// canary fails it, naming NSURLSession.
//
// Makes no network requests: it only runs the audit, which reads local files
// with nm and otool. It never fails on a host that cannot run the audit. On
// Linux, without xcrun, or before the products are built, it prints why it
// skipped and exits 0.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = join(ROOT, 'ios', 'tools', 'audit-binary.sh');
const XCFRAMEWORK = join(ROOT, 'ios', 'CoreCrypto', 'debug', 'SsaCore.xcframework');
const PRODUCTS = join(ROOT, 'ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator');
const product = name => join(PRODUCTS, name);
// The iOS app's bundle and its built frameworks (spike 3c's D1 half, which
// waits for the app). Absent until the owner builds ios/App/.
const APP_PRODUCTS = join(ROOT, 'ios', 'App', 'build', 'Build', 'Products', 'Debug-iphonesimulator');
const appProduct = name => join(APP_PRODUCTS, name);

const skip = reason => {
  console.log(`ios-audit: skipped (${reason})`);
  process.exit(0);
};

if (process.platform !== 'darwin') skip(`not macOS: ${process.platform}`);
if (spawnSync('xcrun', ['--find', 'nm'], { encoding: 'utf8' }).status !== 0) skip('xcrun nm not available');

const BUILD_XCFRAMEWORK = 'from android/: ./gradlew :ui:assembleSsaCoreDebugXCFramework';
const BUILD_PRODUCTS = 'from ios/CoreCrypto/: xcodebuild build-for-testing -scheme CoreCrypto-Package'
  + " -destination 'platform=iOS Simulator,name=iPhone 18 Pro'"
  + ` -derivedDataPath ${join(ROOT, 'ios', 'CoreCrypto', '.build', 'xcode')}`;
const CLEAN = [XCFRAMEWORK, ...['CoreCrypto.o', 'SsaPdf.o', 'CoreCryptoTests.xctest', 'SsaPdfTests.xctest'].map(product)];
const CANARY = product('NetCanary.o');
// The app is audited too when it has been built: the .app itself and every
// framework inside it. It is optional so this test still passes on a host
// that has not built the app.
const APP = appProduct('SsaAssistant.app');

for (const path of [...CLEAN, CANARY]) {
  if (!existsSync(path)) {
    skip(`${relative(ROOT, path)} not built; run ${path === XCFRAMEWORK ? BUILD_XCFRAMEWORK : BUILD_PRODUCTS}`);
  }
}

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
};

// The checked-in allowlist only: an ALLOWLIST in the caller's environment must
// not change what this test proves.
const env = { ...process.env };
delete env.ALLOWLIST;
const audit = inputs => spawnSync('bash', [AUDIT, ...inputs], { encoding: 'utf8', env });
// The audit's verdict lines, without the informational allowlist notes.
const verdict = r => `exit ${r.status}: ${`${r.stdout}${r.stderr}`.split('\n')
  .filter(l => l && !l.startsWith('note: ') && !l.startsWith('allowed: ')).join(' | ')}`;

const clean = audit(CLEAN);
check('the audit ran on the clean set', clean.error === undefined, String(clean.error));
check('the clean set passes the audit', clean.status === 0, verdict(clean));
check('the clean set reports clean', clean.stdout.includes('binary audit clean ('), verdict(clean));

const canary = audit([CANARY]);
check('the canary fails the audit with a finding (exit 1)', canary.status === 1, verdict(canary));
check('the canary finding names NetCanary.o and NSURLSession',
  /NetCanary\.o: imports \S*NSURLSession/.test(canary.stderr), verdict(canary));

if (existsSync(APP)) {
  const app = audit([APP]);
  check('the app bundle passes the audit', app.status === 0, verdict(app));
} else {
  console.log(`ios-audit: the app bundle is not built (${relative(ROOT, APP)}); skipping its audit`);
}

if (failures) {
  console.error(`ios-audit: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('ios-audit: all checks passed');
