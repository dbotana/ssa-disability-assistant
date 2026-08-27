# Voice Assistant for Social Security Disability Prep

A single static website that lets a blind user prepare a Social Security
disability application entirely by voice. A conversational assistant works
through the full question script, then produces a PDF worksheet and an
accessible summary to bring to ssa.gov/apply or an SSA appointment.

This is a **preparation worksheet**. It is not an application, and it never
sends anything to the Social Security Administration.

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

Typing mode with no key is the offline path: answers are parsed and validated
locally, and the browser's built-in voice reads questions aloud. Everything
except speech recognition works without an API key.

### Say at any time

`repeat that` · `go back` · `skip this` · `where am I` · `read back my answers`
· `save and quit` · `start over`

Keyboard equivalents: <kbd>Enter</kbd> repeat, <kbd>B</kbd> back, <kbd>S</kbd>
skip, <kbd>W</kbd> where, <kbd>R</kbd> read back, <kbd>H</kbd> toggle hands
free, <kbd>T</kbd> typing mode, <kbd>Esc</kbd> cancel recording.

## Privacy, and a real limitation

Everything runs in the browser. Answers are stored in `localStorage` on the
device and are never uploaded. The API key is held in `sessionStorage` and
erased when the tab closes.

**This design is appropriate for personal use, not for real claimants.** With
no backend, the API key lives in the browser, and this form collects Social
Security numbers and bank account numbers. A shared computer, a malicious
extension, or an XSS bug would expose both. Before putting this in front of
actual applicants, move the key to a small server that mints short-lived
tokens. Users can say `skip` at any sensitive question and fill those fields in
by hand.

## How it works

The model does **not** conduct the interview. `engine.js` owns all control flow
from a declarative schema; per turn, the model does one narrow job — turn a
transcript into a typed value for one known question. A chat agent handed the
whole script drifts, invents follow-ups, and silently skips questions, with
nowhere to hook validation. Every extracted value is also re-validated locally,
so a malformed SSN triggers a re-ask rather than landing on the worksheet.

High-stakes fields (SSN, routing and account numbers, dates) are read back
digit by digit and require confirmation before they are committed.

### Files

| File | Responsibility |
|---|---|
| `src/schema.js` | The entire interview as data: sections, types, `askIf` skips, loop groups |
| `src/engine.js` | State machine — advance, branch, loop, skip, back, `jumpTo` |
| `src/main.js` | Turn loop, keyboard, commands, error recovery, export |
| `src/llm.js` | Transcription, structured extraction, TTS, local validation |
| `src/audio.js` | Mic capture, silence detection, earcons |
| `src/speech.js` | TTS queue with `SpeechSynthesis` fallback |
| `src/a11y.js` | Live-region announcements, digit read-back formatting |
| `src/store.js` | `localStorage` persistence and resume |
| `src/pdf.js` | Generated worksheet PDF (pdf-lib) |
| `src/summary.js` | Accessible HTML summary, JSON export |

### Why the PDF is generated rather than filled

The official `adult-disability-starter-kit-EN-64-110.pdf` has **no fillable
form fields** — it is flat artwork with drawn table borders. There is nothing
to fill. Stamping text at measured coordinates would also break as soon as
someone has more providers or jobs than the printed rows allow. Instead the app
generates a clean document mirroring the kit's section structure, which
paginates to fit any number of entries and repeats table headers across page
breaks. Loops too wide for a legible table (jobs, marriages) render as stacked
records instead of shredding their headers into fragments.

## Deployment

Hosted on GitHub Pages at
<https://dbotana.github.io/ssa-disability-assistant/>.

Every push to `main` triggers `.github/workflows/pages.yml`, which runs the
tests and then publishes the site. There is no build step — the workflow copies
the repo root and drops what should not be served (tests, Markdown, the
reference starter-kit PDF).

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
```

None of them make an API call. Between them they cover multi-item loops,
`askIf` branches inside loop items, `back()` discarding a speculatively-opened
item, `jumpTo` into a specific loop index, save/resume round-trips, a throwing
`askIf` not stranding the interview, and the guarantee that the spoken
percentage never runs backward however many items a loop collects.

For an end-to-end check without spending API credits, run the site and use
typing mode with the key field left blank.
