# Plan: on-device Android app for the disability forms assistant

## Context

The `android` branch (identical to `local-only`, commit 4d5a755) is a browser app for blind
users that fills two official forms by voice: the SSA Adult Disability Starter Kit and Maine's
DS Intake Application. Here is how it works today:
- **Speech-to-text:** Whisper, running in WASM.
- **Parsing:** a deterministic, "certain or nothing" parser (`src/parse.js`).
- **Interview:** a schema-driven state machine (`src/schema.js` and `src/engine.js`).
- **PDFs:** pdf-lib fills the official AcroForms (`src/fill.js`).

**Goal:** an Android app someone downloads that runs the whole interview on the phone, with
**no network access at all**. An on-device LLM is used **only to parse what the user said into
a value for the current question**. Control flow, commands, validation, read-backs and PDF
filling stay deterministic. The output is the **official PDFs, filled in**, which the user saves
or shares.

**Decisions confirmed with the user**
- **Native Kotlin + Jetpack Compose port.** The JS app stays the reference implementation and generates golden fixtures that the Kotlin code must match.
- **Distribution:** a Play app bundle with the models in AI packs, plus APKs built from the same bundle on GitHub Releases. The app declares **no INTERNET permission**.
- **Voice-first v1:** whisper.cpp, the bundled `audio/` prompt clips, offline-only TTS, TalkBack support. Typing is always available.

**Defaults chosen**
- `minSdk 29`, arm64-v8a. An x86_64 build exists for the emulator in debug only.
- **The LLM is optional by design.** It is enabled only when the device has ≥ 6 GB RAM, is not a low-RAM device, has arm64 dotprod, and passes a first-run benchmark. Otherwise the app runs **deterministic-only**, which is today's web behaviour.
- The deterministic-only build is a complete product and ships first.

---

## Architecture

```
android/                       new Gradle project on the android branch
  core/    pure Kotlin/JVM: schema loader, Engine, Parse, Choice, Correct, Validate,
           Importer, FormSpecs (answers→mapping), HelveticaMetrics, TextFitter,
           FillPlanner, AddendumLayout→DrawList, TurnController (port of src/turn.js)
  pdf/     PdfBox-Android: TemplateLoader, AcroFormWriter, AddendumRenderer,
           PdfSelfCheck, WorksheetBuilder
  speech/  NDK whisper.cpp JNI, AudioRecord + level gates, clip player, offline TTS
  llm/     NDK llama.cpp JNI in an isolated-process service, per-call GBNF, verifier
  app/     Compose UI, encrypted session store, export (SAF + in-memory share provider)
  ai-packs/ stt_pack (install-time), llm_pack (device-targeted ≥6 GB)
third_party/llama.cpp, third_party/whisper.cpp    pinned submodules
tools/export-schema.mjs, tools/golden/*.mjs, tools/llm-eval/
```

- **Shared assets:** `forms/*.pdf` and `audio/` stay at the repo root. A Gradle task copies them into the assets, and their SHA-256 hashes are pinned.
- **TurnController** depends only on interfaces (`Speaker`, `Recorder`, `Transcriber`, `AnswerParser`, `Store`, `Clock`), so every dialog flow is a JVM test.
- **The two native libraries** each link ggml statically with `-fvisibility=hidden` and a version script that exports only the JNI symbols. Both are built with NDK r28+ at 16 KB page alignment.

---

## Step 1: change the JS reference first (web tests stay green)

The fixtures would otherwise freeze bugs, and several pieces have to become data before they can
be shared. Make these changes in order:

1. **Fix two Whisper bugs.**
   - `digitsFrom` in `src/parse.js` (~289–309) must strip inner commas and periods, so "9, 8, 7, …" parses.
   - `NON_SPEECH` at `src/localstt.js:121` must keep parentheticals that contain digits, so "(207)" survives.
   - Add tests in `tests/digit-gate.js`, `tests/local-stt.js` and `tests/parse-local.js`.
