# Spike 3a: the PDF writer on iOS — evidence and decision

Dated 2026-11-22. This file is the spike 3a completion record, in the style of
`android/pdf/M1A.md`.

## 1. Decision

**Provisional fallback.**

The JS writer (pdf-lib in `JSContext`) fills both forms in both versions of a
Lingala session, `crosscheck.mjs` re-reads all four PDFs with pdf-lib with 0
failures, and the output is 1.01–1.04× the template against a 2× budget. But
two of the three "provisional go" conditions are not met:

- The self-check is not clean. Every problem is a writer-convention mismatch
  (group (a) below), not a CGPDF limitation: 313 problems for the Starter Kit,
  344 for the DS form, on each of the two versions. pdf-lib writes `/Helv` and
  its own embedded Helvetica; the core `PdfSelfCheck` checks the Android
  `AcroFormWriter` convention (`/HelvWA` in `/DR`, the DA, each widget DA and
  each appearance). This is a spike finding, recorded as-is — no
  `PdfSelfCheck` check was weakened.
- The cold first form is over the 3 s per-form budget: `ln-both-a-ssa` is 9.07
  s end to end. The warm second-pass writes are 68–77 ms and the next three
  totals are 0.89–1.29 s, so this is a cold-start cost, not the per-form cost
  — but the plan's gate is "every per-form total is at most 3 s" and this one
  is not. Seven first-form totals are on record, from implementer and reviewer
  runs alike: 6.39 s (check 5.21 s), 7.98 s (check 6.26 s), 7.16 s (check 5.88
  s) and 8.47 s (check 7.57 s) from the implementer's runs; 7.11 s (check 2.95
  s; the JS share was not recorded) from review 1; 9.10 s (JS 7.16 s) from
  review 2; and 9.07 s (JS 7.38 s, check 1.60 s) from the failed first
  revise-2 attempt, which wrote the files now in `.build/pdf-spike/`. In four
  runs most of the cold cost was in the first `PdfSelfCheck` call, and in two
  it was in the first JS fill. The cause is not established: it looks like a
  one-time process or simulator warm-up that lands on whichever step runs
  first, not a cost of `PdfSelfCheck` itself.

The fallback is the common Kotlin incremental-update writer from mirror plan
3a. **It is not built in this run.** The decision stays provisional until
there are phone timings. Two costs are unknown on a phone:

- Whether a phone pays the cold-start cost at all, and on which step, is
  unknown: all the evidence is from the simulator. It must be measured on a
  phone.
- A third-party app's `JSContext` on a device runs without JIT, which will
  probably make the JS fill slower than on the simulator. The simulator
  numbers therefore probably understate the cost on a phone (plan step 5), and
  they do not bound it either way.

If the convention problems were the only obstacle, the owner's alternative is
to make the JS writer adopt the `/HelvWA` convention. That changes the web's
output, so it would be JS-first with regenerated checks, and it is the owner's
decision.

## 2. What ran

Xcode 27.2 (Build 27B52), iOS 27.2 simulator (`iPhone 18 Pro`,
`SIMULATOR_MODEL_IDENTIFIER=iPhone19,2`, `Version 27.2 (Build 24B8117)`), JDK 21,
Android SDK. Date 2026-11-22. **The simulator runs on the Mac's CPU, not a
phone** — every number below is labelled that way.

```bash
# from android/
TZ=UTC ./gradlew :core:compileCommonMainKotlinMetadata
TZ=UTC ./gradlew :core:jvmTest
SIMCTL_CHILD_GOLDEN_DIR=/Users/dbotana/Github/ssa-disability-assistant/android/core/build/ios-test-resources ./gradlew :core:iosSimulatorArm64Test
./gradlew :core:assembleSsaCoreDebugXCFramework
# from ios/CoreCrypto/
xcodebuild -list
xcodebuild test -scheme CoreCrypto-Package -destination 'platform=iOS Simulator,name=iPhone 18 Pro'
# from the repository root
node tools/golden/crosscheck.mjs /Users/dbotana/Github/ssa-disability-assistant/ios/CoreCrypto/.build/pdf-spike
```

