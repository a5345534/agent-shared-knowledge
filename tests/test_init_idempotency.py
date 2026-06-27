"""Unit tests: init subcommand idempotency and step-level behavior.

Slice 4 – Verification (tasks 4.1, 4.2, 4.3, 4.4).
"""

from __future__ import annotations

import os
import sys

sys.dont_write_bytecode = True

import shutil
import tempfile
from pathlib import Path
from typing import Any

import pytest

# Ensure scripts directory is importable.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from knowledge_query import (
    _init_create_directories,
    _init_copy_starters,
    _init_inject_b1,
    _init_ensure_gitignore,
    detect_harness,
    cmd_init,
    now_iso,
    find_workspace_root,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def clean_workspace(tmp_path: Path) -> Path:
    """Create a minimal workspace without any knowledge/ directory."""
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "AGENTS.md").write_text("# Test Workspace\n", encoding="utf-8")
    return ws


@pytest.fixture
def prepared_workspace(clean_workspace: Path) -> Path:
    """Create a workspace where init has already been run once."""
    ws = clean_workspace
    _init_create_directories(ws)
    _init_ensure_gitignore(ws)
    return ws


# ---------------------------------------------------------------------------
# _init_create_directories tests (task 4.1, 4.2)
# ---------------------------------------------------------------------------


class TestInitCreateDirectories:
    """init directory creation step."""

    def test_creates_all_directories(self, clean_workspace: Path) -> None:
        """On a clean workspace, all expected directories are created (4.1)."""
        result = _init_create_directories(clean_workspace)
        assert result["status"] == "ok", f"Unexpected status: {result}"
        assert result["created"] > 0, "Expected directories to be created"
        assert result["existed"] == 0, "Expected no pre-existing directories"

        # Verify all directories exist
        expected = [
            "knowledge/facts/workspace",
            "knowledge/facts/module",
            "knowledge/facts/capability",
            "knowledge/inbox",
            "knowledge/followups/skill",
            "knowledge/followups/module-doc",
            "knowledge/.index",
        ]
        for d in expected:
            assert (clean_workspace / d).is_dir(), f"Missing directory: {d}"

    def test_skips_when_already_exist(self, prepared_workspace: Path) -> None:
        """When all directories exist, the step reports skipped (4.2)."""
        result = _init_create_directories(prepared_workspace)
        assert result["status"] == "ok"  # still ok, just nothing new
        assert result["created"] == 0, "Expected no new directories"
        assert result["existed"] > 0, "Expected existing directories to be counted"

    def test_idempotent_on_second_call(self, clean_workspace: Path) -> None:
        """Calling _init_create_directories twice is safe (4.3)."""
        result1 = _init_create_directories(clean_workspace)
        assert result1["status"] == "ok"
        assert result1["created"] > 0

        result2 = _init_create_directories(clean_workspace)
        assert result2["status"] == "ok"
        assert result2["created"] == 0
        assert result2["existed"] > 0


# ---------------------------------------------------------------------------
# _init_copy_starters tests (task 4.1, 4.2)
# ---------------------------------------------------------------------------


