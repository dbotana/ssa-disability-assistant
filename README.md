# Voice Assistant for Disability Forms — local-only fork

A voice assistant that lets a blind user fill out disability paperwork
entirely by voice, **without anything they say leaving their computer**.
Speech is transcribed on the device by a Whisper model that ships with the
project, answers are read by a local parser, and the page is served from the
user's own disk. No API key, no account, no cloud speech service.

This is a fork of
[ssa-disability-assistant](https://github.com/dbotana/ssa-disability-assistant),
which sends each recording to OpenAI (or, optionally, to Google or Apple) to
be transcribed. That is a reasonable trade for a demo and the wrong one for a
form that asks for a Social Security number out loud. See
[Privacy](#privacy-what-leaves-the-computer-and-what-does-not).

It handles two forms:

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

### Run it on your own computer

Download the project, then double-click the launcher for your system:

| System | File |
|---|---|
| macOS | `start-mac.command` |
| Windows | `start-windows.bat` |
| Linux | `start-linux.sh` |

A terminal window opens, prints a `http://localhost:...` address, and opens
your browser there. Chrome, Edge, Firefox and Safari all work. Leave that window open while you use the assistant, and
press Control-C in it when you are finished.

The launchers need either Python 3 or Node, and use whichever they find. macOS
and most Linux systems already have Python. On Windows you will probably need
<https://www.python.org/downloads/>; tick **Add python.exe to PATH** in the
installer.

> On macOS, a launcher downloaded from the internet may be blocked the first
> time with a warning about an unidentified developer. Right-click
> `start-mac.command`, choose **Open**, then confirm. This is only needed once.

### Run it from a terminal

```bash
python3 tools/serve.py     # or: node tools/serve.mjs
```

Both serve the project on the first free port at or after 8000, bound to
`127.0.0.1` so nothing is reachable from the rest of the network, and open a
browser for you.

Opening `index.html` by double-clicking it does **not** work. The app is built
from ES modules, which browsers refuse to load over `file://`, and it fetches
the blank PDF templates, which `file://` also blocks. Both need a real HTTP
origin, which is all the launchers provide.

Whichever way you run it, choose an input mode and start. The speech model
loads from disk in a second or two; the first time, on a slow machine, it can
take longer, and the setup screen shows its progress.

There is deliberately no hosted copy. A page served from someone else's
server is a page that server can change, and one changed page is enough to
send every answer somewhere else. Running the files on your own disk removes
that party.

## Input modes

| Mode | How it works |
|---|---|
| **Voice** | Hold <kbd>Space</kbd> while answering, release to send |
| **Hands free** | The assistant starts listening after each question and stops on ~1.2s of silence |
| **Typing** | Type answers instead |

The mode chooses how the interview *starts*, not what stays available. Both
lanes are live on every question: the hold-to-talk button and the text box are
always on screen, and answering with one does not close the other. Type one
answer and speak the next; the microphone is requested lazily on the first
press, so even a typing-mode session can pick up voice partway through. Only a
microphone that has actually failed — permission denied, no device, or a
browser that cannot run the speech model — closes the voice lane, and it says
so when it does.

<kbd>T</kbd> puts the cursor in the text box, <kbd>Esc</kbd> leaves it so the
space bar talks again.

Every mode works with the network unplugged. Nothing about the interview —
speaking, listening, parsing, filling the PDFs — needs a connection.

### Every spoken answer is read back

After each voice answer the assistant repeats what it heard, verbatim, and
waits to be told whether it got it right. Tapping <kbd>Space</kbd> (or
<kbd>Enter</kbd>, or the **Yes, that's right** button) keeps it;
<kbd>N</kbd> or <kbd>Esc</kbd> throws it away and reopens the same question
*without re-reading the prompt* — the user just heard it, and repeating it
before every retry is what makes a misheard answer feel expensive. Saying
`yes` or `no`, or typing them, does the same thing.

The keystroke matters more than it looks: user testing found that having to
*say* "yes" after every single answer is what made the interview feel slow to
anyone who could read the screen. Speaking is now only required to correct an
answer, never to accept one.

Someone who would rather not hear each answer twice can turn off **Read each
answer back** on the setup screen. The `confirm` fields ignore that setting and
are always read back, because that read-back is what catches a wrong digit in
a Social Security or bank account number.

Two turns are exempt, because they already confirm themselves: commands
(`skip`, `go back`) and the high-stakes fields marked `confirm` — SSN, routing
and account numbers, dates of birth — which instead get the stronger read-back
of the *parsed value*, spoken digit by digit.

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
text box, leave it and hand the space bar back to voice. While an answer is
being read back those keys step aside for <kbd>Space</kbd>/<kbd>Enter</kbd> to
keep it and <kbd>N</kbd>/<kbd>Esc</kbd> to answer again.

From the review screen, `change my phone number` edits an answer in place,
`add another condition` starts a new entry on a list, and `remove the second
provider` deletes one.

### Dates and digit strings

Every date question asks for the month, then the day, then the year, and says
so out loud; the parser reads that order, the reverse of it, slashed US dates,
and numbers spoken as words (`March fourteenth, nineteen seventy nine`).

Nine spoken digits are not one utterance. A Social Security number read with a
pause between groups used to end the capture at the first pause and record
only the first three digits. Two things now prevent that. Digit fields get a
three-second silence window in hands-free mode, and Whisper transcribes the
whole recording at once rather than finalizing on the first pause. A
transcript that still does not have the right number of digits — the gate
asks `normalize()` — is asked again rather than read back.

## Privacy: what leaves the computer, and what does not

**Nothing you say or type is sent anywhere.** Specifically:

- **Speech to text** runs in the page, in a Web Worker, using Whisper
  (`models/whisper-base.en`, about 77 MB, committed to this repository) on
  onnxruntime's WebAssembly backend (`vendor/transformers/`). The recording
  is decoded, transcribed and discarded in memory.
- **Understanding the answer** is done by `src/parse.js`, a deterministic
  parser. There is no language model. If it cannot read an answer with
  certainty, it asks again.
- **Speaking** uses pre-recorded clips of the fixed questions (`audio/`), and
  for anything containing your answer, an on-device system voice. Chrome
  also offers "Google" voices that are synthesized on Google's servers; the
  app refuses any voice the browser does not report as local, because a
  read-back of your SSN would otherwise go to Google.
- **The browser enforces it.** `index.html` and both local servers set a
  Content-Security-Policy whose `connect-src` is `'self'`: the page and its
  worker can make requests only to the localhost server that served them.
  Even a bug, or a script that should not be there, cannot upload anything.
  `tests/no-network.js` fails CI if any of this regresses.
- **The servers** (`tools/serve.py`, `tools/serve.mjs`) bind to `127.0.0.1`
  only, so nothing is reachable from the rest of the network.

What this does **not** protect against:

- **Answers are stored in plain text** in the browser's `localStorage` so an
  unfinished interview can be resumed. That includes the SSN and bank
  numbers. Anyone who can use this browser profile can read them. Use
  **Erase everything** when you finish, and do not use a shared computer.
- **The downloaded PDFs contain your answers**, SSN included. Treat them like
  the paper forms.
- **Browser extensions** with access to all sites can read the page. Use a
  browser profile without extensions you do not trust.

Users can say `skip` at any sensitive question and fill those fields in by
hand.

## Regenerating the spoken audio

The interview script is fixed, so every question, warning, and section header
is synthesized once, by a maintainer, into `audio/`, and played from disk.

```sh
OPENAI_API_KEY=sk-... node tools/build-audio.mjs
```

This is the only step anywhere in the project that calls a cloud API, and it
never handles a user's data: its input is the fixed script in `schema.js` and
`phrases.js`, which is public in this repository. Skipping it is harmless —
a string with no clip is read by the system voice instead.

Only clips that are missing get synthesized, so editing one prompt costs one
clip. Add `--prune` to delete clips nothing references any more, or `--dry-run`
to see what would be generated. Commit the result: `tests/audio-manifest.js`
fails if a spoken string has no clip, which is what catches a prompt edited
without a rebuild.

Anything containing a user's answer — read-backs, the summary — is spoken at
runtime by an on-device voice, and never recorded or cached.

## How it works

`engine.js` owns all control flow from a declarative schema. Per turn, the
recording is transcribed on the device (`localstt.js` → `whisper-worker.js`),
the transcript is read by `parse.js` into a typed value for one known
question, and `validate.js` checks it before anything is kept. A value that
does not fit — eight digits for an SSN — is a re-ask, never a guess.

High-stakes fields (SSN, routing and account numbers, dates) are read back
digit by digit and require confirmation before they are committed.

### Files

| File | Responsibility |
|---|---|
| `src/schema.js` | The entire interview as data: sections, form tags, types, `askIf` skips, loop groups |
| `src/engine.js` | State machine — advance, branch, loop, skip, back, `jumpTo`, `rewalk` |
| `src/choice.js` | Multiple-choice matching (which form, the A–E scale, pay frequency) |
| `src/main.js` | Turn loop, keyboard, commands, error recovery, export |
| `src/localstt.js` | On-device speech to text: decode, resample, hand to the worker |
| `src/whisper-worker.js` | Whisper in a Web Worker; never fetches a model or runtime remotely |
| `src/parse.js` | Transcript → typed value for one question, or null to ask again |
| `src/validate.js` | The final shape check on every value before it is kept |
| `src/audio.js` | Mic capture, silence detection, earcons |
| `src/speech.js` | Pre-recorded clips, then on-device system voices only |
| `src/a11y.js` | Live-region announcements, digit read-back formatting |
| `src/store.js` | `localStorage` persistence and resume |
| `src/fill.js` | Fills an official PDF form, fits text to its boxes, adds addendum pages |
| `src/forms/*.js` | Answers → field names for each form; shared cell formatting |
| `src/pdf.js` | Page layout for addenda and the fallback worksheet (pdf-lib) |
| `forms/*.pdf` | The official blank forms the app fills in |
| `models/` | The Whisper model, with `SHA256SUMS` |
| `vendor/transformers/` | transformers.js and onnxruntime-web, with `VERSIONS.txt` |
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

## Updating the model or runtime

Both are committed, pinned, and checked by `tests/vendor-integrity.js`
against recorded SHA-256 hashes, because both run with access to every
spoken answer.

- **Model:** `node tools/fetch-model.mjs [onnx-community/whisper-small.en]`
  downloads the q8 weights at a pinned revision, checks them against the
  hashes Hugging Face publishes, and writes `models/<name>/SHA256SUMS`. To
  switch, change `MODEL` in `src/whisper-worker.js`. Measure first with
  `tools/stt-eval.mjs`; small.en is about 250 MB and noticeably slower.
- **Runtime:** copy `transformers.min.js` and the two
  `ort-wasm-simd-threaded.jsep.*` files from the `@huggingface/transformers`
  npm package's `dist/` into `vendor/transformers/`, then regenerate
  `VERSIONS.txt` with `shasum -a 256`.

CI (`.github/workflows/ci.yml`) runs the tests on every push. Nothing is
deployed.

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
node tests/add-item.js           # adding a loop entry without overwriting one
node tests/digit-gate.js         # a truncated SSN is asked again, not read back
node tests/audio-manifest.js     # every spoken string has a clip
node tests/local-stt.js          # the on-device transcriber settles, and silence is not an answer
node tests/no-network.js         # no network path in src/, and the CSP that enforces it
node tests/vendor-integrity.js   # the model and runtime are the pinned bytes
```

Three maintainer tools reach what `tests/` cannot:

- `node tools/stt-eval.mjs` runs the real model over the recordings in
  `tests/fixtures/speech/` and reports how many produce exactly the right
  value after parsing — the number that matters for an SSN. Needs
  `cd tools && npm install` once (transformers.js for Node).
- `tools/browser-check.html`, opened from a running local server, checks in a
  real browser that the page is cross-origin isolated, that a remote fetch is
  refused, and that a clip transcribes both from WAV and after a round trip
  through the browser's own `MediaRecorder`.

`tools/smoke.mjs` is separate and not run by CI. It boots `main.js` against a
stub DOM and drives a real interview — the read-back keys, a `confirm` field,
and adding a condition from the review prompt — which is the wiring no test in
`tests/` reaches. Run it by hand after touching the turn loop; it stubs the DOM
by hand, so an ordinary edit to `index.html` can break it without anything
being wrong with the app.

None of them make a network request. Between them they cover multi-item loops,
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

For an end-to-end check, run the site with the network off and answer a few
questions by voice. In the browser's developer tools, the Network panel
should show nothing but `localhost`.
