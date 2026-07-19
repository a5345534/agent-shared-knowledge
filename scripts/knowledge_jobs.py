#!/usr/bin/env python3
"""Safe status, explicit review inspection, and retention operations for private knowledge jobs."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import uuid
from contextlib import contextmanager
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


def normalized_review_summary(value: object) -> dict:
    source = value if isinstance(value, dict) else {}
    return {
        key: source.get(key, 0) if isinstance(source.get(key, 0), int) and source.get(key, 0) >= 0 else 0
        for key in ("pending", "approved", "rejected", "expired")
    }


def review_summary(job: dict) -> dict:
    result = job.get("result") if isinstance(job.get("result"), dict) else {}
    candidates = result.get("reviewCandidates")
    if not isinstance(candidates, list):
        return normalized_review_summary(result.get("reviewSummary"))
    summary = {"pending": 0, "approved": 0, "rejected": 0, "expired": normalized_review_summary(result.get("reviewSummary"))["expired"]}
    decisions = result.get("reviewDecisions") if isinstance(result.get("reviewDecisions"), dict) else {}
    for index, candidate in enumerate(candidates):
        candidate_id = candidate.get("candidate_id", "") if isinstance(candidate, dict) else ""
        item_id = hashlib.sha256(f"{job.get('id', '')}\0{index}\0{candidate_id}".encode()).hexdigest()[:24]
        decision = decisions.get(item_id) if isinstance(decisions.get(item_id), dict) else {}
        state = decision.get("state")
        summary[state if state in {"approved", "rejected"} else "pending"] += 1
    return summary


def expired_review_summary(summary: dict) -> dict:
    return {
        "pending": 0,
        "approved": summary["approved"],
        "rejected": summary["rejected"],
        "expired": summary["expired"] + summary["pending"],
    }


def safe_review_summary(result: dict) -> dict | None:
    value = result.get("reviewSummary")
    return normalized_review_summary(value) if isinstance(value, dict) else None


def process_alive(pid: object) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


@contextmanager
def review_job_lock(root: Path, job_id: str):
    lock_dir = runtime_root(root) / "review-locks"
    lock_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(lock_dir, 0o700)
    key = hashlib.sha256(f"job:{job_id}".encode()).hexdigest()[:32]
    path = lock_dir / f"{key}.lock"
    nonce = str(uuid.uuid4())
    acquired = False
    for attempt in range(8):
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"nonce": nonce, "pid": os.getpid(), "createdAt": dt.datetime.now(dt.timezone.utc).isoformat()}, handle)
                handle.write("\n")
            acquired = True
            break
        except FileExistsError:
            try:
                metadata = json.loads(path.read_text(encoding="utf-8"))
                created = dt.datetime.fromisoformat(str(metadata.get("createdAt", "")).replace("Z", "+00:00")).timestamp()
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                metadata = {}
                created = path.stat().st_mtime if path.exists() else time.time()
            if time.time() - created >= 30 and not process_alive(metadata.get("pid")):
                stale = path.with_name(f"{path.name}.{uuid.uuid4()}.stale")
                try:
                    path.rename(stale)
                    stale.unlink(missing_ok=True)
                    continue
                except OSError:
                    pass
            if attempt < 7:
                time.sleep(0.03)
    if not acquired:
        raise RuntimeError("review action is busy")
    try:
        yield
    finally:
        try:
            metadata = json.loads(path.read_text(encoding="utf-8"))
            if metadata.get("nonce") == nonce:
                path.unlink()
        except (OSError, json.JSONDecodeError):
            pass


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


def purge_eligible(job: dict, cutoff: float, all_terminal: bool) -> bool:
    timestamp = job.get("updatedAt") or job.get("createdAt") or ""
    try:
        old = dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp() <= cutoff
    except (AttributeError, ValueError):
        old = False
    result = job.get("result") if isinstance(job.get("result"), dict) else {}
    has_private_detail = bool(job.get("payload")) or "reviewCandidates" in result or isinstance(result.get("reviewDecisions"), dict)
    return job.get("state") in TERMINAL and has_private_detail and (all_terminal or old)


def close_review(root: Path, job_id: str) -> tuple[int, dict]:
    if not re.fullmatch(r"[a-f0-9]{24}", job_id):
        return 2, {"error": "invalid job id"}
    with review_job_lock(root, job_id):
        matches = [(path, job) for path, job in jobs(root) if job.get("id") == job_id]
        if not matches:
            return 1, {"error": "job not found"}
        path, job = matches[0]
        result = job.get("result") if isinstance(job.get("result"), dict) else {}
        if job.get("state") != "review-ready" or result.get("materializer") != "review":
            return 2, {"error": "job is not review-ready"}
        candidates = result.get("reviewCandidates")
        if isinstance(candidates, list) and candidates:
            return 2, {"error": "review job still has actionable candidates"}
        legacy_empty = isinstance(candidates, list) and not candidates and result.get("candidateCount") == 0
        unavailable = "reviewCandidates" not in result and (bool(job.get("purgedAt")) or isinstance(result.get("reviewSummary"), dict))
        if not legacy_empty and not unavailable:
            return 2, {"error": "review job is not eligible to close"}
        summary = {"pending": 0, "approved": 0, "rejected": 0, "expired": 0} if legacy_empty else expired_review_summary(review_summary(job))
        result.pop("reviewCandidates", None)
        result.pop("reviewDecisions", None)
        result["reviewSummary"] = summary
        job["state"] = "done"
        job["result"] = result
        job["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        job.pop("nextAttemptAt", None)
        job.pop("error", None)
        atomic_json(path, job)
        return 0, {"closed": job_id, "outcome": "empty" if legacy_empty else "expired", "state": "done", "reviewSummary": summary}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    show = sub.add_parser("show")
    show.add_argument("job_id")
    retry = sub.add_parser("retry")
    retry.add_argument("job_id")
    close = sub.add_parser("close-review")
    close.add_argument("job_id")
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
    elif args.command == "close-review":
        code, value = close_review(root, args.job_id)
        if code:
            print(json.dumps(value), file=sys.stderr)
            return code
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
        for path, snapshot in jobs(root):
            job_id = snapshot.get("id", path.stem)
            if args.dry_run:
                if purge_eligible(snapshot, cutoff, args.all_terminal):
                    removed.append(job_id)
                continue
            with review_job_lock(root, str(job_id)):
                try:
                    job = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if not isinstance(job, dict) or job.get("version") != 1 or not purge_eligible(job, cutoff, args.all_terminal):
                    continue
                removed.append(job_id)
                result = job.get("result") if isinstance(job.get("result"), dict) else {}
                summary = review_summary(job) if result.get("materializer") == "review" else None
                if job.get("state") == "review-ready" and summary is not None:
                    summary = expired_review_summary(summary)
                    job["state"] = "done"
                    job.pop("nextAttemptAt", None)
                    job.pop("error", None)
                job["payload"] = None
                result.pop("reviewCandidates", None)
                result.pop("reviewDecisions", None)
                if summary is not None:
                    result["reviewSummary"] = summary
                job["result"] = result or None
                job["purgedAt"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
                job["updatedAt"] = job["purgedAt"]
                atomic_json(path, job)
        value = {"removed": removed, "dryRun": args.dry_run, "retentionDays": args.retention_days}

    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
