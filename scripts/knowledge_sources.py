#!/usr/bin/env python3
"""Deterministic, private evidence-source collection for shared-knowledge."""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path
from typing import Any

VERSION = 1
DEFAULT_CONFIG = ".shared-knowledge-sources.json"
DEFAULT_EXCLUDES = [
    "knowledge/views/**", "knowledge/.index/**", "openwiki/**", "*.lock",
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".last-update.json",
]
SECRET_RE = re.compile(r"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)")


def now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(root: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(["git", *args], cwd=root, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or f"git {' '.join(args)} failed")
    return result.stdout.strip()


def workspace_key(root: Path) -> str:
    canonical = str(root.resolve())
    return f"{root.name}-{hashlib.sha256(canonical.encode()).hexdigest()[:12]}"


def runtime_root(root: Path) -> Path:
    override = os.environ.get("SHARED_KNOWLEDGE_RUNTIME_DIR")
    if override:
        return Path(override).expanduser().resolve() / workspace_key(root)
    try:
        path = run(root, "rev-parse", "--path-format=absolute", "--git-path", "shared-knowledge")
        if path:
            return Path(path).resolve()
    except RuntimeError:
        pass
    state = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return state / "shared-knowledge" / workspace_key(root)


def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def atomic_json(path: Path, value: Any) -> None:
    private_dir(path.parent)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.chmod(0o600)
    temp.replace(path)
    path.chmod(0o600)


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def validate_safe_config(value: Any, prefix: str = "") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            location = f"{prefix}.{key}" if prefix else str(key)
            if SECRET_RE.search(str(key)) and item not in (None, ""):
                errors.append(f"secret value is not allowed at {location}; store only an env-var reference")
            errors.extend(validate_safe_config(item, location))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            errors.extend(validate_safe_config(item, f"{prefix}[{index}]"))
    return errors


def read_sources(root: Path) -> list[dict[str, Any]]:
    config = load_json(root / DEFAULT_CONFIG, {"version": VERSION, "sources": []})
    errors = validate_safe_config(config)
    if errors:
        raise ValueError("; ".join(errors))
    sources = config.get("sources", []) if isinstance(config, dict) else []
    if not sources:
        sources = [{"id": "git-default", "type": "git", "enabled": True, "path": ".", "exclude": DEFAULT_EXCLUDES}]
    seen: set[str] = set()
    result = []
    for source in sources:
        if not isinstance(source, dict):
            raise ValueError("source entries must be objects")
        source_id = str(source.get("id", ""))
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}", source_id) or source_id in seen:
            raise ValueError(f"invalid or duplicate source id: {source_id}")
        if source.get("type") != "git":
            raise ValueError(f"unsupported source type: {source.get('type')}")
        seen.add(source_id)
        result.append(source)
    return result


def source_dir(root: Path, source_id: str) -> Path:
    return runtime_root(root) / "sources" / source_id


def source_state(root: Path, source_id: str) -> dict[str, Any]:
    return load_json(source_dir(root, source_id) / "state.json", {"version": VERSION, "runs": []})


def is_ancestor(repo: Path, old: str, new: str) -> bool:
    result = subprocess.run(["git", "merge-base", "--is-ancestor", old, new], cwd=repo, capture_output=True)
    return result.returncode == 0


def excluded(path: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(path, pattern.removesuffix("/**") + "/*") for pattern in patterns)


