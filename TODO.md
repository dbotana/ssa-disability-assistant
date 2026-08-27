# Next steps

Status: the site is complete and works end to end. Everything below is either
verification that still needs a human, a known limitation, or an improvement.

Ordered roughly by what would block real use.

---

## 1. Verification that still needs a human

Nothing here has been tested with a real microphone, a real API key, or a real
screen reader. These are the highest-value next actions.

- [ ] **Full voice pass with a real key, screen off.** Confirm push-to-talk,
      the SSN digit read-back, a mid-interview "go back", and the PDF download
      all work by ear alone. This is the actual acceptance test.
- [ ] **Hands-free silence detection tuning.** The threshold in
      [src/audio.js](src/audio.js) (`SPEECH = 0.045`, 1200ms) is a guess. It has
      never run against a real mic. Expect to tune it — too low and background
      noise holds the recorder open, too high and it cuts off quiet speakers.
      Test in a noisy room.
- [ ] **VoiceOver pass** (<kbd>Cmd-F5</kbd>). Verify every state change is
      announced exactly once, nothing is announced twice, and no announcement
      clobbers another mid-sentence.
- [ ] **Safari and Chrome recording.** The mime negotiation in
      [src/audio.js](src/audio.js#L15-L27) handles both in theory; only Chrome's
      path has been reasoned through. Safari produces `audio/mp4` — confirm the
      transcription endpoint accepts what we send it.
- [ ] **Transcription accuracy on digits.** Say a 9-digit SSN naturally and
      one digit at a time. If accuracy is poor, the `hintFor()` prompts in
      [src/llm.js](src/llm.js) are the first thing to adjust.

## 2. Known gaps in the question script — CLOSED

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

## 3. Security — before this goes near real claimants

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

## 4. Usability improvements

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
- [ ] **No way to re-import a saved JSON file.** `downloadJson()` exists; the
      load side doesn't. Useful for resuming on a different device.
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
- [ ] **Progress percentage is coarse.** Loops count as one unit regardless of
      how many items they hold, so the percentage stalls during a long provider
      list. Deliberate — a percentage that jumps backward is worse — but worth
      revisiting.
- [ ] **Add a spoken estimate of time remaining**, which is more useful than a
      percentage when the interview is this long.

## 5. Testing

- [ ] **Add browser-level tests.** The three end-to-end runs used during the
      build were scratch scripts against a DOM shim and weren't kept. Playwright
      would make them permanent, at the cost of adding a dev dependency to a
      site that currently has none.
- [ ] **Test the error recovery paths.** Expired key mid-interview, mic revoked
      mid-interview, offline mid-interview. Each has a spoken recovery path in
      `handleLlmError()` — none has been exercised against a real failure.
- [ ] **Test with a very long answer set** — 20 providers, 15 jobs — to confirm
      PDF pagination holds up beyond the 12-provider case that was checked.

## 6. Deployment

- [ ] **Pick a host.** Any static host works (GitHub Pages, Netlify). Note that
      `getUserMedia` requires HTTPS or localhost — the mic will silently fail
      over plain HTTP.
- [ ] **Add a `.gitignore`** — nothing needs ignoring yet, but a stray
      downloaded worksheet with a real SSN in the repo would be bad.
- [ ] **Nothing is committed yet.** The repo still has no commits.
