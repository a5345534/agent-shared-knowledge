#!/usr/bin/env python3
"""No-harness hook adapter (fallback).

Prints manual instructions when no harness is detected.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any


def install(root: Path) -> dict[str, Any]:
    script_dir = Path(__file__).resolve().parents[1]
    absorb = script_dir / "knowledge_absorb.py"
    lint = script_dir / "knowledge_lint.py"
    msg = (
        "No agent harness detected. To integrate shared-knowledge into your workflow:\n\n"
        f"  1. Run the absorption hook manually after each session:\n"
        f"       python3 {absorb} hook\n\n"
        f"  2. Run the linter to validate shared memory state:\n"
        f"       python3 {lint}\n\n"
        f"  3. To automate, add the hook command to your editor/agent's\n"
        f"     post-session callback or CI pipeline.\n\n"
        f"  4. To install a specific harness adapter later, run:\n"
        f"       knowledge init                     # auto-detect\n"
        f"       knowledge init --skip-hook         # skip hook step\n"
    )
    return {"status": "ok", "message": msg, "path": None}
