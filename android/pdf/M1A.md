# M1a: the PDF spike — evidence and decision

Dated 2026-10-24. This file is the M1a completion record; TODO.md is outside
this branch's write scope for the agent run that produced it, so the last
section is the text a human should copy there.

## 1. Decision

**GO with PdfBox-Android 2.0.27.0.**

After this run every instrumented PDF test passes, the pdf-lib cross-read
reports zero failures, the output is 1.03–1.10× the template against a 2×
budget, and the slowest form took 538 ms end to end on the emulator against a
3 s budget. PDFBox is used only as the object model; every appearance is
drawn from the golden-pinned plan, so the risky part (text layout) is already
the JS reference's own arithmetic.

The Android plan's `androidx.javascriptengine`/pdf-lib fallback was **not
built**. It reopens only if a real viewer cannot open the output, the
self-check cannot be made clean on a real template revision, or size/time
goes over budget with no fix.

## 2. What ran

From `android/`, on the arm64 API 35 AVD `ssa35` (4 GB RAM,
`Google sdk_gphone64_arm64 API 35`, an Apple Silicon host). **The emulator is
not a phone**: the timing below is evidence that the work fits in the budget
with room to spare, not a phone measurement.

```bash
./tools/run-pdf-spike.sh ssa35        # :pdf:connectedDebugAndroidTest, crosscheck, report
./gradlew :app:connectedStagingAndroidTest   # R8 staging build, one test
./gradlew :app:assembleRelease        # R8 release build
./gradlew :core:test                  # core stays green
node tools/golden/crosscheck.mjs "android/pdf/build/outputs/connected_android_test_additional_output/debugAndroidTest/connected"
node android/tools/pdf-spike-report.mjs "android/pdf/build/outputs/connected_android_test_additional_output/debugAndroidTest/connected"
```

`:pdf:connectedDebugAndroidTest` ran **23 tests, 0 failures** (18 existing,
3 new self-check damages, 1 export-path test, 1 viewer test).

## 3. Evidence

Fresh run, `pdf-spike-report.mjs`, device `Google sdk_gphone64_arm64 API 35`:

| case | form | template bytes | output bytes | ratio | load ms | fill ms | save ms | check ms | total ms | addendum pages |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| both | ds | 1340631 | 1468188 | 1.10 | 37 | 34 | 15 | 85 | 171 | 1 |
| both | ssa | 468207 | 500364 | 1.07 | 35 | 58 | 12 | 81 | 186 | 4 |
| ds-only | ds | 1340631 | 1454853 | 1.09 | 40 | 26 | 15 | 79 | 160 | 0 |
| ds-only | ssa | 468207 | 481135 | 1.03 | 37 | 7 | 13 | 90 | 147 | 2 |
| long | ds | 1340631 | 1468433 | 1.10 | 39 | 33 | 15 | 82 | 169 | 1 |
| long | ssa | 468207 | 506993 | 1.08 | 36 | 84 | 11 | 91 | 222 | 10 |
| minimal | ds | 1340631 | 1439894 | 1.07 | 39 | 1 | 12 | 71 | 123 | 0 |
| minimal | ssa | 468207 | 481451 | 1.03 | 32 | 8 | 10 | 68 | 118 | 2 |
| starter-kit | ds | 1340631 | 1442365 | 1.08 | 46 | 4 | 20 | 82 | 152 | 0 |
| starter-kit | ssa | 468207 | 487351 | 1.04 | 48 | 52 | 24 | 159 | 283 | 4 |
| winansi | ds | 1340631 | 1468442 | 1.10 | 49 | 54 | 29 | 120 | 252 | 1 |
| winansi | ssa | 468207 | 500385 | 1.07 | 131 | 198 | 63 | 146 | 538 | 4 |

- **max ratio 1.10** (limit 2.00) — size budget ok.
- **max total 538 ms** (3 s target, 6 s ceiling) — time budget ok.
- The `long` case is the constructed one (20 providers, 15 jobs of both
  kinds, 14 long diagnoses); it adds 10 addendum pages to the Starter Kit
  and 1 to the DS form without approaching either budget.

## 4. Correctness

- `crosscheck: 12 PDFs re-read with pdf-lib, 0 failure(s)`.
- Every case's `PdfSelfCheck` is clean. The new checks also prove:
  - each filled text field's `/AP /N` `/BBox` is the manifest box;
  - no filled field is read-only;
  - every addendum page is US Letter (612×792).
- The self-check names no field the template lacks (`filled.missing` is
  empty for all 12).
- Signatures are untouched: the cross-read verifies they are blank and the
  self-check compares their value and appearance bytes with the template.
- `FormFiller.export()` offers the form, not the worksheet, for both forms
  (`theExportPathOffersTheFormNotTheWorksheet`).

## 5. R8

`./gradlew :app:connectedStagingAndroidTest` → **1 test, 0 failures**
(`PdfSpikeReleaseTest`). The staging build inherits the release ruleset,
adds debug signing and `isDebuggable = true` so `am instrument` can run it;
`release` stays non-debuggable. The test calls `PdfSpikeEntry.run()` and
asserts `ok ssa=… ds=…`, so the shrunk build executes the appearance-writing
path for both forms, not merely the save path.

