#!/usr/bin/env python3
"""OpenCode harness hook adapter.

Detects OpenCode via .opencode.json in workspace root, installs post-session hook.
"""
from __future__ import annotations

import stat
from pathlib import Path
from typing import Any


def install(root: Path) -> dict[str, Any]:
    if not (root / ".opencode.json").is_file():
        return {"status": "skipped", "message": "OpenCode harness not detected (no .opencode.json).", "path": None}

    hook_path = root / ".opencode" / "hooks" / "post-session" / "shared-knowledge-absorb.sh"
    hook_content = _hook_script(root)

    if hook_path.is_file() and hook_path.read_text(encoding="utf-8").strip() == hook_content.strip():
        return {"status": "skipped", "message": f"OpenCode hook already installed: {hook_path}", "path": str(hook_path)}

    try:
        hook_path.parent.mkdir(parents=True, exist_ok=True)
        hook_path.write_text(hook_content, encoding="utf-8")
        hook_path.chmod(hook_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return {"status": "ok", "message": f"OpenCode hook installed: {hook_path}", "path": str(hook_path)}
    except (OSError, PermissionError) as exc:
        return {"status": "failed", "message": f"Failed to install OpenCode hook: {exc}", "path": str(hook_path) if hook_path.exists() else None}


def _hook_script(root: Path) -> str:
    absorb = Path(__file__).resolve().parents[1] / "knowledge_absorb.py"
    return f"""#!/usr/bin/env sh
# OpenCode post-session hook -- installed by shared-knowledge init
set -e
cd "{root.resolve()}"
python3 "{absorb}" hook
"""