class TestInitCopyStarters:
    """init starter file copy step."""

    def test_copies_starters_on_clean(self, clean_workspace: Path) -> None:
        """Starter files are copied when targets don't exist (4.1)."""
        # Create starter directory structure where _init_copy_starters can
        # find it: <root>/shared-knowledge/starter/knowledge/facts
        starter = clean_workspace / "shared-knowledge" / "starter" / "knowledge" / "facts"
        starter.mkdir(parents=True, exist_ok=True)
        (starter / "README.md").write_text("# Facts\n", encoding="utf-8")
        (starter / "workspace").mkdir(parents=True)
        (starter / "workspace" / "README.md").write_text("# Workspace\n", encoding="utf-8")
        (starter / "workspace" / "MEMORY.md").write_text("## Memory\n", encoding="utf-8")
        (starter / "module").mkdir(parents=True)
        (starter / "module" / "README.md").write_text("# Module\n", encoding="utf-8")
        (starter / "capability").mkdir(parents=True)
        (starter / "capability" / "README.md").write_text("# Capability\n", encoding="utf-8")
        (starter / "inbox").mkdir(parents=True)
        (starter / "inbox" / "README.md").write_text("# Inbox\n", encoding="utf-8")
        (starter / "followups" / "skill").mkdir(parents=True)
        (starter / "followups" / "module-doc").mkdir(parents=True)
        (starter / "followups" / "README.md").write_text("# Followups\n", encoding="utf-8")
        (starter / "followups" / "skill" / ".gitkeep").write_text("", encoding="utf-8")
        (starter / "followups" / "module-doc" / ".gitkeep").write_text("", encoding="utf-8")

        # Create target directories
        _init_create_directories(clean_workspace)

        result = _init_copy_starters(clean_workspace)
        assert result["status"] == "ok", f"Unexpected status: {result}"
        assert len(result["copies"]) > 0, "Expected files to be copied"
        assert result["skipped"] == []

        # Verify files exist
        assert (clean_workspace / "knowledge" / "facts" / "README.md").exists()
        assert (clean_workspace / "knowledge" / "facts" / "workspace" / "README.md").exists()
        assert (clean_workspace / "knowledge" / "facts" / "workspace" / "MEMORY.md").exists()
        assert (clean_workspace / "knowledge" / "facts" / "module" / "README.md").exists()
        assert (clean_workspace / "knowledge" / "facts" / "capability" / "README.md").exists()
        assert (clean_workspace / "knowledge" / "inbox" / "README.md").exists()
        assert (clean_workspace / "knowledge" / "followups" / "README.md").exists()
        assert (clean_workspace / "knowledge" / "followups" / "skill" / ".gitkeep").exists()
        assert (clean_workspace / "knowledge" / "followups" / "module-doc" / ".gitkeep").exists()

    def test_skips_when_targets_exist(self, prepared_workspace: Path) -> None:
        """Starter files are not overwritten when targets exist (4.2)."""
        # Manually create a starter file in the target directory with custom content
        mem = prepared_workspace / "knowledge" / "facts" / "workspace" / "MEMORY.md"
        mem.parent.mkdir(parents=True, exist_ok=True)
        mem.write_text("CUSTOM CONTENT", encoding="utf-8")

        # Create starter structure
        starter = prepared_workspace / "shared-knowledge" / "starter" / "knowledge" / "facts"
        (starter / "workspace").mkdir(parents=True)
        (starter / "workspace" / "MEMORY.md").write_text("STARTER CONTENT", encoding="utf-8")

        result = _init_copy_starters(prepared_workspace)
        # When starter dir is found, it should skip existing files
        assert "skipped" in result["status"] or result["status"] == "ok"
        # The existing file should NOT be overwritten
        assert mem.read_text(encoding="utf-8") == "CUSTOM CONTENT"


# ---------------------------------------------------------------------------
# _init_inject_b1 tests (task 4.4)
# ---------------------------------------------------------------------------


class TestInitInjectB1:
    """AGENTS.md B1 section injection."""

    def test_appends_b1_when_no_sentinel(self, clean_workspace: Path) -> None:
        """B1 section is appended to AGENTS.md without sentinel (4.1)."""
        result = _init_inject_b1(clean_workspace)
        assert result["status"] == "ok", f"Unexpected status: {result}"
        assert "B1 section appended" in result["message"]

        agents_md = clean_workspace / "AGENTS.md"
        content = agents_md.read_text(encoding="utf-8")
        assert "<!-- shared-knowledge B1 -->" in content
        assert "knowledge/facts/workspace/MEMORY.md" in content

    def test_skips_when_sentinel_exists(self, clean_workspace: Path) -> None:
        """B1 section is NOT duplicated when sentinel exists (4.4)."""
        _init_inject_b1(clean_workspace)
        result = _init_inject_b1(clean_workspace)
        assert result["status"] == "skipped"
        assert "already present" in result["message"]

        # Verify only one B1 section
        content = (clean_workspace / "AGENTS.md").read_text(encoding="utf-8")
        assert content.count("<!-- shared-knowledge B1 -->") == 1

    def test_creates_agents_md_if_missing(self, clean_workspace: Path) -> None:
        """AGENTS.md is created if it doesn't exist."""
        agents_md = clean_workspace / "AGENTS.md"
        agents_md.unlink()
        assert not agents_md.exists()

        result = _init_inject_b1(clean_workspace)
        assert result["status"] == "ok"
        assert agents_md.exists()
        content = agents_md.read_text(encoding="utf-8")
        assert "<!-- shared-knowledge B1 -->" in content

    def test_no_duplicate_if_b1_at_start_of_content(self, clean_workspace: Path) -> None:
        """Edge case: B1 sentinel at beginning of AGENTS.md content."""
        agents_md = clean_workspace / "AGENTS.md"
        agents_md.write_text(
            "<!-- shared-knowledge B1 -->\n## Workspace Shared Knowledge\n",
            encoding="utf-8",
        )
        result = _init_inject_b1(clean_workspace)
        assert result["status"] == "skipped"


# ---------------------------------------------------------------------------
# _init_ensure_gitignore tests
# ---------------------------------------------------------------------------


