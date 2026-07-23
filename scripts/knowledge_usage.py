#!/usr/bin/env python3
"""Private append-only knowledge usage heat log (stats only; no ranking feedback)."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from knowledge_sources import now, private_dir, runtime_root

USAGE_VERSION = 1
DEFAULT_CAP = 50
DEFAULT_RETENTION_DAYS = 90
DEFAULT_WINDOW_DAYS = 30
ENV_DISABLE = "SHARED_KNOWLEDGE_USAGE_HEAT"
VALID_EVENTS = frozenset({
    "search_hit",
    "resolve_hit",
    "inject_selected",
    "inject_budget_dropped",
})


def usage_enabled() -> bool:
    return os.environ.get(ENV_DISABLE, "1").strip() != "0"


def usage_dir(root: Path) -> Path:
    return runtime_root(root) / "usage"


def events_path(root: Path) -> Path:
    return usage_dir(root) / "events.jsonl"


def query_hash(text: str | None) -> str | None:
    if not text or not str(text).strip():
        return None
    normalized = " ".join(str(text).strip().lower().split())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:32]


def session_key(raw: str | None = None) -> str | None:
    value = raw or os.environ.get("SHARED_KNOWLEDGE_USAGE_SESSION") or ""
    if not value.strip():
        return None
    return hashlib.sha256(value.strip().encode("utf-8")).hexdigest()[:24]


def _lock_path(root: Path) -> Path:
    return usage_dir(root) / "events.lock"


def _with_lock(root: Path, action) -> None:
    private_dir(usage_dir(root))
    lock = _lock_path(root)
    deadline = time.time() + 1.0
    fd = None
    while time.time() < deadline:
        try:
            fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            break
        except FileExistsError:
            try:
                age = time.time() - lock.stat().st_mtime
                if age > 30:
                    lock.unlink(missing_ok=True)
            except OSError:
                pass
            time.sleep(0.02)
    if fd is None:
        raise OSError("usage log busy")
    try:
        os.write(fd, f"{os.getpid()}\n".encode())
        action()
    finally:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            lock.unlink(missing_ok=True)
        except OSError:
            pass


def append_events(root: Path, events: Iterable[dict[str, Any]], *, cap: int = DEFAULT_CAP) -> int:
    """Append bounded events. Fail-open: returns written count or 0 on error."""
    if not usage_enabled():
        return 0
    batch: list[dict[str, Any]] = []
    for raw in events:
        if len(batch) >= cap:
            break
        event = raw.get("event")
        if event not in VALID_EVENTS:
            continue
        entry_id = str(raw.get("entry_id") or "").strip()
        path = str(raw.get("path") or "").strip()
        if not entry_id and not path:
            continue
        record = {
            "v": USAGE_VERSION,
            "ts": now(),
            "event": event,
            "entry_id": entry_id or None,
            "path": path or None,
            "scope": (str(raw["scope"]).strip() if raw.get("scope") else None),
            "type": (str(raw["type"]).strip() if raw.get("type") else None),
            "command": (str(raw["command"]).strip() if raw.get("command") else None),
        }
        if raw.get("rank") is not None:
            try:
                record["rank"] = int(raw["rank"])
            except (TypeError, ValueError):
                pass
        qh = raw.get("query_hash")
        if isinstance(qh, str) and qh:
            record["query_hash"] = qh[:32]
        sk = raw.get("session_key")
        if isinstance(sk, str) and sk:
            record["session_key"] = sk[:24]
        batch.append(record)
    if not batch:
        return 0

    def write() -> None:
        path = events_path(root)
        private_dir(path.parent)
        with path.open("a", encoding="utf-8") as handle:
            for item in batch:
                handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        try:
            path.chmod(0o600)
        except OSError:
            pass

    try:
        _with_lock(root, write)
        return len(batch)
    except Exception:
        return 0


def emit_hits(
    root: Path,
    *,
    event: str,
    entries: list[dict[str, Any]],
    command: str,
    query: str | None = None,
    cap: int = DEFAULT_CAP,
) -> int:
    sk = session_key()
    qh = query_hash(query)
    seen: set[str] = set()
    payload: list[dict[str, Any]] = []
    for index, entry in enumerate(entries):
        key = str(entry.get("id") or entry.get("path") or "")
        if not key or key in seen:
            continue
        seen.add(key)
        payload.append({
            "event": event,
            "entry_id": entry.get("id"),
            "path": entry.get("path"),
            "scope": entry.get("scope"),
            "type": entry.get("type"),
            "command": command,
            "rank": index + 1,
            "query_hash": qh,
            "session_key": sk,
        })
    return append_events(root, payload, cap=cap)


def read_events(root: Path) -> list[dict[str, Any]]:
    path = events_path(root)
    if not path.exists():
        return []
    out: list[dict[str, Any]] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict) and item.get("event") in VALID_EVENTS:
                out.append(item)
    except OSError:
        return []
    return out


def purge_events(root: Path, *, retention_days: int = DEFAULT_RETENTION_DAYS) -> int:
    if retention_days < 0:
        return 0
    events = read_events(root)
    if not events:
        return 0
    cutoff = time.time() - retention_days * 86400

    def parse_ts(value: str) -> float:
        try:
            # 2026-07-21T00:00:00Z
            from datetime import datetime, timezone
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0.0

    kept = [e for e in events if parse_ts(str(e.get("ts") or "")) >= cutoff]
    removed = len(events) - len(kept)

    def write() -> None:
        path = events_path(root)
        private_dir(path.parent)
        tmp = path.with_name(f".events.{os.getpid()}.tmp")
        with tmp.open("w", encoding="utf-8") as handle:
            for item in kept:
                handle.write(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n")
        tmp.chmod(0o600)
        tmp.replace(path)
        path.chmod(0o600)

    try:
        _with_lock(root, write)
    except Exception:
        return 0
    return removed


def _entry_key(event: dict[str, Any]) -> str:
    return str(event.get("entry_id") or event.get("path") or "")


def aggregate_heat(
    root: Path,
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    top: int = 10,
) -> dict[str, Any]:
    events = read_events(root)
    cutoff = time.time() - max(window_days, 0) * 86400

    def parse_ts(value: str) -> float:
        try:
            from datetime import datetime
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0.0

    windowed = [e for e in events if parse_ts(str(e.get("ts") or "")) >= cutoff]
    counts: Counter[str] = Counter()
    meta: dict[str, dict[str, Any]] = {}
    for event in windowed:
        key = _entry_key(event)
        if not key:
            continue
        counts[key] += 1
        meta.setdefault(key, {
            "entry_id": event.get("entry_id"),
            "path": event.get("path"),
            "scope": event.get("scope"),
            "type": event.get("type"),
        })

    hot = []
    for key, count in counts.most_common(max(top, 0) or 10):
        item = dict(meta.get(key) or {})
        item["hits"] = count
        item["key"] = key
        hot.append(item)

    indexed: list[dict[str, Any]] = []
    sqlite_path = root / "knowledge" / ".index" / "memory.sqlite"
    if sqlite_path.exists():
        try:
            db = sqlite3.connect(str(sqlite_path))
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT id, path, scope, type, name FROM memory_entries WHERE type != 'deprecated'"
            ).fetchall()
            db.close()
            for row in rows:
                indexed.append({
                    "entry_id": row["id"],
                    "path": row["path"],
                    "scope": row["scope"],
                    "type": row["type"],
                    "name": row["name"],
                    "key": row["id"] or row["path"],
                })
        except sqlite3.Error:
            indexed = []

    hit_keys = set(counts.keys())
    cold = []
    for entry in indexed:
        keys = {entry["key"], entry.get("path") or "", entry.get("entry_id") or ""}
        if hit_keys.intersection(k for k in keys if k):
            continue
        note = None
        if str(entry.get("scope") or "").startswith("workspace") or entry.get("scope") == "workspace":
            note = "B1 always-on index exposure is not counted as a query hit"
        cold.append({
            **entry,
            "hits": 0,
            "note": note,
        })

    return {
        "version": USAGE_VERSION,
        "windowDays": window_days,
        "eventCount": len(windowed),
        "totalEvents": len(events),
        "hot": hot,
        "cold": cold,
        "coldCount": len(cold),
        "hotCount": len(hot),
        "loggingEnabled": usage_enabled(),
    }


def summary_counts(root: Path, *, window_days: int = DEFAULT_WINDOW_DAYS) -> dict[str, int]:
    report = aggregate_heat(root, window_days=window_days, top=5)
    return {
        "events": int(report.get("eventCount") or 0),
        "hot": int(report.get("hotCount") or 0),
        "cold": int(report.get("coldCount") or 0),
    }
