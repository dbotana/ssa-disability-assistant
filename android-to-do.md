# Android port: what to do next

State as of 2026-10-24: the agent-loop run `agent-loop-runs/2026-10-24-1925-android` finished M1a and passed both reviews. Nothing is committed yet. The pass results below come from the agents' logs, not from a re-run.

## 1. Verify and close M1a

- [ ] Run `cd android && ./gradlew :core:test`.
- [ ] Run `./android/tools/run-pdf-spike.sh ssa35` from the repo root. Expect 23 tests, 0 failures, the crosscheck clean, and size and time budgets ok.
- [ ] Open the published `viewer/*-page-1.png` files under `android/pdf/build/outputs/connected_android_test_additional_output/`. Confirm that `PdfRenderer` really draws none of the filled fields. The "spoken preview, no native visual preview" decision depends on this.
- [ ] Rename `ViewerTest.platformRendererDrawsEveryPlannedValue`. It only prints a count.
- [ ] Check the crop code in `ViewerTest.kt` (lines ~116-161). It ignores page rotation and CropBox.
- [ ] Add a trailing newline to `.gitignore`.
- [ ] Commit. Suggested message:
  ```
  Close M1a: harden PdfSelfCheck, add R8 staging probe and viewer test

  PdfSelfCheck now checks the appearance BBox, read-only fields and addendum
  page size. Adds a staging build type plus PdfSpikeEntry to exercise the PDF
  path under R8, a PdfRenderer viewer test, report scripts, and M1A.md with
  the GO decision for PdfBox-Android 2.0.27.0.
  ```
- [ ] Replace the M1a item in `TODO.md` with the text in `android/pdf/M1A.md` §8.

## 2. M1a leftovers that need hardware or system images

- [ ] Install the arm64 API 29 and API 33 system images. Run the viewer test on both.
- [ ] Run on `ssa35_16k` (16 KB page size).
- [ ] Time both forms on a real phone. The budget is 3 s, with a 6 s ceiling.
- [ ] Open a filled PDF by hand in Acrobat, Chrome, Drive and Preview. Check that fields show, edit and re-save.

## 3. CI

- [ ] Push the branch and run the new CI once. The `device-tests` job, the canary job and the bundletool download have never run.
- [ ] Fix whatever it finds.

## 4. M1b: speech and LLM native libraries

Run this as a normal session, not through the loop. It needs the NDK and writes outside `android/`.

- [ ] Add whisper.cpp and llama.cpp as pinned submodules, linked statically into the JNI libraries. The version script and export audit already apply.
- [ ] Load the models mmapped from `(fd, offset, length)`.
- [ ] Transcribe the 9 WAVs.
- [ ] Write a latency and RAM table.

## 5. M1c

- [ ] Build `tools/llm-eval/` and run eval v0 against parser v2.

## 6. Later milestones

- [ ] **M4:** app export plumbing. Run the export path under a full release build, with R8 obfuscation and optimization, which no test has done yet. Call `PdfSpikeEntry` or its replacement from real code.
- [ ] **M5:** Compose screens. Write Android wording for the phrases, with new clips and `tts` entries.
- [ ] **M6/M7:** AI-pack delivery for `llm_pack`. Needs the `com.android.ai-pack` plugin and the Play AI Delivery Library. The merged-manifest audit must still show no INTERNET permission.
- [ ] **M8:** as the plan describes.
- [ ] Make `TurnController` a sealed type (base mode × one overlay) instead of the nullable flags kept for golden parity.
- [ ] **M0 hardware:** get a 6-8 GB arm64 reference phone and a low-end phone.

## 7. Known risks to keep an eye on

- The `staging` build type is debuggable. Never sign or ship it.
- The `kotlin.LazyKt` and `kotlin.text.StringsKt` keeps in `staging-rules.pro` work around how the test APK is shrunk. They apply to staging only.
- The JP2 `-dontwarn` in `app/proguard-rules.pro` applies to release. It's harmless while the templates have no JPEG 2000 images. Revisit if a template changes.
- Keep INTERNET and ACCESS_NETWORK_STATE out of the manifest, and keep `./gradlew :core:test` passing.
