# Plan: one app on iOS and Android that interviews in English or Lingala

## Goal

One product, with one shared codebase and one shared UI, for iOS and Android. It:

- interviews the applicant by voice in **English or Lingala**, with tapping and typing always
  available;
- fills **both** official PDFs in one interview: SSA's Adult Disability Starter Kit (SSA-64-110)
  and Maine DHHS's Developmental Services Intake Application, either one or both;
- for a Lingala interview, produces **two versions of each form**, and the user can save, share
  and open both:
  - **as given:** Lingala answers written exactly as the applicant gave them;
  - **English translation:** the same form, with Lingala free text translated to English on the
    phone, and clearly labelled as a machine translation;
- runs entirely on the phone. Nothing the user says or types leaves the device;
- is installed from a local download, not from an app store, and has no budget for paid
  services, reviewers or publishing.

The web app stays the reference implementation. The Android plan,
[on-device Android app for the disability forms assistant](<on-device Android app for the disability forms assistant.md>),
stays in force except where this plan replaces it: the UI, speech recognition, and distribution.
Open Android items stay in [TODO.md](TODO.md) and [android-to-do.md](android-to-do.md).

## Where things stand (2026-11-21)

- **Web:** complete. English, French and Lingala are data, each chosen separately for input,
  output, screen and fill. The Lingala text is machine-authored and records
  `reviewedByNativeSpeaker: false` ([ln.strings.js:5](src/i18n/catalog/ln.strings.js#L5)): 769
  strings, about 36,000 characters. Only English clips exist (552 in `audio/`). Nobody has
  measured how well Lingala speech is transcribed, and there are no Lingala recordings.
- **Android `:core`:** 7,489 lines of pure Kotlin/JVM. It ports the schema, engine, parser,
  I18n, TurnController, fill planning and addendum layout. It is pinned to the JS reference by
  13 goldens (17 MB) and 11 shared turn scenarios.
- **Android `:pdf`:** M1a is GO with PdfBox-Android. Both forms fill, and the self-check passes.
- **Android `:speech`, `:llm`, `:app`:** skeletons. The whisper.cpp JNI is 15 lines, and there
  are no Compose screens yet. So changing the speech runtime or the UI toolkit now loses almost
  nothing.
- **iOS:** nothing yet.

`:core` touches JVM-only APIs in about a dozen places, and each has a small replacement. Making
it multiplatform is cheap.

## Decisions

| # | Decision | Choice |
|---|---|---|
| D1 | How the code is shared | **Kotlin Multiplatform.** `:core` compiles for Android and iOS, and the same goldens pin both |
| D2 | UI | **One Compose Multiplatform UI** in a new `:ui` module, shared by both apps. Each platform keeps only a thin shell. VoiceOver is the biggest risk, so it gets its own spike (3d) with a fallback for individual controls |
| D3 | Languages | **English and Lingala ship.** French stays in the data and the tests but is not a release target |
| D4 | Language on the forms | **Two versions of each form** in a Lingala session: as given, and with an English translation (Step 4.7). Agency fields are always in English |
| D5 | Translation | **On the device, with Meta's NLLB-200** (distilled 600M, `lin_Latn` → `eng_Latn`). Only narrative text questions are translated |
| D6 | Speech recognition | **ONNX Runtime for every model, on both platforms.** English sessions use the Whisper ONNX packs already pinned in `models/`. Lingala sessions use **Meta's MMS**: MMS language ID chooses the language, then MMS ASR transcribes with the Lingala, French or English adapter. This replaces the whisper.cpp part of Android M1b |
| D7 | Lingala speech output | **[Simba-TTS-lin](https://huggingface.co/UBC-NLP/Simba-TTS-lin), entirely local.** The maintainer's machine renders clips of the fixed strings with it, and the phone runs it on ONNX Runtime for everything that contains an answer. No cloud voice is involved anywhere |
| D8 | Lingala voice input | **Offered for every question type until measured,** then turned on per type from measurements. Tapping and typing are always there |
| D9 | LLM parser | **Not on iOS, and never for Lingala input.** The deterministic-only build is the product. Android M6 is unaffected |
| D10 | Distribution | **A local download.** On Android, an APK from GitHub Releases. On iOS, built from source with Xcode under a free Apple ID. The large Lingala models come as a separate, hash-pinned language pack file |
| D11 | Minimum OS | **Android API 29, iOS 17** |

Meta's MMS covers Lingala for ASR and language ID but not TTS. Simba-TTS-lin, from UBC-NLP, fills
that gap. It is a 36.3M-parameter VITS model in the MMS-TTS architecture, 145 MB at fp32, with
16 kHz output and a CC-BY-4.0 license. MMS and NLLB weights are CC-BY-NC 4.0. That fits a free,
non-commercial app that is never sold; the notices screen says so.

This means the app, its build and its voices all run without a cloud service. The one exception
is the English clips already in `audio/`, which were generated earlier with OpenAI TTS from the
public script. They contain no user data.

## Architecture

```
tools/schema.json      exported by the JS reference: questions, catalogues, phrases, form specs
forms/*.pdf  audio/  audio-ln/ (new)  models/ (ONNX, pinned)  vendor/pdf-lib.min.js

android/core     Kotlin Multiplatform logic: commonMain; jvm, iosArm64, iosSimulatorArm64
  schema, engine, parse, choice, correct, validate, i18n, TurnController,
  fill planning (two versions), addendum layout, AppController + UiState (new),
  store format, self-check rules, Lingala speech normalizer, decoding for every model (new), ports

android/ui       Compose Multiplatform: the screens, used by both apps (new)
  commonMain: Language, Setup, Interview, Review, Export
  androidMain / iosMain: announcements, haptics, the PDF preview view

android/models   Kotlin Multiplatform: ONNX Runtime binding, tokenizers, greedy decoders (new)
  Whisper (encoder-decoder), MMS ASR (CTC + adapters), MMS LID, NLLB (encoder-decoder),
  Simba-TTS-lin (VITS, text → 16 kHz waveform)

platform adapters (Kotlin androidMain / iosMain, not Swift):
  Android  AudioRecord, TextToSpeech, PdfBox writer + reader, javax.crypto, SAF
  iOS      AVAudioEngine, AVSpeechSynthesizer, pdf-lib in JavaScriptCore, CGPDF,
           CommonCrypto + CryptoKit, file import/export

android/app      Android shell: MainActivity hosting the shared UI, manifest, privacy flags
ios/             iOS shell: about 100 lines of Swift. App entry, a host view controller for
                 the shared UI (Magic Tap, escape gesture), and the keyboard-extension refusal
```

Rules:

- **Everything that decides something lives in `core`.** `:ui` only draws `UiState` and sends
  commands back. The adapters capture audio, play audio, run models, encrypt, read and write
  bytes. Nothing else.
- **Kotlin almost everywhere.** With the UI shared, the iOS adapters are written in Kotlin
  `iosMain` against Apple's frameworks through cinterop. The only Swift is the shell.
- **One thread.** Every `core` call runs on the main thread. Model inference, PDF work and key
  derivation run on background dispatchers inside the adapters and post back to main.
- **No renames.** The Gradle root stays at `android/` and the logic module stays `:core`.
  Renaming would touch every golden path, CI and the agent-loop plans for no gain. The iOS shell
  lives in `ios/`.
- **Versions.** Upgrade Kotlin and add Compose Multiplatform at versions where the iOS target is
  stable. Android moves from the androidx Compose BOM to JetBrains Compose for the shared
  module.
- **One version number** for both apps, set in `android/gradle.properties` and read by the
  Xcode build.

## Parity contract

**Identical on Android and iOS, and with the web where the web has the feature,** checked by
goldens and the shared UI:

- questions, order and branching (`schema.json`);
- every spoken and displayed string, for each language;
- the screens, their controls and their order;
- the parse result for a given transcript, and the turn transcript for a given scenario;
- the fill plan for both form versions, given the same answers and the same translations;
- tokenizer output and greedy decoding for every model, checked against the reference
  (Step 3b);
- the JSON v3 export, now with translations and input-language tags, so a session can move
  between web, Android and iOS;
- what is stored, what is never stored, the idle lock and the 7-day expiry.

**Allowed to differ:**

- model outputs, because CPU kernels differ (the read-back catches what that changes; a
  translation that differs only moves which English words are on version B);
- the voice that reads free text back;
- PDF bytes (structural parity, level L2 in the Android plan, is the target);
- whether a visual preview exists, and the system dialogs for saving and sharing.

## Step 1: make `core` multiplatform

Switch `android/core` from `kotlin.jvm` to `kotlin.multiplatform` with `jvm()`, `iosArm64()` and
`iosSimulatorArm64()`. Android modules consume the JVM artifact, so `:pdf` and `:core-device`
(the goldens under ICU) change only their dependency line. Sources move to
`src/commonMain/kotlin`. Tests move to `commonTest` on `kotlin.test`, which still runs on JUnit
for the JVM.

| Where | JVM API | Replacement |
|---|---|---|
| `I18n.kt`, `pdf/FormDocument.kt` | `java.text.Normalizer` (NFKD) | `expect fun nfkd()`: `Normalizer` on the JVM, `decomposedStringWithCompatibilityMapping` on iOS |
| `TtsHash.kt` | `MessageDigest` SHA-256 | `expect fun sha256()`: `MessageDigest` on the JVM, CommonCrypto `CC_SHA256` on iOS |
| `js/JsValues.kt` | `BigDecimal`, for JS's shortest number printing | A common Kotlin shortest round-trip (Schubfach, the algorithm JDK 19+ uses). Checked against today's BigDecimal version on the JVM over the goldens and 10⁷ seeded random doubles |
| `forms/DsIntake.kt`, `parse/Parse.kt`, `pdf/FormDocument.kt`, `turn/TurnController.kt` | `LocalDate`, `Instant`, `ZoneId` | A small common `CivilDate` (year, month, day, leap years, days between). The injected clock supplies the local "today". No new dependency |
| `engine/Engine.kt:29` | `System.currentTimeMillis` as the default | The clock is always injected |
| `js/JsRegex.kt:50` | `synchronized` cache | Kept to one thread, asserted in debug builds |
| `schema/Schema.kt:97` | classloader resource | `expect fun readResource()`: the classloader on the JVM, the app bundle on iOS |
| Several files | `String.format`, `Charsets`, `Math.*`, `Character.*` | `padStart`, `encodeToByteArray`/`decodeToString`, `kotlin.math`, explicit surrogate handling |

**The real risk is regex, not this table.** Kotlin/Native's `Regex` is its own engine: neither
`java.util.regex` nor ICU. `JsRegex.kt` already rewrites every pattern with explicit classes,
which is what makes this manageable. The goldens on the simulator are the proof. Add Lingala
input to its fuzz cases: `ɛ`, `ɔ`, tone marks, and combining and precomposed forms.

**Goldens on iOS** are read from the host's disk, not copied into a bundle. The simulator shares
the host file system, so pass the directory as `SIMCTL_CHILD_GOLDEN_DIR`. `simctl` strips the
prefix, and the test reads `GOLDEN_DIR`. Scenarios and fixtures work the same way, still pinned
by SHA-256.

**Done when:** all 13 goldens and all turn scenarios pass on the JVM, under ICU on the emulator,
and on the iOS simulator; the iOS framework builds; and the web tests are still green. This step
makes no JS changes.

## Step 2: the shared app layer, in `core`

These are things both apps need and neither should build twice. Anything that becomes data here
is added to the JS reference first, so goldens still come from one place.

1. **`AppController` and `UiState`.**
   - The controller owns language → setup → interview → review → export, on top of
     `TurnController`.
   - `UiState` is plain data: the screen, the prompt, the status line, values masked or not,
     which controls are live, progress, the export list, and a language tag for every text run.
   - Live controls are the talk button, the text box, yes/no buttons and one button per choice
     or rating. A tapped option submits its canonical value, the same way an exact typed label
     does.
   - The YAML turn runner gains a controller level, so scenarios run with no UI.
2. **The session store format.** Port `src/store.js`: the envelope, redaction (`Sensitive.kt`
   already has `redact`), `withheld`, the 7-day expiry and the idle lock. Platforms only provide
   `Crypto` (PBKDF2-SHA256 at 600k iterations, then AES-256-GCM) and `FileStore`. A test vector
   made with WebCrypto must decrypt on the JVM and on iOS. Translations and input-language tags
   are part of the saved session. Fix the known quirk here as well: a deleted marriage shifts the
   `withheld` indexes (TODO.md, *Known quirks*).
3. **The Lingala speech normalizer.** Simba-TTS-lin can only say what its vocabulary can spell
   (Step 4.3). So `core` turns every Lingala string into speakable text before the `say` port
   sees it: digits become number words, letters outside the vocabulary are respelled, and
   punctuation becomes pauses. It is a pure function, written in the JS reference first, with its
   own golden. The platform runs Simba on the result. English goes down the same `say` port as
   today, so the English turn golden does not move.
4. **The input matrix.** For each language and question type, record whether voice is offered,
   which recognizer and adapter to use, and which lexicons apply. Lingala sessions already accept
   French digit words. It lives in `src/i18n/languages.js` and is exported in `schema.json`:
   ```js
   ln: { …, stt: { engine: 'mms', lid: true, adapters: ['lin', 'fra', 'eng'],
                   voiceTypes: 'all', alwaysReadBack: true } }   // narrowed by Step 4.4
   ```
5. **Two form versions.** `FillPlanner` takes the answers plus an optional translation overlay
   and produces plan A (as given) and plan B (English translation). Plan B only exists when at
   least one translated field differs from plan A. Step 4.7 has what each version contains.
6. **The model ports.** `Transcriber`, `LanguageId` and `Translator` are interfaces in `core`.
   `:models` implements them, and tests swap in scripted fakes.
7. **Self-check rules.** Move the checks in `android/pdf/.../PdfSelfCheck.kt` into `core`, over a
   `PdfReadPort`: fields, values, DAs, widget rects, decoded `/AP /N` streams, and page count and
   sizes. Add a common content-stream tokenizer for the `Tj` comparison. PdfBox implements the
   port on Android and CGPDF on iOS, so each platform checks its output with a reader other than
   the one that wrote it. Both versions of every form are checked.
8. **Export naming and spoken warnings:** the file-name slug, the version suffix, and the
   warning that the file holds the SSN.

## Step 3: spikes, in parallel with Step 1

Record each outcome in `ios/SPIKES.md`, the way `android/pdf/M1A.md` records M1a.

**3a. PDF on iOS, the mirror of M1a.**

- Split `fillTemplate` in [src/fill.js](src/fill.js) so the writer takes a finished plan and draw
  list, as Android's `AcroFormWriter` already does. The web behaves exactly as before.
- Load `vendor/pdf-lib.min.js` and the writer into a `JSContext`. At load, assert that `fetch`,
  `XMLHttpRequest` and `WebSocket` are undefined. Pass bytes in and out as typed arrays.
- Fill both forms, in both versions, from golden fill plans. Reopen each with CGPDF and run the
  self-check, then re-read it with `tools/golden/crosscheck.mjs`.
- Time it on a low-end and a recent iPhone against Android's budgets: 3 s per form end to end,
  6 s at most. A Lingala session with both forms exports four PDFs, so also time all four. Inside
  an app, JavaScriptCore does not get the JIT that Safari's web content process has, so expect it
  to be slower than in a browser. Measuring that is the point of the spike.
- Check whether PDFKit's `PDFView`, hosted in the shared UI through `UIKitView`, draws the filled
  widgets. If it does, iOS gets the visual preview for sighted helpers that Android cannot have.
- **If it is too slow, the fallback is a common Kotlin incremental-update writer.** It appends
  the changed field dictionaries, `/AP` streams, addendum pages and a new xref section after the
  untouched template bytes. It only has to handle the two hash-pinned templates, which the
  contract test bounds, and it could later replace both platform writers.

**3b. Models on ONNX Runtime, both platforms.**

- **Runtime.** Link ONNX Runtime's mobile build (MIT) on both platforms: the Android AAR, and the
  C API through cinterop on iOS. Confirm the build has no networking code in it.
- **Models:**
  - Whisper base.en and base, the same ONNX packs the web already pins;
  - MMS ASR (`mms-1b-all`, with the `lin`, `fra` and `eng` adapters);
  - MMS language ID;
  - NLLB-200 distilled 600M;
  - Simba-TTS-lin. It ships only `model.safetensors`, so export it to ONNX with a pinned script;
    MMS-TTS VITS models have been exported to ONNX before (sherpa-onnx's export scripts show the
    way). Try fp16 and int8, and keep the smallest one that listeners cannot tell apart from fp32.

  Convert each to ONNX (int8 where quality holds) with a pinned tool, and record each revision
  and SHA-256 in `tools/fetch-model.mjs`'s `REVISIONS`.
- **Decoding in common Kotlin.** Write the shared code that runs these models: Whisper's
  byte-level BPE and NLLB's SentencePiece tokenizers, one greedy encoder-decoder loop used by
  both, and CTC decoding for MMS. Where transformers.js can run the same ONNX files in Node, it
  generates the goldens: token ids, and the decoded text for fixed inputs. Otherwise a pinned
  Python reference in `tools/` does.
- **Measure** latency, peak RAM and disk on a low-end and a recent phone of each platform:
  - the 9 English fixture WAVs through Whisper;
  - language ID on the first 3 s of a clip;
  - MMS on Lingala clips, once Step 4.4 has recordings;
  - NLLB on 20 Lingala sentences;
  - Simba on 20 read-back sentences: the time to the first audio, and the real-time factor. A
    read-back must start within the 700 ms earcon budget of the Android plan, or the earcon
    covers the wait.

  The MMS and NLLB models together are likely to be gigabytes, even at int8; the spike measures
  how much. Load one model at a time: language ID, then ASR, and NLLB only when the review or
  export screen needs it.
- **Memory on iOS.** Whether a 1B-parameter model fits under iOS's memory limit on a 4 GB iPhone
  is the open question. Check whether the increased-memory-limit entitlement can be signed by a
  free Apple ID. If MMS ASR does not fit on low-end phones, those phones use tap and type in
  Lingala sessions (D8).

**3c. The network audit and its canary.** See [Privacy on iOS](#privacy-on-ios). The canary is an
iOS target that uses `NSURLSession`, and CI must fail on it.

**3d. VoiceOver and TalkBack with the shared UI.** This is the riskiest part of D2, so it comes
first. Build the Interview screen in Compose Multiplatform and check on a real iPhone and a real
Android phone:

- every control is reachable, with the right label, role and state;
- the five custom actions work on both: Repeat, Back, Skip, Where am I, Read back;
- **Magic Tap** toggles talk and the **escape gesture** cancels or goes back. Both travel up the
  responder chain, so the Swift host view controller handles them and calls the controller;
- announcements go through one `expect fun announce()`, backed by `UIAccessibility.post` on iOS
  and the Android equivalent, and never read twice;
- a Lingala text run is read with the voice its language tag asks for (Step 4.9). Check whether
  Compose Multiplatform passes span locales through to VoiceOver;
- text fields honour autocorrect off, spell-check off, secure entry for SSN and bank numbers, and
  Writing Tools off on iOS 18 and later.

Whatever fails is replaced with a native view through `UIKitView` or `AndroidView` for that
control only, typically the sensitive text fields. The screen layout stays shared. The spike
records which controls needed that.

## Step 4: English or Lingala

This step has the most unknowns, and with no budget, most of it depends on volunteers. Start it
now: it is the critical path.

### 4.1 The words

- **Review by volunteers.** Ask Lingala speakers in the community the app will serve to review
  the catalogue; Kinshasa and Brazzaville usage differ. Running
  `node tools/export-questions.mjs --lang ln` already makes the review sheet
  (`questions-translatable.ln.md`, plus the `.docx`).
- **Import.** Add the way back: `tools/import-questions.mjs` reads the reviewed sheet into
  `ln.strings.js` and refuses any line whose English source has changed since the export.
- **Disclose until reviewed.** With no budget, an unreviewed catalogue cannot block a release.
  Instead, while `reviewedByNativeSpeaker` is false, every Lingala session opens with a short
  spoken and on-screen notice in Lingala: the Lingala wording and the English translations are
  machine-made and have not been checked by a Lingala speaker.
- **Questions for reviewers:**
  - which numbers a Lingala speaker expects to hear in a read-back: Lingala, French or either;
  - how to say a year;
  - how formal "you" should be;
  - what to do with names that have no Lingala word, such as Social Security and MaineCare. The
    draft keeps the English proper nouns.

### 4.2 Choosing the language

- **The first screen works without reading.** One clip says, in English and then in Lingala,
  "For English, tap the top button. Pona Lingála, …". The screen has two full-width buttons, and
  VoiceOver and TalkBack read each one in its own language.
- **What the choice sets.** Input, output and screen take that language. Fill takes English;
  both form versions are produced anyway (4.7).
- **More language options.** This opens the four separate channels the web app already has. One
  case needs them: a caseworker who reads English, helping an applicant who listens in Lingala
  (screen in English, output and input in Lingala).
- **Before the microphone prompt.** iOS and Android show it in the phone's language, which is
  never Lingala. So the app first explains, in the chosen language, what is about to appear.
- **The Lingala pack.** If Lingala is chosen and the pack is not installed, the app says so in
  Lingala and offers to import the pack file (see Distribution). Until it is installed, the
  interview still runs in Lingala, with tap and type only and no translated version.

### 4.3 Speaking Lingala: Simba-TTS-lin, on the device

One local voice does all Lingala speech. There is no cloud voice and no OS voice involved.

1. **Fixed strings are pre-rendered clips.** The prompts, warnings and hints never change, so the
   maintainer renders them once with the same pinned Simba model:
   - `tools/build-audio-ln.py` runs Simba through `transformers` (`VitsModel`) on the maintainer's
     machine. It needs no network once the pinned model is on disk.
   - Clips are keyed by the `ttshash` of the normalized Lingala text and stored in `audio-ln/`
     with their own manifest. `LANGUAGES.ln.clips` is set, and the files are pinned by SHA-256
     into both apps.
   - `tests/audio-manifest.js` is extended to Lingala, so a string edited without a new clip
     fails CI.
   - Only missing clips are rendered, so a reviewed string costs one clip and no money.

   Clips keep prompts instant and identical on every phone, and they keep the interview speaking
   if the runtime model fails to load.
2. **Everything containing an answer is synthesized on the phone.** This covers read-backs, the
   review read-out and free-text echoes. Simba runs on ONNX Runtime, in the app, on the
   normalized text. SSN, phone, date, name and description read-backs are all spoken in Lingala;
   nothing falls back to a French voice any more. The audio is played from memory and never
   written to disk or cached, as with English read-backs today.
3. **Normalize before speaking** (Step 2, item 3). The model's vocabulary is 39 symbols:
   lowercase `a`–`z` without `x`, digits `0`–`8` with no `9`, space, `'`, `-`, `_` and `ʼ`. It
   has no `ɛ`, `ɔ`, tone marks or capitals. So the normalizer:
   - lowercases, and folds `ɛ`→`e` and `ɔ`→`o`, the same fold the parser already uses. The
     model was evidently trained on text without the open vowels;
   - always spells numbers out as words and never passes digits through. A missing `9` would
     otherwise drop digits from an SSN read-back. Reviewers decide whether digits are read in
     Lingala (`libwa`) or French (4.1);
   - respells letters the model lacks. French and English loanwords are the main source:
     `x` in `deux`, `six` and `dix`, and English names such as Maxine. Each respelling rule is
     data, checked by listeners;
   - turns punctuation into word gaps, and splits long text at sentence ends;
   - is checked in a golden: every catalogue string and every read-back template normalizes to
     symbols in the vocabulary, with no unknown token.
4. **Determinism.** VITS draws random noise for durations and the waveform, so the same text can
   sound slightly different each time. Fix the noise scales and seed the generator per
   utterance, so a phrase sounds the same each time it is repeated.
5. **Quality is unmeasured.** The model card gives no Lingala evaluation and no limitations.
   Volunteers listen to a sample of clips and runtime read-backs, digit strings above all. A word
   the voice gets wrong is fixed by a respelling rule or by the catalogue spelling, and only that
   clip is rendered again.
6. **Size.** 145 MB at fp32; fp16 halves it, and 3b chooses the format. Simba ships **inside the
   app**, not in the Lingala pack, so a Lingala interview can always speak even before the pack
   is installed.

### 4.4 Understanding spoken Lingala: Meta's MMS

- **Per answer in a Lingala session:**
  1. the existing capture gates (size, duration, level, filler);
  2. MMS language ID on the capture, restricted to Lingala, French and English;
  3. MMS ASR with the matching adapter;
  4. the parser with that language's lexicon.

  The detected language is stored with the answer and decides what 4.7 translates. If language
  ID is unsure, use Lingala.
- **Until measured:** voice is offered for every type. Every Lingala voice answer is read back
  whatever the read-back setting, and tap and type stay available. This is safe because the
  read-back catches wrong values; the only open question is how often people are asked again.
- **Measure with volunteers.** Ask 10 or more Lingala speakers to consent to recording a fixed
  script, naturally, in a quiet room and a noisy one: the non-issuable SSNs 987-65-4320 to 4329,
  phone numbers, dates, yes and no, form and rating choices, names and short answers. Publishing
  the audio needs its own consent. Store it as `tests/fixtures/speech/ln/` with `expected.json`,
  or keep the audio out of the repository and commit only the scores.
- **Score** each question type by exact values after parsing, on both platforms. Compare:
  - language ID on, against forcing Lingala;
  - the `lin` adapter against `fra` for digit answers, since many Lingala speakers say numbers
    in French.
- **Narrow the input matrix.** Where a type is exactly right on the first try less than 90% of
  the time, which is a proposed bar, Lingala sessions answer it by tapping or typing and the
  prompt says so.

### 4.5 Yes and no: a bug to fix first

The Lingala yes list includes the bare vowels `e` and `ɛ`
([ln.lexicon.js:7](src/i18n/catalog/ln.lexicon.js#L7)). The same lexicon treats `e` as a
hesitation elsewhere ([ln.lexicon.js:31](src/i18n/catalog/ln.lexicon.js#L31),
[:33](src/i18n/catalog/ln.lexicon.js#L33)). Checked on 2026-11-21 against
`parseLocal(…, { lang: 'ln' })`: the transcripts `e`, `E.`, `e...` and `ɛ` all parse as **yes,
with confidence 1**. The read-back accepts on that same parse
([src/turn.js:517](src/turn.js#L517)). So in a Lingala session, a hesitation transcribed as "E."
would confirm an SSN read-back. MMS's CTC output is lowercase with no punctuation, which makes a
bare `e` more likely, not less.

Fix it in the JS reference, then regenerate the goldens:

- For read-backs and `confirm` fields, the bare vowels do not count as yes. `ɛɛ`, `iyo` and the
  longer forms still do.
- In Lingala sessions, the main way to confirm is the on-screen button, Magic Tap on iOS or the
  matching TalkBack action. Speaking is the alternative, not the requirement; the web app's user
  testing already found that faster.
- Add parse cases and a turn scenario for each.

### 4.6 Typing Lingala

Matching folds `ɛ` to `e` and `ɔ` to `o` and strips diacritics, so any Latin keyboard works. That
matters on iOS, where the app refuses third-party keyboards (see Privacy). Someone who usually
types Lingala with Gboard uses the system keyboard here, and the parser treats the text the same.

### 4.7 The two form versions

In a session with any free-text answer given in Lingala, the export screen offers each chosen
form twice:

| | Version A: as given | Version B: English translation |
|---|---|---|
| File name | `ssa-starter-kit-<name>-<date>-lingala.pdf` | `ssa-starter-kit-<name>-<date>-english.pdf` |
| Agency fields, closed answers | English labels and values, `MM/DD/YYYY`, `$1,200` | The same |
| Free-text answers given in Lingala | Written exactly as given | NLLB's English translation, marked `[MT]` |
| Free-text answers given in English or French | Written as given | Written as given; French is not translated in v1 |
| Names, addresses, medication and provider names, numbers | As given | As given; never translated |
| Addendum opens with | "Some answers were given in Lingala and are written as spoken. The applicant's preferred language is Lingala. Please provide an interpreter." | "Answers marked [MT] were translated from Lingala by software on the applicant's phone and have not been checked by a translator. The applicant's own words follow in the appendix." |
| Appendix | — | Every translated answer in its original Lingala, next to its question |

- **Choosing between them is the user's call.** Both are always saved together, with "Save all"
  writing every file in one step: a folder on Android (`OpenDocumentTree`) and several documents
  in one `fileExporter` on iOS. Share and Open work on each file. The spoken summary explains the
  difference in Lingala, says that SSA provides interpreters at no cost, and does not recommend
  one version over the other.
- **When there is only one version.** English sessions, and Lingala sessions with no Lingala
  free text, export one version per form, as today.
- **The DS form's `primary_language` question** ([src/schema.js:388](src/schema.js#L388)) is
  pre-filled with "Lingala" in Lingala sessions, but still asked and confirmed. It is written in
  English in both versions.
- **Both versions go through `PdfSelfCheck`.** If either fails, that version falls back to the
  worksheet, as today.

### 4.8 Translating on the device

- **Which questions.** A new schema flag, `translate: true`, marks narrative text questions: how
  a condition limits the person, a medication's reason, job duties, daily-living explanations,
  and the like. Leave names, addresses, phone numbers, emails and identifiers unmarked.
  `tests/schema-data.js` lints the flag. Choosing the list is a schema change, reviewed like any
  other.
- **When it runs.** In the background on reaching Review, and again for any answer changed later.
  Each translation is cached by the SHA-256 of its source text, stored in the encrypted session,
  and included in the JSON export.
- **How.** Greedy decoding, one sentence at a time, with a length cap; input over the cap is
  split at sentence ends. It is deterministic on one device and build.
- **Helpers.** The Review screen shows each translation under its original, labelled "Machine
  translation". A helper who reads English can correct it. A corrected translation is marked as
  edited by a person, and keeps its `[MT]` mark only if nobody touched it.
- **Quality is not measured.** Ask bilingual volunteers to rate translations of the Lingala
  evaluation set's short answers, plus 50 written narrative answers. Until they have, the export
  screen and the addendum say plainly that the translation is unchecked.
- **Without the Lingala pack** there is no NLLB, so version B is not offered, and the export
  screen says why.

### 4.9 Screen readers reading Lingala

VoiceOver and TalkBack choose a voice from each text run's language. A run tagged `ln` gets the
phone's default voice, usually English. The app's own Simba voice cannot be lent to the screen
reader. `UiState` carries a tag on every run. Ask volunteers whether tagging Lingala as `fr`
sounds clearer than the default voice. If opinions differ, make it a setting. While the app is
speaking a prompt with its own voice, that text is not also announced, so a VoiceOver or TalkBack
user hears Simba for the interview and their screen reader only for navigation.

## Step 5: the app

The screens are shared: Language → Setup (input mode, PIN, read-back, show numbers, Lingala pack)
→ Interview → Review (change, add, remove, translations) → Export (both versions; save all, save,
share, open, spoken summary, erase everything).

What still differs underneath, behind `expect`/`actual` or an adapter:

| Concern | Android | iOS |
|---|---|---|
| Shell | `MainActivity` hosting the shared UI | Swift app entry and host view controller (`ComposeUIViewController`) |
| Talk key | Button; hardware Space; headset button | Button; hardware Space; Magic Tap (two-finger double tap) starts and stops; the escape gesture cancels or goes back |
| Half-duplex | Never record while anything plays, TalkBack included | The same. Wait for `announcementDidFinishNotification` before opening the mic |
| Capture | `AudioRecord` at 16 kHz | An `AVAudioEngine` input tap, then `AVAudioConverter` to 16 kHz mono, in the `.playAndRecord` session |
| Interruptions | `isClientSilenced` pauses | `interruptionNotification` pauses; it is not "nothing heard" |
| Prompt clips | `audio/` and `audio-ln/` in the APK, pinned | The same files in the app bundle, pinned by a build phase |
| Read-back voice, English | `TextToSpeech`, offline voices only | `AVSpeechSynthesizer`, on the device |
| Read-back voice, Lingala | Simba on ONNX Runtime, played with `AudioTrack` from memory | Simba on ONNX Runtime, played with `AVAudioPlayerNode` from memory |
| Models | ONNX Runtime AAR | ONNX Runtime C API through cinterop |
| PDF writer | PdfBox-Android | pdf-lib in JavaScriptCore (3a) |
| Self-check reader | PdfBox | CGPDF |
| Visual preview | None: `PdfRenderer` draws no widgets | PDFKit `PDFView` through `UIKitView`, if 3a confirms it |
| Save | SAF `CreateDocument`; `OpenDocumentTree` for "Save all" | `fileExporter` with one or several documents |
| Share | In-memory `ContentProvider` pipe | Share sheet, from a temp file with complete file protection, deleted afterwards |
| Pack import | SAF `OpenDocument` | `fileImporter`, or "Open in" from Files |
| Session file and pack | `noBackupFilesDir` | Application Support, excluded from backup, `FileProtectionType.complete` |
| Minimum OS | API 29 | iOS 17. APIs from iOS 18, such as `writingToolsBehavior`, are guarded by availability checks |

**Thresholds are per platform.** `SPEECH` 0.045, `AUDIBLE` 0.02, `QUIET_PEAK` 0.05 and the silence
windows were tuned on a browser's processed microphone, and each platform's capture chain is
different. Keep them as per-platform data. Re-measure with the fixture WAVs played through a
speaker, and then with real speakers.

**Phones close apps.** Without a PIN nothing is saved, and both iOS and Android end background
apps freely. On a phone, that means the interview is lost whenever the app is closed. When the
user skips the PIN, setup says this in the chosen language.

## Privacy on iOS

Android's guarantee is a permission the OS enforces. iOS has no internet permission: every app
can open sockets, and the local-network prompt covers only the LAN. On iOS the guarantee is a
property of the binary, checked by CI. That is weaker, and the README must say so. iOS users
build the app from source themselves (see Distribution), so they can also run the audit on their
own build. Users can turn off cellular data for the app; iOS has no per-app switch for Wi-Fi.

| Android | iOS mirror |
|---|---|
| No INTERNET permission, a merged-manifest check, the `aapt2` audit, and a canary | **Binary audit in CI**, also runnable by anyone who builds it, over the `.app` and every embedded framework, ONNX Runtime included. It fails on: a networking framework linked; an imported networking symbol or class (`NSURLSession`, `NSURLConnection`, `nw_*`, `CFSocket*`, `CFStream*`, `socket`, `connect`, `getaddrinfo`, `WKWebView`); `NSClassFromString` or `dlsym` in our code. The canary target must fail it. A runtime test registers a `URLProtocol` that fails on any request during a scripted interview. A person checks App Privacy Report after a full interview and confirms there is no network activity for the app |
| Auto Backup off | Session files and the Lingala pack excluded from backup. No iCloud, CloudKit or shared-keychain entitlements |
| `FLAG_SECURE`, no screenshot in Recents | A privacy cover whenever the scene goes inactive, which hides it from the app switcher. Numbers are masked while the screen is recorded or mirrored. iOS cannot block screenshots, and the app says so |
| Keyboard: no personalized learning, no suggestions, Gboard voice typing hidden | Third-party keyboards refused for the whole app, in the Swift shell (`shouldAllowExtensionPointIdentifier` returns false for `.keyboard`). Autocorrect, spell-check and smart punctuation off. Writing Tools off on iOS 18 and later, since Apple Intelligence can send text off the device. Secure entry for the SSN and bank numbers, which also hides the dictation key. 3d confirms each of these through Compose's text fields, or replaces those fields with native ones. Dictation cannot be removed from other fields, so the prompt points users to the app's own talk button |
| (none) | No copying sensitive fields. Anything else copied is `localOnly` and expires quickly, so Universal Clipboard cannot carry it to another device |
| (none) | No Siri, Spotlight, Handoff or App Intents donations |
| R8 strips logs; no crash SDK | No logging in release builds and no crash SDK. A test checks that no exception message contains answer text, since iOS sends crash logs to Apple when the user has opted into device analytics |
| Spoken warning before sharing | The same warning, plus: saving to iCloud Drive uploads the file to Apple |
| (none, for both) | Every model, Simba included, runs locally on ONNX Runtime. Synthesized read-backs are played from memory and never written to disk, so no user's answer exists as an audio file |

The JavaScriptCore writer adds one rule. Only the template bytes and the plan go into the
`JSContext`, and the load-time assertion from 3a runs in release builds too.

## Testing and CI

- **Goldens on three runtimes** (Step 1): the JVM on every push, the emulator under ICU, and the
  iOS simulator. New goldens:
  - tokenizer and decoding results for each model, including Simba's `VitsTokenizer` (with its
    blank tokens) from `transformers`;
  - the Lingala speech normalizer: every catalogue string and read-back template maps into
    Simba's vocabulary, with no unknown token and no digit left over;
  - fill plans for version B, from fixed translation fixtures;
  - the input-language tags in the JSON export.
- **Scenarios at two levels.** The YAML turn scenarios also run against `AppController` in
  `commonTest`, so both platforms run them. New scenarios:
  - `lingala-interview.yaml`: a choice, yes/no including the hesitation case from 4.5, an SSN
    read-back built from pieces, a free-text answer detected as Lingala, and both fill plans;
  - `lingala-tap-only.yaml`: a question type with voice turned off;
  - `lingala-no-pack.yaml`: Lingala without the pack, so no translated version.
- **UI tests.** The shared UI runs one full "both forms" interview per language with a scripted
  transcriber and translator, as a Compose UI test on Android and an XCUITest on iOS. The
  XCUITest also runs `performAccessibilityAudit()`, and the Android test runs the Accessibility
  Test Framework checks.
- **Adapter tests**, on each platform:
  - the fixture WAVs through each recognizer;
  - Simba on fixed sentences, with fixed seeds giving the same audio on each run, and with a
    non-silent waveform of the expected length range;
  - fill and self-check on both forms in both versions;
  - the crypto test vectors;
  - the half-duplex rule;
  - pack import, rejecting a file with one byte changed.
- **Across platforms.** A JSON v3 file exported from the web imports to the same state on Android
  and iOS: the `import` golden, plus one end-to-end run. `crosscheck.mjs` re-reads PDFs filled on
  both platforms.
- **CI.**
  - The iOS job runs on macOS runners, and only for changes under `android/core/`, `android/ui/`,
    `android/models/`, `ios/`, `tools/schema.json`, `forms/`, `audio*` or `vendor/`.
  - It builds, runs the simulator tests, runs the network audit, checks that the canary fails,
    and uploads the filled PDFs.
  - The model files are too large for the runners to test with. CI runs the decoders against
    small fixture models and the goldens, and the real models are checked on phones.
- **People** (an extension of M8), all volunteers:
  - VoiceOver and TalkBack sessions with blind testers, in English and in Lingala;
  - Lingala speakers judging Simba's clips and runtime read-backs (digit strings above all) and
    the translations;
  - an airplane-mode run from start to finish on both platforms;
  - the App Privacy Report check.

## Distribution: a local download

**Android:**

- A signed universal APK on GitHub Releases, with its SHA-256 published beside it. Installing
  needs "install unknown apps", which the README explains step by step.
- The Play-only parts of the Android plan are dropped: AI-pack delivery, device-targeted
  `llm_pack`, and the Play Data safety form.
- The APK bundles the English Whisper pack and both clip sets.

**iOS:**

- There is no budget for the Apple Developer Program, so the app is built from source with Xcode
  on a Mac, signed with a free Apple ID's personal team, and installed onto the phone by cable.
  The README gives the steps, including turning on Developer Mode on the iPhone.
- **Known limits of free signing.** The app stops launching after 7 days until it is rebuilt and
  reinstalled from Xcode. A free account can install only a few apps this way at a time. In
  practice, iOS users need a helper with a Mac. Check whether saved sessions survive a reinstall
  over the same bundle ID; if they do not, the 7-day expiry already limits what is lost, and the
  README says so.
- Building from source carries the web app's "no hosted copy" principle to iOS: no third party
  can change what the user runs. There is no published binary hash for iOS, because each user's
  build is their own.

**The Lingala pack** (both platforms):

- One file, `ssa-assistant-ln-pack-<version>.zip`, published next to the app. It holds the MMS
  ASR model and adapters, MMS language ID, and NLLB. Its size is measured in 3b.
- The user downloads it with any browser and opens it with the app. The app checks every file
  against SHA-256 hashes compiled into the app, refuses any mismatch, and unpacks it into private
  storage that is excluded from backup. The app itself never downloads anything.
- English-only users never need it. Simba and the Lingala clips ship inside the app, so Lingala
  prompts and read-backs work without the pack.

**Notices screen, on both platforms:**

- Code: ONNX Runtime (MIT), pdf-lib (MIT), PdfBox-Android (Apache-2.0, with its NOTICE), Kotlin,
  Compose Multiplatform and coroutines (Apache-2.0).
- Models: the Whisper weights (MIT), MMS and NLLB (CC-BY-NC 4.0: free, non-commercial use only).
- Voices: the English clips, generated with OpenAI TTS (check the terms, as the Android plan
  says), and Simba-TTS-lin by UBC-NLP (CC-BY-4.0, which requires attribution), with a citation of
  its paper, "Voice of a Continent" (EMNLP 2025).

## Milestones

Android milestones keep their numbers (M0–M8). Mirror milestones are X1–X8.

| # | Milestone | Needs | Done when |
|---|---|---|---|
| X1 | `core` multiplatform | — | Step 1's done criteria hold: goldens and scenarios pass on the JVM, under ICU and on the iOS simulator, and the iOS framework builds |
| X2 | Spikes | X1, for 3a only | `ios/SPIKES.md` records: the PDF go-or-fallback decision with timings; the 3b table for every model on both platforms, including whether MMS fits low-end iPhones; an audit that fails on the canary; the 3d VoiceOver and TalkBack results, and which controls went native |
| X3 | Lingala voice | X2 (3b, for the on-phone part) | The normalizer and its golden are in place. Every fixed string is rendered with Simba into `audio-ln/`, and the audio-manifest test covers Lingala. Simba runs on both phones within budget. Volunteers have listened to a sample. The 4.5 fix has landed |
| X4 | Lingala words | Nothing; start now | Volunteer review imported, with `reviewedByNativeSpeaker: true`. Until then, the disclosure in 4.1 ships |
| X5 | Understanding spoken Lingala | X2 (3b) | Evaluation set recorded by volunteers. Scores per type, with language ID on and off. Input matrix narrowed |
| X6 | Shared app layer and UI | X1, X2 (3d) | Step 2's eight items in `core`, with the JS reference updated first and goldens fresh. The shared UI runs on both platforms. The Lingala scenarios pass on both |
| X7 | Both apps, deterministic only | X2, X6, Android M4 | On both platforms, in English and Lingala, full "both forms" interviews by voice, tap and typing in airplane mode, exporting both versions. Privacy checklists pass. APK and pack published, and iOS build steps written and tried on a clean Mac |
| X8 | Checks with people | X3, X5, X7 | Blind testers on VoiceOver and TalkBack in both languages. Volunteers rate the translations. App Privacy Report checked |

The Android LLM (M6) is independent of all of this and changes nothing for Lingala or iOS.

## Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Compose Multiplatform's VoiceOver support falls short | Blind iOS users cannot use parts of the app | 3d comes first. Failing controls become native views; the screens stay shared |
| MMS ASR is too poor, or too big, for some phones or types | Lingala answers by tapping and typing there | The input matrix makes that a supported mode. 3b and X5 measure before anyone promises voice input |
| The models together are gigabytes | Slow downloads; little room on low-end phones | A separate optional pack. One model loaded at a time. NLLB only at review and export |
| NLLB mistranslates a medical answer | A wrong statement on version B | `[MT]` marks, the original Lingala in the appendix, version A alongside, a helper can correct it, and the disclosure until volunteers have rated it |
| No volunteers for review, listening or recordings | Lingala stays unreviewed and unmeasured | Disclosed in every Lingala session. The defaults (always read back, tap and type available) stay safe |
| Simba mispronounces Lingala, or loses meaning without `ɛ`/`ɔ` and tones | Prompts or read-backs are hard to follow | Respelling rules, a volunteer listening check, and the text always on screen. Digits are always spelled out as words |
| Simba is too slow on low-end phones | A pause before every read-back | 3b measures it. Pre-rendered clips cover every prompt, and the earcon covers the wait |
| Free iOS signing expires every 7 days | iOS users need a helper with a Mac every week | Documented plainly. Android needs none of this |
| Kotlin/Native regex differs from JS on some pattern | A wrong parse on iOS only | Goldens on the simulator, and `JsRegex` fuzzing with Lingala input |
| pdf-lib in JavaScriptCore is too slow for four PDFs | Export over budget | 3a measures it, and the fallback writer is already defined |
| iOS's network guarantee is weaker | A dependency could add networking unnoticed | The binary audit and canary in CI, runnable on every user's own build |

## Open questions for the owner

1. **Translated questions:** which questions get `translate: true`? The plan proposes narrative
   answers only, never names, addresses or identifiers.
2. **Reinstalls on iOS:** if a 7-day reinstall turns out to lose the saved session, is that
   acceptable, given that saved sessions already expire after 7 days?
3. **Volunteers:** is there a community organisation to ask for reviewers, listeners, test
   speakers and blind testers?

## Out of scope

- French as a release target, and translating French answers.
- Spoken number words beyond digits, such as `quatorze` or `zomi na mitano`.
- The LLM on iOS.
- App store publishing.
- Tablet-specific layouts.
- Watch and car interfaces.
