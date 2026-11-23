/**
 * iOS binary network audit runner
 * Checks that the binary audit passes on clean inputs and fails on the canary.
 * 
 * This script makes no network requests. It only runs the audit-binary.sh script
 * against built products.
 * 
 * On Linux, it exits 0 skipping (not macOS).
 * Header comment says both: makes no network requests, and must not fail on Linux.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const platform = process.platform;

// 1. If not macOS, skip
if (platform !== 'darwin') {
    console.log(`ios-audit: skipped (not macOS: ${platform})`);
    process.exit(0);
}

// 2. If xcrun nm not available, skip
if (!spawnSync('xcrun', ['--find', 'nm']).status) {
    console.log('ios-audit: skipped (xcrun nm not available)');
    process.exit(0);
}

// 3. Check that all required products exist
const requiredPaths = [
    path.join('ios', 'CoreCrypto', 'debug', 'SsaCore.xcframework'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'CoreCrypto.o'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'SsaPdf.o'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'CoreCryptoTests.xctest'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'SsaPdfTests.xctest'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'NetCanary.o'),
];

let allBuilt = true;
for (const p of requiredPaths) {
    if (!fs.existsSync(p)) {
        console.log(`ios-audit: skipped (${p} not built; run xcodebuild)`);
        allBuilt = false;
        break;
    }
}

if (!allBuilt) {
    process.exit(0);
}

// 4. Run the audit script
const auditScript = path.join('ios', 'tools', 'audit-binary.sh');
const allowlist = path.join('ios', 'tools', 'audit-binary.allowlist');

// Run audit on all products
const products = [
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'CoreCrypto.o'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'SsaPdf.o'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'CoreCryptoTests.xctest'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'SsaPdfTests.xctest'),
    path.join('ios', 'CoreCrypto', '.build', 'xcode', 'Build', 'Products', 'Debug-iphonesimulator', 'NetCanary.o'),
];

// Build the argument list for audit-binary.sh
const args = ['ALLOWLIST', allowlist].concat(products);

const result = spawnSync('bash', [auditScript].concat(args), {
    stdio: 'inherit'
});

// Check results based on exit codes
// NetCanary.o should fail with exit 1 and NSURLSession in stderr
// All others should pass with exit 0

// Check NetCanary.o specifically
const netCanaryIdx = products.findIndex(p => p.includes('NetCanary.o'));
const otherIdx = products.findIndex(p => !p.includes('NetCanary.o') && p.includes('CoreCrypto.o'));

// We need to check the exit code and output
// The spawnSync inherited stdout/stderr, so we just check the exit code

if (result.status === 143) {
    // Timed out / signal
    process.exit(1);
}

// Evaluate results
// Exit 0 = all clean (unexpected - NetCanary should fail)
// Exit 1 = findings (expected - NetCanary and possibly NetworkGuardTests)
// Exit 2 = cannot run

// The plan expects:
// - NetCanary.o: exit 1, stderr includes NSURLSession
// - NetworkGuardTests.xctest: exit 1, NSURLSession named (expected: deliberate request)
// - All others: exit 0

let allPassed = true;

// Re-run with captured output to evaluate
const result2 = spawnSync('bash', [auditScript, 'ALLOWLIST', allowlist].concat(products.slice(0, 4)), {
    encoding: 'utf8',
    stdio: 'pipe'
});

// Check NetCanary.o exit code and output
const netCanaryResult = spawnSync('bash', [auditScript, 'ALLOWLIST', allowlist, products[netCanaryIdx]], {
    encoding: 'utf8',
    stdio: 'pipe'
});

if (netCanaryResult.status !== 1) {
    console.error(`ios-audit: FAIL - NetCanary.o expected exit 1, got ${netCanaryResult.status}`);
    allPassed = false;
} else if (!netCanaryResult.stderr.includes('NSURLSession') && !netCanaryResult.stderr.includes('NSURLSession')) {
    console.error(`ios-audit: FAIL - NetCanary.o stderr should include NSURLSession`);
    allPassed = false;
}

// Check other products exit 0
for (let i = 0; i < 4; i++) {
    if (i === netCanaryIdx) continue;
    const r = spawnSync('bash', [auditScript, 'ALLOWLIST', allowlist, products[i]], {
        encoding: 'utf8',
        stdio: 'pipe'
    });
    if (r.status !== 0) {
        console.error(`ios-audit: FAIL - ${products[i]} expected exit 0, got ${r.status}`);
        allPassed = false;
    }
}

if (allPassed) {
    console.log('ios-audit: all checks passed');
    process.exit(0);
} else {
    process.exit(1);
}