2. **Inject the clock.** `parse.js` calls `new Date()` (~438, 464, 468), `engine.js:87` calls `Date.now()`, and the DS mapping takes `today`. Inject all three, so goldens can pin Dec 31, Jan 1 and Feb 29.
3. **Separate the PDF data from the PDF writer.**
   - Split `src/fill.js` into a pure `planFill()` (mapping → fit decisions + wrapped lines + overflow) and a pdf-lib writer.
   - Fix the bugs the review found:
     - A `\n` in a single-line field throws inside `fitText`.
     - The widget-level DA overrides the fitted size ("Applicant Name" at 8 instead of 8.5).
     - The rewritten DA names `/Helvetica`, which the DS form's `/DR` doesn't contain.
     - The `fill.js:150` comment says pdf-lib breaks long words; it doesn't.
   - Split `src/pdf.js` into `layoutAddendum()` → draw list, plus a replayer.
   - Move the fixtures in `tests/form-fill.js` to `tests/fixtures/answers/*.json`.
4. **Turn `askIf` into data.** The 77 closures become a rule format: `eq`, `ne`, `present`, `truthy`, `notIn`, `form: ssa|ds|dsOnly`, `and/or/not`, with scope `answers` or `item`. Add an `evalRule()` in JS, and a lint test that no function is left in the exported schema.
5. **Export the data.**
   - `tools/export-schema.mjs` writes `schema.json`, with `ratingSection()` and the default hints expanded.
   - Also export `correct.js`'s ALIASES, LOOP_WORDS, ORDINALS, STOP and `ratingAliases`.
   - Regexes stay in code, each covered by goldens, because a regex string would run on two different engines.
6. **Deterministic parser v2.** This shrinks what the LLM has to do, and the web app benefits too. It covers:
   - number words ("twelve hundred", "two thousand five")
   - amounts with units ("$20 an hour")
   - "yes I do" / "no she doesn't"
   - answers that start by echoing the question
7. **Pull the dialog layer out of `main.js` into a pure `src/turn.js`.**
   - State is a base mode (Interview, Review, Correcting, Adding) times one overlay (TranscriptCheck, ValueReadBack, ChoosingField, ChoosingItem, ConfirmDelete), with injected ports.
   - Switch the turn to **interpret first, then confirm once**. Today the raw transcript is read back *before* parsing (`sendAudio` → `askTranscriptCheck` → `handleTranscript`), so an LLM-derived value would need a second confirmation.
   - Shared YAML scenarios drive both implementations, absorbing `tools/smoke.mjs`, `tests/local-command.js` and `tests/empty-transcript.js`.

**Golden fixtures.** `tools/golden/*.mjs` writes `android/core/src/test/resources/golden/`. CI
regenerates them and runs `git diff --exit-code`, and they are compared as parsed JSON trees, not
strings. They cover:

| Golden | What it contains |
|---|---|
| parse | every `val`/`defer` case, plus a generated corpus per question |
| choice / correct / add / delete | inputs from those test files × the answer fixtures |
| walks | seeded random engine walks, recording `current()`, `progress()` and `getState()` after every action |
| fillplans | the answer fixtures plus ~200 seeded random answer sets |
| metrics | pdf-lib's Helvetica and Helvetica-Bold `CharWidths`, `KernPairXAmounts`, ascender and descender |
| templateManifest | per field: type, box width and height *as pdf-lib computes them*, multiline, Q, widget count, on-states, DA present |
| fits | every box × ~40 values |
| addendum | the draw lists |
| import | v1/v2/v3 export files |
| tts | every fixed spoken string → its `ttshash` (`audio/manifest.json` lists only hashes) |
| turn | the scenario transcripts |

