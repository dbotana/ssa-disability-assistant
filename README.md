# Voice Assistant for Disability Forms

A single static website that lets a blind user fill out disability paperwork
entirely by voice. It handles two forms:

- **Social Security's Adult Disability Starter Kit** (SSA-64-110): the
  checklist and worksheet you bring to ssa.gov/apply or an SSA appointment.
- **Maine DHHS's Developmental Services Intake Application**: how adults with
  an intellectual disability or autism apply for services from Maine's Office
  of Aging and Disability Services.

The first question asks which form you are filling out: one, the other, or
both. The interview then asks each shared question once, and asks
form-specific questions only for the forms you chose. At the end it downloads
the **official PDF of each form, filled in**, plus an accessible on-screen
summary.

It never sends anything to the Social Security Administration or to Maine
DHHS. You review, sign, and send the forms yourself.

## Running it

No build step, no dependencies to install.

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Paste an OpenAI API key on the setup screen, choose an input mode, and start.

## Input modes

| Mode | How it works |
|---|---|
| **Voice** | Hold <kbd>Space</kbd> while answering, release to send |
| **Hands free** | The assistant starts listening after each question and stops on ~1.2s of silence |
| **Typing** | Type answers instead — works with no API key at all |

The mode chooses how the interview *starts*, not what stays available. Both
lanes are live on every question: the hold-to-talk button and the text box are
always on screen, and answering with one does not close the other. Type one
answer and speak the next; the microphone is requested lazily on the first
press, so even a typing-mode session can pick up voice partway through. Only a
microphone that has actually failed — permission denied, no device, or a
rejected API key — closes the voice lane, and it says so when it does.

<kbd>T</kbd> puts the cursor in the text box, <kbd>Esc</kbd> leaves it so the
space bar talks again.

Typing mode with no key is the offline path: answers are parsed and validated
locally, and the browser's built-in voice reads questions aloud. Everything
except speech recognition works without an API key.

### Every spoken answer is read back

After each voice answer the assistant repeats what it heard, verbatim, and
waits for a spoken `yes` or `no`. `yes` accepts it and moves on. `no` throws it
away and reopens the same question *without re-reading the prompt* — the user
just heard it, and repeating it before every retry is what makes a misheard
answer feel expensive. The read-back can be answered by typing too.

Two turns are exempt, because they already confirm themselves: commands
(`skip`, `go back`) and the high-stakes fields marked `confirm` — SSN, routing
and account numbers — which instead get the stronger read-back of the *parsed
value*, spoken digit by digit.

A capture with no speech in it never reaches this point. The level meter runs
for push-to-talk as well as hands free, and a capture that stayed at the noise
floor, ran under 350ms, or came back as transcriber filler is refused and the
question asked again. Before this, tapping the space bar without speaking sent
room tone to be transcribed — and a transcriber handed silence returns a short
invented phrase, not nothing, which was then recorded as the answer.

### Say at any time

`repeat that` · `go back` · `skip this` · `where am I` · `read back my answers`
· `save and quit` · `start over`

Keyboard equivalents: <kbd>Enter</kbd> repeat, <kbd>B</kbd> back, <kbd>S</kbd>
skip, <kbd>W</kbd> where, <kbd>R</kbd> read back, <kbd>H</kbd> toggle hands
free, <kbd>T</kbd> type, <kbd>Esc</kbd> cancel a recording — or, from inside the
text box, leave it and hand the space bar back to voice.

## Privacy, and a real limitation

Everything runs in the browser. Answers are stored in `localStorage` on the
device, and nothing is ever sent to the Social Security Administration. The API
key is held in `sessionStorage` and erased when the tab closes.

Audio is a separate question from stored answers. In voice modes the recording
of each answer is sent somewhere to be turned into text:

- **To OpenAI**, by default, using your key.
- **To your browser's maker** — Google in Chrome and Edge, Apple in Safari — if
  you tick *use my browser's speech recognition*. It is faster and does not
  spend your key, but it is a third party you did not otherwise choose, so it
  is off unless you turn it on. Spoken answers to the Social Security and bank
  number questions are re-sent to OpenAI when the browser's transcript is not
  cleanly a number of the expected shape.

Typing mode sends no audio anywhere, and works with no API key at all.

**This design is appropriate for personal use, not for real claimants.** With
no backend, the API key lives in the browser, and this form collects Social
Security numbers and bank account numbers. A shared computer, a malicious
extension, or an XSS bug would expose both. Before putting this in front of
actual applicants, move the key to a small server that mints short-lived
tokens. Users can say `skip` at any sensitive question and fill those fields in
by hand.

## Regenerating the spoken audio

The interview script is fixed, so every question, warning, and section header
is synthesized once at build time into `audio/` and served as a static file.
That is most of what the app says, so most of what it says costs nothing to
say, works offline, and works with no API key at all.

```sh
OPENAI_API_KEY=sk-... node tools/build-audio.mjs
```

Only clips that are missing get synthesized, so editing one prompt costs one
clip. Add `--prune` to delete clips nothing references any more, or `--dry-run`
to see what would be generated. Commit the result: `tests/audio-manifest.js`
fails if a spoken string has no clip, which is what catches a prompt edited
without a rebuild.

Anything containing a user's answer — read-backs, the summary — is synthesized
at runtime and cached in the browser instead.

## How it works

The model does **not** conduct the interview. `engine.js` owns all control flow
from a declarative schema; per turn, the model does one narrow job — turn a
transcript into a typed value for one known question. A chat agent handed the
whole script drifts, invents follow-ups, and silently skips questions, with
nowhere to hook validation. Every extracted value is also re-validated locally,
so a malformed SSN triggers a re-ask rather than landing on a form.