One finding to record: AGP warns that a build type which is both debuggable
and minified keeps **shrinking but disables optimization and obfuscation**
("All code optimizations and obfuscation are disabled for debuggable
builds"). Shrinking is the gate that can delete the PDF path, and this run
proves the path survives it; obfuscation and optimization are not exercised
by the staging test. `:app:assembleRelease` (non-debuggable) does apply them
and builds clean, but it is not executed here — M4 must run the export path
once it is wired into the release UI.

Keep rules added (narrow, and only where R8 needed them):

- `app/staging-rules.pro`
  - `-keep class org.ssa.assistant.app.PdfSpikeEntry { public *; }` — the
    entry point the test calls, which R8 cannot see as a reference.
  - `-dontwarn javax.lang.model.element.Modifier` — the androidTest APK is
    shrunk too, and error-prone's annotations name a compile-time JDK type.
  - `-keep class kotlin.LazyKt { *; }` and
    `-keep class kotlin.text.StringsKt { *; }` — the androidTest APK carries
    androidx.test but resolves the Kotlin stdlib from the app APK (as in
    debug); under R8 the app's inlined copy lost those two, and the runner
    (`LazyKt`) and the test (`StringsKt`) could not link. These are the two
    classes the run actually needed. This is staging-only, so the release
    build keeps its full shrinking.
- `app/proguard-rules.pro`
  - `-dontwarn com.gemalto.jp2.JP2Decoder` and `JP2Encoder` — PDFBox's JPX
    filter names gemalto's optional JPEG 2000 classes, which the AAR does not
    ship; neither template contains a JPEG 2000 image.

`:app:assembleRelease` succeeds, and the release APK has no INTERNET or
ACCESS_NETWORK_STATE permission (`aapt2 dump permissions` shows only
RECORD_AUDIO, MODIFY_AUDIO_SETTINGS and the app's own dynamic-receiver
permission).

**The release build removes `PdfSpikeEntry`**: nothing in the release UI
calls it yet, so R8 sees it as dead. M4 must re-run this test (or an
equivalent export-path test) once the export screen is wired.

## 6. Viewer

Measured with Android's own `PdfRenderer`, the renderer a native preview
would use, on API 35:

| form | sdk | pages | drawn/planned |
|---|---:|---:|---:|
| ds | 35 | 5 | 0/113 |
| ssa | 35 | 9 | 0/104 |

**PdfRenderer draws none of the widget appearances on API 35.** Every page
still renders its template content (asserted: ink on every page), but the
filled values are absent. This is the viewer answer, not a test bug: the
regions are the widgets' own `/Rect`s and all 217 of them were cropped
successfully.

**Preview decision:** the app must not rely on a native visual preview. Use
the spoken preview built from `PdfSelfCheck.ReadBack`, and open the form in
an external viewer for a visual check.

PNG evidence is published beside the PDFs:
`…/connected/<device>/viewer/ssa-page-1.png`, `ssa-page-9.png`,
`ds-page-1.png`, `ds-page-5.png`, plus `viewer-ssa.json` / `viewer-ds.json`.

The plan also asked for API 29 and 33. Their arm64 images are not installed
here, so the "before API 35" half of the question is **only partly
answered**; the test skips the drawn>0 assertion and records whatever those
APIs report when someone runs it.

## 7. Still owed (human)

- Real-phone timing on the M0 hardware (the emulator is not a phone).
- Manual open/edit in Acrobat, Chrome, Drive and macOS Preview, using the
  PDFs in the output folder. Editing a field there should regenerate its
  appearance with `/HelvWA`, which is why the DA names that font.
- The `ssa35_16k` run if the 16 KB page-size target is wanted.

## 8. For TODO.md (human to copy)

Replace the M1a open item with:

> - [x] **M1a, the PDF spike: GO with PdfBox-Android 2.0.27.0.** Both forms
>       fill from the golden-pinned plan on the arm64 API 35 emulator; 23
>       instrumented tests pass and `crosscheck.mjs` re-reads all 12 PDFs with
>       pdf-lib with 0 failures. Output is 1.03–1.10× the template (2× budget)
>       and the slowest form is 538 ms end to end (3 s budget); addendum
>       pages, self-checks, signatures and the export fallback are all
>       exercised. The R8 staging build runs the PDF path for both forms under
>       the release ruleset, and `:app:assembleRelease` is clean. Android
>       `PdfRenderer` draws none of the widget appearances on API 35, so the
>       app uses the spoken preview and an external viewer, not a native
>       visual preview. Evidence, commands and the decision are in
>       `android/pdf/M1A.md`. Deliberate departures from the Android plan,
>       already in `plans/stage-2-implementation.md`: centring uses pdf-lib's
>       kerned width, the appearance stream keeps pdf-lib's operator order,
>       plan parity is checked in `crosscheck.mjs` rather than by shipping
>       `fillplans.json` in the test APK, and a constructed long case stands
>       in for the largest random `fillplans.json` set. Still owed: real-phone
>       timing, manual open/edit in Acrobat/Chrome/Drive/Preview, and the
>       API 29/33 viewer runs.
