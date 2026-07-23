"""Tests for private knowledge usage heat logging and reports."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import knowledge_query as kq  # noqa: E402
import knowledge_usage as ku  # noqa: E402


@pytest.fixture
def workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "ws"
    root.mkdir()
    (root / "knowledge" / "facts" / "workspace").mkdir(parents=True)
    (root / "knowledge" / "facts" / "workspace" / "alpha.md").write_text(
        "---\nname: Alpha\ndescription: first fact\ntype: reference\n"
        "scope: workspace\nverified_at: 2026-07-21\nsource: human:test\n---\n\nbody alpha\n",
        encoding="utf-8",
    )
    (root / "knowledge" / "facts" / "workspace" / "beta.md").write_text(
        "---\nname: Beta\ndescription: second fact\ntype: reference\n"
        "scope: workspace\nverified_at: 2026-07-21\nsource: human:test\n---\n\nbody beta\n",
        encoding="utf-8",
    )
    runtime = tmp_path / "runtime"
    monkeypatch.setenv("SHARED_KNOWLEDGE_RUNTIME_DIR", str(runtime))
    monkeypatch.delenv("SHARED_KNOWLEDGE_USAGE_HEAT", raising=False)
    assert kq.cmd_rebuild_index(root) == 0
    return root


def test_search_emits_events_and_heat_report(workspace: Path, capsys: pytest.CaptureFixture[str]) -> None:
    args = type("A", (), {"query": "alpha", "scope": None, "type": None, "limit": 10, "verbose": False, "task_type": ""})()
    assert kq.cmd_search(workspace, args) == 0
    out = capsys.readouterr().out
    assert "alpha" in out.lower() or "Alpha" in out

    events = ku.read_events(workspace)
    assert len(events) >= 1
    assert events[0]["event"] == "search_hit"
    assert "query" not in events[0]
    assert events[0].get("query_hash")

    report = ku.aggregate_heat(workspace, window_days=30, top=5)
    assert report["eventCount"] >= 1
    assert report["hot"]
    cold_paths = {c.get("path") for c in report["cold"]}
    assert any(p and "beta" in p for p in cold_paths)


def test_disable_env_skips_logging(workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SHARED_KNOWLEDGE_USAGE_HEAT", "0")
    args = type("A", (), {"query": "alpha", "scope": None, "type": None, "limit": 10, "verbose": False, "task_type": ""})()
    assert kq.cmd_search(workspace, args) == 0
    assert ku.read_events(workspace) == []


def test_fail_open_when_log_unwritable(workspace: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(ku, "append_events", boom)
    # emit_hits catches via append - actually append is replaced so emit_hits raises
    # cmd_search wraps emit in try/except
    args = type("A", (), {"query": "alpha", "scope": None, "type": None, "limit": 10, "verbose": False, "task_type": ""})()
    # Patch emit_hits at import site used by cmd_search - it imports inside try
    import knowledge_usage as mod

    monkeypatch.setattr(mod, "emit_hits", lambda *a, **k: (_ for _ in ()).throw(OSError("nope")))
    assert kq.cmd_search(workspace, args) == 0


def test_purge_removes_old_events(workspace: Path) -> None:
    ku.append_events(workspace, [{
        "event": "search_hit",
        "entry_id": "x",
        "path": "knowledge/facts/workspace/alpha.md",
        "scope": "workspace",
        "type": "reference",
        "command": "search",
    }])
    path = ku.events_path(workspace)
    # Rewrite timestamp to ancient
    lines = path.read_text(encoding="utf-8").splitlines()
    old = json.loads(lines[0])
    old["ts"] = "2000-01-01T00:00:00Z"
    path.write_text(json.dumps(old) + "\n", encoding="utf-8")
    removed = ku.purge_events(workspace, retention_days=30)
    assert removed == 1
    assert ku.read_events(workspace) == []


def test_ranking_unchanged_with_logging(workspace: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    args = type("A", (), {"query": "fact", "scope": None, "type": None, "limit": 10, "verbose": False, "task_type": ""})()
    assert kq.cmd_search(workspace, args) == 0
    on = json.loads(capsys.readouterr().out)
    monkeypatch.setenv("SHARED_KNOWLEDGE_USAGE_HEAT", "0")
    assert kq.cmd_search(workspace, args) == 0
    off = json.loads(capsys.readouterr().out)
    assert [r["id"] for r in on["results"]] == [r["id"] for r in off["results"]]
    assert [r["score"] for r in on["results"]] == [r["score"] for r in off["results"]]