**Regex dialects differ.** JS `\s` is Unicode while JS `\w` and `\b` are ASCII, and Android's
regex engine is ICU, which differs from both JS and the desktop JVM. So:
- Port regexes with explicit ASCII classes.
- Fuzz with non-breaking spaces, curly quotes, accents and emoji.
- Run the goldens **both on the JVM and as instrumented tests**.
- `money()` needs a `JsNumberFormat` that reproduces `toLocaleString('en-US')`, and `text()` must print numbers as JS `String(n)` does ("15", not "15.0").

---

## PDF filling on Android (the key challenge)

**What the forms need.** Both are PDF 1.7, linearized, and use object streams. Neither uses encryption, XFA, NeedAppearances, field JavaScript, comb fields, MaxLen or rotated widgets.
- **Starter Kit:** 104 multiline text fields with `/Helvetica 10 Tf`, and 12 checkboxes (on-value `/Yes`). Its `/Helv` font has a custom encoding.
- **DS Intake:** 117 text fields: 48 centred, 27 with no DA, 86 widgets with their own DA. Also 5 checkboxes, a `Gender` radio (`/M`, `/F`), and 3 unsigned signature fields with `SigFlags 1`. Its `/DR` has only `/Helv` and `/ZaDb`.

**Library: PdfBox-Android 2.0.27.0** (Apache-2.0). It is used **only as the PDF object model**:
load, set `/V`, `/DA`, `/AP` and `/AS`, add pages, save. Its own appearance generator is never
used, because it wraps without kerning and uses its own padding and auto-size, and could clip
text that `TextFitter` measured as fitting.

**Parity targets**

| Level | Target |
|---|---|
| L1, exact goldens | mapping, fit `{size, text, cut, lines}`, overflow, addendum draw list |
| L2, structural read-back | every value; field count 116/126; pages; every filled widget has `/AP /N` and its DA font exists in `/DR`; signature and unfilled fields untouched |
| L3, visual | snapshots plus a manual check in viewers |

Matching pdf-lib byte for byte is **not** the target.

**`core`**
- `HelveticaMetrics`: from the golden. Width = Σ(width + kern) · size/1000, matching pdf-lib's kerned `widthOfTextAtSize`. Height = 0.925 · size. Same order of operations, so the doubles agree exactly.
- `WinAnsi.toWinAnsi`: iterates code points, using `java.text.Normalizer` NFKD.
- `TemplateManifest`: box sizes are **never** taken from PDFBox, which stores reals as 32-bit floats.
- `TextFitter.fit(box, value) → Fit(size, text, cut, lines)`.
- `FormSpec` (SsaStarterKit, DsIntake): `map(answers, today)`, using a `LinkedHashMap` because insertion order drives the addendum order.
- `FillPlanner` and `AddendumLayout`.

**`pdf`**
1. **`TemplateLoader`**
   - checks the asset's SHA-256
   - opens with `PDDocument.load(bytes, MemoryUsageSetting.setupMainMemoryOnly())` (no scratch file holding personal data in the cache)
   - runs everything on one thread, after `PDFBoxResourceLoader.init`
2. **`AcroFormWriter.apply(doc, plan)`**
   - **Font:** add `/HelvWA` (`PDType1Font.HELVETICA`, WinAnsi) to `/DR`.
   - **DA:** set `/DA "/HelvWA {size} Tf 0 g"` on the field and on **every widget that has its own DA**.
   - **Value:** write `/V` through the COS layer, not `setValue()`.
   - **Appearance:** build each `/AP /N` as `/Tx BMC q <clip> BT … Tj … ET Q EMC`, drawing exactly `fit.lines` inside the 8×3 inset. `Q=1` fields are centred using the unkerned width.
   - **Checkboxes:** `PDCheckBox.check()`. A contract test asserts that the on-value is `Yes`.
   - **Radio:** `PDRadioButton.setValue`.
   - Never call `refreshAppearances()`, never set NeedAppearances, never flatten; the fields stay editable.
