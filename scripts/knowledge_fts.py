#!/usr/bin/env python3
"""Deterministic FTS5 query helpers for internal evidence lookups."""
from __future__ import annotations


def fts5_literal_query(value: object, max_chars: int = 100) -> str:
    """Encode bounded text as one FTS5 literal phrase, never as query syntax."""
    if max_chars <= 0:
        return ""
    normalized = " ".join(str(value or "").replace("\x00", " ").split())[:max_chars].strip()
    if not normalized:
        return ""
    return f'"{normalized.replace(chr(34), chr(34) * 2)}"'
