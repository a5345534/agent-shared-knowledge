#!/usr/bin/env python3
"""Release gate for a clean, tested, packable v0.1.1 checkout."""
from __future__ import annotations
import json, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def run(*command: str) -> None:
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode:
        raise SystemExit(result.returncode)

def main() -> int:
    package = json.loads((ROOT / "package.json").read_text())
    if package.get("version") != "0.1.1":
        print("release version must be 0.1.1", file=sys.stderr); return 1
    required_bins = {"knowledge-jobs", "knowledge-source", "knowledge-view"}
    if not required_bins.issubset(package.get("bin", {})):
        print("background/source/view CLI bins are missing", file=sys.stderr); return 1
    extension = (ROOT / ".pi/extensions/shared-knowledge-lifecycle.ts").read_text()
    capture = extension.split('pi.on("session_before_compact"', 1)[-1].split('pi.on("session_compact"', 1)[0]
    if "complete(" in capture or "getApiKeyAndHeaders" in capture:
        print("pre-compaction capture contains awaited model/provider work", file=sys.stderr); return 1
    for schema in ("knowledge-job.schema.json", "evidence-source.schema.json", "evidence-manifest.schema.json", "derived-view-response.schema.json"):
        json.loads((ROOT / "schemas" / schema).read_text())
    status = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, text=True, capture_output=True, check=True).stdout
    if status:
        print("release checkout is not clean", file=sys.stderr); return 1
    run(sys.executable, "-m", "pytest", "-q")
    run("npm", "run", "typecheck")
    run("npm", "run", "test:materializer")
    run("npm", "pack", "--dry-run")
    print("release smoke passed for v0.1.1")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
