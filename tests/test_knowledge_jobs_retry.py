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
    assert json.loads(status.stdout)["jobs"][0]["result"]["reviewSummary"] == {"pending": 0, "approved": 1, "rejected": 0, "expired": 0}

    shown = run_jobs(tmp_path, "show", job_id)
    assert shown.returncode == 0
    assert "explicit local candidate detail" in shown.stdout
    assert "private-candidate" not in shown.stdout
    assert "private-item" not in shown.stdout

    job["result"]["materializer"] = ["untrusted", "shape"]
    job["modelHint"] = "safe-model\nprivate-control"
    path.write_text(json.dumps(job), encoding="utf-8")
    malformed = run_jobs(tmp_path, "status")
    assert malformed.returncode == 0
    assert "untrusted" not in malformed.stdout
    assert "safe-model\\n" not in malformed.stdout


def test_close_review_handles_legacy_empty_and_refuses_actionable_content(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    job_id, path = write_job(tmp_path, state="review-ready", payload=None)
    job = json.loads(path.read_text(encoding="utf-8"))
    job["result"]["reviewCandidates"] = []
    path.write_text(json.dumps(job), encoding="utf-8")

    closed = run_jobs(tmp_path, "close-review", job_id)
    assert closed.returncode == 0
    assert json.loads(closed.stdout) == {
        "closed": job_id,
        "outcome": "empty",
        "state": "done",
        "reviewSummary": {"pending": 0, "approved": 0, "rejected": 0, "expired": 0},
    }
    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert persisted["state"] == "done"
    assert "nextAttemptAt" not in persisted
    assert "error" not in persisted
    assert "reviewCandidates" not in persisted["result"]

    job["state"] = "review-ready"
    job["result"]["candidateCount"] = 1
    job["result"]["reviewCandidates"] = [{"body": "private actionable candidate"}]
    path.write_text(json.dumps(job), encoding="utf-8")
    refused = run_jobs(tmp_path, "close-review", job_id)
    assert refused.returncode == 2
    assert "private actionable candidate" not in refused.stderr
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "review-ready"

    job["result"]["candidateCount"] = "0"
    job["result"]["reviewCandidates"] = []
    path.write_text(json.dumps(job), encoding="utf-8")
    malformed = run_jobs(tmp_path, "close-review", job_id)
    assert malformed.returncode == 2
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "review-ready"


def test_close_review_expires_safe_legacy_summary_and_rejects_ineligible_jobs(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    job_id, path = write_job(tmp_path, state="review-ready", payload=None)
    job = json.loads(path.read_text(encoding="utf-8"))
    job["purgedAt"] = "2026-01-03T00:00:00Z"
    job["result"] = {
        "candidateCount": 3,
        "materializer": "review",
        "written": [],
        "reviewSummary": {"pending": 2, "approved": 1, "rejected": 0},
    }
    path.write_text(json.dumps(job), encoding="utf-8")
    closed = run_jobs(tmp_path, "close-review", job_id)
    assert closed.returncode == 0
    assert json.loads(closed.stdout)["reviewSummary"] == {"pending": 0, "approved": 1, "rejected": 0, "expired": 2}

    assert run_jobs(tmp_path, "close-review", "bad-id").returncode == 2
    assert run_jobs(tmp_path, "close-review", "f" * 24).returncode == 1
    assert run_jobs(tmp_path, "close-review", job_id).returncode == 2


def test_purge_terminalizes_pending_review_and_counts_empty_arrays(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    job_id, path = write_job(tmp_path, state="review-ready", payload=None)
    job = json.loads(path.read_text(encoding="utf-8"))
    job["result"] = {
        "candidateCount": 2,
        "materializer": "review",
        "written": [],
        "reviewCandidates": [
            {"candidate_id": "one", "body": "private one"},
            {"candidate_id": "two", "body": "private two"},
        ],
        "reviewSummary": {"pending": 2, "approved": 0, "rejected": 0},
    }
    path.write_text(json.dumps(job), encoding="utf-8")
    dry = run_jobs(tmp_path, "purge", "--all-terminal", "--dry-run")
    assert dry.returncode == 0
    assert json.loads(dry.stdout)["removed"] == [job_id]
    assert json.loads(path.read_text(encoding="utf-8"))["state"] == "review-ready"

    purged = run_jobs(tmp_path, "purge", "--all-terminal")
    assert purged.returncode == 0
    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert persisted["state"] == "done"
    assert persisted["result"]["reviewSummary"] == {"pending": 0, "approved": 0, "rejected": 0, "expired": 2}
    assert "private one" not in path.read_text(encoding="utf-8")

    # Empty arrays are explicit private detail in both Python and TypeScript.
    job["state"] = "review-ready"
    job["result"] = {"candidateCount": 0, "materializer": "review", "written": [], "reviewCandidates": []}
    path.write_text(json.dumps(job), encoding="utf-8")
    assert json.loads(run_jobs(tmp_path, "purge", "--all-terminal", "--dry-run").stdout)["removed"] == [job_id]