3. **`AddendumRenderer`** replays the draw list with `PDPageContentStream` on 612×792 pages, in Helvetica and Helvetica-Bold.
4. **`PdfSelfCheck`** runs on **every export, on the device**.
   - It reopens the bytes, runs the L2 checks, and parses each appearance stream to compare its `Tj` strings with the planned lines.
   - On any failure the form is **not** offered. The user gets the `WorksheetBuilder` fallback and a spoken explanation.
5. **`TemplateContractTest`** checks that what PDFBox reads matches `templateManifest` (within 1e-3). It fails if a future template revision adds comb fields, MaxLen or `/Opt`.

**Delivery (`app`)**
- **Save:** `ActivityResultContracts.CreateDocument("application/pdf")` (SAF, no permission), named `ssa-starter-kit-<name>-<date>.pdf`. The name slug folds accents to ASCII.
- **Share:** a `ContentProvider` streams the bytes from memory through a pipe; no plaintext cache file. A spoken warning first says the file contains the SSN.
- **Open:** `ACTION_VIEW` through the same provider.
- **Erase everything:** wipes the session and any bytes held in memory.
- **Preview:**
  - For blind users: a spoken "here is what's on your form", generated from the self-check read-back.
  - For sighted helpers: a visual preview. The spike checks whether `PdfRenderer` before API 35 draws widget appearances; if it doesn't, show the visual preview on API 35+ only.

**Budgets:** load + fill + save + self-check ≤ 3 s on a mid-range phone and ≤ 6 s on a low-end one. Output ≤ 2× the template size, since PDFBox 2.0 can't write object streams.

