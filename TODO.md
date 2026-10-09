# Next steps

Status: this is the local-only fork. Speech is transcribed on the device,
answers are parsed locally, and the browser's Content-Security-Policy refuses
any request off localhost. The interview works end to end — verified in
headless Chromium with a fake microphone: a spoken answer transcribed,
read back, kept, stored, and the next question asked, with zero requests
off localhost. Everything still open is either verification that needs a
human, a known limitation, or an improvement.

Open items come first, ordered roughly by what would block real use. Closed
items are kept below with the detail of what was actually done, so a later
change can tell whether it is undoing a decision or fixing an oversight.

The `android` branch also carries the first pass of the on-device Android
port, built from [the Android plan](<on-device Android app for the disability forms assistant.md>).
Its review comes first.

---

# Android port

Reviewed 2026-10-08 against the plan, after the first implementation pass,
and its fixes made the same day. Nothing is committed yet. Where it stands:

- **JS steps 1–7 (M2): done.** The 21 web test files, `tools/smoke.mjs` and
  the 9 turn scenarios all pass. The goldens are generated in UTC and come
  out the same on any machine.
- **`core` port (M3): done.** Schema, Engine, Parse, Choice, Correct,
  Validate, Importer, TurnController and the whole PDF-planning side —
  HelveticaMetrics, TextFitter, FillPlanner, AddendumLayout, plus the two
  FormSpecs and the summary they build from. `./gradlew :core:test` runs 30
  tests, all passing, and **every golden now has its port and its test**:
  parse, choice and walks (as before), plus metrics, fits, fillplans,
  addendum, import and turn. Every Kotlin regex goes through one
  JS-to-platform translator (`core/js/JsRegex.kt`).
- **`pdf`, `speech`, `llm`, `app`: skeletons**, as the review found. The
  privacy and native audits around them now work and fail closed.

## Open

- [ ] **Run the new CI once and fix what it finds.** Not yet run anywhere:
      the `device-tests` job, the canary job against real artifacts, and the
      bundletool download. Verified locally 2026-10-08, so only the emulator
      run itself is untried: the `google_apis_ps16k` image name is in
      `reactivecircus/android-emulator-runner`'s documented targets, the
      bundletool checksum matches the 1.17.2 release, the whole
      `build-and-test` job (build, canary, both audits, golden freshness)
      passes on this machine, and the workflow now pins `ram-size: 4096M`
      for the goldens' ~17 MB of JSON (the compacted sizes; the androidTest
      manifest already asks for largeHeap).
- [ ] **Device-group delivery for `llm_pack` needs AI packs.** Confirmed
      still true, and now researched (Play for On-device AI, 2026): the
      `com.android.ai-pack` plugin with `dynamicDelivery { deliveryType }`,
      listed in `assetPacks` like any pack, with device targeting applied
      per pack by Play (ram-min 6 GB fits). Needs AGP ≥ 8.8 (we have
      8.13.2). Fast-follow delivery needs the Play AI Delivery Library
      (`com.google.android.play:ai-delivery`), which — like the PAD
      libraries — talks to the Play Store app and should not add an INTERNET
      permission to the app; the existing merged-manifest audit verifies that
      empirically when it lands in M6/M7. Until then `llm_pack` is not in
      `assetPacks`, and the bundle's device-group split stays off (bundletool
      1.17.2 rejects the `#group_` folder key).
- [ ] **Android wording for the phrases.** `Phrases` now reads the exported
      phrase table instead of a hand-made copy. The words are still the web
      app's ("hold the space bar", "check your downloads folder"). The
      Compose screens need their own, which means new clips and `tts`
      entries. Lands with the UI (M5).
