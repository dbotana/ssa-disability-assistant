# AI Product Milestone 1 Package

Milestone 1 frames a potentially valuable problem, a tentative product, a
feasible semester scope, and either real or virtual stakeholders. The product
idea and stakeholder path may still change through Milestone 2.

## Milestone 1 deliverables

- A concise `brief.md` emphasizing who cares, why, the proposed value, the
  tentative product and plan, what must be true, how it will be tested, the most
  important risks, and where AI is necessary.
- `submission.yaml` with the complete current product and stakeholder-path
  record.
- Any useful early supporting artifacts. These are optional at Milestone 1 but
  must be listed when included.
- One complete evidence set for the selected path:
  - **Real:** stakeholder brief PDF, current agreement, approval email PDF when
    approval was by email, and personal-email audio validation when applicable.
  - **Virtual:** three persona profiles and, for each persona, the unchanged
    Milestone 1 prompt, complete five-question chat PDF, model/effort declaration,
    and model-selection evidence.

Milestone 1 virtual personas do not assign rubric scores. The goal is to expose
uncertainty and improve scope, not obtain an artificial green light.

## Formal requirement checklist

The labeled statements below are the formal structural and evidence requirements
for this milestone. `requirements.json` maps each statement to its automatic,
attestation, or manual validation mechanism. Other prose in this README explains
how to satisfy these requirements; it does not create a second specification.

- **[REQ-C01] (both paths)** The final archive must contain one root submission.yaml that parses as JSON-compatible YAML and identifies the correct milestone and submission mode.
- **[REQ-C02] (both paths)** The submission must identify the student, product title, selected stakeholder path, and primary brief.
- **[REQ-C03] (both paths)** The AI Product Brief must use the two required headings, contain no active HTML or unsafe URI, and accurately state the concise value case and engineering credibility checks.
- **[REQ-C04] (both paths)** Every included supporting artifact must be logged in supporting_artifacts, every evidence file must be listed exactly once in evidence_manifest, and every file in the final ZIP must be accounted for.
- **[REQ-C05] (both paths)** A final submission must contain no template placeholders and must include all four truthful student attestations, the student's name, and the attestation date.
- **[REQ-C06] (both paths)** The structured record must accurately represent the brief, artifacts, and original evidence; this consistency and truthfulness remain subject to manual or AI-assisted review.
- **[REQ-C07] (both paths)** Every non-instruction file placed in inbox must have an explicit intake_file_decisions record that includes it as supporting work, includes it as evidence, or ignores it with a stated reason.
- **[REQ-R01] (real path)** The real path must include at least one eligible non-Purdue-student stakeholder with identity, affiliation, relationship, direct interest, contact information, and the exact stakeholder-facing brief.
- **[REQ-R02] (real path)** Each real stakeholder must have the applicable individual or shared agreement and approval evidence; email approval requires the approval-email PDF.
- **[REQ-R03] (real path)** Institutional-email validation requires the institutional address; personal-email validation requires the personal address and the required audio consent file.
- **[REQ-R04] (real path)** A shared agreement must identify the shared group and student count and include enough agreement pages for every listed product.
- **[REQ-V01] (virtual path)** The virtual path must include exactly three complete, realistic persona records whose roles or relationships to the product are meaningfully distinct.
- **[REQ-V02] (virtual path)** Each virtual-persona session must declare an eligible model baseline, exact model, medium-or-higher effort, and the two truthful model-setting attestations.
- **[REQ-V03] (virtual path)** Each virtual persona must complete the unchanged course prompt, five-question and five-answer interaction, complete transcript PDF, and model-selection evidence PDF.
- **[REQ-M1-01] (both paths)** Milestone 1 must frame the problem, stakeholder value, tentative product and plan, feasibility, tests, major risks, and necessary AI role; early supporting artifacts are optional but must be logged when included.

## Start here

This milestone package contains the required format, starter files, an
**autoguide**, and build/validation tools for one individual AI Product
milestone. You do not need to memorize its branching rules.

