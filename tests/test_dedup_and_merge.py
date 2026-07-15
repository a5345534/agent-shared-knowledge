"""Coverage for deterministic absorption deduplication and merge behavior."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import jsonschema

import knowledge_absorb as ka
import knowledge_lint as kl
from tests.conftest import _write_curated_entry, _write_inbox_candidate

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
PACKAGE_ROOT = SCRIPTS_DIR.parent


def _rebuild_index(workspace: Path) -> None:
    result = subprocess.run(
        [sys.executable, "-B", str(SCRIPTS_DIR / "knowledge_query.py"), "--root", str(workspace), "rebuild-index"],
        cwd=workspace,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr


def _merge_action(candidate: Path, target: Path, workspace: Path, strategy: str) -> dict:
    return {
        "candidatePath": candidate.relative_to(workspace).as_posix(),
        "action": "merge_into_existing",
        "destination": target.relative_to(workspace).as_posix(),
        "mergeInto": target.relative_to(workspace).as_posix(),
        "mergeStrategy": strategy,
        "safeToApply": True,
        "metadata": {"suggestedScope": "workspace"},
    }


def _candidate_and_target(workspace: Path) -> tuple[Path, Path]:
    target = _write_curated_entry(
        workspace,
        "knowledge/facts/workspace",
        "existing.md",
        name="Existing Operational Rule",
        description="The existing canonical rule.",
        body="Canonical body.\n\n## Evidence\n- Existing evidence",
        source="agent:existing",
    )
    candidate = _write_inbox_candidate(
        workspace,
        "candidate.md",
        name="Updated Operational Rule",
        description="New evidence for the rule.",
        body="Candidate body.\n\n## Evidence\n- New evidence",
    )
    return candidate, target


def test_dedup_check_high_match_routes_to_merge(workspace):
    _write_curated_entry(
        workspace,
        "knowledge/facts/workspace",
        "validation-hook.md",
        name="System Validation Hook",
        description="A validation hook that runs before every commit.",
    )
    _rebuild_index(workspace)

    result = ka.dedup_check(
        workspace,
        {"name": "System Validation Hook", "description": "A validation hook that runs before every commit."},
        "Matching candidate body.",
    )

    assert result is not None
    assert result["action"] == "merge_into_existing"
    assert result["mergeInto"].endswith("validation-hook.md")


def test_dedup_check_below_threshold_returns_none(workspace, monkeypatch):
    _write_curated_entry(
        workspace,
        "knowledge/facts/workspace",
        "validation-hook.md",
        name="Validation Hook",
        description="Checks commits.",
    )
    _rebuild_index(workspace)
    monkeypatch.setenv("SHARED_MEMORY_DEDUP_THRESHOLD_HIGH", "100")
    monkeypatch.setenv("SHARED_MEMORY_DEDUP_THRESHOLD_MEDIUM", "100")

    result = ka.dedup_check(
        workspace,
        {"name": "Validation Pipeline", "description": "A separate deployment process."},
        "Different candidate body.",
    )

    assert result is None


def test_apply_merge_append_evidence(workspace):
    candidate, target = _candidate_and_target(workspace)
    changed, error = ka.apply_merge_into_existing(workspace, _merge_action(candidate, target, workspace, "append_evidence"))

    assert error is None
    assert not candidate.exists()
    assert target.relative_to(workspace).as_posix() in changed
    content = target.read_text(encoding="utf-8")
    assert "Existing evidence" in content
    assert "New evidence" in content
    assert content.count("New evidence") == 1


def test_apply_merge_update_body(workspace):
    candidate, target = _candidate_and_target(workspace)
    changed, error = ka.apply_merge_into_existing(workspace, _merge_action(candidate, target, workspace, "update_body"))

    assert error is None
    assert changed
    content = target.read_text(encoding="utf-8")
    assert "Canonical body." in content
    assert "## Additional Context" in content
    assert "Candidate body." in content


def test_apply_merge_replace(workspace):
    candidate, target = _candidate_and_target(workspace)
    changed, error = ka.apply_merge_into_existing(workspace, _merge_action(candidate, target, workspace, "replace"))

    assert error is None
    assert changed
    content = target.read_text(encoding="utf-8")
    assert "Candidate body." in content
    assert "Canonical body." not in content
    assert "knowledge/inbox/candidate.md" in content


def test_apply_merge_missing_candidate_returns_error(workspace):
    target = _write_curated_entry(workspace, "knowledge/facts/workspace", "existing.md")
    missing = workspace / "knowledge/inbox/missing.md"

    changed, error = ka.apply_merge_into_existing(workspace, _merge_action(missing, target, workspace, "append_evidence"))

    assert changed == []
    assert error == "missing candidate: knowledge/inbox/missing.md"


def test_apply_plan_dispatches_merge_into_existing(workspace):
    candidate, target = _candidate_and_target(workspace)
    action = _merge_action(candidate, target, workspace, "append_evidence")

    result = ka.apply_plan(workspace, {"actions": [action]}, safe_only=True)

    assert not result.skipped
    assert target.relative_to(workspace).as_posix() in result.changedPaths
    assert not candidate.exists()


def test_content_overlap_flags_similar_entries(workspace):
    _write_curated_entry(workspace, "knowledge/facts/workspace", "one.md", name="Duplicate Validation Rule")
    _write_curated_entry(workspace, "knowledge/facts/module/testmod", "two.md", name="Duplicate Validation Rule", scope="module:testmod")
    _rebuild_index(workspace)
    findings: list[kl.Finding] = []

    kl.check_content_overlap(workspace, findings)

    assert any(f.check_id == "content-overlap" for f in findings)


def test_content_overlap_skips_deprecated_entries(workspace):
    _write_curated_entry(workspace, "knowledge/facts/workspace", "active.md", name="Duplicate Validation Rule")
    _write_curated_entry(
        workspace,
        "knowledge/facts/module/testmod",
        "deprecated.md",
        name="Duplicate Validation Rule",
        scope="module:testmod",
        memory_type="deprecated",
    )
    _rebuild_index(workspace)
    findings: list[kl.Finding] = []

    kl.check_content_overlap(workspace, findings)

    assert not any(f.check_id == "content-overlap" for f in findings)


def test_merge_action_schema_accepts_required_fields():
    schema = json.loads((PACKAGE_ROOT / "schemas/absorption-plan.schema.json").read_text(encoding="utf-8"))
    plan = {
        "version": "1",
        "generatedAt": "2026-07-15T00:00:00Z",
        "trigger": "test",
        "pressure": {
            "triggered": False,
            "reasons": [],
            "thresholds": {"inboxMaxAgeDays": 14, "inboxMaxCount": 10, "workspaceMaxCount": 20},
            "metrics": {"inboxCount": 1, "oldestInboxAgeDays": 0, "oldestInboxPath": "knowledge/inbox/candidate.md", "workspaceMemoryCount": 1},
        },
        "actions": [
            {
                "candidatePath": "knowledge/inbox/candidate.md",
                "action": "merge_into_existing",
                "reason": "Exact duplicate",
                "evidence": ["same operational rule"],
                "destination": "knowledge/facts/workspace/existing.md",
                "mergeInto": "knowledge/facts/workspace/existing.md",
                "mergeStrategy": "append_evidence",
                "confidence": 0.95,
                "safeToApply": True,
                "metadata": {},
            }
        ],
    }

    jsonschema.validate(plan, schema)