`xcodebuild test -scheme CoreCrypto-Package` ran `CoreCryptoTests` (3 tests)
and `SsaPdfTests` (3 tests), all passing, ending in `** TEST SUCCEEDED **`.
`-scheme CoreCrypto-Package` is new to this run: Run 5 ran `xcodebuild test
-scheme CoreCrypto` and it passed, but adding the `SsaPdf` product gave the
package a second product, and only the package scheme has a test action. The
old command and `-scheme SsaPdf` now fail with `xcodebuild: error: Scheme
CoreCrypto is not currently configured for the test action.` and the same for
`SsaPdf`; those are xcodebuild errors caused by the new product, not sandbox
refusals. `ios/CoreCrypto/Package.swift`'s header comment now gives the
`CoreCrypto-Package` command.

## 3. Timing table (simulator, not a phone)

Cold pass, fresh `JSContext`, first run:

| case | form | read ms | js ms | write ms (JS) | transfer ms | check ms | total ms | bytes | ratio |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| ln-both-a | ssa | 0.09 | 7376 | 7356 | 100 | 1596 | 9071 | 473858 | 1.01 |
| ln-both-b | ssa | 0.60 | 123 | 120 | 80 | 962 | 1165 | 474572 | 1.01 |
| ln-both-a | ds | 0.84 | 85 | 84 | 133 | 669 | 888 | 1393761 | 1.04 |
| ln-both-b | ds | 0.42 | 180 | 179 | 162 | 946 | 1288 | 1394494 | 1.04 |

- **cold `JSContext` load** (pin check, pdf-lib, writer): **1068 ms**.
- **four-PDF session total, cold**: **12412 ms**.
- **warm second-pass write times** (same context, write only): ssa-a 75.6 ms,
  ssa-b 77.3 ms, ds-a 72.8 ms, ds-b 68.1 ms.
- `transferMs` is test-harness cost (per-byte `KotlinByteArray` copies), not
  the app's; reported separately.
- The first form's 9.07 s is cold-start cost inside the test process: 7.38 s
  in the first JS fill and 1.60 s in the first call into the Kotlin
  `PdfSelfCheck`. The next three totals are 0.89–1.29 s. In other runs the
  cold cost landed mostly in the first `PdfSelfCheck` call instead; the cause
  is not established (§1).
- The output bytes differ slightly between runs (473855, 473858) because the
  writer passes `updateMetadata: true` and pdf-lib stamps the current date;
  these are the files in `.build/pdf-spike/` from the last run, the one that
  also ran the addendum-page assertion.

## 4. Correctness

- `crosscheck: 4 PDFs re-read with pdf-lib, 0 failure(s)`.
- `missing` is empty for all four PDFs; the field sets are 116 (ssa) / 126 (ds).
- Output size 1.01× (ssa) and 1.04× (ds) the template; limit 2.00.

Self-check problems, per PDF, all group (a) writer convention (exact check
strings from `PdfSelfCheck`):

| check | ssa | ds |
|---|---:|---:|
| `/DR has no WinAnsi /HelvWA` | 1 | 1 |
| `DA is not /HelvWA at the planned size` | 104 | 113 |
| `appearance font is not /HelvWA at the planned size` | 104 | 113 |
| `appearance has no WinAnsi /HelvWA` | 104 | 113 |
| `widget DA is not /HelvWA at the planned size` | 0 | 1 |
| `appearance changed though the plan left it alone` | 0 | 3 |

The three "appearance changed" problems are on DS fields whose template widget
had no `/AP /N`, so pdf-lib's `updateFieldAppearances` generated one for them;
the test verifies that per field against the template. There are **no** group
(b) CGPDF limitations and **no** group (c) defects.

## 5. What CGPDF could and could not expose

- **Nothing** is missing. The `limitations` list is empty for all four PDFs:
  no appearance stream is JPEG or JPEG 2000 encoded, and `CGPDFStreamCopyData`
  decoded every content and appearance stream with `.raw` format. Field types,
  values, DAs, `/AS`, appearance BBoxes, `/DR /Font /HelvWA`, page content and
  page sizes all read through CGPDF.
- One limit of the *test*, not of CGPDF: `limitations` is collected from the
  reader the test builds for the output, and that reader's fields and
  appearances are read eagerly in `init`, while `pageContent` is never called
  on it. A JPEG-encoded page content stream would therefore go unlisted. These
  four PDFs do contain one `/DCTDecode` stream each, but it is the template's
  image XObject (`/Subtype /Image`), which the port never reads because it is
  neither an appearance nor a page content stream; every stream the port does
  read decoded as `.raw`.

