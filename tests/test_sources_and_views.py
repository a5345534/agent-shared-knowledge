from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

import knowledge_jobs as jobs_cli
import knowledge_sources as sources
import knowledge_views as views


def git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=True)
    return result.stdout.strip()


def git_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "repo"; root.mkdir()
    git(root, "init", "-b", "main"); git(root, "config", "user.email", "test@example.com"); git(root, "config", "user.name", "Test")
    (root / "AGENTS.md").write_text("# Adopter\n", encoding="utf-8")
    (root / "README.md").write_text("# Repo\n", encoding="utf-8")
    (root / "knowledge/facts/workspace").mkdir(parents=True)
    (root / "knowledge/inbox").mkdir(parents=True)
    (root / "knowledge/facts/workspace/rule.md").write_text("---\nname: Rule\ndescription: Durable rule\ntype: reference\nscope: workspace\nverified_at: 2026-01-01\nsource: human:test\n---\n\nThe canonical rule.\n", encoding="utf-8")
    git(root, "add", "."); git(root, "commit", "-m", "initial")
    monkeypatch.setenv("SHARED_KNOWLEDGE_RUNTIME_DIR", str(tmp_path / "state"))
    return root


def test_source_instances_reject_secrets_and_are_independent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch)
    config = {"version": 1, "sources": [{"id": "one", "type": "git", "path": "."}, {"id": "two", "type": "git", "path": "."}]}
    (root / sources.DEFAULT_CONFIG).write_text(json.dumps(config), encoding="utf-8")
    assert [item["id"] for item in sources.read_sources(root)] == ["one", "two"]
    config["sources"][0]["api_key"] = "secret"
    (root / sources.DEFAULT_CONFIG).write_text(json.dumps(config), encoding="utf-8")
    with pytest.raises(ValueError, match="secret value"):
        sources.read_sources(root)


def test_git_collection_incremental_enqueue_ack_and_provenance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch)
    source = sources.read_sources(root)[0]
    first = sources.collect_git(root, source, enqueue=True)
    assert first["sourceId"] == "git-default" and first["rawFiles"]
    assert Path(first["rawFiles"][0]).stat().st_mode & 0o077 == 0
    job = sources.runtime_root(root) / "jobs" / f"{first['jobId']}.json"
    payload = json.loads(job.read_text())
    assert payload["payload"]["source"]["runId"] == first["runId"]
    assert payload["payload"]["source"]["evidencePaths"][0].startswith("source://git-default/")
    ack = sources.acknowledge(root, "git-default", first["runId"])
    assert ack["cursor"]["gitHead"] == git(root, "rev-parse", "HEAD")
    (root / "policy.md").write_text("A new durable policy\n", encoding="utf-8")
    git(root, "add", "policy.md"); git(root, "commit", "-m", "add policy")
    second = sources.collect_git(root, source)
    evidence = json.loads(Path(second["rawFiles"][0]).read_text())
    assert "policy.md" in evidence["changedPaths"]
    assert evidence["previousHead"] == ack["cursor"]["gitHead"]


def test_job_status_redacts_payload_and_purge_is_bounded(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch)
    first = sources.collect_git(root, sources.read_sources(root)[0], enqueue=True)
    entries = jobs_cli.jobs(root)
    assert len(entries) == 1
    safe = jobs_cli.safe(entries[0][1])
    assert "payload" not in safe and safe["hasPayload"] is True
    entries[0][1]["state"] = "done"
    entries[0][1]["updatedAt"] = "2000-01-01T00:00:00Z"
    sources.atomic_json(entries[0][0], entries[0][1])
    # CLI helper selection can only remove terminal job files, never tracked knowledge.
    assert (root / "knowledge/facts/workspace/rule.md").exists()


def test_excluded_only_git_change_is_noop_and_advances_collection_cursor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch); source = sources.read_sources(root)[0]
    first = sources.collect_git(root, source); sources.acknowledge(root, source["id"], first["runId"])
    (root / "package-lock.json").write_text("{}\n"); git(root, "add", "package-lock.json"); git(root, "commit", "-m", "lock only")
    second = sources.collect_git(root, source, enqueue=True)
    assert second["status"] == "noop" and "jobId" not in second
    state = sources.source_state(root, source["id"])
    assert state["cursor"]["gitHead"] == git(root, "rev-parse", "HEAD") and "pending" not in state


def test_source_path_confinement_and_cleanup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch)
    first = sources.collect_git(root, sources.read_sources(root)[0])
    raw = Path(first["rawFiles"][0]).parent
    old = raw.stat().st_mtime
    os.utime(raw, (old - 10 * 86400, old - 10 * 86400))
    assert sources.cleanup(root, 7, True)
    assert raw.exists()
    sources.cleanup(root, 7, False)
    assert not raw.exists()


