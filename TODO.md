# Next steps

Status: the site is complete and works end to end. Everything still open is
either verification that needs a human, a known limitation, or an improvement.

Open items come first, ordered roughly by what would block real use. Closed
items are kept below with the detail of what was actually done, so a later
change can tell whether it is undoing a decision or fixing an oversight.

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
- [ ] **Safari and Chrome recording.** The mime negotiation in
      [src/audio.js](src/audio.js#L15-L27) handles both in theory; only Chrome's
      path has been reasoned through and exercised. Safari produces
      `audio/mp4` — confirm the transcription endpoint accepts what we send it.
- [ ] **Transcription accuracy on digits.** Say a 9-digit SSN naturally and
      one digit at a time. If accuracy is poor, the `hintFor()` prompts in
      [src/llm.js](src/llm.js) are the first thing to adjust.
- [ ] **Re-tune the filler list against a real room.** `FILLER_TRANSCRIPTS` in
      [src/main.js](src/main.js) is the set of phrases a transcriber invents
      when handed silence, and it was written from what these models are known
      to emit rather than from logs of this app. If a genuine quiet answer ever
      gets refused as filler, that list and `QUIET_PEAK` are where to look.

## 2. Security — before this goes near real claimants

- [ ] **Move the API key server-side.** The single most important change. A
      small token-minting backend removes the key from the browser entirely.
      Until then this is a personal-use tool. See the README's privacy section.
- [ ] **Decide whether SSN and bank numbers belong in `localStorage` at all.**
      Right now the saved-session blob contains them in plain text. An option to
      resume *without* persisting sensitive fields would be a reasonable middle
      ground.
- [ ] **Consider redacting sensitive fields from the PDF by default**, with an
      explicit opt-in to include them. Someone will email this file to
      themselves.

## 3. Testing

- [ ] **Add browser-level tests.** The three end-to-end runs used during the
      build were scratch scripts against a DOM shim and weren't kept. Playwright
      would make them permanent, at the cost of adding a dev dependency to a
      site that currently has none.
- [ ] **Test the error recovery paths.** Expired key mid-interview, mic revoked
      mid-interview, offline mid-interview. Each has a spoken recovery path in
      `handleLlmError()` — none has been exercised against a real failure.
- [ ] **Test with a very long answer set** — 20 providers, 15 jobs — to confirm
      PDF pagination holds up beyond the 12-provider case that was checked.

---

# Closed

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

## 6. Deployment

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
