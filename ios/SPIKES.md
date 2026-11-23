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
- The cold first form is over the 3 s per-form budget: `ln-both-a-ssa` is
  9.07 s end to end. The warm second-pass writes are 68–77 ms and the next
  three totals are 0.89–1.29 s, so this is a cold-start cost, not the per-form
  cost — but the plan's gate is "every per-form total is at most 3 s" and this
  one is not. The cold cost does not always land on the same step. Across five
  runs the first form was 6.39, 7.98, 8.47, 9.10 and 9.07 s; in three of them
  most of it was in the first Kotlin `PdfSelfCheck` call, and in two it was in
  the first JS fill (9.10 s: js 7.16 s, check 1.84 s, load 0.74 s; 9.07 s: js
  7.38 s, check 1.60 s, load 1.07 s). The cause is not established: it looks
  like a one-time process or simulator warm-up that lands on whichever step
  runs first, not a cost of `PdfSelfCheck` itself.

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
