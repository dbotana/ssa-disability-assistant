// The iOS binary network audit (mirror plan, spike 3c): when its inputs are
// built, the clean set passes ios/tools/audit-binary.sh and the NetCanary
// canary fails it, naming NSURLSession.
//
// Makes no network requests: it only runs the audit, which reads local files
// with nm and otool. It never fails on a host that cannot run the audit. On
// Linux, without xcrun, or before the products are built, it prints why it
// skipped and exits 0.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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

// The functions that reference _dlsym or _NSClassFromString in each linked image of the app, as
// traced on 2026-11-28 (ios/tools/audit-binary.allowlist, "The iOS app"). An allowlist entry for a
// linked image covers every caller of the symbol in it, so this pins the callers: a new one, ours
// or a library's, fails here until it is traced and added to the allowlist and to this list.
const SSAKIT = 'Frameworks/SsaKit_1BC8669A2A8895_PackageProduct.framework/SsaKit_1BC8669A2A8895_PackageProduct';
const TRACED_CALLERS = {
  SsaAssistant: [
    '_OUTLINED_FUNCTION_34 _dlsym',
    '_getDebugDylibEntryPoint _dlsym',
  ],
  'SsaAssistant.debug.dylib': [
    '__initializeAvailabilityCheck _dlsym',
  ],
  [SSAKIT]: [
    '-[CMPLayoutRegion edgeInsetsForLayoutRegionInView:] _NSClassFromString',
    '__Z30SkCTFontGetNSFontWeightMappingv_skiko _dlsym',
    '__ZN12_GLOBAL__N_130TryInitializeCoreSymbolicationEv _dlsym',
    '__ZN5skiko13SkFontMgr_MacC2EPK18__CTFontCollection _dlsym',
    '__ZNK11onnxruntime12_GLOBAL__N_18PosixEnv20GetSymbolFromLibraryEPvRKNSt3__112basic_stringIcNS3_11char_traitsIcEENS3_9allocatorIcEEEEPS2_ _dlsym',
    '__ZNK14SkTypeface_Mac30onGetVariationDesignParametersE6SkSpanIN16SkFontParameters9Variation4AxisEE.cold.1 _dlsym',
    '__ZZN14GrGLInterfaces7MakeIOSEvEN3$_08__invokeEPvPKc _dlsym',
    '__initializeAvailabilityCheck _dlsym',
  ],
};
// `otool -tvV` prints a function's name on its own line, ending in a colon, and annotates
// every reference to an imported symbol (call, tail call or address) with the symbol's name
// as the line's last field.
const callers = file => {
  const r = spawnSync('bash', ['-c',
    'set -o pipefail; xcrun otool -tvV "$1" | awk \'/^[^ \\t].*:$/ { fn = substr($0, 1, length($0) - 1); next }'
    + ' $NF == "_dlsym" || $NF == "_NSClassFromString" { print fn " " $NF }\' | LC_ALL=C sort -u', '_', file],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, list: r.stdout.split('\n').filter(Boolean), stderr: r.stderr };
};

if (existsSync(APP)) {
  // An installed app has no PlugIns/: Xcode embeds the test bundle there only for
  // `xcodebuild test`. So the app is audited entry by entry without it, and the labels are
  // paths inside the .app.
  const entries = readdirSync(APP).filter(e => e !== 'PlugIns').map(e => join(APP, e));
  const app = audit(entries);
  check('the app bundle (without PlugIns/) passes the audit', app.status === 0, verdict(app));

  for (const [label, expected] of Object.entries(TRACED_CALLERS)) {
    const got = callers(join(APP, label));
    check(`otool ran on ${label}`, got.status === 0, got.stderr);
    const want = [...expected].sort();
    check(`the dynamic-lookup callers in ${label} are the traced ones`,
      JSON.stringify(got.list) === JSON.stringify(want),
      `expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got.list)}`);
  }

  // The app's NetworkTrapTests calls URLSession on purpose, so its bundle must fail the audit,
  // like the canary: if it passed, the audit would no longer see URLSession.
  const plugin = join(APP, 'PlugIns', 'SsaAssistantTests.xctest');
  if (existsSync(plugin)) {
    const trap = audit([plugin]);
    check('the app test bundle fails the audit with a finding (exit 1)', trap.status === 1, verdict(trap));
    check('the app test bundle finding names SsaAssistantTests and NSURLSession',
      /SsaAssistantTests\.xctest\/SsaAssistantTests: imports \S*NSURLSession/.test(trap.stderr), verdict(trap));
  }
} else {
  console.log(`ios-audit: the app bundle is not built (${relative(ROOT, APP)}); skipping its audit`);
}

if (failures) {
  console.error(`ios-audit: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('ios-audit: all checks passed');
