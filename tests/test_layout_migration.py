from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "knowledge_query.py"


def legacy(tmp_path: Path) -> Path:
    root = tmp_path / "ws"; root.mkdir()
    (root / "AGENTS.md").write_text("## Shared Memory\nSee `knowledge/shared-memory/MEMORY.md`.\n")
    for scope in ("workspace", "module/payroll", "capability/search", "inbox"):
        (root / "knowledge" / "shared-memory" / scope).mkdir(parents=True)
    (root / "knowledge/shared-memory/workspace/fact.md").write_text("workspace fact\n")
    (root / "knowledge/shared-memory/module/payroll/fact.md").write_text("module fact\n")
    (root / "knowledge/shared-memory/capability/search/fact.md").write_text("capability fact\n")
    (root / "knowledge/shared-memory/inbox/new.md").write_text("inbox fact\n")
    (root / "knowledge/shared-memory/MEMORY.md").write_text("index\n")
    return root


def run(root: Path, *args: str):
    return subprocess.run([sys.executable, str(SCRIPT), "--root", str(root), "migrate-layout", "--from", "shared-memory-v1", *args], text=True, capture_output=True)


def snapshot(root: Path):
    return {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob("*") if p.is_file()}


def test_dry_run_is_immutable_and_reports_hashes(tmp_path):
    root = legacy(tmp_path); before = snapshot(root)
    result = run(root, "--dry-run")
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["status"] == "ready" and all(x["sha256"] for x in data["files"])
    assert snapshot(root) == before


def test_successful_cutover_preserves_content_and_rewrites_b1(tmp_path):
    root = legacy(tmp_path)
    result = run(root)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data["verifiedCount"] == 5
    assert (root / "knowledge/facts/workspace/fact.md").read_text() == "workspace fact\n"
    assert (root / "knowledge/facts/module/payroll/fact.md").exists()
    assert (root / "knowledge/facts/capability/search/fact.md").exists()
    assert (root / "knowledge/inbox/new.md").exists()
    assert not (root / "knowledge/shared-memory").exists()
    agents = (root / "AGENTS.md").read_text()
    assert agents.count("<!-- shared-knowledge B1 -->") == 1
    assert "knowledge/facts/workspace/MEMORY.md" in agents


def test_collision_refuses_source_cleanup(tmp_path):
    root = legacy(tmp_path)
    destination = root / "knowledge/facts/workspace/fact.md"
    destination.parent.mkdir(parents=True); destination.write_text("different\n")
    result = run(root)
    assert result.returncode == 1
    assert json.loads(result.stdout)["collisions"]
    assert (root / "knowledge/shared-memory/workspace/fact.md").exists()