**Fallback if PdfBox-Android fails the spike:** `androidx.javascriptengine` (JavaScriptSandbox: WebView's V8 in an isolated process, with no network) runs the vendored pdf-lib writer unchanged, fed by the Kotlin `FillPlan`.
- It gives exact parity with the reference, at the cost of needing a minimum WebView version.
- MuPDF and iText are excluded because they are AGPL.
- PdfBox-Android's last release was in 2023. That is acceptable because its only inputs are our own hash-pinned templates.

---

## The LLM: only a parser, boxed in by deterministic code

**Runtime**
- llama.cpp through our own JNI, in a bound service with `android:isolatedProcess="true"`. The model is passed in as a `ParcelFileDescriptor`, so a native crash or OOM kills only that process.
- Greedy sampling, a fixed seed, threads, `n_batch` and `n_ubatch`, flash-attention off, and a pinned commit.
- The ggml, llama and whisper log callbacks are no-ops in release builds; by default they would write transcripts to logcat.
- An `AnswerParser` interface keeps LiteRT-LM (GPU/NPU) open as a later backend.

**Per-answer pipeline (in TurnController)**
1. Gates: blob size, 350 ms minimum, level meter, `isEmptyTranscript`/`FILLER_TRANSCRIPTS` with `QUIET_PEAK`, and the digit gate.
2. Correction, delete and add phrases, and `localCommand`.
3. `parseLocal` (v2).
4. Only for an eligible type, and only when step 3 returned null (or, for text, when the answer has ≥ 4 words or framing cues): the LLM, under a grammar generated for this call.
5. The verifier.
6. `normalize()`.
7. **One** confirmation. An LLM-derived value is **always** read back, whatever the read-back setting: "I understood: John Smith. Is that right?" The screen shows "From what you said: …". "No" reopens the question without re-reading the prompt.
8. Commit, with provenance (llm / parse / typed) kept in a side map outside the engine state.

A timeout (3 s hard deadline, via the abort callback), `U` or a verifier rejection means a re-ask
with the hint, exactly like today's `null`. For text it means falling back to `parseText`. After
3 timeouts in a session, the LLM is switched off for that session.

| Type | LLM | Output (line-based, grammar-constrained) | Deterministic verifier |
|---|---|---|---|
| ssn, routing, account, phone, zip, email | **never** | — | — |
| date | **never in v1** (revisit with eval data) | — | — |
| commands, read-back yes/no, correction targets, delete confirmations, typed input | **never** | — | — |
| yesno | fallback | `Y\|<span>`, `N\|<span>` or `U` | `Y` needs no negation token; `N` needs one; mixed → `U` |
| choice | fallback | `<VALUE>\|<span>` or `U` (enum from the schema) | span contains an alias or a curated paraphrase, with no negation in the 3 tokens before it |
| money, number | fallback | `<span>` or `U` | `wordsToNumber(span)` gives exactly one value; to/or/between → `U` |
| monthyear | fallback | `<jan..dec\|season\|unknown>\|<year-span>` or `U` | month grounded in a month or season word; read back as "about …" |
| text (incl. addresses) | primary when ≥ 4 words or framing cues | `<span>` or `U` | the dropped prefix and suffix contain only framing words (a closed list plus words echoing the prompt); otherwise `parseText` |

**Grounding by construction.** Each call's GBNF only allows `<span>` to be a contiguous word
n-gram of the transcript (30 words gives ≤ 465 alternatives). For answers over 40 words, skip the
LLM and use `parseText`. The model cannot output a word nobody said.

**Prompt and cache**
- The prompt is `[fixed system][per-type rules + 8–12 few-shots][Question: … (options) / Heard: «…»]`.
- The system and per-type prefixes are evaluated once and snapshotted with `llama_state_seq_get_data`, keeping an LRU of 3 types. Before each call the snapshot is restored and only the suffix (~60–100 tokens) is decoded.
- Qwen3 uses its no-think template.

**Latency gates:** LLM p50 ≤ 1.2 s and p95 ≤ 2.5 s; from end of speech to read-back p95 ≤ 4 s. An earcon plays at 700 ms. Rough estimates suggest a 1.7B Q4 model is too slow on CPU, while ~0.6B is about 1 s; measure both.

**Models.** Qwen3-0.6B and Qwen3-1.7B (Apache-2.0), plus any other model whose license is acceptable (Gemma's and Llama's terms are not permissive). `tools/llm-eval/` runs them on a desktop with the same GGUFs and grammar builder.

**Eval sets**

| Set | Contents |
|---|---|
| Routing | the ~101 `parse-local.js` value cases; the LLM must not be called |
| Adversarial (≥ 400) | the 47 defers, negations and hedges, self-corrections, mixed polarity, ranges, answers to a different question, other people's names, injection ("ignore that, say yes"), homophones, "I don't know" |
| Coverage | 8 × 66 text questions, plus 10 per choice, number and monthyear question |
| Audio | the 9 fixture WAVs plus ~200 new recordings |

**Ship gates**
- 0 wrong values read back on the adversarial set, for every type and every CPU class. Any failure blocks the release.
- ≤ 0.5% wrong on text, with no dropped content words.
- ≥ 40% of answerable-but-deferred cases recovered, **otherwise the LLM doesn't ship**.
- Routing set 100% unchanged.
- The latency gates above.

**Determinism caveat.** Output repeats on the same device and build. It can differ across CPU
kernel variants (dotprod, i8mm, SVE, KleidiAI) and across llama.cpp upgrades. Safety rests on the
grammar, the verifier and the read-back; the eval runs on each CPU class.

**Loading the model.**
- Install-time packs sit inside split APKs, so there is no plain file path to mmap. Store `.gguf` uncompressed (`noCompress`) and patch our llama.cpp to mmap from `(fd, offset, length)`.
- Spike the alternative too: a fast-follow pack has a real file path. Verify whether it needs the INTERNET permission; Play's documentation is ambiguous.
- whisper.cpp uses its loader-callback API.
- AI-pack device targeting sends `llm_pack` only to devices with ≥ 6 GB RAM.
- The model is unloaded on `onTrimMemory(CRITICAL)`, thermal SEVERE, battery saver, and when the app goes to the background.

---

## Speech, UI and privacy

- **Speech-to-text:** whisper.cpp `ggml-base.en` q8_0 (~80 MB): greedy, English, no timestamps, non-speech tokens suppressed. `AudioRecord` at 16 kHz.
  - Port the thresholds: `src/audio.js:149` (SPEECH 0.045), `:156` (AUDIBLE 0.02), `src/main.js:941` (DIGIT_SILENCE_MS 3000), `:1028–1041` (FILLER_TRANSCRIPTS, QUIET_PEAK 0.05). Also the 1.2 s silence window and the 60 s maximum.
  - An instrumented test ports `tools/stt-eval.mjs` over `tests/fixtures/speech/`.
- **Audio, half-duplex.** Never record while any audio is playing, including TalkBack, which the mic would otherwise transcribe. Capture starts after an earcon.
  - Audio focus `GAIN_TRANSIENT_EXCLUSIVE`.
  - A phone call silences the mic (`isClientSilenced`); treat that as a pause, not "nothing heard".
  - Test Bluetooth headset routing, and let the headset button act as the talk key.
  - Offer tap-to-talk with auto-stop as well as hold-to-talk.
- **Prompts:** the clips in `audio/` are found by the `ttshash` port and checked against the `tts` golden.
- **Read-backs:** `TextToSpeech` only with voices where `!isNetworkConnectionRequired` and no `KEY_FEATURE_NETWORK_SYNTHESIS`, re-checked after `setVoice`. If there's none, TalkBack and the screen carry the read-back.
  - TalkBack's own TTS engine is outside the app's control; tell users.
  - Tell users the bundled prompt voice was generated with OpenAI TTS.
- **TalkBack:** detect touch exploration. Text the app is already speaking is not a live region.
  - Custom actions: Repeat, Back, Skip, Where am I, Read back.
  - A hardware keyboard gets the web app's keys.
- **Screens (Compose):** Setup → Interview → Review (change/add/remove) → Export (Save, Share, Open, spoken preview). An "offline verified" indicator shows that the app holds no network permission.
- **Privacy:**
  - **Permissions:** `tools:node="remove"` for INTERNET and ACCESS_NETWORK_STATE. A Gradle check fails if any merged manifest has them, and CI runs `aapt2 dump permissions` on every AAB module and every APK. A deliberate canary proves the check fires.
  - **No backups:** `allowBackup="false"`, and `dataExtractionRules` exclude everything. Auto Backup would upload app data even without INTERNET.
  - **Screens:** `FLAG_SECURE` and `setRecentsScreenshotEnabled(false)`.
  - **Keyboard:** an EditText interop with `IME_FLAG_NO_PERSONALIZED_LEARNING`, no suggestions or autofill on sensitive fields, Gboard's voice-typing mic hidden (it can send audio to Google), and `setContentSensitivity` on Android 15+.
  - **Logs:** R8 strips `Log` calls; no crash SDK.
  - **Session store:** a port of `src/store.js`: PIN → PBKDF2-SHA256 600k → AES-256-GCM in `noBackupFilesDir`. SSN, routing and account numbers are never written; they go on the `withheld` re-ask list. Saves expire after 7 days. The 15-minute idle lock also applies after 15 minutes in the background.
  - **Known quirk:** fix the `withheld` index shift when a marriage is deleted (TODO.md).
  - **JSON export/import:** keep the v3 format, so sessions move between web and Android.
- **Known gap:** addendum pages are untagged, while the SSA template is tagged. Note it, and consider tagging later.

---

## Milestones (de-risking order)

| # | Milestone | Done when |
|---|---|---|
| **M0** | Toolchain and skeleton | This Mac has only Node 20, so install Android Studio (JDK 21), SDK 35/36, NDK r28+ and CMake; get a 6–8 GB arm64 reference phone and a low-end phone. The Gradle skeleton builds in CI, the permission-audit canary fails as intended, the 16 KB alignment check runs, and the JS tests are green. |
| **M1a** | PDF spike (needs JS step 3) | On a phone, both forms are filled from the JS-exported plan. The self-check is clean, the pdf-lib cross-read passes, edits work in Acrobat, Chrome, Drive and Preview, time and size are measured, the R8 release build works, and the go/fallback decision is written down. |
| **M1b** | Native spike (parallel) | whisper.cpp and llama.cpp coexist in one APK, 16 KB aligned, with the models loaded without copying. The 9 WAVs transcribe. There is a latency and RAM table from 2 devices. |
| **M1c** | Host LLM study (parallel) | Eval v0 on a laptop against parser v2 gives a go/no-go for the LLM in v1 and a model choice. |
| **M2** | JS steps 1–7 and goldens | Every golden is generated and fresh in CI; the web tests are green. |
| **M3** | `core` port | 100% of goldens pass on the JVM **and** on an emulator, including a 16 KB page-size image. |
| **M4** | `pdf` complete | The instrumented port of every `tests/form-fill.js` assertion passes, plus 20 providers and 15 jobs, overflow and WinAnsi. A CI Node job re-reads the Kotlin-filled PDFs with pdf-lib. Worksheet fallback and the share flow work. |
| **M5** | Speech, TurnController and UI, deterministic-only | The YAML scenarios pass. Full interviews of both forms by voice and by typing in airplane mode. TalkBack sessions with 2 blind testers. The privacy checklist passes. **Ships to the internal track even if the LLM slips.** |
| **M6** | LLM integration | Every ship gate in the LLM section passes on each CPU class; deterministic-only mode still passes M5. |
| **M7** | Distribution | Device-targeted AI packs. A "lite" universal APK (~120 MB, deterministic-only) and a "full" one built with `bundletool --mode=universal`. Signing, reproducible builds, published checksums. A LICENSE for the repo and an open-source notices screen (llama.cpp and whisper.cpp MIT, PdfBox-Android Apache-2.0 plus NOTICE, the Whisper weights, the chosen LLM's license). Check the terms for redistributing the OpenAI-generated clips. Play Data safety: no data collected. |
| **M8** | Human verification | The open items in TODO.md §1: noisy-room hands-free, real voices on SSNs 987-65-4320…4329, low-end timing, a DS voice pass. Decide whether the PDF redacts the SSN and bank numbers by default (TODO §2). |

---

## Verification

- **Web reference:** `for t in tests/*.js; do node "$t" || exit 1; done` stays green.
- **Golden freshness:** `node tools/golden/check.mjs` (also the schema export) + `git diff --exit-code`.
- **`./gradlew :core:test` and `:core:connectedDebugAndroidTest`:** every golden and the turn scenarios, on the JVM and under ICU.
- **`./gradlew :pdf:connectedDebugAndroidTest`:** the `form-fill.js` port, `TemplateContractTest`, `PdfSelfCheck` on both forms, overflow, tables, WinAnsi. The output PDFs are uploaded as CI artifacts, and `node tools/golden/crosscheck.mjs <pdfs>` re-reads them with pdf-lib.
- **`./gradlew :speech:connectedDebugAndroidTest`:** fixture WAVs → whisper → parse → `normalize`, compared with `expected.json`.
- **`tools/llm-eval`** (desktop) plus `./gradlew :llm:connectedDebugAndroidTest` on each reference phone: the ship gates.
- **Release checks:** `aapt2 dump permissions` shows no INTERNET in any artifact; `bundletool get-size total` stays within budget; `readelf -l` shows 16 KB-aligned `.so` files.
- **End-to-end:** install the universal APK, airplane mode on, TalkBack on. Do a "both forms" voice interview with an SSN, a go-back, a correction, and adding and removing a provider. Export both PDFs, open them in Acrobat and Drive, and confirm the values are visible and the fields editable.
