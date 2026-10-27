# Milestone 2 interview prep — Suzanne Botana (RS-01)

Child psychologist, licensed in Maine (Biddeford School Department). Family
member, so keep the session structured and take notes. Grading rewards how
honestly you sought feedback and how you used it, not how high she rates it.

## What you need to leave with

| # | Item | Notes |
|---|---|---|
| 1 | Her written feedback as a PDF | Email saved as PDF, or a signed PDF. It must be about the product, not just consent. Any format. Send it right after the session (draft below). |
| 2 | Review documentation | Recording (ask permission first; the M1 agreement doesn't cover it; max 100 MB) and/or a detailed written summary. Template: `evidence/real/RS-01/review-session-summary.md`. |
| 3 | Her answers to the open questions below | These drive the "decisions and tests it changes" in `brief.md`. |

Carried over from M1 (already in `ai-product-milestone-1-package-v1.0.0/evidence/real/RS-01/`):
signed agreement and stakeholder brief. Validation is by institutional email
(sbotana@biddefordschools.me), so no consent audio is needed.

## What changed since you last talked (tell her up front)

- **Privacy model changed.** M1 said an API key lived in the browser and
  audio went to a cloud service. The current build is local-only: Whisper runs
  on the device, the parser is deterministic (no LLM), and the browser blocks
  any request off localhost. The M1 brief's risk (2) is largely gone. Check
  that she's comfortable with that framing for families.
- **User testing already changed the product** (`feedback 9-20-26.md`):
  nine-digit SSNs were being truncated to three digits; the "is that correct?
  yes/no" step was slow for sighted users, so Space now accepts and speech is
  only needed to correct; all dates are asked month, day, year; "add another
  condition" now adds instead of replacing.
- **Android on-device port started** (`TODO.md`): core logic is ported and
  tested against goldens; the PDF writer, speech, and UI are still skeletons.
  Don't present it as working. Present it as the next step.

## Demo plan (about 10 min, then discuss)

Use the local web app (`start-mac.command`). Practice once beforehand, with the
network off, using fake data only. Never use a real SSN.

1. Setup screen: choose both forms, pick a mode, PIN.
2. Voice answers with read-back: say a few answers, accept with Space, reject one
   with N and correct it.
3. A high-stakes field: SSN or routing number read back digit by digit.
4. A loop: add two providers, then say "add another condition" on review.
5. Download the filled SSA-64-110 and Maine DS intake PDFs. Open them and show
   the addendum page for long answers.
6. Say plainly what doesn't work yet: Android app not usable, accuracy not
   measured at scale, agency acceptance unconfirmed, no hosted copy, run via a
   launcher script.

## Questions for her

Ask these in roughly this order. The bolded ones matter most for the brief.

### Need and fit
1. In your own words, what's the biggest problem families have with these two
   applications? Does this address it, or a different one?
2. Who would actually use it: the applicant, a caregiver, or you or a case
   manager? Does that match who I built it for?
3. Does asking about a person's SSN and bank number out loud feel safe and
   appropriate for the families you work with?

### Trust and accuracy
4. **If the tool mishears a digit and it ends up on the form, what's the
   consequence for a family? How would you want that caught: read-back,
   review screen, something else?**
5. Are the read-backs too slow or too repetitive? Would a family stick with
   them for ~200 answers?
6. **Would you hand the filled PDF to a family and say "check and sign this"?
   What would you need to see first?**

### Content and wording
7. Read the question wording aloud. Anything confusing, clinical, or upsetting
   for someone with an intellectual disability or a recent diagnosis?
8. Is anything missing that you routinely have to help families with
   (e.g., how to describe functional limitations, onset date, what to bring)?
9. **Is the Maine form's treatment right? Have you seen typed or addendum
   pages accepted by OADS?** (M1 risk 3: if OADS rejects typed forms, scope
   narrows to SSA plus a printable worksheet.)
10. SSA's form asks about work in the five years before onset. Do families
    know their onset date, and does the question help them find it?

### Accessibility and real use
11. Which users would struggle most (blind, low vision, motor, intellectual
    disability, limited English, no computer)? Is a launcher-on-a-laptop
    realistic, or is a phone app the only workable form?
12. Would a family use this alone, or only with help? What help?
13. **What would stop you from recommending it?**

### Scope and priorities
14. If I can only fix one thing before the final, which should it be?
15. Of Android app, accuracy testing, agency confirmation, and more
    languages, which matters most to you?
16. What can't you judge from this demo?

### Close
17. What's the one thing to preserve, and the one thing generic, unnecessary,
    or poorly matched to your need? (This is the form's optional comment.)
18. May I record? May I quote you in the brief? Can you email feedback today
    or tomorrow, in any format?

## Session notes — 10-25-26 (25 min, recorded; from transcript)

Source: `assignment-info/ai-product-milestone-2-package/ece 570 interview with
suzanne botana 10-25-26.docx`. Full account in
`evidence/real/RS-01/review-session-summary.md`. No live demo happened; she
evaluated the earlier hosted web version, not the offline build.

| Q | Her answer (paraphrased) |
|---|---|
| 1 | Benefits access is complex. A walkthrough ending in a finished form makes completing it, and completing it accurately, more likely. Two forms with reused info is a plus. |
| 2 | Applicants who can understand and speak can go alone. Others need a caregiver. She sometimes facilitates at the table. Case managers will like it. Matches who it was built for. |
| 3 | Fine. Families already share sensitive medical details; SSN/bank number are no more sensitive. She tells them to say "1-2-3-4-5" and fix it on the PDF. Offline matters for medical info too. |
| 4 | Read-back plus on-screen confirmation of every answer is right. Medical-term transcription is accurate and fast, better than Siri. She didn't describe a specific consequence of a wrong digit. |
| 5 | Can be slow or repetitive. Offer text-or-spoken read-back, and an option to not hear every prompt. |
| 6 | Yes: print it and give it to the family, since only SSN/bank get changed and the PDF matches what was reviewed on screen. |
| 7 | Questions fine. Unclear whether to answer per condition (it doesn't matter). Add an intro saying to list everything together. |
| 8 | Nothing missing. Idea: carry the previous medical source (name, address, phone) forward until a new one is named. |
| 9 | Limited Maine-form experience; working with a family now. Expects good flow, no new comments. OADS acceptance of typed/addendum pages **not asked**. |
| 10 | **Not asked.** |
| 11 | Low reading/writing, low vision, low motor benefit most. Intellectual disability: via case manager. Also ADHD. Low-tech/paper-preferring people: still encourage trying. |
| 12 | Partly covered (case manager/caregiver help). Not asked directly. |
| 13 | **Not asked.** |
| 14 | **Not asked.** |
| 15 | Languages came up: yes, start with Lingala (French readers); spoken read-back for languages families can't read. She'll send more languages. |
| 16 | **Not asked.** Did not judge the offline/Android builds or Maine form. |
| 17–18 | Close: she agreed to email feedback today or tomorrow. Quote permission not captured. |

Changes to consider for `brief.md`: optional/lighter read-backs (text or spoken);
intro explaining the form structure; carry-forward of source; Lingala/French
with spoken read-back; take offline scope to all health data.

Follow-ups: confirm recording and quote permission in her email; ask the
unasked questions (10, 13, 14, OADS) in the email or a quick call; she'll send
other languages.

## Technique notes
- Ask her to say it back in her own words rather than answering yes/no.
- Write down disagreement and uncertainty, including where you aren't sure
  what she meant. Note what she couldn't judge.
- Don't defend the product during the session; clarify and log.
- Don't coach her ratings or wording in the feedback email.

## Draft feedback request (send within a day)

> Subject: Feedback on the Disability Forms Assistant
>
> Hi Suzanne, thank you for reviewing the assistant today. For my course I
> need your feedback in your own words, as a reply to this email or in a
> document you sign. A few sentences is fine. It would help most if you cover:
> what's useful, what isn't, what I should change, the most important thing to
> improve or preserve, and anything generic, unclear, or poorly matched to
> your need. You don't need to judge the AI or code. If you like, you can
> also rate these from 1 (strongly disagree) to 5 (strongly agree), or N if you
> can't judge: SR-1 it addresses the need we discussed; SR-2 you or your
> organization would use or benefit from a successful version; SR-3 it is
> useful or promising now; SR-4 I understood and responded to your feedback;
> SR-5 it feels specifically designed for this need rather than generic; SR-6
> you understand its limits and next steps. Ratings don't affect my grade.
> Thank you!

## After the session checklist
1. Same day: fill in the review-session summary from your notes.
2. Get her feedback email; save as PDF (selectable text) to
   `evidence/real/RS-01/stakeholder-feedback.pdf`.
3. Copy M1's `signed-stakeholder-agreement.pdf` and `stakeholder-brief.pdf`
   into `evidence/real/RS-01/`.
4. Rewrite `brief.md` (two headings only) with the feedback synthesis: most
   consequential feedback, disagreement or uncertainty, what you learned,
   decisions and tests it changes.
5. Fill `supporting/prototype/README.md` (how to run via launcher, what to
   try, limitations) and `submission.yaml` (use `examples/submission-real.yaml`
   as the model; set `recording_file` null if using only a summary).
6. Run `python guide_submission.py status`, then `python package_submission.py`.
   You personally confirm the attestations.
