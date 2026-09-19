#!/usr/bin/env python3
"""Structural validator for ECE 570 AI Product milestone submissions.

Uses only the Python standard library.  The course's submission.yaml files use
JSON syntax, which is a valid subset of YAML 1.2.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path, PurePosixPath
import re
import sys
import zipfile


MAX_FILES = 5000
MAX_UNCOMPRESSED_BYTES = 4 * 1024**3
ALLOWED_EFFORTS = {"medium", "high", "xhigh", "max"}
ALLOWED_MODEL_BASELINES = {"gpt-5.6-sol", "claude-opus-5"}
ALLOWED_RELATIONSHIPS = {
    "none",
    "friend",
    "family",
    "supervisor",
    "collaborator",
    "other_prior_relationship",
}
PLACEHOLDER_RE = re.compile(r"\b(REPLACE|PLACEHOLDER|CHOOSE|COURSE-DEFINED)\b", re.I)
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
SAFE_RELATIVE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ /+()@-]*$")
UNSAFE_MD_RE = re.compile(r"<!--|<\s*(?:script|style|iframe|object|embed|form|svg|html)\b", re.I)
UNSAFE_URI_RE = re.compile(r"(?:javascript|data|file|vbscript):", re.I)
MANAGED_ROOT_FILES = {
    "AGENTS.md",
    "README.md",
    "check_submission.py",
    "guide_submission.py",
    "package_submission.py",
    "requirements.json",
    "template-config.json",
}
MANAGED_NESTED_FILES = {
    "evidence/README.md",
    "inbox/README.md",
    "prompts/README.md",
    "supporting/README.md",
}
MANAGED_PREFIXES = ("examples/", "inbox/", "build/", "prompts/")


class Findings:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.referenced: set[str] = set()

    def error(self, message: str) -> None:
        self.errors.append(message)

    def warn(self, message: str) -> None:
        self.warnings.append(message)


def normalize_relative(value: object, label: str, findings: Findings) -> str | None:
    if not isinstance(value, str) or not value.strip():
        findings.error(f"{label}: expected a non-empty archive-relative path")
        return None
    path = value.strip().replace("\\", "/")
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts or path.startswith("./"):
        findings.error(f"{label}: unsafe or non-canonical path: {value!r}")
        return None
    if not SAFE_RELATIVE_RE.fullmatch(path):
        findings.error(f"{label}: path contains unsupported characters: {value!r}")
        return None
    return str(pure)


class Source:
    def names(self) -> set[str]:
        raise NotImplementedError

    def read_bytes(self, name: str) -> bytes:
        raise NotImplementedError

    def exists(self, name: str) -> bool:
        return name in self.names()

    def read_text(self, name: str) -> str:
        return self.read_bytes(name).decode("utf-8")


class DirectorySource(Source):
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self._names = {
            p.relative_to(self.root).as_posix()
            for p in self.root.rglob("*")
            if p.is_file()
        }

    def names(self) -> set[str]:
        return self._names

    def read_bytes(self, name: str) -> bytes:
        return (self.root / name).read_bytes()


class ZipSource(Source):
    def __init__(self, path: Path, findings: Findings) -> None:
        self.archive = zipfile.ZipFile(path)
        infos = [i for i in self.archive.infolist() if not i.is_dir()]
        if len(infos) > MAX_FILES:
            findings.error(f"archive contains {len(infos)} files; limit is {MAX_FILES}")
        if sum(i.file_size for i in infos) > MAX_UNCOMPRESSED_BYTES:
            findings.error("archive exceeds the uncompressed-size safety limit")
        self._names: set[str] = set()
        folded: set[str] = set()
        for info in infos:
            normalized = normalize_relative(info.filename, "ZIP entry", findings)
            if normalized is None:
                continue
            if normalized in self._names or normalized.casefold() in folded:
                findings.error(f"duplicate or case-colliding ZIP entry: {normalized}")
            self._names.add(normalized)
            folded.add(normalized.casefold())
            mode = (info.external_attr >> 16) & 0o170000
            if mode == 0o120000:
                findings.error(f"symbolic links are not allowed in the ZIP: {normalized}")

    def names(self) -> set[str]:
        return self._names

    def read_bytes(self, name: str) -> bytes:
        return self.archive.read(name)


def required_map(parent: object, label: str, findings: Findings) -> dict:
    if not isinstance(parent, dict):
        findings.error(f"{label}: expected an object")
        return {}
    return parent


def required_list(parent: dict, key: str, label: str, findings: Findings) -> list:
    value = parent.get(key)
    if not isinstance(value, list):
        findings.error(f"{label}.{key}: expected a list")
        return []
    return value


def required_string(parent: dict, key: str, label: str, findings: Findings) -> str:
    value = parent.get(key)
    if not isinstance(value, str) or not value.strip():
        findings.error(f"{label}.{key}: expected a non-empty string")
        return ""
    return value.strip()


def required_bool(parent: dict, key: str, label: str, findings: Findings) -> bool | None:
    value = parent.get(key)
    if not isinstance(value, bool):
        findings.error(f"{label}.{key}: expected true or false")
        return None
    return value


def check_date(value: object, label: str, findings: Findings) -> None:
    if not isinstance(value, str):
        findings.error(f"{label}: expected YYYY-MM-DD")
        return
    try:
        dt.date.fromisoformat(value)
    except ValueError:
        findings.error(f"{label}: expected YYYY-MM-DD, got {value!r}")


def check_file(
    source: Source,
    value: object,
    label: str,
    findings: Findings,
    *,
    final: bool,
    extensions: set[str] | None = None,
    pdf: bool = False,
) -> str | None:
    name = normalize_relative(value, label, findings)
    if name is None:
        return None
    findings.referenced.add(name)
    if not source.exists(name):
        findings.error(f"{label}: referenced file does not exist: {name}")
        return name
    suffix = PurePosixPath(name).suffix.lower()
    if final and extensions and suffix not in extensions:
        findings.error(f"{label}: expected one of {sorted(extensions)}, got {suffix or 'no extension'}")
    if final and pdf and not source.read_bytes(name).startswith(b"%PDF-"):
        findings.error(f"{label}: file does not appear to be a PDF: {name}")
    return name


def check_optional_file(
    source: Source,
    value: object,
    label: str,
    findings: Findings,
    *,
    final: bool,
    extensions: set[str] | None = None,
    pdf: bool = False,
) -> str | None:
    if value is None:
        return None
    return check_file(source, value, label, findings, final=final, extensions=extensions, pdf=pdf)


def check_brief(source: Source, path: str, findings: Findings) -> None:
    try:
        text = source.read_text(path)
    except (UnicodeDecodeError, KeyError, OSError):
        findings.error(f"{path}: must be UTF-8 text")
        return
    headings = re.findall(r"^##\s+(.+?)\s*$", text, flags=re.M)
    if headings != ["Product value case", "Engineering credibility checks"]:
        findings.error(
            f"{path}: must contain exactly these H2 headings in order: "
            "'Product value case', 'Engineering credibility checks'"
        )
    if UNSAFE_MD_RE.search(text) or UNSAFE_URI_RE.search(text):
        findings.error(f"{path}: contains disallowed active HTML or unsafe URI content")


def check_review(
    source: Source,
    review: object,
    label: str,
    findings: Findings,
    *,
    final: bool,
    virtual: bool,
) -> None:
    data = required_map(review, label, findings)
    required_string(data, "rubric_version", label, findings)
    ratings = required_list(data, "ratings", label, findings)
    if not ratings:
        findings.error(f"{label}.ratings: at least one rubric rating is required")
    seen: set[str] = set()
    for index, item in enumerate(ratings):
        item_label = f"{label}.ratings[{index}]"
        row = required_map(item, item_label, findings)
        criterion = required_string(row, "criterion_id", item_label, findings)
        required_string(row, "rating", item_label, findings)
        if criterion in seen:
            findings.error(f"{item_label}.criterion_id: duplicate criterion {criterion!r}")
        seen.add(criterion)
    comment = data.get("optional_comment_exact")
    if comment is not None and not isinstance(comment, str):
        findings.error(f"{label}.optional_comment_exact: expected a string or null")
    if virtual:
        if data.get("source_review_turn_label") != "PERSONA_REVIEW":
            findings.error(f"{label}.source_review_turn_label: expected 'PERSONA_REVIEW'")
    else:
        method = data.get("source_method")
        if method not in {"signed_form", "email"}:
            findings.error(f"{label}.source_method: expected 'signed_form' or 'email'")
        check_file(source, data.get("source_review_pdf"), f"{label}.source_review_pdf", findings, final=final, extensions={".pdf"}, pdf=True)


def check_agreement(source: Source, agreement: object, label: str, findings: Findings, *, final: bool) -> None:
    data = required_map(agreement, label, findings)
    kind = data.get("kind")
    if kind not in {"individual", "shared"}:
        findings.error(f"{label}.kind: expected 'individual' or 'shared'")
    method = data.get("approval_method")
    if method not in {"signed_form", "email"}:
        findings.error(f"{label}.approval_method: expected 'signed_form' or 'email'")
    check_file(source, data.get("agreement_pdf"), f"{label}.agreement_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
    email_pdf = check_optional_file(source, data.get("approval_email_pdf"), f"{label}.approval_email_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
    if method == "email" and email_pdf is None:
        findings.error(f"{label}.approval_email_pdf: required when approval_method is 'email'")
    if method == "signed_form" and data.get("approval_email_pdf") is not None:
        findings.warn(f"{label}.approval_email_pdf: allowed but not required for a signed-form approval")
    if kind == "shared":
        count = data.get("shared_student_count")
        if not isinstance(count, int) or count < 2:
            findings.error(f"{label}.shared_student_count: expected an integer of at least 2")
            count = 2
        required_string(data, "shared_group_id", label, findings)
        additional = required_list(data, "additional_agreement_pdfs", label, findings)
        for index, path in enumerate(additional):
            check_file(source, path, f"{label}.additional_agreement_pdfs[{index}]", findings, final=final, extensions={".pdf"}, pdf=True)
        required_additional = (count + 3) // 4 - 1
        if len(additional) < required_additional:
            findings.error(
                f"{label}.additional_agreement_pdfs: {count} shared students require "
                f"at least {required_additional} additional shared agreement PDF(s)"
            )


def check_real_path(source: Source, root: dict, milestone: int, findings: Findings, *, final: bool) -> None:
    stakeholders = required_list(root, "real_stakeholders", "submission", findings)
    if not stakeholders:
        findings.error("submission.real_stakeholders: at least one stakeholder is required")
    ids: set[str] = set()
    for index, item in enumerate(stakeholders):
        label = f"submission.real_stakeholders[{index}]"
        data = required_map(item, label, findings)
        sid = required_string(data, "stakeholder_id", label, findings)
        if sid in ids:
            findings.error(f"{label}.stakeholder_id: duplicate ID {sid!r}")
        ids.add(sid)
        required_string(data, "name", label, findings)
        email = required_string(data, "email", label, findings)
        if email and not EMAIL_RE.fullmatch(email):
            findings.error(f"{label}.email: invalid email address")
        required_string(data, "role_and_affiliation", label, findings)
        required_string(data, "direct_interest", label, findings)
        relationship = data.get("relationship")
        if relationship not in ALLOWED_RELATIONSHIPS:
            findings.error(f"{label}.relationship: expected one of {sorted(ALLOWED_RELATIONSHIPS)}")
        if required_bool(data, "is_purdue_student", label, findings) is True:
            findings.error(f"{label}.is_purdue_student: Purdue students are not eligible real stakeholders")
        check_file(source, data.get("stakeholder_brief_pdf"), f"{label}.stakeholder_brief_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
        check_agreement(source, data.get("agreement"), f"{label}.agreement", findings, final=final)
        validation = required_map(data.get("validation"), f"{label}.validation", findings)
        method = validation.get("method")
        if method not in {"institutional_email", "personal_email_audio"}:
            findings.error(f"{label}.validation.method: expected 'institutional_email' or 'personal_email_audio'")
        audio = check_optional_file(
            source,
            validation.get("audio_file"),
            f"{label}.validation.audio_file",
            findings,
            final=final,
            extensions={".aac", ".m4a", ".mp3", ".wav"},
        )
        if method == "personal_email_audio" and audio is None:
            findings.error(f"{label}.validation.audio_file: required for personal-email validation")

        if milestone >= 2:
            status = data.get("review_status")
            if status == "completed":
                check_review(source, data.get("review"), f"{label}.review", findings, final=final, virtual=False)
                session = required_map(data.get("evaluation_session"), f"{label}.evaluation_session", findings)
                evidence = session.get("evidence")
                if evidence not in {"recording_included", "recording_external", "signed_waiver"}:
                    findings.error(
                        f"{label}.evaluation_session.evidence: expected recording_included, recording_external, or signed_waiver"
                    )
                if evidence == "recording_included":
                    check_file(source, session.get("recording_file"), f"{label}.evaluation_session.recording_file", findings, final=final, extensions={".mp4", ".mov", ".webm", ".m4a", ".mp3"})
                elif evidence == "recording_external":
                    url = session.get("recording_url")
                    if not isinstance(url, str) or not url.startswith("https://"):
                        findings.error(f"{label}.evaluation_session.recording_url: expected an https URL")
                    required_string(session, "external_reason", f"{label}.evaluation_session", findings)
                elif evidence == "signed_waiver":
                    check_file(source, session.get("waiver_pdf"), f"{label}.evaluation_session.waiver_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
            elif milestone == 2 and status == "scheduled_late_exception":
                late = required_map(data.get("late_evaluation"), f"{label}.late_evaluation", findings)
                check_date(late.get("scheduled_date"), f"{label}.late_evaluation.scheduled_date", findings)
                for key in ("stakeholder_note_pdf", "initial_request_pdf", "followup_pdf"):
                    check_file(source, late.get(key), f"{label}.late_evaluation.{key}", findings, final=final, extensions={".pdf"}, pdf=True)
            else:
                allowed = "'completed' or 'scheduled_late_exception'" if milestone == 2 else "'completed'"
                findings.error(f"{label}.review_status: expected {allowed}")


PERSONA_FIELDS = {
    "persona_id",
    "display_name",
    "role",
    "perspective_category",
    "setting",
    "relationship_to_product",
    "why_they_care",
    "current_workflow",
    "current_alternatives",
    "goals",
    "observable_success",
    "constraints",
    "adoption_authority",
    "knowledge_boundary",
    "evidence_threshold",
    "top_concerns",
    "distinct_from_other_personas",
    "grounded_facts_and_sources",
    "plausible_assumptions",
}


def check_virtual_path(source: Source, root: dict, milestone: int, findings: Findings, *, final: bool) -> None:
    personas = required_list(root, "virtual_personas", "submission", findings)
    if len(personas) != 3:
        findings.error(f"submission.virtual_personas: expected exactly 3 personas, found {len(personas)}")
    ids: set[str] = set()
    for index, item in enumerate(personas):
        label = f"submission.virtual_personas[{index}]"
        data = required_map(item, label, findings)
        for field in sorted(PERSONA_FIELDS):
            value = data.get(field)
            if field in {"current_alternatives", "goals", "observable_success", "constraints", "top_concerns", "grounded_facts_and_sources", "plausible_assumptions"}:
                if not isinstance(value, list) or not value or not all(isinstance(v, str) and v.strip() for v in value):
                    findings.error(f"{label}.{field}: expected a non-empty list of strings")
            else:
                required_string(data, field, label, findings)
        pid = str(data.get("persona_id", ""))
        if pid in ids:
            findings.error(f"{label}.persona_id: duplicate ID {pid!r}")
        ids.add(pid)
        session = required_map(data.get("session"), f"{label}.session", findings)
        baseline = session.get("minimum_model_baseline")
        if baseline not in ALLOWED_MODEL_BASELINES:
            findings.error(
                f"{label}.session.minimum_model_baseline: expected one of "
                f"{sorted(ALLOWED_MODEL_BASELINES)}"
            )
        required_string(session, "model_exact", f"{label}.session", findings)
        if session.get("effort") not in ALLOWED_EFFORTS:
            findings.error(f"{label}.session.effort: expected one of {sorted(ALLOWED_EFFORTS)}")
        model_attestation = required_bool(
            session,
            "student_attests_model_meets_or_exceeds_baseline",
            f"{label}.session",
            findings,
        )
        effort_attestation = required_bool(
            session,
            "student_attests_effort_medium_or_higher",
            f"{label}.session",
            findings,
        )
        if final and model_attestation is not True:
            findings.error(
                f"{label}.session.student_attests_model_meets_or_exceeds_baseline: "
                "must be true for a final submission"
            )
        if final and effort_attestation is not True:
            findings.error(
                f"{label}.session.student_attests_effort_medium_or_higher: "
                "must be true for a final submission"
            )
        if session.get("session_header_label") != "SESSION_CONFIGURATION":
            findings.error(f"{label}.session.session_header_label: expected 'SESSION_CONFIGURATION'")
        if session.get("question_count") != 5 or session.get("student_answer_count") != 5:
            findings.error(f"{label}.session: question_count and student_answer_count must both equal 5")
        check_file(source, session.get("course_prompt_file"), f"{label}.session.course_prompt_file", findings, final=final, extensions={".txt", ".md"})
        check_file(source, session.get("transcript_pdf"), f"{label}.session.transcript_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
        check_file(source, session.get("model_selection_evidence_pdf"), f"{label}.session.model_selection_evidence_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
        share_url = session.get("optional_share_url")
        if share_url is not None and (not isinstance(share_url, str) or not share_url.startswith("https://")):
            findings.error(f"{label}.session.optional_share_url: expected an https URL or null")
        if milestone >= 2:
            check_review(source, data.get("review"), f"{label}.review", findings, final=final, virtual=True)

def contains_placeholder(value: object) -> bool:
    if isinstance(value, str):
        return bool(PLACEHOLDER_RE.search(value))
    if isinstance(value, list):
        return any(contains_placeholder(item) for item in value)
    if isinstance(value, dict):
        return any(contains_placeholder(item) for item in value.values())
    return False


def build_summary(root: dict, source: Source, findings: Findings) -> dict:
    """Return a compact, non-evaluative summary of the declared submission."""
    student = root.get("student") if isinstance(root.get("student"), dict) else {}
    product = root.get("product") if isinstance(root.get("product"), dict) else {}
    artifacts = root.get("supporting_artifacts") if isinstance(root.get("supporting_artifacts"), list) else []
    evidence_manifest = root.get("evidence_manifest") if isinstance(root.get("evidence_manifest"), list) else []
    intake_decisions = root.get("intake_file_decisions") if isinstance(root.get("intake_file_decisions"), list) else []
    attestations = root.get("student_attestations") if isinstance(root.get("student_attestations"), dict) else {}

    artifact_rows = []
    for item in artifacts:
        if not isinstance(item, dict):
            continue
        artifact_rows.append(
            {
                "kind": item.get("kind"),
                "description": item.get("description"),
                "location_type": item.get("location_type"),
                "location": item.get("path") if item.get("location_type") == "included" else item.get("url"),
            }
        )

    evidence_rows = []
    for item in evidence_manifest:
        if not isinstance(item, dict):
            continue
        evidence_rows.append(
            {
                "evidence_id": item.get("evidence_id"),
                "kind": item.get("kind"),
                "description": item.get("description"),
                "path": item.get("path"),
            }
        )

    real_rows = []
    for item in root.get("real_stakeholders", []) if isinstance(root.get("real_stakeholders"), list) else []:
        if not isinstance(item, dict):
            continue
        agreement = item.get("agreement") if isinstance(item.get("agreement"), dict) else {}
        validation = item.get("validation") if isinstance(item.get("validation"), dict) else {}
        review = item.get("review") if isinstance(item.get("review"), dict) else {}
        real_rows.append(
            {
                "stakeholder_id": item.get("stakeholder_id"),
                "name": item.get("name"),
                "email": item.get("email"),
                "relationship": item.get("relationship"),
                "agreement_kind": agreement.get("kind"),
                "approval_method": agreement.get("approval_method"),
                "validation_method": validation.get("method"),
                "review_status": item.get("review_status", "not applicable for Milestone 1"),
                "rubric_rating_count": len(review.get("ratings", [])) if isinstance(review.get("ratings"), list) else 0,
            }
        )

    virtual_rows = []
    for item in root.get("virtual_personas", []) if isinstance(root.get("virtual_personas"), list) else []:
        if not isinstance(item, dict):
            continue
        session = item.get("session") if isinstance(item.get("session"), dict) else {}
        review = item.get("review") if isinstance(item.get("review"), dict) else {}
        virtual_rows.append(
            {
                "persona_id": item.get("persona_id"),
                "display_name": item.get("display_name"),
                "role": item.get("role"),
                "perspective_category": item.get("perspective_category"),
                "model_exact": session.get("model_exact"),
                "minimum_model_baseline": session.get("minimum_model_baseline"),
                "effort": session.get("effort"),
                "question_count": session.get("question_count"),
                "student_answer_count": session.get("student_answer_count"),
                "rubric_rating_count": len(review.get("ratings", [])) if isinstance(review.get("ratings"), list) else 0,
            }
        )

    attestation_keys = (
        "structured_information_is_accurate",
        "work_is_individual",
        "evidence_is_complete_and_unaltered",
        "no_material_misrepresentation",
    )
    return {
        "milestone": root.get("milestone"),
        "submission_mode": root.get("submission_mode"),
        "student": {
            "name": student.get("name"),
            "purdue_email": student.get("purdue_email"),
            "puid": student.get("puid"),
        },
        "product": {
            "title": product.get("title"),
            "stakeholder_path": product.get("stakeholder_path"),
            "brief_file": product.get("brief_file"),
            "tldr_pitch": product.get("tldr_pitch"),
        },
        "supporting_artifact_count": len(artifact_rows),
        "supporting_artifacts": artifact_rows,
        "evidence_manifest_count": len(evidence_rows),
        "evidence_manifest": evidence_rows,
        "intake_decision_count": len(intake_decisions),
        "real_stakeholder_count": len(real_rows),
        "real_stakeholders": real_rows,
        "virtual_persona_count": len(virtual_rows),
        "virtual_personas": virtual_rows,
        "attestations_true": sum(attestations.get(key) is True for key in attestation_keys),
        "attestations_expected": len(attestation_keys),
        "archive_file_count": len(source.names()),
        "referenced_file_count": len(findings.referenced),
        "referenced_files": sorted(findings.referenced),
        "evidence_file_count": sum(name.startswith("evidence/") and not name.endswith("README.md") for name in source.names()),
    }


def print_summary(summary: dict) -> None:
    product = summary["product"]
    student = summary["student"]
    print("\nSubmission summary (declared in submission.yaml)")
    print(f"  Milestone: {summary['milestone']} | mode: {summary['submission_mode']}")
    print(f"  Student: {student['name']} | {student['purdue_email']} | PUID {student['puid']}")
    print(f"  Product: {product['title']}")
    print(f"  Stakeholder path: {product['stakeholder_path']} | brief: {product['brief_file']}")
    if product.get("tldr_pitch"):
        print(f"  TL;DR: {product['tldr_pitch']}")
    print(f"  Supporting artifacts declared: {summary['supporting_artifact_count']}")
    for item in summary["supporting_artifacts"]:
        print(
            f"    - {item['kind']}: {item['description']} "
            f"[{item['location_type']}: {item['location']}]"
        )
    print(f"  Evidence files declared: {summary['evidence_manifest_count']}")
    for item in summary["evidence_manifest"]:
        print(
            f"    - {item['evidence_id']} | {item['kind']}: "
            f"{item['description']} [included: {item['path']}]"
        )
    print(f"  Intake-file decisions recorded: {summary['intake_decision_count']}")
    if product["stakeholder_path"] == "real":
        print(f"  Real stakeholders declared: {summary['real_stakeholder_count']}")
        for item in summary["real_stakeholders"]:
            print(
                f"    - {item['stakeholder_id']}: {item['name']} | {item['email']} | "
                f"relationship={item['relationship']} | agreement={item['agreement_kind']}/"
                f"{item['approval_method']} | validation={item['validation_method']} | "
                f"review={item['review_status']} | rubric ratings={item['rubric_rating_count']}"
            )
    elif product["stakeholder_path"] == "virtual":
        print(f"  Virtual personas declared: {summary['virtual_persona_count']}")
        for item in summary["virtual_personas"]:
            print(
                f"    - {item['persona_id']}: {item['display_name']} | {item['perspective_category']} | "
                f"model={item['model_exact']} (baseline={item['minimum_model_baseline']}, "
                f"effort={item['effort']}) | Q/A={item['question_count']}/"
                f"{item['student_answer_count']} | rubric ratings={item['rubric_rating_count']}"
            )
    print(
        f"  Files: {summary['archive_file_count']} in package | "
        f"{summary['referenced_file_count']} referenced | "
        f"{summary['evidence_file_count']} non-README evidence files"
    )
    print(
        f"  Final attestations currently true: {summary['attestations_true']}/"
        f"{summary['attestations_expected']}"
    )
    print("  This summary confirms declared structure, not truth or cross-file consistency.")


def validate(source: Source, findings: Findings, *, force_final: bool) -> tuple[dict, bool]:
    if not source.exists("submission.yaml"):
        findings.error("missing required root file: submission.yaml")
    if not source.exists("submission.yaml"):
        return {}, force_final
    try:
        root = json.loads(source.read_text("submission.yaml"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        findings.error(f"submission.yaml: must be UTF-8 JSON-compatible YAML: {exc}")
        return {}, force_final
    root = required_map(root, "submission", findings)

    expected_milestone = None
    if source.exists("template-config.json"):
        try:
            config = json.loads(source.read_text("template-config.json"))
            expected_milestone = config["milestone"]
        except Exception as exc:
            findings.error(f"template-config.json: invalid template metadata: {exc}")

    mode = root.get("submission_mode")
    if mode not in {"format_test", "final"}:
        findings.error("submission.submission_mode: expected 'format_test' or 'final'")
    final = force_final or mode == "final"
    if force_final and mode != "final":
        findings.error("submission.submission_mode must be 'final' for final validation")
    if final and contains_placeholder(root):
        findings.error("submission.yaml contains REPLACE/PLACEHOLDER/CHOOSE/COURSE-DEFINED text")

    if root.get("schema_version") != "1.0-draft":
        findings.error("submission.schema_version: expected '1.0-draft'")
    milestone = root.get("milestone")
    if milestone not in {1, 2, 3}:
        findings.error("submission.milestone: expected 1, 2, or 3")
        milestone = expected_milestone or 0
    if expected_milestone is not None and milestone != expected_milestone:
        findings.error(f"submission.milestone: expected {expected_milestone} for this template")

    student = required_map(root.get("student"), "submission.student", findings)
    for key in ("name", "purdue_email", "puid"):
        required_string(student, key, "submission.student", findings)
    email = str(student.get("purdue_email", ""))
    if email and not EMAIL_RE.fullmatch(email):
        findings.error("submission.student.purdue_email: invalid email address")

    product = required_map(root.get("product"), "submission.product", findings)
    required_string(product, "title", "submission.product", findings)
    path = product.get("stakeholder_path")
    if path not in {"real", "virtual"}:
        findings.error("submission.product.stakeholder_path: expected 'real' or 'virtual'")
    brief = check_file(source, product.get("brief_file"), "submission.product.brief_file", findings, final=final, extensions={".md"})
    if brief:
        check_brief(source, brief, findings)
    if milestone == 3:
        pitch = required_string(product, "tldr_pitch", "submission.product", findings)
        if final and len(pitch) > 350:
            findings.error("submission.product.tldr_pitch: exceeds the provisional 350-character limit")

    artifacts = required_list(root, "supporting_artifacts", "submission", findings)
    if milestone >= 2 and not artifacts:
        findings.error("submission.supporting_artifacts: at least one artifact is required")
    for index, item in enumerate(artifacts):
        label = f"submission.supporting_artifacts[{index}]"
        data = required_map(item, label, findings)
        required_string(data, "description", label, findings)
        required_string(data, "kind", label, findings)
        location = data.get("location_type")
        if location == "included":
            check_file(source, data.get("path"), f"{label}.path", findings, final=final)
        elif location == "external":
            url = data.get("url")
            if not isinstance(url, str) or not url.startswith("https://"):
                findings.error(f"{label}.url: expected an https URL")
            required_string(data, "external_reason", label, findings)
            checksum = data.get("sha256")
            if checksum is not None and not re.fullmatch(r"[0-9a-fA-F]{64}", str(checksum)):
                findings.error(f"{label}.sha256: expected 64 hexadecimal characters or null")
        else:
            findings.error(f"{label}.location_type: expected 'included' or 'external'")

    evidence_manifest = root.get("evidence_manifest", [])
    if not isinstance(evidence_manifest, list):
        findings.error("submission.evidence_manifest: expected a list")
        evidence_manifest = []
    evidence_ids: set[str] = set()
    evidence_paths: set[str] = set()
    for index, item in enumerate(evidence_manifest):
        label = f"submission.evidence_manifest[{index}]"
        data = required_map(item, label, findings)
        evidence_id = required_string(data, "evidence_id", label, findings)
        required_string(data, "description", label, findings)
        required_string(data, "kind", label, findings)
        evidence_path = check_file(source, data.get("path"), f"{label}.path", findings, final=final)
        if evidence_id in evidence_ids:
            findings.error(f"{label}.evidence_id: duplicate ID {evidence_id!r}")
        evidence_ids.add(evidence_id)
        if evidence_path:
            if not evidence_path.startswith("evidence/"):
                findings.error(f"{label}.path: evidence files must be under evidence/: {evidence_path}")
            if evidence_path in evidence_paths:
                findings.error(f"{label}.path: duplicate evidence path {evidence_path!r}")
            evidence_paths.add(evidence_path)

    intake_decisions = root.get("intake_file_decisions", [])
    if not isinstance(intake_decisions, list):
        findings.error("submission.intake_file_decisions: expected a list")
        intake_decisions = []
    intake_sources: set[str] = set()
    supporting_paths = {
        item.get("path")
        for item in artifacts
        if isinstance(item, dict) and item.get("location_type") == "included"
    }
    for index, item in enumerate(intake_decisions):
        label = f"submission.intake_file_decisions[{index}]"
        data = required_map(item, label, findings)
        source_path = normalize_relative(data.get("source_path"), f"{label}.source_path", findings)
        if source_path and not source_path.startswith("inbox/"):
            findings.error(f"{label}.source_path: expected a path under inbox/")
        if source_path in intake_sources:
            findings.error(f"{label}.source_path: duplicate intake decision for {source_path!r}")
        if source_path:
            intake_sources.add(source_path)
        decision = data.get("decision")
        if decision not in {"include_as_supporting", "include_as_evidence", "ignore"}:
            findings.error(
                f"{label}.decision: expected include_as_supporting, include_as_evidence, or ignore"
            )
        required_string(data, "reason", label, findings)
        submitted_path = data.get("submitted_path")
        if decision == "ignore":
            if submitted_path is not None:
                findings.error(f"{label}.submitted_path: must be null when decision is ignore")
        else:
            normalized = normalize_relative(submitted_path, f"{label}.submitted_path", findings)
            if decision == "include_as_supporting" and normalized not in supporting_paths:
                findings.error(f"{label}.submitted_path: not listed as an included supporting artifact")
            if decision == "include_as_evidence" and normalized not in evidence_paths:
                findings.error(f"{label}.submitted_path: not listed in evidence_manifest")

    if milestone >= 2:
        check_file(source, root.get("feedback_synthesis_file"), "submission.feedback_synthesis_file", findings, final=final, extensions={".md"})

    if milestone == 3:
        transition = required_map(root.get("path_transition"), "submission.path_transition", findings)
        kind = transition.get("kind")
        if kind not in {"unchanged", "virtual_to_real", "real_to_virtual_approved"}:
            findings.error("submission.path_transition.kind: expected unchanged, virtual_to_real, or real_to_virtual_approved")
        approval = check_optional_file(source, transition.get("instructor_approval_email_pdf"), "submission.path_transition.instructor_approval_email_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
        if kind == "real_to_virtual_approved" and approval is None:
            findings.error("submission.path_transition.instructor_approval_email_pdf: required for an approved real-to-virtual switch")
        changed = required_bool(transition, "virtual_persona_changed_after_m2", "submission.path_transition", findings)
        persona_approval = check_optional_file(source, transition.get("persona_change_approval_email_pdf"), "submission.path_transition.persona_change_approval_email_pdf", findings, final=final, extensions={".pdf"}, pdf=True)
        if changed is True and persona_approval is None:
            findings.error("submission.path_transition.persona_change_approval_email_pdf: required when a virtual persona changed after Milestone 2")

    if path == "real":
        check_real_path(source, root, milestone, findings, final=final)
    elif path == "virtual":
        check_virtual_path(source, root, milestone, findings, final=final)

    attest = required_map(root.get("student_attestations"), "submission.student_attestations", findings)
    required_string(attest, "student_name", "submission.student_attestations", findings)
    check_date(attest.get("date"), "submission.student_attestations.date", findings)
    for key in ("structured_information_is_accurate", "work_is_individual", "evidence_is_complete_and_unaltered", "no_material_misrepresentation"):
        value = required_bool(attest, key, "submission.student_attestations", findings)
        if final and value is not True:
            findings.error(f"submission.student_attestations.{key}: must be true for a final submission")

    missing_from_manifest = sorted(
        name
        for name in findings.referenced
        if name.startswith("evidence/") and name not in evidence_paths
    )
    for name in missing_from_manifest:
        findings.error(
            f"submission.evidence_manifest: evidence file is used elsewhere but not listed: {name}"
        )

    if isinstance(source, DirectorySource):
        intake_files = {
            name
            for name in source.names()
            if name.startswith("inbox/") and name != "inbox/README.md"
        }
        for name in sorted(intake_files - intake_sources):
            findings.error(
                f"submission.intake_file_decisions: inbox file has no include/ignore decision: {name}"
            )
        for name in sorted(intake_sources - intake_files):
            findings.warn(
                f"submission.intake_file_decisions: source file is no longer present in the workspace: {name}"
            )

    managed = set()
    if isinstance(source, DirectorySource):
        managed = {
            name
            for name in source.names()
            if name in MANAGED_ROOT_FILES
            or name in MANAGED_NESTED_FILES
            or name.startswith(MANAGED_PREFIXES)
        }
    unreferenced = sorted(
        name
        for name in source.names()
        if name != "submission.yaml"
        and name not in findings.referenced
        and name not in managed
    )
    for name in unreferenced:
        message = (
            f"unaccounted file: {name}; add it to supporting_artifacts, list it in "
            "evidence_manifest and reference it where applicable, or remove it"
        )
        if final:
            findings.error(message)
        else:
            findings.warn(message)
    return root, final


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an AI Product milestone directory or ZIP")
    parser.add_argument("path", nargs="?", default=".", help="submission directory or ZIP file")
    parser.add_argument("--final", action="store_true", help="enforce final-submission rules")
    parser.add_argument("--json", action="store_true", dest="json_output", help="emit machine-readable results")
    args = parser.parse_args()

    findings = Findings()
    target = Path(args.path)
    try:
        if target.is_dir():
            source: Source = DirectorySource(target)
        elif target.is_file() and zipfile.is_zipfile(target):
            source = ZipSource(target, findings)
        else:
            findings.error(f"path is not a directory or readable ZIP: {target}")
            source = DirectorySource(Path("."))
        root, final = validate(source, findings, force_final=args.final)
    except Exception as exc:
        findings.error(f"unexpected validation failure: {type(exc).__name__}: {exc}")
        final = args.final
        root = {}

    summary = build_summary(root, source, findings)

    result = {
        "valid": not findings.errors,
        "validation_level": "final" if final else "format_test",
        "errors": findings.errors,
        "warnings": findings.warnings,
        "summary": summary,
    }
    if args.json_output:
        print(json.dumps(result, indent=2))
    else:
        print(f"AI Product validation: {'PASS' if result['valid'] else 'FAIL'} ({result['validation_level']})")
        print_summary(summary)
        for message in findings.errors:
            print(f"ERROR: {message}")
        for message in findings.warnings:
            print(f"WARNING: {message}")
        if result["valid"] and not final:
            print("NOTE: Format-test mode does not certify a final submission. Replace placeholders, set submission_mode to 'final', and run with --final.")
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