def collect_git(workspace: Path, source: dict[str, Any], enqueue: bool = False) -> dict[str, Any]:
    source_id = str(source["id"])
    repo = (workspace / str(source.get("path", "."))).resolve()
    if not (repo / ".git").exists() and not run(repo, "rev-parse", "--is-inside-work-tree", check=False):
        raise RuntimeError(f"not a Git repository: {repo}")
    state = source_state(workspace, source_id)
    previous = str(state.get("cursor", {}).get("gitHead", ""))
    head = run(repo, "rev-parse", "HEAD")
    fallback = None
    if previous and is_ancestor(repo, previous, head):
        range_spec = f"{previous}..{head}"
    else:
        range_spec = "HEAD~20..HEAD"
        if subprocess.run(["git", "rev-parse", "--verify", "HEAD~20"], cwd=repo, capture_output=True).returncode:
            range_spec = "HEAD"
        fallback = "missing-or-non-ancestor-cursor" if previous else "initial-bounded-window"
    log = run(repo, "log", "--max-count=20", "--name-status", "--oneline", range_spec, check=False)
    status = run(repo, "status", "--short", "--untracked-files=all", check=False)
    changed = run(repo, "diff", "--name-only", previous if previous and is_ancestor(repo, previous, head) else "HEAD", check=False).splitlines()
    changed += [line[3:].strip() for line in status.splitlines() if len(line) > 3]
    patterns = [str(x) for x in source.get("exclude", DEFAULT_EXCLUDES)]
    paths = sorted({path for path in changed if path and not excluded(path, patterns)})
    evidence = {"repository": str(repo), "previousHead": previous or None, "currentHead": head, "fallback": fallback,
                "status": status[:100_000], "gitLog": log[:200_000], "changedPaths": paths}
    snapshot = hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()
    run_id = now().replace(":", "-")
    raw_dir = source_dir(workspace, source_id) / "raw" / run_id
    private_dir(raw_dir)
    evidence_path = raw_dir / "git-evidence.json"
    atomic_json(evidence_path, evidence)
    prior_snapshot = state.get("snapshot")
    no_relevant_change = bool(previous) and not paths
    manifest = {"version": VERSION, "sourceId": source_id, "sourceType": "git", "runId": run_id,
                "collectedAt": now(), "snapshot": snapshot, "priorSnapshot": prior_snapshot,
                "status": "noop" if snapshot == prior_snapshot or no_relevant_change else "success",
                "warnings": ([fallback] if fallback else []) + (["all changed paths were excluded or no relevant paths changed"] if no_relevant_change else []), "rawFiles": [str(evidence_path)],
                "proposedCursor": {"gitHead": head}}
    manifest_path = raw_dir / "manifest.json"
    atomic_json(manifest_path, manifest)
    run_summary = {key: manifest[key] for key in ("runId", "collectedAt", "snapshot", "status", "warnings")}
    state["runs"] = [run_summary, *state.get("runs", [])][:20]
    state["pending"] = {"runId": run_id, "gitHead": head, "snapshot": snapshot, "manifest": str(manifest_path)}
    atomic_json(source_dir(workspace, source_id) / "state.json", state)
    if manifest["status"] == "noop":
        acknowledge(workspace, source_id, run_id)
    if enqueue and manifest["status"] != "noop":
        manifest["jobId"] = enqueue_manifest(workspace, manifest, evidence)
        atomic_json(manifest_path, manifest)
    return manifest


def enqueue_manifest(root: Path, manifest: dict[str, Any], evidence: dict[str, Any]) -> str:
    conversation = "Untrusted deterministic source evidence follows. Extract only durable shared-knowledge candidates.\n" + json.dumps(
        {"manifest": manifest, "evidence": evidence}, ensure_ascii=False, sort_keys=True
    )
    payload = {"version": VERSION, "workspace": str(root.resolve()), "sessionId": f"source:{manifest['sourceId']}:{manifest['runId']}",
               "capturedAt": now(), "conversation": conversation, "truncated": False,
               "originalBytes": len(conversation.encode()), "source": {"instanceId": manifest["sourceId"], "runId": manifest["runId"],
               "snapshot": manifest["snapshot"], "revision": manifest["proposedCursor"]["gitHead"],
               "evidencePaths": [f"source://{manifest['sourceId']}/{manifest['runId']}/{Path(item).name}" for item in manifest["rawFiles"]]}}
    stable = {"version": VERSION, "workspace": payload["workspace"], "sessionId": payload["sessionId"], "conversation": conversation}
    digest = hashlib.sha256(json.dumps(stable, separators=(",", ":")).encode()).hexdigest()
    job_id = digest[:24]
    job = {"version": VERSION, "id": job_id, "payloadHash": digest, "state": "pending", "createdAt": now(),
           "updatedAt": now(), "attempts": 0, "payload": payload}
    path = runtime_root(root) / "jobs" / f"{job_id}.json"
    if not path.exists():
        atomic_json(path, job)
    return job_id


