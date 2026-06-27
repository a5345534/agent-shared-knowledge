"""Integration tests: init on temp workspace → lint 0 errors, search valid output.

Slice 4 – Verification (tasks 4.7, 4.8).
"""

from __future__ import annotations

import os
import sys
import subprocess
import tempfile

sys.dont_write_bytecode = True

from pathlib import Path

import pytest

# Ensure scripts directory is importable.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from knowledge_query import (
    cmd_init,
    find_workspace_root,
    now_iso,
    _init_create_directories,
    _init_ensure_gitignore,
    _init_rebuild_index,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _create_starter_dir(ws: Path) -> None:
    """Create the starter directory structure needed by _init_copy_starters."""
    starter = ws / "shared-knowledge" / "starter" / "knowledge" / "facts"
    starter.mkdir(parents=True, exist_ok=True)
    (starter / "README.md").write_text("# Facts\n", encoding="utf-8")
    (starter / "workspace").mkdir(parents=True, exist_ok=True)
    (starter / "workspace" / "README.md").write_text("# Workspace\n", encoding="utf-8")
    (starter / "workspace" / "MEMORY.md").write_text("## Memory\n", encoding="utf-8")
    (starter / "module").mkdir(parents=True, exist_ok=True)
    (starter / "module" / "README.md").write_text("# Module\n", encoding="utf-8")
    (starter / "capability").mkdir(parents=True, exist_ok=True)
    (starter / "capability" / "README.md").write_text("# Capability\n", encoding="utf-8")
    (starter / "inbox").mkdir(parents=True, exist_ok=True)
    (starter / "inbox" / "README.md").write_text("# Inbox\n", encoding="utf-8")
    (starter / "followups" / "skill").mkdir(parents=True, exist_ok=True)
    (starter / "followups" / "module-doc").mkdir(parents=True, exist_ok=True)
    (starter / "followups" / "README.md").write_text("# Followups\n", encoding="utf-8")
    (starter / "followups" / "skill" / ".gitkeep").write_text("", encoding="utf-8")
    (starter / "followups" / "module-doc" / ".gitkeep").write_text("", encoding="utf-8")

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def temp_workspace(tmp_path: Path) -> Path:
    """Create a temporary workspace that mimics a real project root."""
    ws = tmp_path / "project"
    ws.mkdir()
    (ws / "AGENTS.md").write_text("# Test Project\n", encoding="utf-8")
    (ws / ".gitignore").write_text("*.pyc\n", encoding="utf-8")
    # Create a minimal knowledge layout so lint can find workspace scope
    return ws


# ---------------------------------------------------------------------------
# Integration: init → lint 0 errors (task 4.7)
# ---------------------------------------------------------------------------


def test_init_then_lint_zero_errors(temp_workspace: Path) -> None:
    """After init on a clean temp workspace, lint returns 0 errors (4.7).

    This validates that init produces a state the linter accepts.
    """
    ws = temp_workspace

    # Provide starter directory so the step succeeds
    _create_starter_dir(ws)

    # Run init with --skip-hook to avoid harness detection
    exit_init = cmd_init(ws, _args(skip_hook=True, dry_run=False))
    assert exit_init == 0, f"init failed with exit code {exit_init}"

    lint_script = Path(__file__).resolve().parent.parent / "scripts" / "knowledge_lint.py"

    # Run lint via subprocess
    result = subprocess.run(
        [sys.executable, str(lint_script), "--root", str(ws)],
        capture_output=True,
        text=True,
        timeout=15,
    )
    # lint returns exit code 0 when no errors (warnings are OK)
    assert result.returncode == 0, f"lint failed with code {result.returncode}:\n{result.stderr}"


def test_init_then_search_valid_output(temp_workspace: Path) -> None:
    """After init, search "test" returns valid JSON output even with 0 entries (4.8)."""
    ws = temp_workspace

    _create_starter_dir(ws)

    # Run init
    exit_init = cmd_init(ws, _args(skip_hook=True, dry_run=False))
    assert exit_init == 0

    # Run search via subprocess
    query_script = Path(__file__).resolve().parent.parent / "scripts" / "knowledge_query.py"
    if not query_script.exists():
        pytest.skip("knowledge_query.py not found in test context")

    result = subprocess.run(
        [sys.executable, str(query_script), "--root", str(ws), "search", "test"],
        capture_output=True,
        text=True,
        timeout=10,
    )

    assert result.returncode == 0, f"search failed: {result.stderr}"
    output = result.stdout.strip()
    assert output, "search produced no output"

    # Parse as JSON
    import json
    try:
        data = json.loads(output)
    except json.JSONDecodeError as exc:
        pytest.fail(f"search output is not valid JSON: {exc}\nOutput:\n{output[:500]}")

    # Verify structure
    assert "version" in data, "Missing 'version' in search result"
    assert "results" in data, "Missing 'results' in search result"
    assert isinstance(data["results"], list), "'results' should be a list"
    # 0 results is valid for an empty workspace


def test_init_cli_bootstraps_workspace_without_existing_markers(tmp_path: Path) -> None:
    """CLI init can create AGENTS.md when the target has no workspace markers."""
    ws = tmp_path / "brand-new-project"
    ws.mkdir()
    _create_starter_dir(ws)

    query_script = Path(__file__).resolve().parent.parent / "scripts" / "knowledge_query.py"
    result = subprocess.run(
        [sys.executable, str(query_script), "--root", str(ws), "init", "--skip-hook"],
        capture_output=True,
        text=True,
        timeout=15,
    )

    assert result.returncode == 0, f"init failed: stdout={result.stdout}\nstderr={result.stderr}"
    assert (ws / "AGENTS.md").exists()
    assert (ws / "knowledge" / "facts" / "workspace" / "MEMORY.md").exists()
    assert (ws / "knowledge" / "inbox" / "README.md").exists()
    assert (ws / "knowledge" / "followups" / "skill" / ".gitkeep").exists()


# ---------------------------------------------------------------------------
# Integration: init on existing workspace with inbox candidates
# ---------------------------------------------------------------------------


def test_init_with_some_facts(temp_workspace: Path) -> None:
    """Init works correctly when some facts already exist before init."""
    ws = temp_workspace

    # Manually create some facts before init
    facts_workspace = ws / "knowledge" / "facts" / "workspace"
    facts_workspace.mkdir(parents=True, exist_ok=True)
    (facts_workspace / "my-fact.md").write_text(
        "---\nname: Existing Fact\ndescription: Pre-existing\ntype: reference\n---\nBody\n",
        encoding="utf-8",
    )

    _create_starter_dir(ws)

    # Run init — should not overwrite existing fact
    exit_init = cmd_init(ws, _args(skip_hook=True, dry_run=False))
    assert exit_init == 0

    # Existing fact should still be there
    fact_content = (facts_workspace / "my-fact.md").read_text(encoding="utf-8")
    assert "Existing Fact" in fact_content
    assert "Pre-existing" in fact_content


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _args(**kwargs: object) -> object:
    """Create a minimal argparse.Namespace stand-in."""
    from types import SimpleNamespace
    return SimpleNamespace(**kwargs)
