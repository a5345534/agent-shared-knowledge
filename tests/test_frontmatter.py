"""Unit tests for frontmatter parsing (supported subset only)."""

from __future__ import annotations

import pytest
import knowledge_absorb as ka
import knowledge_query as kq
import knowledge_lint as kl


# ---------------------------------------------------------------------------
# Shared parsing test data
# ---------------------------------------------------------------------------

SIMPLE_FRONTMATTER = """---
name: Test Entry
description: A test description.
type: reference
scope: workspace
verified_at: 2026-06-22
source: agent:test
---
This is the body text.
"""

EMPTY_FRONTMATTER = """---
name: 
description: 
type: 
---
Body after empty frontmatter values.
"""

LIST_FRONTMATTER = """---
name: List Test
tags:
  - tag1
  - tag2
  - tag3
evidence:
  - Evidence item 1
  - Evidence item 2
---
Body with lists.
"""

NO_FRONTMATTER = """This is just body text with no frontmatter at all.
It spans multiple lines and has no --- delimiters.
"""

ONLY_OPENING_DASHES = """---
Some text that looks like frontmatter but is missing closing dashes.
"""

MIXED_VALUES = """---
name: Mixed Entry
confidence: 0.85
evidence:
  - First evidence
  - Second evidence
source: agent:test
---
Body content for mixed values.
"""


class TestParseFrontmatterInAbsorb:
    """Test frontmatter parsing via knowledge_absorb.parse_frontmatter."""

    def test_parses_simple_frontmatter(self):
        """Simple frontmatter with scalar values is parsed correctly."""
        fm, body = ka.parse_frontmatter(SIMPLE_FRONTMATTER)
        assert fm["name"] == "Test Entry"
        assert fm["description"] == "A test description."
        assert fm["type"] == "reference"
        assert fm["scope"] == "workspace"
        assert fm["verified_at"] == "2026-06-22"
        assert fm["source"] == "agent:test"
        assert "This is the body text." in body

    def test_returns_empty_dict_for_no_frontmatter(self):
        """Text without frontmatter returns empty dict and full body."""
        fm, body = ka.parse_frontmatter(NO_FRONTMATTER)
        assert fm == {}
        assert body == NO_FRONTMATTER.strip()

    def test_parses_list_values(self):
        """List values (  - item) are parsed into arrays."""
        fm, body = ka.parse_frontmatter(LIST_FRONTMATTER)
        assert fm["name"] == "List Test"
        assert isinstance(fm["tags"], list)
        assert fm["tags"] == ["tag1", "tag2", "tag3"]
        assert isinstance(fm["evidence"], list)
        assert fm["evidence"] == ["Evidence item 1", "Evidence item 2"]

    def test_empty_values_are_empty_strings_or_lists(self):
        """Fields with empty values are treated as empty lists in the parser (value=="" path)."""
        fm, body = ka.parse_frontmatter(EMPTY_FRONTMATTER)
        # When value after colon is empty, parser creates an empty list
        assert fm["name"] == []
        assert fm["description"] == []
        assert fm["type"] == [] or fm["type"] == ""

    def test_body_trimmed(self):
        """The body returned is stripped of leading/trailing whitespace."""
        text = "---\nkey: val\n---\n\n\n  \nBody text here.  \n\n"
        fm, body = ka.parse_frontmatter(text)
        assert body == "Body text here."

    def test_mixed_scalar_and_list(self):
        """Frontmatter with both scalars and lists parses correctly."""
        fm, body = ka.parse_frontmatter(MIXED_VALUES)
        assert fm["name"] == "Mixed Entry"
        assert fm["confidence"] == "0.85"  # scalars are string
        assert isinstance(fm["evidence"], list)
        assert len(fm["evidence"]) == 2

    def test_handles_quoted_values(self):
        """Quoted values are unquoted by the parser."""
        text = '---\nname: "Quoted Name"\ndescription: "Quoted Description"\n---\nBody.'
        fm, body = ka.parse_frontmatter(text)
        assert fm["name"] == "Quoted Name"
        assert fm["description"] == "Quoted Description"


