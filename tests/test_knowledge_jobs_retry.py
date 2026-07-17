from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from knowledge_sources import runtime_root

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "knowledge_jobs.py"


def run_jobs(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), *args],
        text=True,
        capture_output=True,
    )


def write_job(root: Path, *, state: str = "failed", payload: object | None = None) -> tuple[str, Path]:
    job_id = "a" * 24
    path = runtime_root(root) / "jobs" / f"{job_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "version": 1,
        "id": job_id,
        "payloadHash": "hash",
        "state": state,
        "createdAt": "2026-01-01T00:00:00Z",
        "updatedAt": "2026-01-01T00:00:00Z",
        "attempts": 3,
        "nextAttemptAt": "2026-01-02T00:00:00Z",
        "error": "private model response detail",
        "result": {"candidateCount": 0, "materializer": "review", "written": []},
        "payload": payload,
    }), encoding="utf-8")
    return job_id, path


def test_retry_resets_failed_job_without_printing_payload(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    job_id, path = write_job(tmp_path, payload={"conversation": "private conversation"})

    result = run_jobs(tmp_path, "retry", job_id)

    assert result.returncode == 0
    output = json.loads(result.stdout)
    assert output["retried"] == job_id
    assert output["job"]["state"] == "pending"
    assert output["job"]["attempts"] == 0
    assert output["job"]["hasPayload"] is True
    assert "private conversation" not in result.stdout
    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert persisted["payload"]["conversation"] == "private conversation"
    assert "error" not in persisted
    assert "result" not in persisted
    assert "nextAttemptAt" not in persisted


def test_retry_refuses_nonfailed_or_purged_jobs(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    job_id, path = write_job(tmp_path, state="done", payload={"conversation": "private"})
    assert run_jobs(tmp_path, "retry", job_id).returncode == 2

    job = json.loads(path.read_text(encoding="utf-8"))
    job["state"] = "failed"
    job["payload"] = None
    path.write_text(json.dumps(job), encoding="utf-8")
    assert run_jobs(tmp_path, "retry", job_id).returncode == 2


def test_status_redacts_review_paths_and_raw_errors_but_show_remains_explicit(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    job_id, path = write_job(tmp_path, state="review-ready", payload=None)
    job = json.loads(path.read_text(encoding="utf-8"))
    job["error"] = "private model response detail"
    job["result"] = {
        "candidateCount": 1,
        "materializer": "review",
        "written": ["knowledge/inbox/private-candidate.md"],
        "reviewCandidates": [{"body": "explicit local candidate detail"}],
        "reviewDecisions": {"private-item": {"state": "approved", "inboxPath": "knowledge/inbox/private-candidate.md"}},
        "reviewSummary": {"pending": 0, "approved": 1, "rejected": 0},
    }
    path.write_text(json.dumps(job), encoding="utf-8")

    status = run_jobs(tmp_path, "status")
    assert status.returncode == 0
    assert "private model response detail" not in status.stdout
    assert "private-candidate" not in status.stdout
    assert "private-item" not in status.stdout
    assert "explicit local candidate detail" not in status.stdout
    assert json.loads(status.stdout)["jobs"][0]["result"]["reviewSummary"] == {"pending": 0, "approved": 1, "rejected": 0}

    shown = run_jobs(tmp_path, "show", job_id)
    assert shown.returncode == 0
    assert "explicit local candidate detail" in shown.stdout
    assert "private-candidate" not in shown.stdout
    assert "private-item" not in shown.stdout