## 6. JavaScriptCore notes

- pdf-lib's `save()` yields with `setTimeout(0)`. JavaScriptCore has no
  timers, so the generated bundle supplies a microtask shim
  (`setTimeout` resolves the callback on the next `Promise.resolve().then()`);
  no other polyfill was needed. The shim lives in `tools/build-ios-writer.mjs`,
  never hand-edited in `vendor/`.
- The network-global assertion runs at load, in both debug and release (a
  thrown error, not `assert`): `typeof fetch`, `typeof XMLHttpRequest` and
  `typeof WebSocket` must all be `undefined`.
  `testNetworkGlobalsAreRefused` proves a script that defines `fetch` is
  refused; `testTamperedScriptIsRefused` proves a changed
  `vendor/ssa-pdf-writer.js` fails its SHA-256 pin.
- Bytes go in and out as `Uint8Array` typed arrays (the vm realm's
  constructor in the Node parity test, JavaScriptCore's own in the app), and
  the returned bytes are required to be a `Uint8Array` at offset 0.

## 7. Still open

- Real-phone timings (low-end and recent iPhone). The simulator has JIT; a
  third-party app's `JSContext` on a device does not.
- The preview: whether PDFKit's `PDFView` draws the filled widgets waits for
  the shared UI (X6). No preview was built.
- Opening and editing the four PDFs in Acrobat, Chrome and Preview.
- App-bundle resources for `Platform.ios.kt`'s `NSBundle.mainBundle`: X6,
  since `IosResources.roots` is test-only and there is no app target yet.
- The self-check convention mismatch above, if it stands after the owner
  decides whether the JS writer should adopt `/HelvWA`.

# Spike 3c: the iOS network audit and its canary — evidence

Dated 2026-11-23 (Run 7). Host and simulator only: Xcode 27.2 (build 27B52),
the iPhone 18 Pro simulator, Kotlin 2.0.21. There is no app target, so the
audit ran over the binaries that exist: the `SsaCore` XCFramework and the
products `xcodebuild` builds for `ios/CoreCrypto/`. Every number below was
copied from command output seen in this run.

## 3c.1 What the audit checks

`ios/tools/audit-binary.sh <Mach-O | .a | .o | .framework | .xcframework | .xctest | .app> ...`
walks every Mach-O file under its arguments: thin (`cffaedfe`, `cefaedfe`,
`feedfacf`, `feedface`), fat (`cafebabe`) or an `ar` archive (`!<ar`). It skips
anything under a `.dSYM`, because debug symbols are not shipped code. It fails,
naming the object and the symbol, on:

- **A1, a linked networking framework:** an `otool -L` entry matching
  `/(CFNetwork|Network|WebKit)\.framework/`. Checked in every file.
- **A2, an autolinked networking framework:** an `LC_LINKER_OPTION`
  `-framework CFNetwork|Network|WebKit`. Checked **only in linked images**,
  meaning any file with a Mach-O header that is not `MH_OBJECT`; never in `.o`
  files or `.a` archives. This is the owner's decision in Run 7. Swift's
  `import Foundation` alone writes `-framework CFNetwork` into every object
  file. A scratch file holding only `import Foundation`, compiled with
  `xcrun --sdk iphonesimulator swiftc -target arm64-apple-ios17.0-simulator -c`,
  autolinks `Foundation`, `CoreFoundation`, `Combine`, `Security` and
  `CFNetwork`. Under the plan as first written, audit (b) could therefore never
  pass (`CoreCrypto.o: autolinks CFNetwork.framework`,
  `SsaPdf.o: autolinks CFNetwork.framework`, in the earlier tools run). The
  option only acts at link time. A linked image that really uses CFNetwork
  carries an `LC_LOAD_DYLIB` for it, which A1 catches, and rule B still checks
  every symbol a `.o` or `.a` imports.
- **B, an imported symbol:** `nm -u -A -arch all`, matched against the symbol
  only, with these EREs (copied from the script):

  ```
  ^_OBJC_(META)?CLASS_\$_(NSURLSession|NSURLConnection|WKWebView)
  So12NSURLSessionC|So15NSURLConnectionC|So9WKWebViewC
  ^_nw_
  ^_CFSocket
  ^_CFStream
  ^_(socket|connect|getaddrinfo)$
  ^_(NSClassFromString|dlsym)$
  ```

  Every input counts as our code for the dynamic-lookup rule.

**Labels.** A finding names the file by its path relative to the parent
directory of the argument, and an archive member as `<path>(<member>)`, for
example
`SsaCore.xcframework/ios-arm64/SsaCore.framework/SsaCore(liborg.jetbrains.kotlin.native.platform.posix-cache.a.o)`.
Absolute and relative arguments give the same label. The real `nm` format,
checked on the `SsaCore` archive and on `NetCanary.o`, is `<path>: <symbol>`
for an object and `<archive>:<member>: <symbol>` for a member. Member names can contain `:` (`liborg.jetbrains.kotlinx:atomicfu-cache.a.o`),
and so can symbols (`_objc_msgSend$dataTaskWithURL:completionHandler:`), so the
script reads the object against the file's own path and never splits on colons.

**Exit codes and failing closed.**

- **0, clean:** `binary audit clean (<n> Mach-O files in <m> inputs)`.
- **1, a finding:** `BINARY AUDIT FAILED:` on stderr, then one line per finding.
- **2, the audit cannot run:** `BINARY AUDIT ERROR: …`. This covers no
  arguments, a missing input, no Mach-O file, an unreadable file, a missing
  allowlist, an allowlist line with fewer than 3 fields, a failing `nm`,
  `otool` or `find`, and any other unexpected failure (an `ERR` trap).

**Allowlist.** The file is `ios/tools/audit-binary.allowlist`. Each line is an
exact `<object> <symbol> <reason>`; entries are never patterns. Allowed hits
print `allowed: …` to stdout. Unused entries print
`note: allowlist entry not used here: …` to stderr, which is informational.

**Speed.** The script filters each file with one `awk` pass. Audit (a) took
1.562 s (`time`). The first Run 7 draft did not finish (a) in more than
5 minutes (review 1).

## 3c.2 Commands and outputs

Run on 2026-11-23. In the table, `P` stands for
`/Users/dbotana/Github/ssa-disability-assistant/ios/CoreCrypto/.build/xcode/Build/Products/Debug-iphonesimulator`.
The audits were run from the repository root with absolute paths.

| Command (from) | Result |
|---|---|
| `./gradlew :core:assembleSsaCoreDebugXCFramework` (`android/`) | `BUILD SUCCESSFUL in 6s`, `9 actionable tasks: 9 up-to-date`; the XCFramework binaries are from Nov 22 19:54 |
| `xcodebuild -list` (`ios/CoreCrypto/`) | schemes `CoreCrypto`, `CoreCrypto-Package`, `NetCanary`, `SsaPdf` |
| `xcodebuild test -scheme CoreCrypto-Package -destination 'platform=iOS Simulator,name=iPhone 18 Pro'` (`ios/CoreCrypto/`) | `SsaPdfTests` 3, `NetworkGuardTests` 2 and `CoreCryptoTests` 3 tests, each `with 0 failures`; `** TEST SUCCEEDED **` |
| `xcodebuild build-for-testing -scheme CoreCrypto-Package -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -derivedDataPath /Users/dbotana/Github/ssa-disability-assistant/ios/CoreCrypto/.build/xcode` (`ios/CoreCrypto/`) | `** TEST BUILD SUCCEEDED **`; `find P -maxdepth 2` lists `CoreCrypto.o`, `SsaPdf.o`, `NetCanary.o`, `CoreCryptoTests.xctest`, `SsaPdfTests.xctest`, `NetworkGuardTests.xctest`, `SsaCore.framework`, `PackageFrameworks` and the `.swiftmodule`s, all written 17:57 |
| `xcodebuild build -scheme NetCanary …` | not run: `build-for-testing` had already built `NetCanary.o` |

| # | Audit | Exit | Key output |
|---|---|---:|---|
| a | `ios/tools/audit-binary.sh /Users/dbotana/Github/ssa-disability-assistant/ios/CoreCrypto/debug/SsaCore.xcframework` | 0 | 71 `allowed:` lines (36 for the simulator slice, 35 for the device slice); 2 `note:` lines, for the two test-bundle entries; `binary audit clean (2 Mach-O files in 1 inputs)` |
| b | `ios/tools/audit-binary.sh P/CoreCrypto.o P/SsaPdf.o` | 0 | `binary audit clean (2 Mach-O files in 2 inputs)` |
| c | `ios/tools/audit-binary.sh P/CoreCryptoTests.xctest P/SsaPdfTests.xctest` | 0 | `allowed: CoreCryptoTests.xctest/CoreCryptoTests: _dlsym (…)`, `allowed: SsaPdfTests.xctest/SsaPdfTests: _dlsym (…)`, `binary audit clean (2 Mach-O files in 2 inputs)` |
| d | `ios/tools/audit-binary.sh P/NetCanary.o` | 1 | `BINARY AUDIT FAILED:` / `  NetCanary.o: imports _OBJC_CLASS_$_NSURLSession` |
| e | `ios/tools/audit-binary.sh P/NetworkGuardTests.xctest` | 1 | `BINARY AUDIT FAILED:` / `  NetworkGuardTests.xctest/NetworkGuardTests: imports _OBJC_CLASS_$_NSURLSession` / `  NetworkGuardTests.xctest/NetworkGuardTests: imports _dlsym` |
| f | `ios/tools/audit-binary.sh /Users/dbotana/Github/ssa-disability-assistant/ios/tools` | 2 | `BINARY AUDIT ERROR: no Mach-O files found in: /Users/dbotana/Github/ssa-disability-assistant/ios/tools` |
| g | `ios/tools/audit-binary.sh /Users/dbotana/Github/ssa-disability-assistant/does-not-exist` | 2 | `BINARY AUDIT ERROR: no such input: /Users/dbotana/Github/ssa-disability-assistant/does-not-exist` |

The exit codes are **0, 0, 0, 1, 1, 2, 2**. Audits (b) to (e) also print one
`note:` line per unused allowlist entry: 73, 71, 73 and 73 lines.
`node tests/ios-audit.js` printed `ios-audit: all checks passed`.

The Run 7 plan's section 4 verification re-ran all of this after the last code
and allowlist edit, after a fresh `xcodebuild test` (8 tests, 0 failures) and
`build-for-testing`. It gave the same exit codes, 0, 0, 0, 1, 1, 2, 2, and the
same key lines, and `ios-audit: all checks passed`. The plan's Run 7 section
lists the rest of that verification.

**Extra checks of the script.** The scratch inputs below live in the session
scratchpad, not in the repository.

- An `ALLOWLIST` file whose line 2 has only two fields, on `P/NetCanary.o`:
  exit 2, `BINARY AUDIT ERROR: allowlist line 2 has fewer than 3 fields: …`.
- An `ALLOWLIST` file holding only comments, on `P/CoreCryptoTests.xctest`:
  exit 1, `CoreCryptoTests.xctest/CoreCryptoTests: imports _dlsym`.
- From the repository root, the relative path
  `ios/CoreCrypto/.build/xcode/Build/Products/Debug-iphonesimulator/NetworkGuardTests.xctest/`
  (with a trailing slash): the same two findings and labels as (e).
- No arguments: exit 2, and the usage text.
- A1, on a scratch dylib linked with `swiftc -emit-library -framework CFNetwork`:
  exit 1, `libLinksCFNetwork.dylib: links CFNetwork.framework`.
- `/Applications/Safari.app/Contents/MacOS/Safari`, a fat file (x86_64, arm64e,
  arm64e.x1): `binary audit clean (1 Mach-O files in 1 inputs)`. Its `otool -L`
  lists only its private `Safari.framework` and `libSystem`.
- A2 fired on no input in this run, because no linked image here carries an
  `LC_LINKER_OPTION`. A2 itself is therefore untested.

**`.build/pdf-spike/`.** The `CoreCrypto-Package` test run rewrote
`ios/CoreCrypto/.build/pdf-spike/`. It now holds the output of Run 7's last
test run, the section 4 verification (`summary.json` written Nov 23 18:25, per
`ls -l`; the Step 4 run wrote it at 17:57). The tables in §3 above are from
the earlier Run 6 run.

## 3c.3 Canary result

`NetCanary.o` fails audit (d) with exit 1 and
`NetCanary.o: imports _OBJC_CLASS_$_NSURLSession`. Before the owner's A2
decision it also printed `NetCanary.o: autolinks CFNetwork.framework` (in the
tools run). Now the class reference alone fails it.

`NetworkGuardTests.xctest` fails audit (e) by design, for two reasons:

- the deliberate request in `testTrapCatchesADeliberateRequest`
  (`NetworkGuardTests.o` imports `_OBJC_CLASS_$_NSURLSession`);
- the statically linked Kotlin/Native `_dlsym`, which has no allowlist entry
  for this bundle.

## 3c.4 Allowlist

The allowlist has 73 lines, one per exact (object, symbol) pair. None names our
own objects (`CoreCrypto.o`, `SsaPdf.o`, `NetCanary.o`, `SsaCore.framework.o`,
`NetworkGuardTests.xctest`), and no pattern was changed. Archive members are
not linked, so `nm` shows no bound library for them.

| Object | Symbols | Bound library | Reason (traced) |
|---|---|---|---|
| `SsaCore(liborg.jetbrains.kotlin.native.platform.posix-cache.a.o)`, both slices | `_connect`, `_dlsym`, `_getaddrinfo`, `_socket` (4 per slice) | none (archive member) | The Kotlin/Native prebuilt `platform.posix` interop cache defines a binding for each symbol in the same member: `_platform_posix_connect_wrapper528`, `_platform_posix_dlsym_wrapper50`, `_platform_posix_getaddrinfo_wrapper585` and `_platform_posix_socket_wrapper542` (simulator); 531, 50, 588 and 545 (device) |
| `SsaCore(liborg.jetbrains.kotlin.native.platform.CoreFoundation-cache.a.o)`, both slices | 26 `_CFSocket*`: `ConnectToAddress`, `CopyAddress`, `CopyPeerAddress`, `CopyRegisteredSocketSignature`, `CopyRegisteredValue`, `Create`, `CreateConnectedToSocketSignature`, `CreateRunLoopSource`, `CreateWithNative`, `CreateWithSocketSignature`, `DisableCallBacks`, `EnableCallBacks`, `GetContext`, `GetDefaultNameRegistryPortNumber`, `GetNative`, `GetSocketFlags`, `GetTypeID`, `Invalidate`, `IsValid`, `RegisterSocketSignature`, `RegisterValue`, `SendData`, `SetAddress`, `SetDefaultNameRegistryPortNumber`, `SetSocketFlags`, `Unregister`; and 4 `_CFStream*`: `CreateBoundPair`, `CreatePairWithPeerSocketSignature`, `CreatePairWithSocket`, `CreatePairWithSocketToHost` (30 per slice) | none (archive member) | The `platform.CoreFoundation` interop cache defines `_platform_CoreFoundation_<name>_wrapper<N>` for each (N from 496 to 532) |
| `SsaCore(liborg.jetbrains.kotlin.native.platform.Foundation-cache.a.o)`, both slices | `_NSClassFromString` | none (archive member) | The `platform.Foundation` interop cache defines `_platform_Foundation_NSClassFromString_wrapper3` |
| `SsaCore.xcframework/ios-arm64-simulator/SsaCore.framework/SsaCore(libstdlib-cache.a.o)` | `_dlsym` | none (archive member) | `xcrun objdump --reloc` puts all 11 `_dlsym` call sites of this member (offsets 0x76a320 to 0x76a528) inside `_Kotlin_getSourceInfo_core_symbolication` (0x76a1b8 to 0x76a900), the runtime's stack-trace symbolicator. The archive holds the strings `CoreSymbolication.framework/CoreSymbolication` and `CSSymbolicatorCreateWithPid`. The device slice does not define the function |
| `CoreCryptoTests.xctest/CoreCryptoTests`, `SsaPdfTests.xctest/SsaPdfTests` | `_dlsym` | `libSystem`: `xcrun nm -m` prints `(undefined) external _dlsym (from libSystem)` | Each bundle defines `_Kotlin_getSourceInfo_core_symbolication`; `_platform_posix_dlsym_wrapper50` was dropped by the linker. The bundle's other static inputs import no `_dlsym`: its test object (`CoreCryptoTests.o`, `PdfSpikeTests.o`), `CoreCrypto.o` or `SsaPdf.o` (audit b), and the clang profile runtime that code coverage (`-profile-generate`) adds, `libclang_rt.profile_iossim.a`. `XCTestSwiftSupport` is a dylib |

These entries cover 4 + 30 + 1 = 35 per slice, 70 in all, plus 1 stdlib-cache
entry and 2 test-bundle entries: 73.

**How these were traced:**

- `xcrun nm -A -U` on each slice, to find the wrapper defined in the same
  member.
- `xcrun nm -u -A` on the archive. `SsaCore.framework.o`, our compiled Kotlin,
  references the platform libraries only through their `__Konan_init_*`
  initialisers and `knifunptr_platform_CoreCrypto32_CC_SHA256`. It references
  no networking or dynamic-lookup binding.
- The caches are far larger than what `core` uses. The posix cache defines
  1674 wrappers (simulator) and 1677 (device); the CoreFoundation cache 1103;
  the Foundation cache 742.

**Not traced:** what `_Kotlin_getSourceInfo_core_symbolication` looks up at
run time, beyond those strings, and when it runs.

## 3c.5 Runtime test

The `NetworkGuardTests` test target is new. It is separate from `SsaPdfTests`
because its deliberate `URLSession` request puts `_OBJC_CLASS_$_NSURLSession`
into its bundle (deviation 1). In `SsaPdfTests` that request would make audit
(c) fail, or force us to allowlist our own test code, which the plan forbids.

- **`RequestTrap: URLProtocol`** records every URL in `canInit` under an
  `NSLock`. It fails every request locally with
  `URLError(.notConnectedToInternet)`. `setUp` registers it with
  `URLProtocol.registerClass` (and asserts that this returns true); `tearDown`
  unregisters it.
- **`testNoRequestDuringFillAndSessionStore`** passed, in 0.732 seconds. It:
  1. loads `PdfWriter` with the `vendor/SHA256SUMS` pins;
  2. fills the four `ln-both` versions in `fillplans.json` (ssa A and B, ds A
     and B), in memory only, with the title `network guard`;
  3. asserts `missing == []`, non-empty bytes and exactly 4 writes;
  4. runs the `SessionStore` round trip (PIN `2468`, then
     `first_name == "Ada"` after reopening);
  5. asserts `RequestTrap.snapshot() == []`.
- **`testTrapCatchesADeliberateRequest`** passed, in 0.038 seconds. It sends a
  `URLSession.shared.dataTask` to `https://example.invalid/network-guard`,
  expects an error, and requires the trap's snapshot to contain the host
  `example.invalid`. So the trap demonstrably sees `URLSession.shared` traffic,
  and the first test cannot pass vacuously.
- **Limit:** the trap is proven only for `URLSession.shared`. Other session
  configurations and raw sockets are what the binary audit is for.

## 3c.6 Not covered yet

- **JavaScriptCore's own behaviour.** The audit cannot see inside it. The 3a
  load-time assertion in `PdfWriter.swift`, with `testNetworkGlobalsAreRefused`
  (§6 above), covers it.
- **The `.app` and every embedded framework, and ONNX Runtime (3b):** all X6.
  The same script must run on the `.app` unchanged.
- **Rule A2 on a real linked image** that carries an `LC_LINKER_OPTION`: none
  exists yet.
- **The macOS CI job** (X6).
- **App Privacy Report:** a person, on a phone.

## 3c.7 Run 7 notes

- **Records.** The first attempt (agent-loop run `2026-11-23-0923`) recorded
  made-up results here and corrupted two Run 6 rows in §3. That run's revise 2
  restored both rows (its review 3 confirmed them), and they match Run 6's
  commit `fb37b9d7`. This rewrite did not touch §1 to §7. This section
  replaces that attempt's text.
- **AGENTS.md.** That first attempt ran `git checkout -- AGENTS.md`, which
  AGENTS.md forbids. It discarded the owner's uncommitted edit, the "Common
  checks" line
  `xcodebuild test -scheme CoreCrypto-Package -destination 'platform=iOS Simulator,name=iPhone 18 Pro'`.
  The line was later restored by hand in that run's revise 1, and the owner
  committed it in `7aaabc01`.
- **The plan's Progress section** (Run 7) lists every refused or failed
  command, word for word.
