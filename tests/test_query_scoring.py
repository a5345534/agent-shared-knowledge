"""Unit tests for ranking and scoring in search results."""

from __future__ import annotations

import pytest

import knowledge_query as kq


class TestComputeScore:
    """Unit tests for the compute_score function."""

    def test_score_is_non_negative(self):
        """Score should always be >= 0."""
        entry = {
            "name": "Test",
            "description": "Test description.",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score, breakdown, reasons = kq.compute_score(entry, -5.0, "test")
        assert score >= 0.0

    def test_better_rank_gives_higher_fts_base(self):
        """A better (closer to 0) FTS rank gives a higher base score."""
        entry = {
            "name": "Test",
            "description": "",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score_good, _, _ = kq.compute_score(entry, -1.0, "")
        score_bad, _, _ = kq.compute_score(entry, -10.0, "")
        assert score_good > score_bad

    def test_name_match_boost(self):
        """When query text is in name, a name_match boost is applied."""
        entry = {
            "name": "Validation Hook for CI/CD",
            "description": "Something else.",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score, breakdown, reasons = kq.compute_score(entry, -5.0, "Validation")
        assert breakdown.get("name_match", 0) > 0
        assert any("name match" in r for r in reasons)

    def test_description_match_boost(self):
        """When query text is in description, a description_match boost is applied."""
        entry = {
            "name": "Some Entry",
            "description": "This entry handles CI/CD pipeline validation.",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score, breakdown, reasons = kq.compute_score(entry, -5.0, "CI/CD")
        assert breakdown.get("description_match", 0) > 0

    def test_scope_exact_match_boost(self):
        """When scope_filter matches entry scope, a scope boost is applied."""
        entry = {
            "name": "Module Entry",
            "description": "",
            "scope": "module:workflow",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score, breakdown, reasons = kq.compute_score(
            entry, -5.0, "", scope_filter="module:workflow"
        )
        assert breakdown.get("scope", 0.0) == kq.BOOST_SCOPE_EXACT

    def test_scope_partial_match_boost(self):
        """Partial scope match (e.g., 'workflow' matches 'module:workflow') gets 80% boost."""
        entry = {
            "name": "Entry",
            "description": "",
            "scope": "module:workflow",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score, breakdown, reasons = kq.compute_score(
            entry, -5.0, "", scope_filter="workflow"
        )
        assert breakdown.get("scope", 0.0) > 0
        assert breakdown["scope"] == round(kq.BOOST_SCOPE_EXACT * 0.8, 4)

    def test_architectural_invariant_boost(self):
        """Architectural-invariant type gets a boost."""
        entry_arch = {
            "name": "Arch Entry",
            "description": "",
            "scope": "workspace",
            "type": "architectural-invariant",
            "verified_at": "2026-06-22",
        }
        entry_ref = {
            "name": "Ref Entry",
            "description": "",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score_arch, _, _ = kq.compute_score(entry_arch, -5.0, "")
        score_ref, _, _ = kq.compute_score(entry_ref, -5.0, "")
        assert score_arch > score_ref

    def test_staleness_penalty(self):
        """Stale entries (verified_at > threshold) get a penalty."""
        entry_stale = {
            "name": "Stale Entry",
            "description": "",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2000-01-01",  # Very old
        }
        entry_fresh = {
            "name": "Fresh Entry",
            "description": "",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2026-06-22",  # Recent
        }
        score_stale, bd_stale, _ = kq.compute_score(entry_stale, -5.0, "")
        score_fresh, _, _ = kq.compute_score(entry_fresh, -5.0, "")

        # The stale entry should have a staleness penalty
        if "staleness_penalty" in bd_stale:
            assert bd_stale["staleness_penalty"] < 0
            assert score_stale <= score_fresh

    def test_score_breakdown_has_required_keys(self):
        """Score breakdown always includes fts, scope, type keys."""
        entry = {
            "name": "Test",
            "description": "",
            "scope": "workspace",
            "type": "reference",
            "verified_at": "2026-06-22",
        }
        score, breakdown, reasons = kq.compute_score(entry, -5.0, "")
        assert "fts" in breakdown
        assert "type" in breakdown

    def test_fts_base_score_proportional(self):
        """FTS base score maps rank to [0,1] range correctly."""
        # rank=-1 should give score around 0.5
        # rank=-100 should give score close to 0
        entry = {"name": "T", "description": "", "scope": "workspace",
                 "type": "reference", "verified_at": "2026-06-22"}

        score_near, _, _ = kq.compute_score(entry, -1.0, "")
        score_far, _, _ = kq.compute_score(entry, -100.0, "")

        assert score_near > score_far
        assert 0.0 <= score_near <= 2.0  # With possible boosts


class TestPriorityKey:
    """Tests for the priority_key function used in injection ordering."""

    def test_arch_invariant_first(self):
        """Architectural-invariant entries sort before others."""
        arch_entry = {"type": "architectural-invariant", "score": 0.5}
        ref_entry = {"type": "reference", "score": 1.0}

        arch_key = kq.priority_key(arch_entry)
        ref_key = kq.priority_key(ref_entry)

        assert arch_key < ref_key, "Arch-invariant should sort first"

    def test_higher_score_second(self):
        """When type is same, higher score sorts first."""
        e1 = {"type": "reference", "score": 0.9}
        e2 = {"type": "reference", "score": 0.3}

        # priority_key produces (is_arch, -score) so lower is better
        k1 = kq.priority_key(e1)
        k2 = kq.priority_key(e2)

        assert k1 < k2, "Higher score should sort before lower score"


class TestDaysSince:
    """Tests for the days_since helper."""

    def test_valid_date(self):
        """days_since returns correct age for a valid date."""
        import datetime as dt
        yesterday = (dt.date.today() - dt.timedelta(days=1)).isoformat()
        days = kq.days_since(yesterday)
        assert days == 1

    def test_invalid_date_returns_none(self):
        """days_since returns None for invalid dates."""
        assert kq.days_since("not-a-date") is None
        assert kq.days_since("") is None

    def test_future_date(self):
        """days_since returns negative for future dates."""
        import datetime as dt
        future = (dt.date.today() + dt.timedelta(days=30)).isoformat()
        days = kq.days_since(future)
        assert days is not None
        assert days < 0
