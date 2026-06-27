#!/usr/bin/env python3
"""Pi harness hook adapter.

Detects Pi via ~/.pi/ dir, installs post-compact hook calling knowledge_absorb.py hook.
"""
from __future__ import annotations

import stat
from pathlib import Path
from typing import Any


def install(root: Path) -> dict[str, Any]:
    pi_dir = Path.home() / ".pi"
    if not pi_dir.is_dir():
        return {"status": "skipped", "message": "Pi harness not detected (~/.pi/ not found).", "path": None}

    hooks_dir = pi_dir / "hooks" / "post-compact"
    hook_path = hooks_dir / "shared-knowledge-absorb.sh"
    hook_content = _hook_script(root)

    if hook_path.is_file() and hook_path.read_text(encoding="utf-8").strip() == hook_content.strip():
        return {"status": "skipped", "message": f"Pi post-compact hook already installed: {hook_path}", "path": str(hook_path)}

    try:
        hooks_dir.mkdir(parents=True, exist_ok=True)
        hook_path.write_text(hook_content, encoding="utf-8")
        hook_path.chmod(hook_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return {"status": "ok", "message": f"Pi post-compact hook installed: {hook_path}", "path": str(hook_path)}
    except (OSError, PermissionError) as exc:
        return {"status": "failed", "message": f"Failed to install Pi hook: {exc}", "path": str(hook_path) if hook_path.exists() else None}


def _hook_script(root: Path) -> str:
    absorb = Path(__file__).resolve().parents[1] / "knowledge_absorb.py"
    return f"""#!/usr/bin/env sh
# Pi post-compact hook -- installed by shared-knowledge init
set -e
cd "{root.resolve()}"
python3 "{absorb}" hook
"""