class TestParseFrontmatterInQuery:
    """Test that knowledge_query.parse_frontmatter behaves identically."""

    def test_query_parser_matches_absorb(self):
        """Both scripts' frontmatter parsers produce identical results."""
        for text in [SIMPLE_FRONTMATTER, LIST_FRONTMATTER, NO_FRONTMATTER, MIXED_VALUES]:
            fm_a, body_a = ka.parse_frontmatter(text)
            fm_q, body_q = kq.parse_frontmatter(text)
            assert fm_a == fm_q, f"Mismatch for text: {text[:40]}..."
            assert body_a == body_q


class TestParseFrontmatterInLint:
    """Test that knowledge_lint.parse_frontmatter behaves identically."""

    def test_lint_parser_matches_absorb(self):
        """Lint's frontmatter parser matches absorb's."""
        for text in [SIMPLE_FRONTMATTER, LIST_FRONTMATTER, NO_FRONTMATTER]:
            fm_a, body_a = ka.parse_frontmatter(text)
            fm_l, body_l = kl.parse_frontmatter(text)
            assert fm_a == fm_l


# ---------------------------------------------------------------------------
# Scope parsing tests
# ---------------------------------------------------------------------------

class TestScopeParsing:
    """Test scope normalization and parsing."""

    def test_workspace_scope(self):
        """scope: workspace parses correctly."""
        scope, directory = ka.normalize_scope("workspace")
        assert scope == "workspace"
        assert "workspace" in directory

    def test_module_scope(self):
        """scope: module:<name> parses correctly."""
        scope, directory = ka.normalize_scope("module:testmod")
        assert scope == "module:testmod"
        assert "module/testmod" in directory

    def test_capability_scope(self):
        """scope: capability:<name> parses correctly."""
        scope, directory = ka.normalize_scope("capability:testcap")
        assert scope == "capability:testcap"
        assert "capability/testcap" in directory

    def test_invalid_scope_returns_none(self):
        """An invalid scope returns None."""
        result = ka.normalize_scope("invalid:scope:format")
        assert result is None

    def test_query_parse_scope_workspace(self):
        """kq.parse_scope handles workspace."""
        st, sn = kq.parse_scope("workspace")
        assert st == "workspace"
        assert sn == ""

    def test_query_parse_scope_module(self):
        """kq.parse_scope handles module scopes."""
        st, sn = kq.parse_scope("module:testmod")
        assert st == "module"
        assert sn == "testmod"

    def test_query_parse_scope_capability(self):
        """kq.parse_scope handles capability scopes."""
        st, sn = kq.parse_scope("capability:testcap")
        assert st == "capability"
        assert sn == "testcap"

    def test_query_parse_scope_fallback(self):
        """kq.parse_scope falls back to workspace for unrecognized formats."""
        st, sn = kq.parse_scope("garbage")
        assert st == "workspace"
        assert sn == ""


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestFrontmatterEdgeCases:
    """Edge cases for frontmatter parsing."""

    def test_multiline_continuous_list(self):
        """A list that has multiple continuation items."""
        text = "---\ntags:\n  - a\n  - b\n  - c\n---\nBody."
        fm, body = ka.parse_frontmatter(text)
        assert len(fm["tags"]) == 3

    def test_key_with_no_colon_ignored(self):
        """Lines without colons are skipped."""
        text = "---\norphan line\nname: Test\n---\nBody."
        fm, _ = ka.parse_frontmatter(text)
        assert fm["name"] == "Test"

    def test_frontmatter_with_dashes_in_body(self):
        """Body text containing --- should not confuse the parser."""
        text = "---\nname: Test\n---\n\nBody with --- inside it."
        fm, body = ka.parse_frontmatter(text)
        assert fm["name"] == "Test"
        assert "Body with --- inside it." in body

    def test_frontmatter_only_opening_dashes(self):
        """Only opening --- without closing --- returns empty dict."""
        fm, body = ka.parse_frontmatter(ONLY_OPENING_DASHES)
        assert fm == {}
        # The text without frontmatter delimiter should be the body
        assert "Some text" in body

    def test_comment_keyword_supported(self):
        """Frontmatter fields with common keywords are parsed."""
        text = "---\nreason: This is a reason\nstatus: active\n---\nBody."
        fm, _ = ka.parse_frontmatter(text)
        assert fm["reason"] == "This is a reason"
        assert fm["status"] == "active"