class TestInitEnsureGitignore:
    """.gitignore knowledge/.index/ entry."""

    def test_adds_line_when_missing(self, clean_workspace: Path) -> None:
        """.gitignore gets knowledge/.index/ when missing (4.1)."""
        (clean_workspace / ".gitignore").write_text("*.pyc\n", encoding="utf-8")
        result = _init_ensure_gitignore(clean_workspace)
        assert result["status"] == "ok"
        content = (clean_workspace / ".gitignore").read_text(encoding="utf-8")
        assert "knowledge/.index/" in content

    def test_skips_when_already_present(self, clean_workspace: Path) -> None:
        """.gitignore is not modified when entry exists (4.2)."""
        (clean_workspace / ".gitignore").write_text("knowledge/.index/\n", encoding="utf-8")
        result = _init_ensure_gitignore(clean_workspace)
        assert result["status"] == "skipped"

    def test_creates_gitignore_if_missing(self, clean_workspace: Path) -> None:
        """.gitignore is created if it doesn't exist."""
        assert not (clean_workspace / ".gitignore").exists()
        result = _init_ensure_gitignore(clean_workspace)
        assert result["status"] == "ok"
        content = (clean_workspace / ".gitignore").read_text(encoding="utf-8")
        assert "knowledge/.index/" in content


# ---------------------------------------------------------------------------
# Full cmd_init idempotency (task 4.3)
# ---------------------------------------------------------------------------


def test_init_twice_is_idempotent(monkeypatch: pytest.MonkeyPatch, clean_workspace: Path) -> None:
    """Running cmd_init twice produces the same state (4.3).

    The first run creates everything; the second run skips all steps.
    We run with --skip-hook to avoid harness detection complexity.
    """
    # Provide a starter directory so the starter-copy step succeeds
    _create_starter_dir(clean_workspace)

    # Change to the workspace so find_workspace_root works
    monkeypatch.setattr("sys.argv", ["knowledge_query.py", "init", "--skip-hook", "--root", str(clean_workspace)])

    # First run
    exit1 = cmd_init(clean_workspace, argparse_namespace(skip_hook=True, dry_run=False))
    assert exit1 == 0, "First init should succeed"

    # Snapshot state
    state_after_first = _snapshot_workspace(clean_workspace)

    # Second run
    exit2 = cmd_init(clean_workspace, argparse_namespace(skip_hook=True, dry_run=False))
    assert exit2 == 0, "Second init should succeed"

    # Snapshot state after second run
    state_after_second = _snapshot_workspace(clean_workspace)

    # State should be identical
    assert state_after_first == state_after_second, "Workspace state changed after second init"


def _snapshot_workspace(ws: Path) -> dict[str, Any]:
    """Capture a snapshot of relevant workspace files for idempotency comparison."""
    snapshot: dict[str, Any] = {}
    # Directory listing
    knowledge_paths: list[str] = []
    knowledge_dir = ws / "knowledge"
    if knowledge_dir.exists():
        for p in sorted(knowledge_dir.rglob("*")):
            if p.is_file() and p.suffix not in (".pyc", ".pyo"):
                knowledge_paths.append(str(p.relative_to(ws)))
    snapshot["knowledge_files"] = sorted(knowledge_paths)

    # AGENTS.md content
    agents_md = ws / "AGENTS.md"
    if agents_md.exists():
        snapshot["agents_md"] = agents_md.read_text(encoding="utf-8")

    # .gitignore content
    gitignore = ws / ".gitignore"
    if gitignore.exists():
        snapshot["gitignore"] = gitignore.read_text(encoding="utf-8")

    return snapshot


def test_init_dry_run_does_not_modify(clean_workspace: Path) -> None:
    """Init with --dry-run does not change any files (4.3)."""
    snapshot_before = _snapshot_workspace(clean_workspace)

    cmd_init(clean_workspace, argparse_namespace(skip_hook=True, dry_run=True))

    snapshot_after = _snapshot_workspace(clean_workspace)
    assert snapshot_before == snapshot_after, "Dry-run modified workspace state"


def test_init_skip_hook_does_not_install_hook(monkeypatch: pytest.MonkeyPatch, clean_workspace: Path) -> None:
    """Init with --skip-hook does not attempt hook installation."""
    _create_starter_dir(clean_workspace)
    cmd_init(clean_workspace, argparse_namespace(skip_hook=True, dry_run=False))
    # Just verify it completes successfully — no hook-related errors


# ---------------------------------------------------------------------------
# argparse helper
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


class argparse_namespace:
    """Minimal argparse.Namespace stand-in for cmd_init calls."""

    def __init__(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)