- [ ] **M0 hardware:** a 6–8 GB arm64 reference phone and a low-end phone.
- [ ] **M1a, the PDF spike** (the plan's biggest risk): TemplateLoader,
      AcroFormWriter, AddendumRenderer and PdfSelfCheck; both forms filled
      from the JS-exported plan; a pdf-lib cross-read; the viewer checks;
      time and size; a written go/fallback decision. The templates are now in
      `:pdf`'s assets, pinned, and `:core` already ships the goldens this
      spike reads: `HelveticaMetrics` and `TemplateManifest` from
      `core/src/main/resources/golden/` (written by the generator alongside
      the test copies), and `AddendumLayout`'s draw lists for the renderer to
      replay. PdfBox-Android 2.0.27.0 is in `libs.versions.toml`.
- [ ] **M1b:** whisper.cpp and llama.cpp as pinned submodules, linked
      statically into the JNI libraries; the version script and export audit
      already apply to them. Load the models mmapped from
      `(fd, offset, length)`, transcribe the 9 WAVs, and make a latency and
      RAM table.
- [ ] **M1c:** `tools/llm-eval/` and eval v0 against parser v2.
- [ ] **M4–M8** as the plan describes. TurnController should be a sealed
      type, a base mode × one overlay, rather than a copy of turn.js's
      nullable flags — the current port keeps the nullable flags for golden
      parity.

## Done in the fix pass (2026-10-08)

Each was checked by a test or a re-run, and the new tests were checked by
putting the bug back and watching them fail.

**JS reference**
- [x] **Commit `android/`, the goldens and `tools/schema.json`.**
      `node tools/golden/check.mjs` now fails on goldens that were never
      committed (it used to pass while checking nothing). So it fails until
      the first commit, and passes from then on.
- [x] **Parser v2 numbers.** `wordsToNumber()` follows the spoken grammar
      instead of summing words: "nineteen ninety eight", "three fifty", "one
      two three" and a bare "hundred" defer. A period said with an amount is
      checked against the schema's new `per` on money and number questions:
      "$20 an hour" defers for a monthly amount and is kept for a job's pay.
      `kind: 'year'` reads "nineteen ninety eight" as 1998 where the question
      asks for a year. `engine.current()` carries `per` and `kind`. Without
      that, the live app would have deferred every job pay said with its
      period; a test now goes through `current()`.
- [x] **Yes/no clauses are anchored at the end**, so "yes I do not" and "yes
      I do, no wait" defer, read-backs included. Curly apostrophes read as
      straight ones.
- [x] **A word that is not a digit word no longer reads as digits.** Found
      on the way: `DIGIT_WORDS[token]` found "constructor" on the prototype,
      so "1234 constructor" passed as an account number.
- [x] **Typed non-numbers are refused** rather than stored as 0.
- [x] **Echo stripping applies to typed input**, as its comment said. Kept
      deliberately for sensitive digits: "My Social Security number is …"
      parses; "my social is …" still defers.
- [x] **`askIf` scope is explicit.** A loop field's rule reads its item, a
      top-level rule reads the answers, and `scope: 'answers'` reaches across.
      There is no fallback between the two. tests/schema-data.js lints every
      rule for known operators and for keys its scope can read, and proves
      the lint fires.
- [x] **turn.js:** "no" to a read-back reopens the question without its
      prompt again (`ANSWER_AGAIN`), and `repeat` still replays the prompt. A
      command wins over an open read-back, and `repeat` there replays the
      read-back. The clock reaches the parser and the engine. A second
      concurrent `start()` joins the first, so every front end gets the guard.
      Also found and fixed:
      - Resumed sessions never asked again for the SSN and bank numbers:
        `withheldFrom = []` threw the saved list away.
      - The idle lock left the cleared number in the screen's last snapshot.
- [x] **Scenarios:** the runner has a fixed clock, fake timers (`advance`),
      `resume` built through store.js's real redaction, `start-twice`, and the
      `unspoken`, `spokenOnce` and `withheld` assertions. New scenarios cover
      the SSN digit gate and read-back, resume with withheld numbers, the idle
      lock, commands during a correction, and the double start.
- [x] **Goldens:**
      - Generated in UTC.
      - Walks record every action with its arguments, give each walk its own
        generator, and add correction, mid-correction save and remove actions.
        Each step records the full `current()` view and `missingRequired()`.
      - The parse corpus covers loop fields and typed cases, plus probes where
        the regex dialects differ.
      - Choice cases always record candidates.
      - Fillplans record their answers, and random answer sets now get choice
        values (they never did).
      - `fits` records the value it actually fitted.
      - `check.mjs` also fails on goldens that were never committed.
- [x] **Smaller.** The phrases are exported in `tools/schema.json`, and
      form-fill checks widget DAs as well as field DAs.

**The seven remaining goldens (2026-10-08, completes M3)**
- [x] **The goldens are large — decided: compact.** walks and fillplans are
      written without indentation (33 MB → ~17 MB, mostly walks 18→7 MB and
      fillplans 10→5 MB). The tests compare parsed JSON trees, never text,
      and git keeps every version anyway; the small goldens stay
      pretty-printed for human diffs.
- [x] **metrics → `HelveticaMetrics`.** The generator also records probes
      (text × size → width over the WinAnsi text, height), so the Kotlin
      widths are pinned to pdf-lib directly. The WinAnsi code-point→glyph
      table was extracted from the vendored pdf-lib bundle. `metrics.json`
      and `templateManifest.json` are also written to `core/src/main/
      resources/golden/` — the app reads them at runtime (box sizes and
      widths never come from PDFBox), and `check.mjs` covers both copies.
- [x] **templateManifest → `TemplateManifest` + `parseDa`**, with the
      contract test: no comb, no MaxLen, no `/Opt` on either form.
- [x] **fits → `TextFitter`** (`wrapLines`, `fitTextBox`), every box × ~40
      values compared exactly, cut path included.
- [x] **fillplans → `FillPlanner` + the two FormSpecs** (SsaStarterKit,
      DsIntake) and the summary (`buildReport`/`present`/`shortLabel`,
      en-US number grouping) they map through; ~400 plans re-planned from
      their recorded answers, sections and tables compared whole.
- [x] **addendum → `AddendumLayout`**, replaying the recorded content; every
      draw op compared with exact doubles (JS order of operations kept).
- [x] **import → `Importer`**, v1/v2/v3 inputs recorded in the golden and
      reparsed, broken files refused with the same spoken-sentence messages.
- [x] **turn → `TurnController`**, a port of turn.js over injected ports
      (`createEngine`, `say`, `parseLocal`, `normalize`, `speakable`,
      `formatTimeRemaining`, `correct`, `store`, `speech`, `audio`, `stt`,
      `timers`, `clock`, `announce`, `onState`, `onExport`, `onReadBack`).
      The shared YAML scenarios are copied into core's test resources pinned
      by SHA-256 (like forms/ and audio/), plus the answer fixtures for
      `resume`; a Kotlin harness with the same fixed clock and fake timers
      runs all 9 scenarios and compares every spoken and announced line and
      the final answers with the golden. Also ported on the way:
      `localCommand`, `speakableValue`/`spellDigits`/`formatDate`/
      `formatMonthYear`/`formatTimeRemaining`, and store.js's
      `sensitiveAnswers`/`redact`.
- [x] **`JsRegex` gained `\S`/`\D`/`\W` inside classes** — the complement
      union (`[\s\S]` = any character) is exact under every dialect's
      boundary, and `parseDa` needs it.
- [x] **Numbers as JS prints them everywhere a value becomes text**: "8",
      never "8.0" — `text()`, `present()` and the idle-lock message.

**Kotlin `core`**
- [x] **One regex translator** (`JsRegex.kt`, 25 cases taken from Node). It
      writes JS's `\s`, `\w`, `\d`, `\b`, `.`, `$` and `/i` as explicit
      classes, and `jsTrim()` matches JS `trim()`. Parse.kt is a function-by-
      function port of parse.js. Choice, Correct and Validate use the
      translator too. That fixed several mismatches:
      - Correct removed every add/delete verb where JS's non-global regex
        removes only the first.
      - "your" was replaced inside other words.
      - `String.format` would have written Arabic-Indic digits into dates on a
        phone set to Arabic.
- [x] **Numbers:**
      - `jsNumberToString()` uses JS's notation thresholds and the shortest
        round-trip digits, from the exact value rather than `Double.toString`.
      - Validate turns values into text the JS way: an imported zip of 4101
        no longer becomes "41010".
      - JSON writes NaN as null.
- [x] **Engine:**
      - `getState(returnTo)` and `rewind()` are ported.
      - Entry prompts carry their section.
      - `sectionNumber` is 0 like JS when the section isn't active.
      - Paths hold numbers.
      - `present` treats a stored null as absent.
      - `jsEquals` uses IEEE equality.
      - `findQuestion` returns section and loopId.
      - JsonParser throws only `IllegalArgumentException`.
- [x] **Tests.** WalksGoldenTest replays the recorded actions, with no
      generator. ParseGoldenTest builds its questions exactly as the
      generator does, reads `now` from the golden, and covers typed and
      loop-field cases. ChoiceGoldenTest fails on a missing question and
      compares whole resolutions.
- [x] **`:core-device`** compiles core's tests and goldens into an
      instrumented APK, so they run under ICU
      (`:core-device:connectedDebugAndroidTest`). The APK builds; nothing has
      run it yet (see Open).

**CI and privacy**
- [x] **Permission audit.** It matches aapt2's quoted output, including
      `uses-permission-sdk-23`, and reads AAB modules through a pinned,
      checksum-verified bundletool. It fails closed when a tool is missing or
      errors.
- [x] **The canary is a real app (`:canary`).** Its APK, its AAB and its
      manifest each make the audit fail.
- [x] **`verify<Variant>NoNetworkPermissions`** fails the build on a merged
      manifest. Found with it: the manifest's removals covered
      `<uses-permission>` only, so a library's `<uses-permission-sdk-23>`
      INTERNET got through. The sdk-23 forms are now removed too.
- [x] **Native audit (`tools/audit-native.sh`, replaces audit-alignment.sh).**
      It checks ELF 16 KB alignment, `zipalign -P 16` and JNI-only exports,
      and fails when it finds nothing to check. The JNI library now has the
      version script its comments promised and links the C++ runtime
      statically: no more 9 MB `libc++_shared.so` per ABI.
- [x] **Workflow:**
      - It triggers on `src/**`, `tests/fixtures/**` and `vendor/**`.
      - It uses Node 20 with `TZ=UTC`, and runs the freshness check first.
      - The audits run on every artifact, with the canary step after them.
      - A new emulator job runs the goldens under ICU.
- [x] **Smaller:**
      - `setRecentsScreenshotEnabled` now applies from API 33.
      - R8 also strips `Log.wtf`, `Log.println` and `printStackTrace`.
      - The manifest comment describes what the app actually asks for.

**Repository**
- [x] **`android/.gitignore`** covers `local.properties`, `.gradle/`,
      `.kotlin/`, `build/` and `.cxx/`. `schema.json` is generated under
      `build/`, so `tools/schema.json` is the only copy.
- [x] **Pinned assets.** `forms/` and `audio/` are copied into `:pdf` and
      `:speech` assets by `CopyPinnedAssets` (buildSrc), checked against
      `forms.SHA256SUMS` and `audio.SHA256SUMS`. The build fails on a wrong
      hash, a missing file or an unpinned one. The turn scenarios and answer
      fixtures are pinned into `:core`'s test resources the same way.

---

# Open

## 1. Verification that still needs a human

The first end-to-end pass with a real microphone and a real key has now
happened, and it passed. What it turned up is fixed below; what it did not
cover is still open.

- [x] **Full voice pass with a real key, screen off.** Push-to-talk, the SSN
      digit read-back, a mid-interview "go back" and the PDF download all work
      by ear alone. Two defects came out of it, both fixed — see *Fixed after
      the first live voice pass* below.
- [ ] **Hands-free silence detection tuning.** The threshold in
      [src/audio.js](src/audio.js) (`SPEECH = 0.045`, 1200ms) is still a guess;
      the live pass was push-to-talk. Expect to tune it — too low and
      background noise holds the recorder open, too high and it cuts off quiet
      speakers. Test in a noisy room. Note that `AUDIBLE`, the separate and
      lower floor that decides whether anything was said at all, now runs on
      the push-to-talk path too, so tuning it affects both.
- [ ] **VoiceOver pass** (<kbd>Cmd-F5</kbd>). Verify every state change is
      announced exactly once, nothing is announced twice, and no announcement
      clobbers another mid-sentence. The new transcript read-back adds a turn
      to every voice answer, so this is worth more now than it was.
- [ ] **Safari and Firefox recording.** Chrome's webm/opus is verified: it
      decodes and transcribes (`tools/browser-check.html`, run in headless
      Chromium). Safari records `audio/mp4` — open the browser check in Safari
      and confirm `decodeAudioData` handles it, and that Safari's WebAssembly
      threads work under the servers' cross-origin isolation headers.
- [ ] **Transcription accuracy on digits, with real voices.**
      `tools/stt-eval.mjs` scores 9/9 on synthetic `say` recordings, which are
      far cleaner than a person. Record real speakers — naturally, digit by
      digit, in pause-separated groups, with an accent, in a noisy room — using
      the non-issuable SSNs 987-65-4320 through 4329, add them to
      `tests/fixtures/speech/`, and re-run. If base.en falls short, try
      `whisper-small.en` (`tools/fetch-model.mjs`), which is ~250 MB. There
      is no transcription hint any more; accuracy fixes go in the model choice
      or in `parse.js`.
- [ ] **Timing on a slow machine.** About 0.4 s per answer on an Apple
      Silicon Mac, on CPU. Measure on an older Windows laptop; if it is over a
      couple of seconds, the "Transcribing…" status needs an earcon or a
      spoken "one moment".
- [ ] **Check that a local system voice exists** on a stock Windows and a
      stock Linux install. With none, read-backs are silent and only the
      screen reader's live region carries them.
- [ ] **A voice pass through the Developmental Services interview.** Choose
      "developmental services" and "both" out loud; answer the A–E ratings by
      word and by letter; confirm the scale being spoken once per section is
      enough to answer the later rows without hearing it again. Also check that
      someone answering for the applicant is not confused by "you" after the
      one-time explanation.
- [x] **Regenerate the audio.** Done: `audio/` is committed (552 clips and
      the manifest), the `tts` golden finds a clip for every fixed string and
      prompt, and the Android build pins all of them
      (`android/speech/audio.SHA256SUMS`).
- [ ] **Ask Maine OADS whether a typed-in copy of the intake application,
      with an addendum page for long answers, is acceptable** as submitted.
- [ ] **Re-tune the filler list against a real room.** `FILLER_TRANSCRIPTS` in
      [src/main.js](src/main.js) is the set of phrases a transcriber invents
      when handed silence, and it was written from what these models are known
      to emit rather than from logs of this app. If a genuine quiet answer ever
      gets refused as filler, that list and `QUIET_PEAK` are where to look.

## 2. Security — before this goes near real claimants

With transcription local and the numbers kept out of storage, the downloaded files are now the largest exposure left.

- [ ] **Consider redacting sensitive fields from the PDF by default**, with an
      explicit opt-in to include them. Someone will email this file to
      themselves. The same for "Save my answers as a file", which writes the
      SSN in plain JSON.
- [ ] **Reword the spoken warning before the SSN question.** It still says
      "It is saved only on this device"; it is not saved at all now. Needs
      its clip regenerated (`tools/build-audio.mjs`).
- [ ] **Try the dedicated browser window on Windows and Linux.** Verified on
      macOS only, with a stand-in browser recording its arguments.

## 3. Testing

- [ ] **Add browser-level tests.** The three end-to-end runs used during the
      build were scratch scripts against a DOM shim and weren't kept. Playwright
      would make them permanent, at the cost of adding a dev dependency to a
      site that currently has none.
- [ ] **Test the error recovery paths.** Mic revoked mid-interview, the speech
      worker dying mid-interview, a missing model file at startup. Each has a
      recovery path (`handleSttError()`, `speechModelFailed()`), and
      `tests/local-stt.js` covers the worker side with stubs — none has been
      exercised against a real failure in a browser.
- [ ] **Keep the browser checks.** `tools/browser-check.html` covers the
      worker, the CSP and cross-origin isolation, but it is run by hand. The
      headless-Chromium driver used to verify this fork (fake microphone fed
      from a WAV, driving a real voice answer through `main.js`) was a scratch
      script; making it permanent would need Playwright as a dev dependency.
- [ ] **Test with a very long answer set** — 20 providers, 15 jobs — to confirm
      PDF pagination holds up beyond the 12-provider case that was checked.

---

## Known quirks

- [ ] **Deleting a marriage shifts which spouse's number is owed.** The
      re-ask list (`withheld` in main.js, `carried` in store.js) records a
      spouse's SSN by its position in the marriages list. Delete a marriage
      after resuming and the positions after it renumber, so the re-ask can
      skip a spouse whose number is owed or ask about one who never had one.
      `removeItem()` repairs the engine's cursors; these two lists need the
      same repair.

---

# Closed

## Review of the local-only fork

Found by driving `main.js` against a stub DOM with real storage and
WebCrypto, not by the test suite, which passed throughout. Each is now
covered by a test or by `tools/smoke.mjs`.

- [x] **A command during a correction filed the next answer under another
      question.** `clearCorrectionState()` began restoring the pre-correction
      cursor, and `where`, `read back` and `save` all called it without asking
      anything again: the corrected question stayed on screen while the walk
      pointed elsewhere. Resuming a session made it worse — at the SSN re-ask,
      pressing W then typing the number recorded it as a medical condition,
      and saved it. Commands that only report something now leave the
      correction open (`KEEPS_CORRECTION`), and a save made mid-correction
      stores the place the walk returns to (`engine.getState({ returnTo })`).
- [x] **The idle lock forgot what it promised to ask again.** In a session
      that was not resumed, the lock cleared the numbers and saved a
      `withheld` list without them, so after the tab closed they were never
      asked for. `store.markWithheld()` keeps them on every later save. A
      number cleared mid-read-back of its own re-ask goes back on the list,
      and the re-ask says the page was idle rather than "not saved when you
      stopped last time".
- [x] **A second press of Start or Resume ran a second start.** The setup
      panel stays up through key derivation and the model load. Resume twice
      lost an older unencrypted session outright; Start twice forgot the PIN,
      so nothing was saved. `startOnce()` ignores the second press.
- [x] **Deleting an entry during a correction lost the next answer.** The
      correction's saved cursor was not repaired by `removeItem()` and pointed
      past the end of the list. A mid-interview deletion now drops an open
      correction first.
- [x] **Typed free text was rewritten.** `parseText()` capitalized and
      stripped full stops from typed answers too ("de la Cruz", "Jr.").
      `parseLocal(…, { typed: true })` leaves it as written.
- [x] **A long session was silently not saved.** Base64 by spreading the
      ciphertext into one call overflows the stack past about 100 KB, and
      `saveState()` swallowed the error while "save and quit" said it worked.
- [x] **The Node server could be stopped from outside.** A malformed escape
      (`GET /%`, sendable by any web page) was an unhandled rejection, and a
      browser that would not start (`SSA_BROWSER` naming a `.app` folder)
      was an unhandled spawn error. Both now fall back as `serve.py` does.
- [x] **The Windows launcher closed before its STOPPED message could be
      read.** It now pauses when the server exits with an error.
- [x] **Smaller:** the withheld re-ask for a spouse names the marriage; a
      restart clears the re-ask list; a file loaded but not resumed is not
      kept in memory, out of the idle lock's reach.

## Local-only fork

- [x] **No audio or answer leaves the device.** OpenAI transcription,
      extraction and TTS are gone (`llm.js` became `validate.js`, keeping only
      `normalize()`), and so is the browser's cloud `SpeechRecognition`
      (`stt.js`). Whisper base.en runs in a Web Worker on the WebAssembly
      backend (`localstt.js`, `whisper-worker.js`); model and runtime are
      committed and pinned by hash.
- [x] **The browser enforces it.** CSP with `connect-src 'self'` in
      `index.html` and as a header from both servers (the header is what
      covers the worker). Checked statically by `tests/no-network.js` and in
      a real browser by `tools/browser-check.html`.
- [x] **Free text without a model.** `parseText()` in `parse.js` strips
      hesitation and the transcriber's full stop; the read-back catches the
      rest.
- [x] **Read-backs stay on the device too.** `speech.js` uses only voices the
      browser reports as `localService`, never Chrome's network "Google"
      voices, and deletes upstream's Cache Storage of synthesized read-backs.
- [x] **WASM rather than WebGPU.** The committed q8 weights are the only
      variant small enough to commit without Git LFS, and onnxruntime's WebGPU
      backend runs their int8 matmuls on the CPU anyway. Revisit only with a
      second, ~200 MB fp32/q4 copy of the model.
- [x] **Move the API key server-side.** Moot: there is no key.
- [x] **SSN and bank numbers are never written to `localStorage`.** Removed
      from every save and recorded as `withheld`; a resumed session asks for
      each again, once, as a correction before the review. Older saved
      sessions are scrubbed on first load. An imported file's numbers are held
      in memory for the resume it sets up. Fixed on the way: a correction left
      the cursor on the corrected question, so a session saved afterwards
      resumed mid-form (`engine.restoreCursor()`).
- [x] **Typed answers opt out of cloud spell-check** and of the Grammarly and
      LanguageTool extensions.
- [x] **Port 27183, not 8000**, so no other local tool shares the origin the
      answers are saved under.
- [x] **Saved answers are encrypted with a PIN**, or not saved at all
      (PBKDF2-SHA256 600k → AES-256-GCM, key non-extractable, in memory
      only). Saved sessions expire after 7 days.
- [x] **Numbers masked on screen** (last four digits) unless the user opts
      in at setup; speech and the live region keep every digit.
- [x] **Idle lock**: sensitive numbers leave memory after 15 minutes without
      activity and are asked again before a form is filled. After a download
      the user is told how to erase everything.
- [x] **Dedicated browser profile**: the launchers open Chrome/Edge/
      Chromium/Brave with its own profile, extensions, sync, background
      networking, crash dumps, translation and autofill lookups off.
- [x] **Launchers verify the model, runtime and pdf-lib hashes** before
      serving, and refuse to start on a mismatch.
- [x] **No hosted copy.** The GitHub Pages deploy is replaced by a test-only
      CI workflow, and the launchers no longer suggest the hosted upstream
      site when Python is missing.

## Known quirks

- [x] **The Starter Kit's first conditions prompt is asked as a yes/no.**
      A loop marked `entryIsFirstField` now asks its entry prompt as its
      first field, so a spoken "diabetes" opens the first condition and
      fills its name; "another condition?" is still a yes/no, and skipping
      the entry still means none. The progress count charges the repeat
      prompts it used to treat as free.

## Two forms: the Starter Kit and Maine's DS Intake Application

- [x] **The first question chooses the form.** Starter Kit, Developmental
      Services Intake Application, or both. Every section and question in
      [src/schema.js](src/schema.js) is tagged with its forms; shared
      questions are asked once, and the DS form derives marital status,
      diagnoses, and work history from the Starter Kit's questions when both
      are chosen. A loop can now be skipped whole by its `askIf`. Sections are
      counted among the ones the chosen forms use. Changing the choice later
      re-walks to the new questions in a catch-up mode that skips everything
      already answered. Covered by [tests/form-routing.js](tests/form-routing.js).
- [x] **The download is the official form, filled in.** Both PDFs are
      fillable AcroForms (the README used to say the Starter Kit was not; it
      is). [src/fill.js](src/fill.js) fills them, shrinks long answers to fit,
      and moves anything still too long, or past a table's printed rows, to
      addendum pages. Covered by [tests/form-fill.js](tests/form-fill.js),
      which fills every field of both real templates and reads them back.
- [x] **Multiple-choice answers.** A `choice` type with local matching
      ([src/choice.js](src/choice.js)), so the A–E scale and the form choice
      work by voice with no API key. Negations defer rather than match.
- [x] **Sessions saved before this change still resume.** They become
      Starter Kit sessions and land on their first unanswered question.
- [x] **Going back over "add another? yes" erased the earlier items.** At a
      loop's repeat prompt the cursor still pointed at the last finished
      item, so `back()` truncated the list to before it: going back over "yes,
      another provider" deleted provider 1 as well as the empty provider 2.
      The cursor now points past the recorded items at every entry prompt.
      Covered by test 12b in [tests/engine-walk.js](tests/engine-walk.js).
- [x] **CI only failed on the last test.** The workflow's test loop now stops
      at the first failure.

## Fixed after the first live voice pass

Two defects, both found by using the thing rather than by reading it. Neither
was visible from the code — one needed a real microphone, the other needed
someone to change their mind about how they wanted to answer.

- [x] **A silent capture was being recorded as an answer.** Press and release
      the space bar without speaking and the question advanced. The cause was
      not the recorder: it was that push-to-talk never ran the level meter
      (`heardSpeech` was hardcoded true whenever `autoStop` was off), so a
      second of room tone passed the blob-size guard and was sent to be
      transcribed — and a transcriber handed silence does not return an empty
      string, it returns a short plausible phrase like "you" or "Thank you."
      That phrase was extracted, committed, and the form moved on past a
      question the user never answered, with no way back except the review
      screen. Four guards now stand between a capture and the extractor: blob
      size, a 350ms minimum duration, a measured microphone level that now runs
      on both paths, and a filler-phrase check that only fires when the mic
      also stayed at the noise floor. All four end in a re-ask.
      [tests/empty-transcript.js](tests/empty-transcript.js) covers the last
      one, including the cases where the same words *were* actually spoken.
- [x] **Typing an answer permanently closed the voice lane.** `switchToText()`
      set `mode = 'text'` and hid the talk button, and nothing ever undid it —
      so one typed answer meant typing the rest of the interview. The lane a
      user is in is no longer the same thing as the mode: `mode` now only
      decides whether the recorder opens on its own and where focus lands,
      while both controls stay on screen for the whole interview. `voiceDisabled`
      is the only thing that closes voice, and it is set only for a microphone
      that genuinely cannot work. Push-to-talk is no longer gated on
      `mode === 'voice'`, the microphone is requested lazily on first press so
      a typing-mode session can pick up voice partway through, <kbd>T</kbd>
      moves to the text box and <kbd>Esc</kbd> hands the space bar back.

## Transcript read-back on every voice answer

- [x] **Confirm what was heard before using it.** Each voice answer is now read
      back verbatim and waits for a spoken (or typed) yes/no. `no` discards it
      and reopens the same question *without* re-reading the prompt — the user
      just heard it, and repeating it before every retry is what makes a
      misheard answer feel expensive. Two turns are exempt because they already
      confirm themselves: commands, and the `confirm` fields (SSN, routing,
      account), which get the stronger read-back of the parsed value spoken
      digit by digit. Reading the raw transcript first would have asked the
      same question twice and buried the version that actually catches a wrong
      digit. Yes/no is matched before the command table here, since "correct"
      is both a way to say yes and the name of the change-an-answer command.

## 4. Gaps in the question script

All five gaps below are now encoded in [src/schema.js](src/schema.js), with
wording taken from the official worksheet's own column headers (extracted from
[the starter kit PDF](adult-disability-starter-kit-EN-64-110.pdf)). Tests 13
and 14 in [tests/engine-walk.js](tests/engine-walk.js) assert each one so they
cannot silently regress back out.