def synthesize_job(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    job_id = manifest.get("jobId")
    if not job_id:
        raise ValueError("manifest has no queued job")
    job_path = runtime_root(root) / "jobs" / f"{job_id}.json"
    producer = Path(__file__).with_name("knowledge_compact_producer.py")
    result = subprocess.run([sys.executable, str(producer), "--root", str(root), "produce-job", "--job-file", str(job_path), "--format", "json"],
                            cwd=root, text=True, capture_output=True)
    try: summary = json.loads(result.stdout or "{}")
    except json.JSONDecodeError: summary = {"errors": [result.stderr.strip() or "invalid producer output"]}
    if result.returncode or summary.get("errors"):
        raise RuntimeError("; ".join(str(item) for item in summary.get("errors", [])) or f"producer exited {result.returncode}")
    ack = acknowledge(root, manifest["sourceId"], manifest["runId"])
    try:
        job = load_json(job_path, {})
        job.update({"state": "done", "updatedAt": now(), "payload": None, "result": {"candidateCount": summary.get("candidatesWritten", 0), "materializer": "inbox", "written": summary.get("candidates", [])}})
        atomic_json(job_path, job)
    except OSError: pass
    return {"summary": summary, "ack": ack}


def acknowledge(root: Path, source_id: str, run_id: str) -> dict[str, Any]:
    state_path = source_dir(root, source_id) / "state.json"
    state = load_json(state_path, {})
    pending = state.get("pending", {})
    if pending.get("runId") != run_id:
        raise ValueError(f"run is not pending for {source_id}: {run_id}")
    state["cursor"] = {"gitHead": pending["gitHead"]}
    state["snapshot"] = pending["snapshot"]
    state["lastSuccessfulAt"] = now()
    state.pop("pending", None)
    atomic_json(state_path, state)
    return {"sourceId": source_id, "runId": run_id, "cursor": state["cursor"], "snapshot": state["snapshot"]}


def safe_status(root: Path, source: dict[str, Any]) -> dict[str, Any]:
    state = source_state(root, str(source["id"]))
    return {"id": source["id"], "type": source["type"], "enabled": source.get("enabled", True),
            "cursor": state.get("cursor"), "snapshot": state.get("snapshot"),
            "pending": state.get("pending", {}).get("runId"), "lastRun": (state.get("runs") or [None])[0]}


def cleanup(root: Path, retention_days: int, dry_run: bool) -> list[str]:
    cutoff = dt.datetime.now(dt.timezone.utc).timestamp() - retention_days * 86400
    removed: list[str] = []
    sources_root = runtime_root(root) / "sources"
    if not sources_root.exists(): return removed
    for raw in sources_root.glob("*/raw/*"):
        if raw.is_dir() and raw.stat().st_mtime < cutoff:
            removed.append(str(raw))
            if not dry_run: shutil.rmtree(raw)
    return removed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--format", choices=("json", "text"), default="json")
    subs = parser.add_subparsers(dest="command", required=True)
    subs.add_parser("list"); subs.add_parser("status")
    collect = subs.add_parser("collect"); collect.add_argument("target", nargs="?", default="all"); collect.add_argument("--enqueue", action="store_true"); collect.add_argument("--synthesize", action="store_true")
    ack = subs.add_parser("ack"); ack.add_argument("source_id"); ack.add_argument("run_id")
    clean = subs.add_parser("cleanup"); clean.add_argument("--retention-days", type=int, default=7); clean.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(); root = Path(args.root).resolve()
    try:
        sources = read_sources(root)
        if args.command in {"list", "status"}:
            value: Any = [safe_status(root, source) for source in sources]
        elif args.command == "collect":
            selected = [s for s in sources if s.get("enabled", True) and (args.target == "all" or s["id"] == args.target or s["type"] == args.target)]
            if not selected: raise ValueError(f"no source matched {args.target}")
            value = [collect_git(root, source, args.enqueue or args.synthesize) for source in selected]
            if args.synthesize:
                for manifest in value:
                    if manifest["status"] != "noop": manifest["synthesis"] = synthesize_job(root, manifest)
        elif args.command == "ack": value = acknowledge(root, args.source_id, args.run_id)
        else: value = {"removed": cleanup(root, args.retention_days, args.dry_run), "dryRun": args.dry_run}
        print(json.dumps(value, ensure_ascii=False, indent=2) if args.format == "json" else value)
        return 0
    except (ValueError, RuntimeError, OSError) as exc:
        print(json.dumps({"error": str(exc)}) if args.format == "json" else f"ERROR: {exc}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
