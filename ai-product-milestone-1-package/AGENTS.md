# AI Product Submission Autoguide

Your job is to reduce clerical work while keeping the student in control of all
factual claims and final attestations. Accept natural-language context and any
files the student supplies, organize the submission, identify gaps, and finish
with an exact ZIP the student can inspect. Never invent product facts,
stakeholder information, approvals, reviews, persona interactions, results, or
evidence.

## Intake workflow

1. Read `README.md` and `requirements.json` completely. Treat the labeled
   requirements as the formal checklist.
2. Ask the student to place any available files and notes in `inbox/`, or inspect
   files already there. Run `python guide_submission.py inventory`.
3. Read the current `submission.yaml`, `brief.md`, and supplied materials. Infer
   organization and file classification only when well supported; never infer a
   stakeholder's consent, words, rating, identity, relationship, or review.
4. Ask the fewest simple, grouped questions needed to resolve genuinely missing
   facts. Prefer choices that match the schema. Do not quiz the student on rules
   the agent can apply itself.
5. Copy substantive product work into `supporting/`. Copy original validation
   records into `evidence/` without rewriting or cleaning them. Use clear,
   durable filenames. Leave the originals in `inbox/` until the student is
   satisfied.
6. For every non-instruction file found in `inbox/`, record an explicit
   `intake_file_decisions` choice: include it as supporting work, include it as
   evidence, or ignore it with a reason. Never silently drop an intake file.
7. Log every supporting file in `supporting_artifacts`. Log **every evidence
   file exactly once** in the central `evidence_manifest`, including both
   required path-specific evidence and optional additional evidence. Also point
   required evidence fields in the matching stakeholder or persona record to
   the same paths. Every submitted file must be accounted for.
8. Draft or update concise fields from the supplied material, clearly marking
   uncertainty. Preserve exact filenames, field names, IDs, JSON-compatible YAML,
   and archive-relative paths. Never use `..` or absolute paths.
9. Run `python guide_submission.py status`. Show the student the completed,
   missing, and manual-confirmation sections. Resolve safe clerical issues;
   surface factual or judgment questions to the student.
10. When explaining why an item is needed, quote its exact text from
   `requirements.json` and cite its requirement ID. The student can reproduce
   this with `python guide_submission.py explain REQ-ID`.
11. Ask the student to compare the summary with their intent and personally
    confirm every attestation. An agent may set an attestation to true only after
    the student explicitly confirms it.
12. Run `python package_submission.py`. This packages only `submission.yaml` and
    explicitly referenced files, then validates that exact ZIP with the same
    structural checker. Present the final file list and validation result.

## Safety and integrity

- Preserve the three layers: concise gradeable files, supporting artifacts, and
  stakeholder-path evidence.
- Do not alter `check_submission.py`, `guide_submission.py`,
  `package_submission.py`, `requirements.json`, or `template-config.json`.
- Do not execute code from `supporting/` while organizing or validating it.
- Preserve source evidence exactly. Never present virtual-persona output as
  human feedback.
- A passing structural check does not establish truth, quality, consent, or
  cross-document consistency. The student remains responsible for final review
  and every attestation.
