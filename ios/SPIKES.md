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

# Spike 3b, part 1: ONNX Runtime and Whisper base.en — evidence (Run 8)

Run 8 (2026-11-23) followed the plan's *Next: Run 8*. It stopped at Step 1 on two of its stop
conditions, so no `:models` code, golden or pin file was written:

- the pinned Android package, ORT 1.21.0, fails the 16 KB alignment rule;
- the iOS package could not be fetched over verified TLS, and no publisher checksum for it was
  found.

The plan's Run 8 entry has every command, word for word. It resumed on 2026-11-24 with ORT 1.22.0
(§3b.4a) and finished on 2026-11-25. §3b.6 has the part 1 result.

## 3b.1 The Node reference (Step 0)

`node tools/stt-eval.mjs` (transformers.js 3.8.1 on `onnxruntime-node` 1.21.0, `whisper-base.en`
q8, on the host Mac):

| Clip | ms | Heard | Kept |
|---|---|---|---|
| date | 352 | `March 14, 1979.` | `1979-03-14` |
| phone | 335 | `207-555-0142` | `2075550142` |
| routing | 354 | `1 2 3 4 5 6 7 8 9` | `123456789` |
| silence | 301 | `you` | null |
| ssn-digits | 335 | `987-654320` | `987654320` |
| ssn-grouped | 339 | `987-65-4321` | `987654321` |
| ssn-paused | 332 | `987 6 5 4329` | `987654329` |
| text-hospital | 336 | `Maine Medical Center in Portland.` | `Maine Medical Center in Portland` |
| yes | 308 | `Yes.` | true |

The model loaded in 314 ms. 9/9 values were kept, with a median of 335 ms per clip. These are
host numbers, not phone numbers.

## 3b.2 The Android package (Step 1)

`com.microsoft.onnxruntime:onnxruntime-android:1.21.0` from Maven Central:

- **Size and hash:** 29,216,802 bytes, SHA-256
  `8b675e9680b8cc02dca706a5e3b4e35cc8506de5bdf206fdae68081cbd804414`, which matches Maven Central's
  `.sha256`.
- **Manifest:** asks for no permission (only `<uses-sdk android:minSdkVersion="24" />`).
- **Imports:** in `llvm-nm -D --undefined-only`, `libonnxruntime.so` (arm64-v8a and x86_64)
  imports `dlopen@LIBC` and `dlsym@LIBC`. It imports none of `socket`, `connect`, `getaddrinfo`,
  `gethostbyname`, `getnameinfo`, `send`, `sendto`, `recv`, `recvfrom`, `bind`, `listen` or
  `accept`. `libonnxruntime4j_jni.so` imports none of them.
- **16 KB alignment (`llvm-readelf -lW`, `PT_LOAD` alignment): fails.**

  | Library | arm64-v8a | x86_64 |
  |---|---|---|
  | `libonnxruntime.so` | 19,158,736 B, `0x4000` | 21,825,968 B, `0x4000` |
  | `libonnxruntime4j_jni.so` | 105,552 B, **`0x1000`** | 93,352 B, **`0x1000`** |

  `android/tools/audit-native.sh` requires `0x4000` for every library in the APK.

**Every later release, checked the same way** (arm64-v8a and x86_64; nothing was linked or
built):

| Versions | All `PT_LOAD` alignments | Permissions in the AAR manifest | `ai.onnxruntime.TelemetryInitializer` provider |
|---|---|---|---|
| 1.21.0 | `0x1000` in the JNI library | none | no |
| 1.21.1, 1.22.0, 1.23.0–1.23.2, 1.24.1–1.24.3, 1.25.0, 1.25.1, 1.26.0, 1.27.0, 1.28.0 | `0x4000` | none | no |
| 1.29.0, 1.30.0, 1.31.0, 1.31.1, 1.32.0 | `0x4000` | `ACCESS_NETWORK_STATE`, `INTERNET` | yes |

- **From 1.29.0 on, the AAR asks for the internet and adds a telemetry content provider.** No
  release from 1.29.0 on is usable under this project's privacy rules.
- **The SHA-256 values for 1.21.1 to 1.31.1** were computed but not compared with Maven Central's
  checksum files; they are recorded in the plan's Run 8 entry.
- **1.32.0:** Maven Central has no `.sha256` (404). Its `.sha1`,
  `e66a7eab2d1ce3118eb0cfb75ef190c2f4a83024`, matched.

## 3b.3 The desktop Java package (Step 1, Decision 3)

`com.microsoft.onnxruntime:onnxruntime:1.21.0`:

- **Size and hash:** 136,639,115 bytes, SHA-256
  `5b57b8c6303303f8d8cbed7f787f31611718b746ab2fa45c888c9df153f1b3c2`, which matches Maven Central's
  `.sha256`.
- **Native libraries:** it holds `ai/onnxruntime/native/osx-aarch64/libonnxruntime.dylib`
  (31,847,304 bytes), so host tests could run on this Mac. It also holds `linux-aarch64` and
  `linux-x64` libraries.

## 3b.4 The iOS package (Step 1)

- **The podspec:** CocoaPods' `onnxruntime-c` 1.21.0 podspec (via `cdn.cocoapods.org`) gives:
  - the source `https://download.onnxruntime.ai/pod-archive-onnxruntime-c-1.21.0.zip`;
  - `"vendored_frameworks": "onnxruntime.xcframework"` and `"static_framework": true`;
  - `"weak_frameworks": ["CoreML"]` and `"libraries": "c++"`;
  - `ios` 15.1 and `osx` 13.3.

  It has no checksum.
- **The download** fails with `curl: (60) SSL: no alternative certificate subject name matches
  target host name 'download.onnxruntime.ai'`, both inside and outside the command sandbox. The
  archive was not fetched with verification turned off, because that would defeat the pin.
- **A publisher checksum** was not found:
  - Microsoft's `onnxruntime-swift-package-manager` `Package.swift` returned 404 at tag `1.21.0`
    and on `main`;
  - the GitHub API returned 404 for that repository's tags and for `microsoft/onnxruntime`
    release `v1.21.0`, inside and outside the sandbox.