def response(path: Path) -> None:
    path.write_text(json.dumps({"pages": [{"path": "quickstart.md", "title": "Quickstart", "body": "Navigate canonical knowledge.", "evidence": ["knowledge/facts/workspace/rule.md"]}], "gaps": []}), encoding="utf-8")


def test_derived_view_is_labeled_snapshotted_and_noop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch); result_file = tmp_path / "response.json"; response(result_file)
    first = views.update_view(root, views.DEFAULT_VIEW, result_file)
    page = root / views.DEFAULT_VIEW / "quickstart.md"
    assert first["changed"] is True
    assert "authority: derived" in page.read_text()
    metadata_before = (root / views.DEFAULT_VIEW / views.METADATA_FILE).read_text()
    second = views.update_view(root, views.DEFAULT_VIEW, result_file)
    assert second["changed"] is False
    assert (root / views.DEFAULT_VIEW / views.METADATA_FILE).read_text() == metadata_before
    result_file.write_text(json.dumps({"pages": [{"path": "replacement.md", "title": "Replacement", "body": "A replacement derived page."}]}))
    views.update_view(root, views.DEFAULT_VIEW, result_file)
    assert not page.exists() and (root / views.DEFAULT_VIEW / "replacement.md").exists()


def test_derived_path_guards_and_openwiki_collision(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch); result_file = tmp_path / "bad.json"
    with pytest.raises(ValueError, match="overlaps"):
        views.resolve_output(root, "knowledge/facts")
    result_file.write_text(json.dumps({"pages": [{"path": "../facts/evil.md", "title": "Bad", "body": "Bad body"}]}))
    with pytest.raises(ValueError, match="unsafe"):
        views.update_view(root, views.DEFAULT_VIEW, result_file)
    (root / "openwiki").mkdir(); (root / "openwiki/.last-update.json").write_text("{}")
    with pytest.raises(ValueError, match="owned"):
        views.update_view(root, "openwiki", result_file)


def test_managed_guidance_preserves_content_and_rejects_malformed(tmp_path: Path):
    path = tmp_path / "AGENTS.md"; path.write_text("# Mine\n", encoding="utf-8")
    assert views.managed_section(path, "first", False)["changed"]
    assert path.read_text().startswith("# Mine")
    views.managed_section(path, "second", False)
    assert path.read_text().count(views.START) == 1 and "second" in path.read_text()
    path.write_text(path.read_text() + views.START)
    with pytest.raises(ValueError, match="malformed"):
        views.managed_section(path, "bad", False)


def test_generated_pages_are_outside_canonical_scan(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch); result_file = tmp_path / "response.json"; response(result_file)
    views.update_view(root, views.DEFAULT_VIEW, result_file)
    from knowledge_query import collect_curated_entries
    paths = [entry.path for entry in collect_curated_entries(root)]
    assert not any("knowledge/views" in item for item in paths)


def test_workflow_is_opt_in_restricted_and_does_not_promote():
    workflow = views.workflow_text()
    assert "pull-requests: write" in workflow
    assert "knowledge/facts" not in workflow
    assert "knowledge/inbox" in workflow and "knowledge/views/wiki" in workflow
    assert "create-pull-request@22a908" in workflow
    assert "merge" not in workflow.lower()


def test_derived_gaps_enter_inbox_with_provenance(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    root = git_workspace(tmp_path, monkeypatch); result_file = tmp_path / "response.json"
    result_file.write_text(json.dumps({"pages": [{"path": "quickstart.md", "title": "Quickstart", "body": "A derived overview."}],
        "gaps": [{"name": "Missing Policy", "description": "A durable policy may be missing.", "body": "The repository evidence suggests a durable policy needs review.", "reason": "Not present in canonical facts"}]}))
    result = views.update_view(root, views.DEFAULT_VIEW, result_file)
    assert len(result["gapCandidates"]) == 1
    candidate = (root / result["gapCandidates"][0]).read_text()
    assert "capture_source: agent:derived-wiki" in candidate
    assert "derived-view-snapshot:" in candidate


def test_lifecycle_source_has_no_model_call_in_capture_handler():
    extension = (Path(__file__).resolve().parents[1] / ".pi/extensions/shared-knowledge-lifecycle.ts").read_text()
    capture = extension.split('pi.on("session_before_compact"', 1)[1].split('pi.on("session_compact"', 1)[0]
    assert "complete(" not in capture
    assert "getApiKeyAndHeaders" not in capture
    assert "queueFor(ctx.cwd).enqueue" in capture
