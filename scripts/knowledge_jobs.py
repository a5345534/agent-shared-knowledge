#!/usr/bin/env python3
"""Safe status, explicit review inspection, and retention operations for private knowledge jobs."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
from pathlib import Path

from knowledge_sources import atomic_json, runtime_root

TERMINAL = {"done", "review-ready", "skipped", "failed"}


def jobs(root: Path) -> list[tuple[Path, dict]]:
    result = []
    for path in sorted((runtime_root(root) / "jobs").glob("*.json")):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if value.get("version") == 1:
                result.append((path, value))
        except (OSError, json.JSONDecodeError):
            pass
    return result


def safe_diagnostic(error: object) -> dict:
    if not isinstance(error, str) or not error:
        return {"category": "no-diagnostic"}
    command_exit = re.search(r"Materializer exited\s+(\d{1,3})(?:\D|$)", error, flags=re.I)
    if command_exit:
        return {"category": "materializer-command-exited", "exitCode": int(command_exit.group(1))}
    if "Configured command materializer binding is unavailable" in error:
        return {"category": "command-binding-unavailable"}
    if "Credentials unavailable" in error:
        return {"category": "credentials-unavailable"}
    if "Configured extraction model is unavailable" in error or "No active model available" in error:
        return {"category": "model-unavailable"}
    if "Background extraction timed out" in error:
        return {"category": "extraction-timeout"}
    if "Invalid SHARED_KNOWLEDGE_EXTRACTION_MODEL" in error:
        return {"category": "invalid-model-configuration"}
    return {"category": "background-failure"}


def safe_review_summary(result: dict) -> dict | None:
    value = result.get("reviewSummary")
    if not isinstance(value, dict):
        return None
    return {
        key: value.get(key)
        for key in ("pending", "approved", "rejected")
        if isinstance(value.get(key), int) and value.get(key) >= 0
    }


def safe_model_hint(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = re.sub(r"[\x00-\x1f\x7f-\x9f]+", " ", value).strip()[:240]
    return normalized or None


def safe_materializer(value: object) -> str | None:
    return value if isinstance(value, str) and value in {"review", "inbox", "command"} else None


def safe(job: dict) -> dict:
    value = {
        key: job.get(key)
        for key in (
            "id",
            "state",
            "createdAt",
            "updatedAt",
            "attempts",
            "nextAttemptAt",
            "sessionId",
            "sourceInstance",
            "purgedAt",
        )
        if job.get(key) is not None
    }
    hint = safe_model_hint(job.get("modelHint"))
    if hint is not None:
        value["modelHint"] = hint
    value["diagnostic"] = safe_diagnostic(job.get("error"))
    result = job.get("result")
    if isinstance(result, dict):
        materializer = safe_materializer(result.get("materializer"))
        if materializer is not None:
            safe_result = {"materializer": materializer}
            if isinstance(result.get("candidateCount"), int) and result["candidateCount"] >= 0:
                safe_result["candidateCount"] = result["candidateCount"]
            if materializer != "review" and isinstance(result.get("written"), list):
                safe_result["written"] = result["written"]
            if materializer == "review":
                review_summary = safe_review_summary(result)
                if review_summary is not None:
                    safe_result["reviewSummary"] = review_summary
            value["result"] = safe_result
    return value | {"hasPayload": bool(job.get("payload"))}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    show = sub.add_parser("show")
    show.add_argument("job_id")
    retry = sub.add_parser("retry")
    retry.add_argument("job_id")
    purge = sub.add_parser("purge")
    purge.add_argument("--retention-days", type=int, default=7)
    purge.add_argument("--dry-run", action="store_true")
    purge.add_argument("--all-terminal", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    if args.command == "status":
        value = {"runtimeRoot": str(runtime_root(root)), "jobs": [safe(job) for _, job in jobs(root)]}
    elif args.command == "show":
        matches = [job for _, job in jobs(root) if job.get("id") == args.job_id]
        if not matches:
            print(json.dumps({"error": "job not found"}), file=sys.stderr)
            return 1
        job = matches[0]
        result = job.get("result") if isinstance(job.get("result"), dict) else {}
        value = {"job": safe(job), "reviewCandidates": result.get("reviewCandidates", [])}
    elif args.command == "retry":
        matches = [(path, job) for path, job in jobs(root) if job.get("id") == args.job_id]
        if not matches:
            print(json.dumps({"error": "job not found"}), file=sys.stderr)
            return 1
        path, job = matches[0]
        if job.get("state") != "failed":
            print(json.dumps({"error": "job is not failed"}), file=sys.stderr)
            return 2
        if not job.get("payload"):
            print(json.dumps({"error": "job has no retained payload"}), file=sys.stderr)
            return 2
        job["state"] = "pending"
        job["attempts"] = 0
        job["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        for key in ("nextAttemptAt", "error", "result"):
            job.pop(key, None)
        atomic_json(path, job)
        value = {"retried": args.job_id, "job": safe(job)}
    else:
        cutoff = dt.datetime.now(dt.timezone.utc).timestamp() - args.retention_days * 86400
        removed = []
        for path, job in jobs(root):
            timestamp = job.get("updatedAt") or job.get("createdAt") or ""
            try:
                old = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp() <= cutoff
            except ValueError:
                old = False
            result = job.get("result") if isinstance(job.get("result"), dict) else {}
            has_private_detail = bool(job.get("payload")) or bool(result.get("reviewCandidates")) or bool(result.get("reviewDecisions"))
            if job.get("state") in TERMINAL and has_private_detail and (args.all_terminal or old):
                removed.append(job.get("id", path.stem))
                if not args.dry_run:
                    job["payload"] = None
                    result.pop("reviewCandidates", None)
                    result.pop("reviewDecisions", None)
                    job["result"] = result or None
                    job["purgedAt"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
                    job["updatedAt"] = job["purgedAt"]
                    atomic_json(path, job)
        value = {"removed": removed, "dryRun": args.dry_run, "retentionDays": args.retention_days}

    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
