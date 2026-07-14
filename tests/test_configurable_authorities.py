from __future__ import annotations

import json
import pytest
import knowledge_absorb as absorb
import knowledge_lint as lint
from tests.conftest import _write_inbox_candidate

OPEN_SPEC = [{
    "action": "promote_to_openspec",
    "kind": "openspec_followup",
    "directory": "openspec",
    "handoff": "openspec-author",
    "destination": "openspec/changes/<change>/",
}]


def test_builtins_remain_without_configuration(monkeypatch):
    monkeypatch.delenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", raising=False)
    authorities = absorb.followup_authorities()
    assert set(authorities) == {"promote_to_skill", "promote_to_module_doc"}
    assert "promote_to_openspec" not in authorities


def test_configured_openspec_authority_flows_through_contract(monkeypatch):
    monkeypatch.setenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", json.dumps(OPEN_SPEC))
    assert absorb.followup_kind_for_action("promote_to_openspec") == "openspec_followup"
    assert absorb.followup_dir_for_kind("openspec_followup") == "openspec"
    assert absorb.suggested_destination_for_followup("promote_to_openspec", {}) == "openspec/changes/<change>/"
    artifact = absorb.render_followup_artifact(
        "knowledge/inbox/x.md", "promote_to_openspec",
        {"name": "Spec", "description": "Promote this requirement"}, "body",
        "openspec/changes/<change>/", "reason", ["evidence"], .8,
    )
    assert artifact["kind"] == "openspec_followup"
    assert artifact["handoffTo"] == "openspec-author"
    assert lint.check_kind(artifact, "x.json") == []
    assert lint.check_source_action(artifact, "x.json") == []
    assert lint.check_handoff_to(artifact, "x.json") == []


def test_configured_authority_destination_wins_over_facts_destination(workspace, monkeypatch):
    monkeypatch.setenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", json.dumps(OPEN_SPEC))
    candidate = _write_inbox_candidate(
        workspace,
        "openspec.md",
        name="OpenSpec migration decision",
        description="Promote this decision to the OpenSpec authority.",
        suggested_action="promote_to_openspec",
        suggested_scope="workspace",
        candidate_id="openspec-migration-decision",
    )
    action = absorb.classify_candidate(workspace, candidate)
    assert action.action == "promote_to_openspec"
    assert action.destination == "openspec/changes/<change>/"
    assert action.safeToApply is False

    result = absorb.apply_followup_artifact(workspace, absorb.dataclasses.asdict(action))
    artifact = json.loads((workspace / result["path"]).read_text(encoding="utf-8"))
    assert artifact["suggestedDestination"] == "openspec/changes/<change>/"


def test_explicit_candidate_destination_wins_over_configured_authority(workspace, monkeypatch):
    monkeypatch.setenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", json.dumps(OPEN_SPEC))
    candidate = _write_inbox_candidate(
        workspace,
        "explicit.md",
        name="Explicit destination",
        description="Promote to a specifically selected change.",
        suggested_action="promote_to_openspec",
        suggested_scope="workspace",
        candidate_id="explicit-destination",
        extra_frontmatter={"destination": "openspec/changes/specific-change/"},
    )
    action = absorb.classify_candidate(workspace, candidate)
    assert action.destination == "openspec/changes/specific-change/"


def test_retain_memory_still_uses_facts_destination(workspace, monkeypatch):
    monkeypatch.setenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", json.dumps(OPEN_SPEC))
    candidate = _write_inbox_candidate(
        workspace,
        "retain.md",
        name="Retain this memory",
        description="A durable workspace fact retained as curated memory.",
        suggested_action="retain_memory",
        suggested_scope="workspace",
    )
    action = absorb.classify_candidate(workspace, candidate)
    assert action.action == "retain_memory"
    assert action.destination == "knowledge/facts/workspace/retain-this-memory.md"


def test_builtin_promote_destination_remains_authority_owned(workspace, monkeypatch):
    monkeypatch.delenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", raising=False)
    candidate = _write_inbox_candidate(
        workspace,
        "skill.md",
        name="Reusable deployment skill",
        description="A repeatable deployment workflow.",
        suggested_action="promote_to_skill",
        suggested_scope="workspace",
    )
    action = absorb.classify_candidate(workspace, candidate)
    assert action.destination == "agent-workspace/skills/<skill>/"


def test_malformed_authority_config_fails_closed(monkeypatch):
    monkeypatch.setenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", "not-json")
    with pytest.raises(ValueError, match="Invalid SHARED_KNOWLEDGE"):
        absorb.followup_authorities()
    monkeypatch.setenv("SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES", '[{"action":"promote_to_x"}]')
    with pytest.raises(ValueError, match="require non-empty fields"):
        absorb.followup_authorities()
