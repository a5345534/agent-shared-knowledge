from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "knowledge_query.py"


def legacy(tmp_path: Path) -> Path:
    root = tmp_path / "ws"; root.mkdir()
    (root / "AGENTS.md").write_text(
        "## Shared Memory\n"
        "- [Index](knowledge/shared-memory/workspace/MEMORY.md)\n"
        "- [Workspace fact](knowledge/shared-memory/workspace/fact.md)\n"
        "- [Payroll](knowledge/shared-memory/module/payroll/fact.md)\n"
        "- [Search](knowledge/shared-memory/capability/search/fact.md)\n"
        "- [Inbox](knowledge/shared-memory/inbox/new.md)\n\n"
        "## Historical Notes\n"
        "Do not rewrite historical text: knowledge/shared-memory/workspace/old.md\n"
    )
    for scope in ("workspace", "module/payroll", "capability/search", "inbox"):
        (root / "knowledge" / "shared-memory" / scope).mkdir(parents=True)
    (root / "knowledge/shared-memory/workspace/MEMORY.md").write_text("index\n")
    (root / "knowledge/shared-memory/workspace/fact.md").write_text("workspace fact\n")
    (root / "knowledge/shared-memory/module/payroll/fact.md").write_text("module fact\n")
    (root / "knowledge/shared-memory/capability/search/fact.md").write_text("capability fact\n")
    (root / "knowledge/shared-memory/inbox/new.md").write_text("inbox fact\n")
    return root


def run(root: Path, *args: str):
    return subprocess.run([sys.executable, str(SCRIPT), "--root", str(root), "migrate-layout", "--from", "shared-memory-v1", *args], text=True, capture_output=True)


def snapshot(root: Path):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}


def test_dry_run_is_immutable_and_reports_hashes_and_b1_rewrites(tmp_path):
    root = legacy(tmp_path); before = snapshot(root)
    result = run(root, "--dry-run")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "ready" and all(x["sha256"] for x in data["files"])
    assert len(data["b1Rewrites"]) == 5
    assert {
        "source": "knowledge/shared-memory/workspace/MEMORY.md",
        "destination": "knowledge/facts/workspace/MEMORY.md",
    } in data["b1Rewrites"]
    assert snapshot(root) == before


def test_successful_cutover_preserves_content_and_rewrites_production_b1(tmp_path):
    root = legacy(tmp_path)
    result = run(root)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["verifiedCount"] == 5
    assert data["b1Validation"] == {"legacyRefs": [], "missingDestinations": []}
    assert (root / "knowledge/facts/workspace/MEMORY.md").read_text() == "index\n"
    assert (root / "knowledge/facts/workspace/fact.md").read_text() == "workspace fact\n"
    assert (root / "knowledge/facts/module/payroll/fact.md").exists()
    assert (root / "knowledge/facts/capability/search/fact.md").exists()
    assert (root / "knowledge/inbox/new.md").exists()
    assert not (root / "knowledge/shared-memory").exists()
    agents = (root / "AGENTS.md").read_text()
    assert agents.count("<!-- shared-knowledge B1 -->") == 1
    assert "knowledge/facts/workspace/MEMORY.md" in agents
    assert "knowledge/facts/workspace/fact.md" in agents
    assert "knowledge/facts/module/payroll/fact.md" in agents
    assert "knowledge/facts/capability/search/fact.md" in agents
    assert "knowledge/inbox/new.md" in agents
    assert "Do not rewrite historical text: knowledge/shared-memory/workspace/old.md" in agents


def test_migration_removes_duplicate_legacy_b1_section(tmp_path):
    root = legacy(tmp_path)
    (root / "AGENTS.md").write_text(
        "<!-- shared-knowledge B1 -->\n"
        "## Workspace Shared Knowledge\n"
        "See `knowledge/facts/workspace/MEMORY.md`.\n\n"
        "## Shared Memory\n"
        "See `knowledge/shared-memory/workspace/MEMORY.md`.\n\n"
        "## Other Guidance\nKeep this.\n"
    )
    result = run(root)
    assert result.returncode == 0, result.stderr
    agents = (root / "AGENTS.md").read_text()
    assert agents.count("<!-- shared-knowledge B1 -->") == 1
    assert agents.count("knowledge/facts/workspace/MEMORY.md") == 1
    assert "## Shared Memory" not in agents
    assert "## Other Guidance\nKeep this." in agents


def test_unresolved_active_b1_link_refuses_source_cleanup(tmp_path):
    root = legacy(tmp_path)
    agents = (root / "AGENTS.md").read_text()
    agents = agents.replace(
        "## Historical Notes",
        "- [Missing](knowledge/shared-memory/workspace/missing.md)\n\n## Historical Notes",
    )
    (root / "AGENTS.md").write_text(agents)
    result = run(root)
    assert result.returncode == 1
    data = json.loads(result.stdout)
    assert data["status"] == "b1_validation_failed"
    assert data["b1Validation"]["missingDestinations"] == ["knowledge/facts/workspace/missing.md"]
    assert (root / "knowledge/shared-memory/workspace/fact.md").exists()
    assert "knowledge/shared-memory/workspace/missing.md" in (root / "AGENTS.md").read_text()


def test_collision_refuses_source_cleanup(tmp_path):
    root = legacy(tmp_path)
    destination = root / "knowledge/facts/workspace/fact.md"
    destination.parent.mkdir(parents=True); destination.write_text("different\n")
    result = run(root)
    assert result.returncode == 1
    assert json.loads(result.stdout)["collisions"]
    assert (root / "knowledge/shared-memory/workspace/fact.md").exists()