The easiest workflow is to attach or copy everything you currently have into
`inbox/`, add any natural-language context as a text or Markdown file, and ask an
AI agent to **follow `AGENTS.md` and prepare this submission**. The agent should
inventory the materials, fill clerical fields, organize and log files, ask only
for genuinely missing facts, quote the relevant requirement when explaining a
gap, and return a completed/missing/manual-confirmation report. You remain
responsible for checking the facts and personally confirming the attestations.

Without an agent, begin with:

```bash
python guide_submission.py start
```

At any time, run `python guide_submission.py status` for a readiness report or
`python guide_submission.py explain REQ-ID` to see why an item is required.

Keep the folder structure and exact filenames. The underlying steps are:

1. Choose your stakeholder path. The starter `submission.yaml` is the real-path
   example. Keep it for the real path, or replace it with a copy of
   `examples/submission-virtual.yaml`. The final file at the ZIP root must be
   named exactly `submission.yaml`.
2. Replace the example values and file pointers. The `.yaml` file uses JSON
   syntax intentionally; JSON is valid YAML and requires no extra Python package.
3. Complete `brief.md` and, when present, `feedback-synthesis.md`.
4. Put substantive work in `supporting/` and original validation evidence in
   `evidence/`. Add every supporting artifact to the manifest in
   `submission.yaml`; the chosen stakeholder-path records point to required
   evidence. List every evidence file—required or optional—exactly once in the
   central `evidence_manifest`. For every file placed in `inbox/`, record an
   `intake_file_decisions` choice to include it as supporting work, include it as
   evidence, or ignore it with a reason.
5. During preparation, keep `submission_mode` as `format_test` and run:

   ```bash
   python guide_submission.py status
   ```

6. Before the final upload, remove every placeholder, set `submission_mode` to
   `final`, and make every required attestation true only after personally
   confirming it.

   ```bash
   python package_submission.py
   ```

7. Inspect the generated ZIP and the printed file list. The packaging script
   includes only `submission.yaml` and explicitly declared files, then validates
   that exact ZIP just as the structural autograder will.

After every run, the checker prints a compact summary of the milestone, student,
product, selected path, declared artifacts, stakeholders or personas, model and
question settings, referenced files, and attestations. Read this summary before
uploading; it is intended to catch a structurally valid submission that describes
something different from what you meant to submit. The summary reflects
`submission.yaml` and file presence only—it does not establish truth or
cross-document consistency. Use `--json` if you want the checker result and
summary in machine-readable form.

Only the last Gradescope submission is authoritative for grading and consistency
review. Earlier `format_test` attempts may use obvious placeholders to test the
format. A format-test pass is not a valid final submission.

## The three layers

### 1. Concise, gradeable information

- `brief.md` is the primary AI Product Brief. It must contain exactly two H2
  headings, in order: `Product value case` and
  `Engineering credibility checks`.
- `submission.yaml` contains the student and product fields, stakeholder or
  persona information, rubric ratings and optional comments when applicable,
  attestations, and exact pointers to all other submitted files.
- `feedback-synthesis.md`, when present, concisely identifies the most important
  feedback, disagreements or uncertainty, and resulting decisions.

The checker validates structure and required fields. Course staff may grade or
review any of these files manually, automatically, or with AI assistance.

### 2. Supporting artifacts

Put the actual product work in `supporting/`: code, documentation, figures,
reports, configurations, results, datasets, benchmark materials, or other
deliverables. Do not include secrets, credentials, restricted data, package
caches, or generated environments.

Every artifact must have a manifest entry in `submission.yaml`. Include files
directly whenever practical. An artifact too large to include may instead use an
`external` manifest entry with an HTTPS URL, a reason, and—when available—a
SHA-256 checksum or immutable version identifier. Mutable links may carry less
evidentiary weight.

### 3. Stakeholder-path validity evidence

