#!/usr/bin/env python3
"""Low-friction intake, requirement help, and readiness reporting."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent
CHECKER = ROOT / "check_submission.py"
REGISTRY = ROOT / "requirements.json"
PLACEHOLDER_RE = re.compile(r"\b(REPLACE|PLACEHOLDER|CHOOSE|COURSE-DEFINED)\b", re.I)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def checker_result() -> dict:
    process = subprocess.run(
        [sys.executable, str(CHECKER), str(ROOT), "--final", "--json"],
        capture_output=True,
        text=True,
    )
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError:
        return {
            "valid": False,
            "errors": [f"checker did not return JSON: {process.stdout or process.stderr}"],
            "warnings": [],
            "summary": {},
        }


def selected_requirements(submission: dict) -> list[dict]:
    registry = load_json(REGISTRY)
    milestone = submission.get("milestone", registry.get("milestone"))
    path = submission.get("product", {}).get("stakeholder_path")
    return [
        item
        for item in registry["requirements"]
        if milestone in item["milestones"] and (not path or path in item["paths"])
    ]


def matching_errors(item: dict, errors: list[str]) -> list[str]:
    needles = item.get("failure_contains", [])
    return [message for message in errors if any(needle in message for needle in needles)]


def placeholder_gaps(value: object, path: str = "submission") -> list[str]:
    gaps: list[str] = []
    if isinstance(value, str) and PLACEHOLDER_RE.search(value):
        gaps.append(f"{path}: template placeholder remains")
    elif isinstance(value, dict):
        for key, item in value.items():
            gaps.extend(placeholder_gaps(item, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            gaps.extend(placeholder_gaps(item, f"{path}[{index}]"))
    return gaps


def requirement_applies(item: dict, submission: dict) -> bool:
    condition = item.get("condition")
    if condition == "shared_agreement":
        return any(
            isinstance(stakeholder, dict)
            and isinstance(stakeholder.get("agreement"), dict)
            and stakeholder["agreement"].get("kind") == "shared"
            for stakeholder in submission.get("real_stakeholders", [])
        )
    return True


def status_report() -> tuple[str, dict]:
    submission = load_json(ROOT / "submission.yaml")
    result = checker_result()
    errors = list(result.get("errors", []))
    warnings = list(result.get("warnings", []))
    errors.extend(message for message in placeholder_gaps(submission) if message not in errors)
    requirements = selected_requirements(submission)
    completed: list[dict] = []
    missing: list[dict] = []
    manual: list[dict] = []
    not_applicable: list[dict] = []
    matched_messages: set[str] = set()

    for item in requirements:
        if not requirement_applies(item, submission):
            not_applicable.append(item)
            continue
        matched = matching_errors(item, errors)
        matched_messages.update(matched)
        if matched:
            missing.append({"requirement": item, "errors": matched})
        elif "manual" in item["validation_type"] or "attestation" in item["validation_type"]:
            manual.append(item)
        else:
            completed.append(item)

    unmatched = [message for message in errors if message not in matched_messages]
    inbox_files = sorted(
        path.relative_to(ROOT).as_posix()
        for path in (ROOT / "inbox").rglob("*")
        if path.is_file() and path.relative_to(ROOT).as_posix() != "inbox/README.md"
    ) if (ROOT / "inbox").exists() else []
    decision_rows = {
        item.get("source_path"): item
        for item in submission.get("intake_file_decisions", [])
        if isinstance(item, dict) and isinstance(item.get("source_path"), str)
    }
    undecided_inbox_files = [name for name in inbox_files if name not in decision_rows]

    lines = [
        "# AI Product submission readiness report",
        "",
        f"**Final structural readiness:** {'PASS' if result.get('valid') else 'NOT READY'}",
        "",
    ]
    summary = result.get("summary", {})
    product = summary.get("product", {})
    lines.extend(
        [
            f"- Milestone: {summary.get('milestone')}",
            f"- Product: {product.get('title')}",
            f"- Stakeholder path: {product.get('stakeholder_path')}",
            f"- Declared supporting artifacts: {summary.get('supporting_artifact_count', 0)}",
            f"- Evidence files listed in the manifest: {summary.get('evidence_manifest_count', 0)}",
            f"- Intake-file decisions recorded: {summary.get('intake_decision_count', 0)}",
            f"- Declared referenced files: {summary.get('referenced_file_count', 0)}",
            f"- Files in `inbox/`: {len(inbox_files)} ({len(undecided_inbox_files)} undecided)",
            "",
            "## Completed automatic requirements",
            "",
        ]
    )
    lines.extend(
        [f"- **{item['id']}** — {item['text']}" for item in completed]
        or ["- None yet."]
    )
    lines.extend(["", "## Missing or invalid items", ""])
    if missing:
        for row in missing:
            item = row["requirement"]
            lines.append(f"### {item['id']}")
            lines.append("")
            lines.append(f"> {item['text']}")
            lines.append("")
            lines.extend(f"- {message}" for message in row["errors"])
            lines.append("")
    if unmatched:
        lines.append("### Other final-readiness gaps")
        lines.append("")
        lines.extend(f"- {message}" for message in unmatched)
        lines.append("")
    if not missing and not unmatched:
        lines.append("- No automatic gaps found.")

    lines.extend(["", "## Manual confirmation still required", ""])
    lines.extend(
        [f"- **{item['id']}** — {item['text']}" for item in manual]
        or ["- None."]
    )
    lines.extend(["", "## Warnings to review", ""])
    lines.extend([f"- {message}" for message in warnings] or ["- None."])
    lines.extend(["", "## Not applicable for the selected options", ""])
    lines.extend(
        [f"- **{item['id']}** — {item['text']}" for item in not_applicable]
        or ["- None."]
    )
    lines.extend(["", "## Intake-file decisions", ""])
    if inbox_files:
        for name in inbox_files:
            decision = decision_rows.get(name)
            if decision is None:
                lines.append(f"- `{name}` — **UNDECIDED**")
            else:
                target = decision.get("submitted_path")
                target_text = f" -> `{target}`" if target else ""
                lines.append(
                    f"- `{name}` — {decision.get('decision')}{target_text}; "
                    f"reason: {decision.get('reason')}"
                )
    else:
        lines.append("- None.")
    lines.extend(
        [
            "",
            "## Next step",
            "",
            "Ask an AI agent to resolve the listed gaps, or edit the files directly. When this",
            "report passes, run `python package_submission.py` to create and revalidate the",
            "declared-files-only ZIP.",
            "",
        ]
    )

    report = "\n".join(lines)
    structured = {
        "valid": result.get("valid", False),
        "summary": summary,
        "completed_requirement_ids": [item["id"] for item in completed],
        "missing": [
            {"requirement_id": row["requirement"]["id"], "errors": row["errors"]}
            for row in missing
        ],
        "manual_confirmation_requirement_ids": [item["id"] for item in manual],
        "not_applicable_requirement_ids": [item["id"] for item in not_applicable],
        "other_errors": unmatched,
        "warnings": warnings,
        "inbox_files": inbox_files,
        "undecided_inbox_files": undecided_inbox_files,
    }
    return report, structured


def command_status() -> int:
    report, structured = status_report()
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    (build / "submission-status.md").write_text(report, encoding="utf-8")
    save_json(build / "submission-status.json", structured)
    print(report)
    print(f"\nSaved: {build / 'submission-status.md'}")
    return 0 if structured["valid"] else 1


def command_inventory() -> int:
    inbox = ROOT / "inbox"
    files = sorted(
        path
        for path in inbox.rglob("*")
        if path.is_file() and path.relative_to(ROOT).as_posix() != "inbox/README.md"
    )
    if not files:
        print("The inbox is empty. Add any available files or natural-language notes to inbox/.")
        return 0
    print("Files available for an AI agent or student to organize:")
    for path in files:
        suffix = path.suffix.lower()
        suggestion = "supporting artifact"
        if suffix in {".eml", ".msg", ".pdf", ".wav", ".mp3", ".m4a", ".mp4", ".mov"}:
            suggestion = "inspect: possibly stakeholder-path evidence"
        elif suffix in {".md", ".txt"}:
            suggestion = "inspect: context, report, documentation, or evidence"
        print(f"  - {path.relative_to(ROOT)} ({path.stat().st_size} bytes) — {suggestion}")
    print(
        "Nothing in inbox/ is packaged automatically. Every file needs an explicit "
        "intake_file_decisions include-or-ignore record."
    )
    return 0


def prompt(label: str, current: object = "") -> str:
    shown = f" [{current}]" if current else ""
    answer = input(f"{label}{shown}: ").strip()
    return answer or str(current)


def command_start() -> int:
    current = load_json(ROOT / "submission.yaml") if (ROOT / "submission.yaml").exists() else {}
    current_path = current.get("product", {}).get("stakeholder_path", "real")
    chosen = prompt("Stakeholder path (real or virtual)", current_path).lower()
    if chosen not in {"real", "virtual"}:
        print("Please enter exactly real or virtual.")
        return 1
    example = ROOT / "examples" / f"submission-{chosen}.yaml"
    data = load_json(example)
    data["student"]["name"] = prompt("Student name", current.get("student", {}).get("name", ""))
    data["student"]["purdue_email"] = prompt(
        "Purdue email", current.get("student", {}).get("purdue_email", "")
    )
    data["student"]["puid"] = prompt("PUID", current.get("student", {}).get("puid", ""))
    data["product"]["title"] = prompt(
        "Current product title", current.get("product", {}).get("title", "")
    )
    data["student_attestations"]["student_name"] = data["student"]["name"]
    data["submission_mode"] = "format_test"
    backup = ROOT / "build" / "backups" / "submission-before-start.yaml"
    backup.parent.mkdir(parents=True, exist_ok=True)
    if (ROOT / "submission.yaml").exists():
        shutil.copy2(ROOT / "submission.yaml", backup)
    save_json(ROOT / "submission.yaml", data)
    print("Created the selected starter record. Existing submission.yaml was backed up under build/backups/.")
    print("Next: add files or notes to inbox/, ask an AI agent to help, then run status.")
    return command_status()


def command_explain(requirement_id: str) -> int:
    registry = load_json(REGISTRY)
    item = next((row for row in registry["requirements"] if row["id"] == requirement_id), None)
    if item is None:
        print(f"Unknown requirement ID: {requirement_id}")
        return 1
    print(f"{item['id']} ({item['validation_type']})")
    print(f"> {item['text']}")
    print(f"Validator mapping: {item['checker_anchor']}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Guide an AI Product submission from intake to final ZIP")
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("start", help="answer a few basic questions and select the path starter")
    subparsers.add_parser("inventory", help="list files waiting in inbox/")
    subparsers.add_parser("status", help="write a completed/missing/manual readiness report")
    explain = subparsers.add_parser("explain", help="quote and explain one formal requirement")
    explain.add_argument("requirement_id")
    subparsers.add_parser("package", help="build and validate the exact final ZIP")
    args = parser.parse_args()

    if args.command in {None, "status"}:
        return command_status()
    if args.command == "start":
        return command_start()
    if args.command == "inventory":
        return command_inventory()
    if args.command == "explain":
        return command_explain(args.requirement_id)
    if args.command == "package":
        return subprocess.run([sys.executable, str(ROOT / "package_submission.py")]).returncode
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
