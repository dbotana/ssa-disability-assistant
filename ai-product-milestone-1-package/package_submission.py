#!/usr/bin/env python3
"""Build and revalidate a declared-files-only AI Product submission ZIP."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent
CHECKER = ROOT / "check_submission.py"


def run_checker(target: Path) -> tuple[int, dict, str]:
    process = subprocess.run(
        [sys.executable, str(CHECKER), str(target), "--final", "--json"],
        capture_output=True,
        text=True,
    )
    try:
        payload = json.loads(process.stdout)
    except json.JSONDecodeError:
        payload = {}
    return process.returncode, payload, process.stderr


def safe_filename(value: object) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "student")).strip("-.")
    return cleaned or "student"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Package only files declared in submission.yaml, then validate the exact ZIP"
    )
    parser.add_argument("--output", type=Path, help="output ZIP path; defaults to build/")
    args = parser.parse_args()

    code, result, stderr = run_checker(ROOT)
    if code != 0 or not result.get("valid"):
        print("The working submission is not ready to package. Fix these items first:")
        for message in result.get("errors", []):
            print(f"  - {message}")
        if stderr:
            print(stderr, file=sys.stderr)
        print("Run: python guide_submission.py status")
        return 1

    summary = result["summary"]
    milestone = summary["milestone"]
    student_id = safe_filename(summary["student"].get("puid"))
    output = args.output or ROOT / "build" / f"ai-product-milestone-{milestone}-{student_id}.zip"
    if not output.is_absolute():
        output = ROOT / output
    output.parent.mkdir(parents=True, exist_ok=True)

    declared = ["submission.yaml", *summary.get("referenced_files", [])]
    names: list[str] = []
    for name in declared:
        if name in names:
            continue
        path = ROOT / name
        if path.is_symlink():
            print(f"Refusing to package symbolic link: {name}")
            return 1
        if not path.is_file():
            print(f"Declared file is missing or is not a regular file: {name}")
            return 1
        names.append(name)

    with tempfile.NamedTemporaryFile(
        prefix="aip-package-", suffix=".zip", dir=output.parent, delete=False
    ) as temporary:
        temporary_path = Path(temporary.name)
    try:
        with zipfile.ZipFile(temporary_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(names):
                archive.write(ROOT / name, name)

        zip_code, zip_result, zip_stderr = run_checker(temporary_path)
        if zip_code != 0 or not zip_result.get("valid"):
            print("The exact packaged ZIP failed final validation:")
            for message in zip_result.get("errors", []):
                print(f"  - {message}")
            if zip_stderr:
                print(zip_stderr, file=sys.stderr)
            return 1
        os.replace(temporary_path, output)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()

    print(f"Created: {output}")
    final_summary = zip_result["summary"]
    final_product = final_summary["product"]
    final_student = final_summary["student"]
    print("Final submission summary:")
    print(
        f"  Milestone {final_summary['milestone']} | {final_product['stakeholder_path']} path | "
        f"{final_product['title']}"
    )
    print(
        f"  Student: {final_student['name']} | {final_student['purdue_email']} | "
        f"PUID {final_student['puid']}"
    )
    print(
        f"  Declared artifacts: {final_summary['supporting_artifact_count']} | "
        f"evidence files: {final_summary['evidence_manifest_count']} | "
        f"real stakeholders: {final_summary['real_stakeholder_count']} | "
        f"virtual personas: {final_summary['virtual_persona_count']}"
    )
    print(
        f"  Attestations true: {final_summary['attestations_true']}/"
        f"{final_summary['attestations_expected']}"
    )
    print(f"Files packaged: {len(names)}")
    for name in sorted(names):
        print(f"  - {name}")
    print("Exact ZIP validation: PASS (same structural checker used for the workspace)")
    print("Open the ZIP and compare its contents with the summary before uploading.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
