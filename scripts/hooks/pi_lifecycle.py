#!/usr/bin/env python3
"""Pi lifecycle adapter using the package's canonical TypeScript extension."""
from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any

PACKAGE_SOURCE = "agent-shared-knowledge"


def install(root: Path, scope: str = "workspace", legacy_hook: bool = False) -> dict[str, Any]:
    if scope not in {"workspace", "global"}:
        return {"status": "failed", "message": f"Unsupported Pi hook scope: {scope}", "path": None}
    pi_dir = Path.home() / ".pi"
    if not pi_dir.is_dir():
        return {"status": "skipped", "message": "Pi harness not detected (~/.pi/ not found).", "path": None}

    results: list[dict[str, Any]] = []
    if scope == "workspace" and _pi_package_declared(root):
        results.append({
            "status": "skipped",
            "message": "Pi package already declares the canonical lifecycle extension; duplicate install skipped.",
            "path": None,
            "scope": scope,
        })
    else:
        results.append(_install_extension(root, scope))
    if legacy_hook:
        results.append(_install_legacy_hook(root, scope))

    errors = [result for result in results if result["status"] == "failed"]
    if errors:
        status = "failed"
    elif all(result["status"] == "skipped" for result in results):
        status = "skipped"
    else:
        status = "ok"
    return {
        "status": status,
        "message": "; ".join(result["message"] for result in results),
        "path": results[0].get("path"),
        "results": results,
    }


def _pi_package_declared(root: Path) -> bool:
    settings_path = root.resolve() / ".pi" / "settings.json"
    if not settings_path.is_file():
        return False
    try:
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    packages = settings.get("packages", [])
    for package in packages if isinstance(packages, list) else []:
        source = package if isinstance(package, str) else package.get("source", "") if isinstance(package, dict) else ""
        if PACKAGE_SOURCE in source:
            return True
    return False


def _extension_dir(root: Path, scope: str) -> Path:
    if scope == "global":
        return Path.home() / ".pi" / "agent" / "extensions"
    return root.resolve() / ".pi" / "extensions"


def _canonical_extension(root: Path) -> Path:
    return root.resolve() / "shared-knowledge" / ".pi" / "extensions" / "shared-knowledge-lifecycle.ts"


def _extension_script(root: Path) -> str:
    """Return a thin loader so generated installs cannot diverge from the package."""
    canonical = _canonical_extension(root).as_uri()
    return (
        "/** Generated loader for the canonical shared-knowledge lifecycle extension. */\n"
        f'export {{ default }} from {json.dumps(canonical)};\n'
    )


def _install_extension(root: Path, scope: str) -> dict[str, Any]:
    canonical = _canonical_extension(root)
    if not canonical.is_file():
        return {
            "status": "failed",
            "message": f"Canonical lifecycle extension not found: {canonical}",
            "path": None,
            "scope": scope,
        }
    ext_dir = _extension_dir(root, scope)
    ext_path = ext_dir / "shared-knowledge-lifecycle.ts"
    content = _extension_script(root)
    if ext_path.is_file() and ext_path.read_text(encoding="utf-8").strip() == content.strip():
        return {"status": "skipped", "message": f"Pi {scope} lifecycle loader already installed: {ext_path}", "path": str(ext_path), "scope": scope}
    try:
        ext_dir.mkdir(parents=True, exist_ok=True)
        ext_path.write_text(content, encoding="utf-8")
        ext_path.chmod(ext_path.stat().st_mode | stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
        return {"status": "ok", "message": f"Pi {scope} lifecycle loader installed: {ext_path}", "path": str(ext_path), "scope": scope}
    except (OSError, PermissionError) as exc:
        return {"status": "failed", "message": f"Failed to install Pi {scope} loader: {exc}", "path": None, "scope": scope}


def _legacy_hook_dir(root: Path, scope: str) -> Path:
    if scope == "global":
        return Path.home() / ".pi" / "hooks"
    return root.resolve() / ".pi" / "hooks"


def _install_legacy_hook(root: Path, scope: str) -> dict[str, Any]:
    hooks_dir = _legacy_hook_dir(root, scope) / "post-compact"
    hook_path = hooks_dir / "shared-knowledge-absorb.sh"
    absorb = root.resolve() / "shared-knowledge" / "scripts" / "knowledge_absorb.py"
    content = f'''#!/usr/bin/env sh
# Pi post-compact hook -- DEPRECATED, use shared-knowledge-lifecycle.ts instead
set -e
cd "{root.resolve()}"
python3 "{absorb}" hook --git-mode none
'''
    if hook_path.is_file() and hook_path.read_text(encoding="utf-8").strip() == content.strip():
        return {"status": "skipped", "message": f"Legacy hook already installed: {hook_path}", "path": str(hook_path)}
    try:
        hooks_dir.mkdir(parents=True, exist_ok=True)
        hook_path.write_text(content, encoding="utf-8")
        hook_path.chmod(hook_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return {"status": "ok", "message": f"Legacy hook installed: {hook_path}", "path": str(hook_path)}
    except (OSError, PermissionError) as exc:
        return {"status": "failed", "message": f"Failed to install legacy hook: {exc}", "path": None}