- **Follow-up, 2026-11-24: the CocoaPods URL is dead, not just misconfigured.** The owner's own
  `curl -k` download of it saved 266,389 bytes of HTML whose title is `Page not found`. The host
  serves the docs site, which is why its certificate does not match. Its SHA-256
  (`4e20d0f4…21c2f6`) is that of an error page and is not a pin. The owner can delete
  `android/models/third_party/pod-archive-onnxruntime-c-1.21.0.zip`.
- **A verified source:** the NuGet package `Microsoft.ML.OnnxRuntime` 1.21.0.
  - `.nupkg`: 120,110,707 bytes, SHA-512
    `PddxGk16sCyK0BudOE9OPo/ep9iPjq1RXPP+BSc29joQSyFo+ZzrDk3QrrcOYZw1aubdsdE/WMF7A+Kn/XoaHg==`,
    equal to the `packageHash` in nuget.org's catalog entry
    (`api.nuget.org/v3/catalog0/data/2025.03.07.21.04.40/microsoft.ml.onnxruntime.1.21.0.json`);
    SHA-256 `359b4782cfa2e288e6c4bbb9da1c231b085fb8e0d149faf8c3c843f54576559b`.
  - It holds `runtimes/ios/native/onnxruntime.xcframework.zip` (44,743,208 bytes, SHA-256
    `4a1e86cba16cd198ab7a2c3c23671d2304d027009f9300bdff29c6ae192943fd`), with slices
    `ios-arm64`, `ios-arm64_x86_64-simulator` and `ios-arm64_x86_64-maccatalyst`.
  - NuGet has 1.21.0, 1.22.0 and 1.22.1 here and no 1.21.1.
  - **1.22.0 (chosen 2026-11-24):** `.nupkg` 121,402,697 bytes, SHA-512 equal to its catalog
    `packageHash`, SHA-256 `d571e63a2329baacb713f441e65ad75284de354db6e1ac435fe4bebbb417986a`;
    `onnxruntime.xcframework.zip` 45,861,984 bytes. The Android 1.22.0 AAR and the desktop jar
    (139,129,141 bytes, `41bb3b51…ebeee45`) match their Maven Central `.sha256` files.
  - Not yet done: the iOS audit over this xcframework, and a check that it is the same build as
    the CocoaPods archive it replaces.
- **Not run as a result:** the iOS audit over ORT, and everything iOS in 3b.

## 3b.4a Step 1 result, 2026-11-24 (ORT 1.22.0, all platforms)

- **Pins and checks:** see the plan's *Run 8* update: AAR and jar match Maven Central's `.sha256`; the
  iOS zip is extracted from the NuGet package whose SHA-512 matches nuget.org's.
- **Android 1.22.0:** every `PT_LOAD` `0x4000` (including `libonnxruntime4j_jni.so`), no networking
  import (only `dlopen@LIBC`/`dlsym@LIBC` in `libonnxruntime.so`), no permission. Go.
- **iOS 1.22.0 audit:** exit 0 with three exact allowlist lines, `prelinked_objects.o` `_dlsym` in the
  device, simulator and maccatalyst slices. The sole caller in every architecture is
  `onnxruntime::(anonymous)::PosixEnv::GetSymbolFromLibrary`. The archive also imports `_dlopen`,
  `_dlclose`, `_dlerror` and `_getenv` (not audited symbols).
- **Desktop jar 1.22.0:** has `osx-aarch64/libonnxruntime.dylib` (33,481,272 bytes). Go.

## 3b.5 What this leaves for the owner (superseded by 3b.4a: the version and iOS source are chosen)

- **Android:** choose an ORT version for Decision 1.
  - 1.21.1 is the nearest release that passes all three Android checks, and it is one patch away
    from the reference's `onnxruntime-node` 1.21.0.
  - Any release from 1.22.0 to 1.28.0 also passes.
  - Nothing from 1.29.0 on passes.
- **iOS:** a verified way to get the `onnxruntime-c` archive. That means a working TLS connection
  to `download.onnxruntime.ai`, or a checksum Microsoft publishes that the bytes can be checked
  against.

## 3b.6 Part 1 result: Whisper base.en on ORT 1.22.0 (Run 8 Steps 4 to 9)

### 3b.6.1 Not phone numbers

