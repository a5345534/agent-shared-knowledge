#!/usr/bin/env python3
"""GitHub Actions harness hook adapter.

Generates .github/workflows/shared-knowledge.yml with scheduled hook + lint.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def install(root: Path) -> dict[str, Any]:
    workflow_path = root / ".github" / "workflows" / "shared-knowledge.yml"
    content = _workflow_yml(root.resolve())

    if workflow_path.is_file() and workflow_path.read_text(encoding="utf-8").strip() == content.strip():
        return {"status": "skipped", "message": f"GitHub Actions workflow already installed: {workflow_path}", "path": str(workflow_path)}

    try:
        workflow_path.parent.mkdir(parents=True, exist_ok=True)
        workflow_path.write_text(content, encoding="utf-8")
        msg = f"GitHub Actions workflow installed: {workflow_path}"
        if os.environ.get("GITHUB_ACTIONS") != "true":
            msg += " (configured as CI fallback)"
        return {"status": "ok", "message": msg, "path": str(workflow_path)}
    except (OSError, PermissionError) as exc:
        return {"status": "failed", "message": f"Failed to install workflow: {exc}", "path": str(workflow_path) if workflow_path.exists() else None}


def _workflow_yml(root: Path) -> str:
    script_dir = Path(__file__).resolve().parents[1]
    try:
        script_rel = script_dir.relative_to(root.resolve()).as_posix()
    except ValueError:
        # Unit tests may call the adapter outside an actual checked-out
        # workspace. Keep generated workflow commands repo-relative.
        script_rel = "shared-knowledge/scripts"

    return f"""# GitHub Actions workflow -- installed by shared-knowledge init
name: shared-knowledge
on:
  schedule:
    - cron: "0 6 * * *"
  workflow_dispatch:
jobs:
  hook-and-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: true
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - name: Run knowledge absorption hook
        run: python3 {script_rel}/knowledge_absorb.py hook
      - name: Run knowledge lint
        run: python3 {script_rel}/knowledge_lint.py
"""