High-stakes fields (SSN, routing and account numbers, dates) are read back
digit by digit and require confirmation before they are committed.

### Files

| File | Responsibility |
|---|---|
| `src/schema.js` | The entire interview as data: sections, form tags, types, `askIf` skips, loop groups |
| `src/engine.js` | State machine — advance, branch, loop, skip, back, `jumpTo`, `rewalk` |
| `src/choice.js` | Multiple-choice matching (which form, the A–E scale, pay frequency) |
| `src/main.js` | Turn loop, keyboard, commands, error recovery, export |
| `src/llm.js` | Transcription, structured extraction, TTS, local validation |
| `src/audio.js` | Mic capture, silence detection, earcons |
| `src/speech.js` | TTS queue with `SpeechSynthesis` fallback |
| `src/a11y.js` | Live-region announcements, digit read-back formatting |
| `src/store.js` | `localStorage` persistence and resume |
| `src/fill.js` | Fills an official PDF form, fits text to its boxes, adds addendum pages |
| `src/forms/*.js` | Answers → field names for each form; shared cell formatting |
| `src/pdf.js` | Page layout for addenda and the fallback worksheet (pdf-lib) |
| `forms/*.pdf` | The official blank forms the app fills in |
| `src/summary.js` | Accessible HTML summary, JSON export |
| `src/importer.js` | Reading a saved JSON file back in |

### One interview, two forms

Every section and question in `src/schema.js` is tagged with the forms it
belongs to (`forms: ['ssa']`, `['ds']`, or both). The engine asks a question
only when it belongs to a chosen form and its `askIf` holds; a loop can be
skipped whole the same way. Sections are numbered among the ones the chosen
forms use, so "section 4 of 19" is honest whichever form it is.

Where the forms want the same fact, it is asked once, in the Starter Kit's
words, and the DS form derives its value: marital status from the marriage
history, diagnoses from the conditions list, employment history from the job
list. The DS-only versions of those questions are asked only when the Starter
Kit is not being filled out.

The DS form's daily-living sections (7–12) rate 26 activities on its A–E
scale. Each is a `choice` question; the scale is spoken once per section, and
an explanation is asked only when the answer is not A, Independent.

Choosing differently later ("change my form to both") re-walks the interview
to the first question the new choice adds, and skips over everything already
answered.

### Filling the official forms

Both official PDFs, in `forms/`, are fillable AcroForms, so the download is
the agency's own document with the answers typed in (`src/fill.js`), not a
look-alike:

- The Starter Kit has fields for its checklist and worksheet sections A–E.
  Checklist boxes are ticked for what the interview collected. Everything the
  checklist asks you to have ready but the kit has nowhere to write
  (identity, marriages, bank details, and so on) goes on addendum pages
  appended to the kit.
- The DS Intake Application has a field for every blank. Signature lines and
  signature dates are left empty for ink.

Boxes are fixed in size and answers are not. Each answer is shrunk to fit its
box, down to 7pt. Anything still too long is cut short with "(see attached)"
and written out in full on an addendum page, as are table rows past the
printed capacity (a sixth doctor). Fields stay editable, so a caregiver can
fix a typo in any PDF reader.

The field names come from the PDFs themselves, and two of them are traps.
`tests/form-fill.js` fills every field of both real templates and reads them
back, which is what catches them:

- The Starter Kit's first table rows are named after the instruction text
  above them, cut at 100 characters.
- On the DS form, section 10's rows are wired to fields named after section
  11's rows (`LetterFamily` is Shopping), and section 11 uses the `_2` names.

If a template cannot be fetched (offline, or the page opened from disk), a
plain worksheet of the same answers is downloaded instead.

## Deployment

Hosted on GitHub Pages at
<https://dbotana.github.io/ssa-disability-assistant/>.

Every push to `main` triggers `.github/workflows/pages.yml`, which runs the
tests and then publishes the site. There is no build step — the workflow copies
the repo root and drops what should not be served (tests, tools, Markdown).
The blank official forms in `forms/` are published, because they are the
templates the app fills in.

All asset paths are relative, so the site works unchanged from the
`/ssa-disability-assistant/` subpath. HTTPS matters here beyond the usual
reasons: `getUserMedia` is unavailable over plain HTTP, so the mic would fail
silently on a non-TLS host.

One-time setup, which the workflow cannot do for itself: in the repository's
**Settings → Pages**, set **Source** to **GitHub Actions**.

## Testing

```bash
node tests/engine-walk.js        # control flow
node tests/correct-match.js      # spoken field matching
node tests/delete-item.js        # loop entry removal
node tests/progress-estimate.js  # progress counting and time remaining
node tests/import-json.js        # re-importing a saved answers file
node tests/empty-transcript.js   # a silent capture never becomes an answer
node tests/form-routing.js       # which questions each form choice asks
node tests/form-fill.js          # filling both real PDFs and reading them back
node tests/parse-local.js        # local parsing, including multiple choice
```

None of them make an API call. Between them they cover multi-item loops,
`askIf` branches inside loop items, `back()` discarding a speculatively-opened
item, `jumpTo` into a specific loop index, save/resume round-trips, a throwing
`askIf` not stranding the interview, and the guarantee that the spoken
percentage never runs backward however many items a loop collects, and that a
saved answers file re-imports to the exact question it was left on — or, for a
file written before the cursor was recorded, to the first unanswered one.
`empty-transcript.js` covers the one failure that loses data silently: a
recorder handed silence produces a short invented phrase rather than nothing,
and without the filter that phrase is committed as the answer and the form
moves on.

For an end-to-end check without spending API credits, run the site and use
typing mode with the key field left blank.