- [x] **Provider addresses.** Added as `address` on the provider loop.
- [x] **Medications "why you take it."** Added as `reason`, matching the
      worksheet's "Why You Take It" column.
- [x] **Provider visit dates.** Added as `first_seen` / `last_seen`, phrased to
      cover the worksheet's "or Admission Date" / "or Discharge Date" wording.
      "Still seeing them" is accepted and stores `present`.
- [x] **Job "type of business."** Added as `business_type`, with the
      worksheet's own example ("restaurant") as the spoken hint.
- [x] **Onset date.** Added as a required `onset_date` question at the end of
      the conditions section. The employment loop's prompts now anchor on it
      ("the 5 years before your condition began to limit your work") instead of
      a bare "last 5 years", which is what the worksheet actually asks.

Two things fell out of this work:

- The provider loop now has 5 columns, so the PDF renders it as stacked
  records rather than a table — that is the existing `table()` threshold at
  [src/pdf.js:123](src/pdf.js#L123) doing its job, not a regression.
- `present()` in [src/summary.js](src/summary.js) never formatted dates, so the
  printed worksheet showed `2023-05` where the spoken read-back correctly said
  "May 2023". Fixed for `date` and `monthyear`. This also cleans up the job
  start/end columns and date of birth, which had the same problem all along.

## 5. Usability improvements

- [x] **Correcting a specific answer by voice.** Done. [src/correct.js](src/correct.js)
      maps a spoken field name to a question id — labels, per-field aliases,
      loop group words ("my doctor's phone"), and ordinals ("the second
      provider's address"). `engine.setAnswer()` writes the value in place so
      a correction does not resume the forward walk, and `jumpTo()` is now
      scoped by loop id, since ids like `name` and `phone` repeat across loops.
      Matching is local and deterministic — no model call decides which answer
      gets overwritten, and it works in typing mode with no API key. When a
      phrase is genuinely ambiguous ("change my phone number", which could be a
      provider, a reference, or the landlord) it asks rather than guessing, and
      an item that does not exist ("the second provider" when there is one) is
      reported as a miss rather than silently correcting item 1. Reachable by
      voice, the `correct` command, the C key, and the review screen button.
      Covered by [tests/correct-match.js](tests/correct-match.js).
- [x] **Loop entries can be deleted.** Done. `engine.removeItem()` splices the
      item and repairs every cursor that indexes into that loop — the live one
      *and* every snapshot in the undo history — since removing an element
      renumbers the items after it and a stale `loopIndex` would otherwise let
      `back()` corrupt a different person's answers. A cursor sitting inside
      the deleted item is parked on the loop entry rather than on a
      neighbour's half-filled fields. `engine.listItems()` names items for the
      spoken prompts. `resolveDeletion()` in [src/correct.js](src/correct.js)
      matches "remove that last provider", "delete the second job", and
      "delete City Clinic" by name. Because it is destructive and cannot be
      undone, nothing is removed until an explicit yes to a prompt that names
      the entry; an unnumbered multi-item loop ("delete a provider") asks
      which, and an item number past the end refuses rather than deleting
      item 1. Works from the review screen and mid-interview — a mid-interview
      delete resumes the open question instead of jumping to the summary. The
      command needs both a removal verb and a real named group, so "they
      removed my gallbladder" stays an answer. Covered by
      [tests/delete-item.js](tests/delete-item.js).
- [x] **Progress percentage is coarse.** Done. `engine.progress()` now counts
      individual questions instead of schema nodes: a loop contributes its real
      item count times its askable fields, so the 46-node schema reads as 69
      questions on a minimal walk and 167 on one with eight providers and five
      jobs. Branches the user has closed off drop out of the total, and a loop
      not yet reached is budgeted at one item so walking into it is not a
      surprise. That makes the honest fraction dip when a ninth provider is
      added, so the *spoken* percentage is a high-water mark held in state — it
      holds still rather than retreating, which is the correct failure for
      someone who genuinely is not getting closer to the end. `rawPercent`
      carries the un-clamped value. The provider list now moves the number from
      13 to 51 percent where it used to sit still.
- [x] **Add a spoken estimate of time remaining.** Done. The engine samples the
      wall-clock gap between serving a question and receiving its answer, and
      extrapolates the median over the questions left. Measured rather than
      assumed, because a hands-free user and a fast typist differ by more than
      a factor of three. A gap longer than three minutes is discarded as a
      break rather than an answer, the last dozen samples are what count so the
      pace tracks the user rather than their first nervous minute, and nothing
      is said below four samples — two answers are not a pace. Timing is not
      persisted, so a resumed interview does not count the hours the page was
      closed as one very slow answer. `formatTimeRemaining()` in
      [src/a11y.js](src/a11y.js) buckets hard on purpose (five-minute steps
      under an hour, half-hours above); "about 23 minutes" claims a precision a
      twelve-sample median does not have. Spoken on demand via "where am I",
      offered at a section break only when the bucket has changed, and shown
      continuously in an `aria-hidden` on-screen line so a screen reader is not
      made to narrate a number that barely moved. Covered by
      [tests/progress-estimate.js](tests/progress-estimate.js).
- [x] **Re-importing a saved JSON file.** Done. `downloadJson()` had no load
      side, so a saved file was a backup and nothing more. The export is now
      `version: 2` and carries the cursor alongside the answers, which is what
      lets an unfinished interview resume on another device at the exact
      question it was left on. `answers` stays at the top level so the file is
      still readable on its own and so a version 1 file (answers only) keeps
      importing — those land on the first unanswered question instead, and the
      import says so rather than pretending it knew. [src/importer.js](src/importer.js)
      is strict about types and forgiving about shape: unknown question ids,
      wrong-typed values, and loop items that are not objects are dropped
      rather than handed to an engine that assumes its own state is well
      formed, and a cursor is trusted only if it still points at a position the
      current schema has — otherwise it is rebuilt by walking the schema. A
      file picker in the setup panel loads the file into the saved session and
      fills the resume row; it deliberately does not auto-start, because mode,
      microphone, and API key still have to be settled and the resume button
      already runs through exactly that. Covered by
      [tests/import-json.js](tests/import-json.js).

## 6. Deployment (upstream; replaced in this fork — see *Local-only fork*)

- [x] **Pick a host.** GitHub Pages, deployed by `.github/workflows/pages.yml`
      on every push to `main`. The workflow runs the tests first, then publishes
      the repo root minus tests, Markdown, and the reference starter-kit PDF.
      Pages serves over HTTPS, which `getUserMedia` requires — the mic would
      silently fail over plain HTTP.
- [x] **Add a `.gitignore`** — covers downloaded worksheets, which may carry a
      real SSN.
- [x] **Enable Pages in repo settings** — Settings → Pages → Source:
      **GitHub Actions**. The workflow cannot do this itself; until it was set,
      the deploy step failed.