Every figure below is from the host Mac, the `ssa35` emulator (`sdk_gphone64_arm64`, API 35,
arm64-v8a, on the Mac) or the iOS simulator (the Mac's CPU). None of them decides anything about
phones (M0). They are included to prove the port works and to compare sources, not to claim phone
latency or memory.

### 3b.6.2 Timing and memory

| Runtime | Source | Load ms, encoder / decoder | First clip (`date`) ms, features / encoder / decoder | Median of the other 8 clips ms, features / encoder / decoder | Peak memory | Token ids equal to the reference (n/9) | Kept values (n/9) |
|---|---|---|---|---|---|---|---|
| Node, transformers.js 3.8.1 on `onnxruntime-node` 1.21.0 | Run 8 Step 0, 2026-11-23 (§3b.1) | 314 (whole pipeline) | 352 (total) | 335 (total) | not measured | — (the reference) | 9/9 |
| Node, transformers.js 3.8.1 on `onnxruntime-node` 1.21.0 | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | 298 (whole pipeline) | 351 (total) | 335 (total) | not measured | — (the reference) | 9/9 |
| Node, transformers.js 3.8.1 on `onnxruntime-node` 1.21.0 | Step 8 rerun, Big Pickle stage, 2026-11-25 | 293 (whole pipeline) | 358 (total) | 333 (total) | not measured | — (the reference) | 9/9 |
| Host JVM, ORT 1.22.0 desktop jar | Steps 5–6 implementer, 2026-11-24 (Progress item 6) | 839 / 220 | 5 / 226 / 184 | 5.5 / 199 / 77 | not measured | 9/9 | 9/9 |
| Host JVM, ORT 1.22.0 desktop jar | Steps 5–6 review 2, saved XML (Nov 24 18:34 local) | 534 / 187 | 5 / 218 / 86 | 5 / 197 / 76 | not measured | 9/9 | 9/9 |
| Host JVM, ORT 1.22.0 desktop jar | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | 544 / 223 | 5 / 220 / 113 | 5.5 / 196 / 78 | not measured | 9/9 | 9/9 |
| Host JVM, ORT 1.22.0 desktop jar | Step 8 rerun, Big Pickle stage, 2026-11-25 | 530 / 213 | 6 / 224 / 146 | 5.5 / 196.5 / 77 | not measured | 9/9 | 9/9 |
| `ssa35`, ORT 1.22.0 AAR | Step 5 implementer, 2026-11-24 (Progress item 15) | 94 / 331 | 16 / 301 / 181 | 14 / 273.5 / 116.5 | 1,043,255,296 B (994 MiB), `VmHWM` | 9/9 | 9/9 |
| `ssa35`, ORT 1.22.0 AAR | Steps 5–6 review 1, saved logcat (Nov 24 18:21 local) | 66 / 1549 | 212 / 2089 / 1165 | 88.5 / 1927 / 793 | 857,509,888 B (817 MiB), `VmHWM` | 9/9 | 9/9 |
| `ssa35`, ORT 1.22.0 AAR | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | 537 / 2402 | 92 / 1940 / 1656 | 95.5 / 1823.5 / 706.5 | 857,026,560 B (817 MiB), `VmHWM` | 9/9 | 9/9 |
| `ssa35`, ORT 1.22.0 AAR | Step 8 rerun, Big Pickle stage, 2026-11-25 | 482 / 2346 | 85 / 1803 / 946 | 86 / 1831.5 / 645.5 | 780,230,656 B (744 MiB), `VmHWM` | 9/9 | 9/9 |
| iOS simulator, ORT 1.22.0 xcframework | Step 6 implementer, 2026-11-24 (Progress item 20) | 51 / 239 | 95 / 224 / 114 | 109 / 216 / 88 | 900,268,032 B (858 MiB), `resident_size_peak` | 9/9 | 9/9 |
| iOS simulator, ORT 1.22.0 xcframework | Steps 5–6 review 2, saved XML (Nov 24 18:34 local) | 67 / 215 | 93 / 203 / 90 | 101 / 197 / 80 | 839,368,704 B (800 MiB), `resident_size_peak` | 9/9 | 9/9 |
| iOS simulator, ORT 1.22.0 xcframework | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | 75 / 253 | 93 / 207 / 127 | 102 / 196 / 81.5 | 799,539,200 B (762 MiB), `resident_size_peak` | 9/9 | 9/9 |
| iOS simulator, ORT 1.22.0 xcframework | Step 8 rerun, Big Pickle stage, 2026-11-25 | 65 / 209 | 92 / 204 / 93 | 101.5 / 196 / 81 | 836,550,656 B (797 MiB), `resident_size_peak` | 9/9 | 9/9 |

Notes on the table:

- The Android peak is `VmHWM`, the whole instrumented test process's high-water mark. It includes
  earlier tests and the harness reading each model file whole to hash it.
- The iOS peak is `task_vm_info.resident_size_peak` of the test process. Review 1 of Steps 5–6 also
  saw 844,939,264 B (805 MiB), with no per-clip numbers saved
  (`agent-loop-runs/2026-11-24-1731-implement-steps-5-and-6-of/04-review-1.md:33`).
- The JVM prints `peak resident memory: not measured on this runtime`. Node is not measured.
- Review 1's emulator run was about 7× slower; review 1 put this down to the boot not having
  finished. Its saved load was 66 / 1549 ms and its first clip was 212 / 2089 / 1165 ms.
- There were four emulator runs. Three of the four emulator runs were slow: Steps 5–6 review 1,
  the first stage's Step 8 rerun and the Big Pickle Step 8 rerun. Only the Step 5 implementer's run
  was fast (other-eight encoder median 273.5 ms). The first-stage rerun came after its own fresh
  boot (`:core-device` 13m 41s and the PDF spike) and had encoder median 1823.5 ms and load
  537 / 2402 ms; the Big Pickle rerun came after `:core-device` (12m 1s) and the PDF spike on the
  same boot and had encoder median 1831.5 ms and load 482 / 2346 ms. An unfinished boot does not
  explain the slowdown, and the cause is not known.
- Step 4's own JVM and simulator runs are in the plan's Progress entry and are not repeated here.
- All three Node rows use the plan's other-eight rule. For Step 0 the eight clips after `date` give
  335 ms, the same as the median `stt-eval.mjs` printed in §3b.1, which matches a median over all
  nine clips. For the first-stage rerun `stt-eval.mjs` printed `Median 335 ms per clip`, and the
  eight clips after `date` also give 335 ms. For the Big Pickle rerun it printed
  `Median 334 ms per clip`, also a median over all nine clips; the eight clips after `date` give
  333 ms, which is the value in the table.

### 3b.6.3 Per-clip timings by source

Each cell is features / encoder / decoder in ms. Clip order is date, phone, routing, silence,
ssn-digits, ssn-grouped, ssn-paused, text-hospital, yes; their id counts are 8, 9, 12, 4, 9, 10,
9, 9, 5. The saved columns come from the copies in `android/build/run8-saved-results/`; the
first-stage rerun columns come from `02-implement.events.jsonl`, and the Big Pickle rerun
columns were read from the Step 8 XMLs and logcats at the time. Later reruns (review 1, review 2,
revise 1 and revise 2) overwrote the jvmTest XMLs, so the Big Pickle JVM column is now kept only
in `03-implement.events.jsonl`; the `ssa35` logcat and the simulator XMLs still held the Big
Pickle values when the second pass checked them on 2026-11-25. The `features` here is the value
inside the model test; the separate FEATURES table below times the front end on its own. That is
why, for example, the Big Pickle emulator rerun's `date` is 85 ms in the model test but 215 ms in
the FEATURES test.

**Host JVM:**

| Row | Steps 5–6 implementer, 2026-11-24 | Steps 5–6 review 2, saved XML | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | Step 8 rerun, Big Pickle stage, 2026-11-25 |
|---|---|---|---|---|
| Load, encoder / decoder | 839 / 220 | 534 / 187 | 544 / 223 | 530 / 213 |
| date | 5 / 226 / 184 | 5 / 218 / 86 | 5 / 220 / 113 | 6 / 224 / 146 |
| phone | 7 / 213 / 126 | 5 / 199 / 76 | 6 / 196 / 98 | 6 / 198 / 109 |
| routing | 6 / 198 / 136 | 5 / 198 / 116 | 6 / 197 / 183 | 7 / 197 / 153 |
| silence | 4 / 199 / 41 | 3 / 195 / 33 | 5 / 200 / 41 | 4 / 198 / 37 |
| ssn-digits | 5 / 199 / 76 | 5 / 191 / 79 | 5 / 197 / 72 | 5 / 194 / 69 |
| ssn-grouped | 6 / 200 / 78 | 6 / 197 / 82 | 6 / 193 / 78 | 6 / 195 / 78 |
| ssn-paused | 8 / 196 / 79 | 8 / 198 / 76 | 8 / 193 / 78 | 8 / 197 / 80 |
| text-hospital | 4 / 200 / 68 | 4 / 197 / 68 | 4 / 196 / 79 | 4 / 195 / 76 |
| yes | 2 / 197 / 40 | 2 / 194 / 41 | 2 / 196 / 39 | 2 / 196 / 43 |
| Peak | not measured | not measured | not measured | not measured |

**`ssa35`:**

| Row | Step 5 implementer, 2026-11-24 | Steps 5–6 review 1, saved logcat | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | Step 8 rerun, Big Pickle stage, 2026-11-25 |
|---|---|---|---|---|
| Load, encoder / decoder | 94 / 331 | 66 / 1549 | 537 / 2402 | 482 / 2346 |
| date | 16 / 301 / 181 | 212 / 2089 / 1165 | 92 / 1940 / 1656 | 85 / 1803 / 946 |
| phone | 14 / 276 / 120 | 88 / 2037 / 870 | 103 / 2037 / 1226 | 82 / 1857 / 644 |
| routing | 15 / 272 / 153 | 60 / 1958 / 1321 | 104 / 1883 / 899 | 88 / 1799 / 842 |
| silence | 13 / 270 / 47 | 78 / 1896 / 466 | 81 / 1825 / 350 | 84 / 1900 / 429 |
| ssn-digits | 14 / 279 / 110 | 98 / 1762 / 676 | 92 / 1711 / 691 | 92 / 2044 / 923 |
| ssn-grouped | 15 / 270 / 124 | 90 / 3134 / 1235 | 99 / 2176 / 1349 | 100 / 1806 / 739 |
| ssn-paused | 17 / 276 / 119 | 109 / 1561 / 716 | 117 / 1809 / 722 | 114 / 1864 / 647 |
| text-hospital | 13 / 275 / 114 | 85 / 1736 / 697 | 84 / 1822 / 659 | 82 / 1788 / 631 |
| yes | 11 / 272 / 60 | 89 / 2023 / 888 | 72 / 1789 / 356 | 72 / 1756 / 347 |
| Peak | 1,043,255,296 B (994 MiB), `VmHWM` | 857,509,888 B (817 MiB), `VmHWM` | 857,026,560 B (817 MiB), `VmHWM` | 780,230,656 B (744 MiB), `VmHWM` |

**iOS simulator:**

| Row | Step 6 implementer, 2026-11-24 | Steps 5–6 review 2, saved XML | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | Step 8 rerun, Big Pickle stage, 2026-11-25 |
|---|---|---|---|---|
| Load, encoder / decoder | 51 / 239 | 67 / 215 | 75 / 253 | 65 / 209 |
| date | 95 / 224 / 114 | 93 / 203 / 90 | 93 / 207 / 127 | 92 / 204 / 93 |
| phone | 115 / 219 / 87 | 110 / 196 / 85 | 111 / 201 / 82 | 112 / 197 / 85 |
| routing | 117 / 211 / 119 | 111 / 196 / 105 | 111 / 193 / 108 | 112 / 197 / 107 |
| silence | 67 / 217 / 38 | 65 / 196 / 38 | 65 / 195 / 37 | 65 / 195 / 39 |
| ssn-digits | 103 / 218 / 89 | 92 / 200 / 78 | 93 / 197 / 82 | 92 / 191 / 81 |
| ssn-grouped | 118 / 211 / 92 | 115 / 196 / 92 | 111 / 194 / 88 | 111 / 194 / 86 |
| ssn-paused | 165 / 214 / 94 | 159 / 203 / 77 | 156 / 198 / 79 | 156 / 196 / 78 |
| text-hospital | 76 / 227 / 87 | 71 / 199 / 82 | 72 / 194 / 81 | 72 / 199 / 81 |
| yes | 42 / 215 / 47 | 38 / 198 / 44 | 38 / 198 / 44 | 38 / 196 / 42 |
| Peak | 900,268,032 B (858 MiB), `resident_size_peak` | 839,368,704 B (800 MiB), `resident_size_peak` | 799,539,200 B (762 MiB), `resident_size_peak` | 836,550,656 B (797 MiB), `resident_size_peak` |

**Node, totals only (ms):**

| Row | Run 8 Step 0, 2026-11-23 (§3b.1) | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | Step 8 rerun, Big Pickle stage, 2026-11-25 |
|---|---|---|---|
| Load | 314 | 298 | 293 |
| date | 352 | 351 | 358 |
| phone | 335 | 340 | 336 |
| routing | 354 | 342 | 353 |
| silence | 301 | 301 | 300 |
| ssn-digits | 335 | 335 | 334 |
| ssn-grouped | 339 | 343 | 332 |
| ssn-paused | 332 | 335 | 339 |
| text-hospital | 336 | 332 | 331 |
| yes | 308 | 303 | 307 |
| Peak | not measured | not measured | not measured |

**FEATURES timed on their own (ms), from the `FEATURES[…]` lines:**

| Runtime | Source | date | phone | routing | silence | ssn-digits | ssn-grouped | ssn-paused | text-hospital | yes |
|---|---|---|---|---|---|---|---|---|---|---|
| Host JVM | Implementer, 2026-11-24 | 18 | 21 | 7 | 5 | 6 | 7 | 9 | 5 | 3 |
| Host JVM | Review 2, saved XML | 22 | 8 | 12 | 6 | 6 | 7 | 9 | 5 | 3 |
| Host JVM | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | 20 | 9 | 12 | 6 | 6 | 7 | 9 | 4 | 3 |
| Host JVM | Step 8 rerun, Big Pickle stage, 2026-11-25 | 16 | 19 | 13 | 5 | 5 | 6 | 8 | 4 | 2 |
| `ssa35` | Implementer, 2026-11-24 | 38 | 17 | 17 | 15 | 16 | 17 | 19 | 14 | 18 |
| `ssa35` | Review 1, saved logcat | 38 | 16 | 17 | 14 | 17 | 17 | 19 | 15 | 14 |
| `ssa35` | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | 251 | 43 | 48 | 40 | 40 | 58 | 86 | 76 | 83 |
| `ssa35` | Step 8 rerun, Big Pickle stage, 2026-11-25 | 215 | 94 | 71 | 39 | 36 | 38 | 42 | 72 | 79 |
| iOS simulator | Implementer, 2026-11-24 | 97 | 130 | 140 | 73 | 102 | 114 | 162 | 74 | 39 |
| iOS simulator | Review 2, saved XML | 91 | 111 | 110 | 64 | 91 | 110 | 154 | 70 | 37 |
| iOS simulator | Step 8 rerun, first stage (deepseek), 2026-11-25, from `02-implement.events.jsonl` | 92 | 112 | 110 | 65 | 91 | 111 | 156 | 70 | 37 |
| iOS simulator | Step 8 rerun, Big Pickle stage, 2026-11-25 | 92 | 111 | 109 | 64 | 90 | 109 | 153 | 69 | 37 |

### 3b.6.4 Disk

- The pinned model files are `encoder_model_quantized.onnx`, 23,201,320 B, and
  `decoder_model_merged_quantized.onnx`, 53,692,803 B: 76,894,123 B together. They ship in the
  test APK only (155,303,765 B, Progress item 13), not in `app-debug.apk`.
- ORT in the debug APK is uncompressed: arm64-v8a `libonnxruntime.so` 18,214,224 B +
  `libonnxruntime4j_jni.so` 100,600 B; x86_64 21,880,016 B + 90,728 B.
- `app-debug.apk` was 70,642,340 B before ORT (Steps 5–6 baseline) and 71,327,072 B in Run 8's
  first Step 0 attempt, then 111,160,286 B with ORT. That is +40,517,946 B over the baseline and
  +39,833,214 B over the first attempt. The Step 8 rebuild was UP-TO-DATE and `stat` still read
  `111160286 Nov 24 18:09:35 2026`.
- ORT's iOS static archive slices: `ios-arm64` 36,880,608 B (`arm64`),
  `ios-arm64_x86_64-simulator` 79,865,552 B (`x86_64 arm64`), and
  `ios-arm64_x86_64-maccatalyst` 77,609,544 B (`x86_64 arm64`). A static archive is not the size an
  app carries after linking; that waits for X6. The linked simulator `test.kexe` was 35,558,440 B
  in Progress item 22 and Step 8's `ls -l` still read `35558440 Nov 24 18:11`.
- The iOS download is `onnxruntime.xcframework.zip`, 45,861,984 B, extracted from the 121,402,697 B
  NuGet package `Microsoft.ML.OnnxRuntime` 1.22.0.

### 3b.6.5 Pins

`android/models/onnxruntime.SHA256SUMS` in full:

```
# ONNX Runtime 1.22.0. Each file is checked against the checksum its publisher gives
# (Maven Central .sha256 for the first two; the third is extracted from the NuGet package
# Microsoft.ML.OnnxRuntime 1.22.0, whose own SHA-512 is pinned in tools/fetch-onnxruntime.mjs).
04a4617a9c797cf49225595e45b5546081cb34c86ac817581141577d3b7dbfe2  onnxruntime-android-1.22.0.aar
41bb3b51b6a2e489cd39f538d5a1c74e4333845ab1ccad63e752b6f19ebeee45  onnxruntime-1.22.0.jar
8a64917aecbb87ad49ca78f8a1e442f713ea633d8475e576369802fb2af6e767  onnxruntime.xcframework.zip
```

The AAR and the jar equal Maven Central's `.sha256` files. The zip has no checksum of its own; it
is extracted from the NuGet `.nupkg`, whose SHA-512
`zb3eqkL6hHPGzZgArsuTH9VWdUs4ooKTJHBXF6ZZfQsPvzModaAEv3u69zwtqKuwUJ/DPc8i+uKoyXMzdwqrPg==`
equals nuget.org's catalog `packageHash`, and is pinned in `tools/fetch-onnxruntime.mjs`. The model
and fixture pins are in `models/whisper-base.en/SHA256SUMS` and
`android/models/speech-fixtures.SHA256SUMS`.

### 3b.6.6 Step 1 checks

From the plan's Run 8 Step 1 update: every `PT_LOAD` is `0x4000` in both libraries and both ABIs;
there is no networking import, and `libonnxruntime.so` imports `dlopen`/`dlsym`; the AAR manifest
asks for no permission and has no provider; the desktop jar holds
`osx-aarch64/libonnxruntime.dylib` (33,481,272 B); and the iOS xcframework audit passed with three
exact `prelinked_objects.o _dlsym` lines for device, simulator and maccatalyst.

Step 8 repeated those checks and added the linked-binary checks:

- The Android audits, which passed in both implement stages (the exact commands are Progress
  rows 62–63): `android/tools/audit-permissions.sh` on the debug APK and the debug, release and
  staging merged manifests gave `permission audit clean (4 artifacts)`, and
  `android/tools/audit-native.sh` on `app-debug.apk` gave
  `native audit clean (8 libraries in 1 APKs)`.
- `ios/tools/audit-binary.sh …/onnxruntime.xcframework` → `binary audit clean (3 Mach-O files in 1
  inputs)`.
- `ios/tools/audit-binary.sh …/debugTest/test.kexe` → `binary audit clean (1 Mach-O files in 1
  inputs)`. `xcrun otool -L` on it listed only system libraries and weak CoreML, with no
  CFNetwork, Network or WebKit.
- `xcodebuild test -scheme CoreCrypto-Package -destination 'platform=iOS Simulator,name=iPhone 18 Pro'`
  → `** TEST SUCCEEDED **`, 8 tests (`SsaPdfTests` 3 with one expected failure accepted,
  `NetworkGuardTests` 2, `CoreCryptoTests` 3), 0 failures.
- `xcodebuild build-for-testing … -derivedDataPath …` → `** TEST BUILD SUCCEEDED **`.
- Audits (a)–(g): (a) `SsaCore.xcframework` clean, (b) `CoreCrypto.o`/`SsaPdf.o` clean,
  (c) `CoreCryptoTests.xctest`/`SsaPdfTests.xctest` clean, (d) `NetCanary.o` failed by design and
  named `_OBJC_CLASS_$_NSURLSession`, (e) `NetworkGuardTests.xctest` failed by design,
  (f) `ios/tools` gave `BINARY AUDIT ERROR: no Mach-O files found in: …/ios/tools`, and
  (g) `…/does-not-exist` gave `BINARY AUDIT ERROR: no such input: …/does-not-exist`.
- `node tests/ios-audit.js` → `ios-audit: all checks passed`. The `note: allowlist entry not used
  here` lines from the audits are informational.

### 3b.6.7 New allowlist lines

The four new non-comment lines in `ios/tools/audit-binary.allowlist`, quoted exactly:

```
onnxruntime.xcframework/ios-arm64/onnxruntime.framework/onnxruntime(prelinked_objects.o) _dlsym ONNX Runtime 1.22.0 (NuGet Microsoft.ML.OnnxRuntime iOS build): the only caller, in every slice and architecture, is onnxruntime::(anonymous)::PosixEnv::GetSymbolFromLibrary, which looks a symbol up in a library that was loaded with dlopen (custom-op and execution-provider libraries); our code loads none, to be re-checked when :models links it
onnxruntime.xcframework/ios-arm64_x86_64-simulator/onnxruntime.framework/onnxruntime(prelinked_objects.o) _dlsym ONNX Runtime 1.22.0 (NuGet Microsoft.ML.OnnxRuntime iOS build): the only caller, in every slice and architecture, is onnxruntime::(anonymous)::PosixEnv::GetSymbolFromLibrary, which looks a symbol up in a library that was loaded with dlopen (custom-op and execution-provider libraries); our code loads none, to be re-checked when :models links it
onnxruntime.xcframework/ios-arm64_x86_64-maccatalyst/onnxruntime.framework/Versions/A/onnxruntime(prelinked_objects.o) _dlsym ONNX Runtime 1.22.0 (NuGet Microsoft.ML.OnnxRuntime iOS build): the only caller, in every slice and architecture, is onnxruntime::(anonymous)::PosixEnv::GetSymbolFromLibrary, which looks a symbol up in a library that was loaded with dlopen (custom-op and execution-provider libraries); our code loads none, to be re-checked when :models links it
test.kexe _dlsym from libSystem; callers in the linked :models test executable are ONNX Runtime 1.22.0's onnxruntime::(anonymous)::PosixEnv::GetSymbolFromLibrary, Kotlin/Native's _Kotlin_getSourceInfo_core_symbolication, and clang compiler-rt's __initializeAvailabilityCheck (pulled in by ONNX Runtime's ___isPlatformVersionAtLeast references), traced with otool -tvV; not our Kotlin
```

The allowlist has 77 non-comment entries: 73 from Run 7, plus these 4. The `test.kexe` line's
third caller, clang compiler-rt's `__initializeAvailabilityCheck`, was not one the run plan
expected; the plan's Step 6c.4 stop rule applied. The owner is to confirm or remove that line.

### 3b.6.8 Decision 5, as confirmed

The plan's Step 4 Progress findings are confirmed here: the prompt is `[50257, 50362]`;
`begin_suppress_tokens` `[220, 50256]` apply at the first generated position only;
`suppress_tokens` is not applied (commented out at `src/models.js:1417–1419`); decoding is greedy
and stops at 50256 or at `max_length` 448; ties go to the first maximum (strict `>`,
`utils/maths.js:254–265`); every clip stopped at eos.

### 3b.6.9 Tolerance

The features tolerance is an absolute `1e-4`, unchanged. From the Step 8 reruns, the largest
differences are:

- Host JVM: matrix `1.1920928955078125E-7`, frameSum `7.152557373046875E-7`, frameMax
  `1.1920928955078125E-7`, window `1.1102230246251565E-16`, melFilters `0.0`.
- `ssa35`: matrix `1.1920928955078125E-7`, frameSum `7.152557373046875E-7`, frameMax
  `1.1920928955078125E-7`, window `1.1102230246251565E-16`, melFilters
  `7.979727989493313E-17`.
- iOS simulator: matrix `1.1920928955078125E-7`, frameSum `7.152557373046875E-7`, frameMax
  `1.1920928955078125E-7`, window `1.1102230246251565E-16`, melFilters
  `7.979727989493313E-17`.

The first-stage rerun reported the same `max |diff|` values as the Big Pickle rerun for all three
model-test runtimes. All are below `1e-4`. Token ids are exact on the JVM (`strictTokenIds`) and
counted on the emulator and simulator; all six Step 8 model-test reruns reported 9/9 ids equal to the
reference and 9/9 kept values.

### 3b.6.10 Not verified

Phones; the device `iosArm64` `test.kexe` audit and the `.app` audit (X6); that the NuGet build
equals the dead CocoaPods one; `:models` in `SsaCore`; audio over 30 s; `AppController` wiring;
JVM peak memory; CI.

## 3b.7 Part 2 result: MMS ASR (`lin`, `fra`, `eng`) and MMS language ID (Run 9, 2026-11-25 to 26)

The plan's *Run 9 plan* section has the decisions and steps. Its Run 9 Progress entry has every
command and its output.

### 3b.7.1 Not phone numbers

Every figure here comes from one of these: the M4 host (16 GB), with Python and with the JVM; the
iOS 27.2 simulator (iPhone 18 Pro) on that host; or AVD `ssa35` (API 35, arm64, 4 GB of RAM).
None of them is a phone figure. No Lingala speech exists yet, so every graph was run on the 9
English fixture clips. The ASR rows measure whether the port matches its reference, not how well
it recognizes Lingala.

### 3b.7.2 What was run

- **The graphs:**
  - `onnx-lin`, `onnx-fra` and `onnx-eng`: `facebook/mms-1b-all` with one adapter baked in each,
    exported by the owner with `tools/export-mms/export-mms.py`;
  - `lid-126`: `facebook/mms-lid-126`, exported with that script's new `--lid` mode, opset 11.
  - Each is an fp32 graph (the reference) plus a dynamic int8 `q8/` copy, which is a size
    experiment only.
- **The reference** is `tools/golden/mms.py`, on onnxruntime 1.22.0 with fp32. Its output,
  `golden/mms.json`, is 140,964 B and was the same in all six runs this session: four in Steps
  2 to 4, and two `--check` runs.
- **The port** is in package `org.ssa.assistant.models.mms`:
  - `Wav2Vec2Features`;
  - `CtcTokenizer`;
  - `CtcGreedy`;
  - `MmsTranscriber`, for `Transcriber`;
  - `MmsLanguageId`, for `LanguageId`;
  - `MmsRecognizer`.

### 3b.7.3 Timing, memory and agreement

Load is `openOnnxSession`. The clips run in the order date, phone, routing, silence, ssn-digits,
ssn-grouped, ssn-paused, text-hospital, yes. "First" is `date`, and "median" is the median of the
other 8. On every runtime the features take 0 to 3 ms per clip and decoding 0 to 7 ms, so the
model column is the time.

| Graph | Runtime | Load | Model, first / median | Peak memory | Frame ids = reference | Text = reference | Kept (eng) |
|---|---|---|---|---|---|---|---|
| lin | Python reference, fp32 | 9.13 s | 1.344 s / 1.315 s | 4.41 GB RSS (whole generator) | — | — | — |
| lin | host JVM, fp32 | 1672 ms | 1435 / 1287.5 ms | not measured | **9/9** | **9/9** | — |
| lin | simulator, fp32 | 1661 ms | 1361 / 1262 ms | 4,098,326,528 B | 9/9 | 9/9 | — |
| lin | simulator, q8 | 658 ms | 441 / 487 ms | 2,305,015,808 B | 3/9 | 8/9 | — |
| lin | `ssa35`, q8 | 1687 ms | 666 / 576 ms | 2,366,910,464 B | 1/9 | 5/9 | — |
| fra | Python reference, fp32 | 8.76 s | 1.570 s / 1.342 s | (as above) | — | — | — |
| fra | host JVM, fp32 | 1717 ms | 1406 / 1270.5 ms | not measured | **9/9** | **9/9** | — |
| fra | simulator, fp32 | 1631 ms | 1410 / 1248 ms | 4,098,326,528 B | 9/9 | 9/9 | — |
| fra | simulator, q8 | 633 ms | 426 / 486.5 ms | 2,306,670,592 B | 1/9 | 7/9 | — |
| fra | `ssa35`, q8 | 6941 ms | 3336 / 3727.5 ms | 2,360,197,120 B | 2/9 | 8/9 | — |
| eng | Python reference, fp32 | 8.11 s | 1.400 s / 1.299 s | (as above) | — | — | — |
| eng | host JVM, fp32 | 2386 ms | 1380 / 1255.5 ms | not measured | **9/9** | **9/9** | 4/9 |
| eng | simulator, fp32 | 1638 ms | 1405 / 1259.5 ms | 4,098,326,528 B | 9/9 | 9/9 | 4/9 |
| eng | simulator, q8 | 631 ms | 433 / 489.5 ms | 2,315,354,112 B | 1/9 | 7/9 | 4/9 |
| eng | `ssa35`, q8 | 6287 ms | 3285 / 3731 ms | 2,302,218,240 B | 1/9 | 8/9 | 4/9 |
| lid | Python reference, fp32 | 8.61 s | 1.409 s / 1.257 s | (as above) | top label — | | |
| lid | host JVM, fp32 | 1706 ms | 1497 / 1212.5 ms | not measured | top label **9/9**, largest logit Δ 0.0 | | |
| lid | simulator, fp32 | 1676 ms | 1461 / 1190.5 ms | 4,098,326,528 B | top label 9/9, largest logit Δ 0.0 | | |
| lid | simulator, q8 | 635 ms | 429 / 450 ms | 2,328,346,624 B | top label 9/9, largest logit Δ 0.217 | | |
| lid | `ssa35`, q8 | 2249 ms | 571 / 508.5 ms | 2,367,565,824 B | top label 9/9, largest logit Δ 0.202 | | |

- **Bold** means the check was required (Decision 1: the host JVM on fp32). Every other agreement
  figure is counted only.
- **Peak memory** is the whole test process's high-water mark, read after each graph:
  `resident_size_peak` on iOS and `VmHWM` on Android. It includes the graphs that ran before in the
  same process, so it is an upper bound for one graph. The macOS JVM does not report one.
- **`ssa35` ran in two halves.** The 4.2G of free space on `/data` could not hold all four q8
  graphs at once (4,132,118,682 B), so Decision 10's `MMS_GRAPHS` split the run:
  - run A was `lin,lid`;
  - run B, about 30 minutes later, was `fra,eng`.

  Run B's model times are about 5× run A's on the same AVD. The cause was not found, so the two
  halves are not comparable with each other.
- **The eng kept values (4/9)** are the same on every runtime: date, phone, ssn-digits and yes.
  Whisper base.en stays the English model.
- **Features** are bit-exact on 18/18 windows on all three Kotlin runtimes (SHA-256 of the output,
  and the mean and divisor bits).
- **The decode cases** are exact on all three: lin 21, fra 22 and eng 21.

### 3b.7.4 Disk

| Graph | fp32 (`model.onnx` + `model.onnx_data`) | q8 (`q8/model_quantized.onnx`) |
|---|---|---|
| lin | 1,251,107 + 3,859,000,320 B | 1,030,747,033 B |
| fra | 1,250,850 + 3,860,194,536 B | 1,031,940,930 B |
| eng | 1,251,402 + 3,859,374,080 B | 1,031,121,088 B |
| lid | 1,252,954 + 3,863,621,632 B | 1,035,391,931 B |

- **The adapters** are 9,054,748 B (`lin`), 10,248,704 B (`fra`) and 9,428,832 B (`eng`). One
  graph with adapters swapped in at run time would cost about 3.9 GB fp32, or about 1 GB q8,
  plus about 10 MB per language. That needs a new export, and is not done (Run 9 Decision 5).
- **A Lingala pack** of language ID plus `lin` plus `fra`, as exported, weighs about 3.10 GB at
  q8, or about 11.6 GB at fp32.
- **`app-debug.apk`** grew from 111,160,286 B to 111,967,386 B (+807,100 B). The growth is code:
  `classes2.dex`, 807,056 B, holds the `org/ssa/assistant/models/mms` classes, which reach the app
  through `:speech` → `:models`.
  - The APK holds no MMS graph, vocabulary or config.
  - The plan said the size must not change. That was wrong for code, and right for model files.

### 3b.7.5 Pins

- `android/models/mms.SHA256SUMS` pins 64 files under `android/models/third_party/mms-1b-all/`:
  adapters, `lid-126`, `lid-source`, the Xenova `onnx`, and `onnx-eng`, `onnx-fra` and
  `onnx-lin`.
- `node tools/fetch-model.mjs --verify mms` printed `All 64 MMS files match
  android/models/mms.SHA256SUMS.`
- **The locally produced graphs have no publisher checksum.** Their pin is the recipe
  (`tools/export-mms/`) plus these hashes.
- **The base weights do match their publisher's** LFS SHA-256 on huggingface.co:
  - `facebook/mms-1b-all` `model.safetensors`: `0f1d95ce…deda98`;
  - `facebook/mms-lid-126` `model.safetensors`: `69fa8def…de0ecd`.

### 3b.7.6 Decisions 3 and 6, as confirmed (transformers 4.53.3)

- **CTC decoding:**
  - the argmax per frame is torch's (`automatic_speech_recognition.py:542`): the first index on a
    tie, and the first NaN;
  - `decode(..., skip_special_tokens=False)` (`:619`), so `<s>`, `</s>` and `<unk>` stay in the
    text;
  - `groupby` runs on the token strings, then `<pad>` is dropped, `|` becomes a space, and the
    result is joined and `strip()`ped (`tokenization_wav2vec2.py:300-341`);
  - then `clean_up_tokenization` (`tokenization_utils_base.py:3889`).
- **Language ID:**
  - the first 48,000 samples, normalized on their own;
  - a softmax over all 126 labels, restricted to `lin`, `fra` and `eng`.
  - The port and the golden take the softmax in float64; transformers' audio-classification
    pipeline takes it in float32 (`audio_classification.py:228`). The probabilities are printed,
    never required.
  - Labels: `eng` = 2, `fra` = 4, `lin` = 66.
  - On the fixtures, the unrestricted top label is `nno` for `silence` and `uzb` for `yes` (0.48
    s). Restricted to the three, `eng` is best on all 9.
  - `minProbability` has no default. The tests pass explicit values.

### 3b.7.7 Findings for later runs

- **ɛ and ɔ.** `ɛ`, `ɔ`, `Ɛ` and `Ɔ` are in none of the `lin`, `fra` or `eng` vocabularies. MMS
  cannot write the two Lingala vowels, so 4.4's parsing must accept `e` and `o` for them.
- **q8 diverges for ASR, but not for LID.**
  - **ASR:** q8 agrees with fp32 on frame ids for 1 to 3 of 9 clips, though often on the text.
  - **LID:** the q8 top label is 9/9, with a largest logit difference of about 0.2.
  - Whether q8 ASR is good enough on Lingala speech can only be measured with recordings (4.4).
- **mms-lid-126 has adapters** in all 48 layers. The `--lid` q8 leaves those 96 MatMuls in fp32,
  as the ASR recipe does. The owner should confirm this.
- **ORT 1.22.0's dynamic quantizer renames each Gemm** to `<name>_MatMul` before it matches
  `nodes_to_exclude` (`onnx_quantizer.py:67-68`). `--lid` therefore excludes both names, and
  asserts the result.
- **Memory.** An fp32 graph needs about 4 GB of resident memory, and a q8 one about 2.2 to 2.4 GB.
  The q8 figure comes from a process that also ran Whisper.
  - A 4 GB iPhone cannot hold the fp32 graph.
  - Whether one q8 graph fits under iOS's per-app limit on a 4 GB phone is still open (M0).
  - `MmsLanguageId` keeps its session until `close()`, and `MmsRecognizer` cannot close it. An
    app must release language ID before it opens an ASR graph.

### 3b.7.8 Audits

- `ios/tools/audit-binary.sh` on the linked `:models` simulator `test.kexe` (36,376,264 B) gives
  `binary audit clean (1 Mach-O files in 1 inputs)`, with Run 8's `_dlsym` entry as the only
  allowed line. The CommonCrypto `CC_SHA256_*` imports raise no finding.
- `otool -L` lists the same libraries as Run 8. There is no CFNetwork, Network or WebKit framework.
- Android:
  - `audit-permissions.sh` gives `permission audit clean (4 artifacts)`. The merged manifests are
    dated Nov 24, and Run 9 changed no manifest;
  - `audit-native.sh` gives `native audit clean (8 libraries in 1 APKs)`.

### 3b.7.9 Not verified

- Phones, and Lingala speech.
- The language-ID threshold's value.
- The JVM's peak memory.
- Why run B on `ssa35` was about 5× slower.
- The device `iosArm64` and `.app` audits.
- An LID cross-check through transformers' audio-classification pipeline.
- That the ASR mode of `export-mms.py` still produces identical files. It was not re-run; its
  body is unchanged against the owner's copy.
- This run's adversarial review. The workflow's six reviewers all stopped at the usage limit
  before reporting, so the only review was the lead's own targeted reading.