Put original evidence in `evidence/`. Do not rewrite or "clean up" stakeholder
forms, approval emails, review forms, recordings, waivers, model-selection
evidence, or chat transcripts. The corresponding structured values in
`submission.yaml` must accurately represent these source files.

The central `evidence_manifest` lists every evidence file with a stable ID,
kind, description, and path so the student and reviewer can see the complete
evidence set in one place. This includes files already referenced by a dedicated
stakeholder-path field and useful additional evidence such as an analysis
report, preliminary code snapshot, email, interaction note, or PDF. The final
ZIP may not contain unexplained extra files.

For the **real-stakeholder path**, each stakeholder record includes identity,
relationship, direct interest, validation method, the exact stakeholder brief,
and agreement evidence. If approval was by email, submit both the agreement PDF
sent to the stakeholder and a PDF containing the request and unambiguous reply.
If approval was by signed form, submit the signed form; the approval-email PDF is
optional. A stakeholder without institutional email also requires the short
audio validation described in the Student Guide. For a shared agreement covering
more than four students, list the additional shared agreement PDF or PDFs in the
same agreement record.

For the **virtual-stakeholder path**, `submission.yaml` contains exactly three
complete persona profiles. Each persona's evidence includes the unchanged course
prompt, complete chat PDF, and model-selection evidence. The three
sessions may all use the same provider, but every session must use GPT-5.6 Sol,
Claude Opus 5, or a later clearly stronger version from the same provider, at a
student-declared medium-or-higher effort. Each chat begins with a standard
`SESSION_CONFIGURATION` header that echoes those declarations without claiming
independent verification. Platform share URLs are optional and do not replace
the transcript PDF.

For each virtual persona:

1. Open a fresh chat and select an eligible model at medium-or-higher effort.
2. Supply the unchanged course prompt, the complete persona record, the current
   brief, and any required artifact manifest or evidence. Replace only the
   explicitly marked prompt placeholders.
3. Confirm that the first response prints the `SESSION_CONFIGURATION` header and
   Question 1. Answer Questions 1-5 using `STUDENT_A01` through `STUDENT_A05`.
4. Do not branch, edit, regenerate, or delete an unfavorable turn. If the model
   breaks the protocol, preserve the failure, correct it in the same chat, and
   continue.
5. At Milestones 2 and 3, paste the unchanged review prompt after
   `STUDENT_A05`. Preserve the complete generated review in the same transcript
   and transcribe its rubric ratings and optional comment into `submission.yaml`.
6. Save or print the complete chat as a PDF and verify that the prompt, persona,
   brief, all five Q/A pairs, and any review output are visible and unclipped.
   Also save model-selection evidence. Separate technical proof of the hidden
   effort setting is not required; the course relies on the transcript header
   and student attestation.
7. Put the source files under the matching persona ID in `evidence/virtual/` and
   make every `submission.yaml` pointer exact. Do not include secrets, private
   data, or proprietary material in an AI chat.

## What the checker does—and does not do

The included Python checker verifies that:

- the archive is safe to inspect and required root files exist;
- `submission.yaml` parses and matches this milestone;
- required fields, counts, choices, and attestations are present;
- every declared included-file pointer resolves;
- every final-ZIP file is explicitly accounted for;
- path-specific evidence is present for the selected options;
- final PDF pointers appear to reference PDF files; and
- final virtual sessions report 5 questions and 5 student answers and contain
  the required model-baseline and effort attestations.

It also prints what it found so you can quickly confirm that the declared
milestone, path, product, stakeholder or persona set, artifacts, and evidence
counts match your intent.

It does **not** determine whether the product is valuable, execute submitted
code, verify stakeholder identity, compare structured fields with source
evidence, or decide whether a claim is truthful. Course staff may perform those
checks separately or with AI assistance. A technical pass is therefore necessary
but not sufficient for grading.

False, fraudulent, altered, or materially misleading information—including
inconsistency among the brief, structured data, supporting work, and source
evidence—may result in an F for the milestone or course and referral to the
Office of the Dean of Students under Purdue policy.
