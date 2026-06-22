#!/usr/bin/env python3
"""Lint workspace knowledge surfaces.

This script intentionally uses only the Python standard library so it can run
from a fresh checkout without bootstrapping project dependencies.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote


VALID_MEMORY_TYPES = {
    "feedback",
    "project",
    "reference",
    "user",
    "architectural-invariant",
    "deprecated",
}
VALID_MEMORY_SCOPE_RE = re.compile(r"^(workspace|module:[a-z0-9][a-z0-9-]*|capability:[a-z0-9][a-z0-9-]*)$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")
PATH_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9_./-])"
    r"((?:AGENTS\.md|docs|knowledge|agent-workspace|projects|docker)"
    r"[A-Za-z0-9_./#-]*)"
)
DEFAULT_STALENESS_THRESHOLD = 25
DEFAULT_INBOX_MAX_AGE_DAYS = 14
DEFAULT_INBOX_MAX_COUNT = 20
DEFAULT_WORKSPACE_MAX_COUNT = 20
SKIP_DIR_NAMES = {
    ".git",
    ".worktrees",
    "target",
    "node_modules",
    "dist",
    "build",
    "__pycache__",
}


@dataclasses.dataclass
class Finding:
    severity: str
    check_id: str
    surface: str
    location: str
    description: str
    fix_hint: str


def find_workspace_root(start: Path) -> Path:
    """Locate the workspace root by finding AGENTS.md."""
    current = start.resolve()
    while True:
        if (current / "AGENTS.md").exists():
            return current
        if current.parent == current:
            raise SystemExit("Could not find workspace root (no AGENTS.md found)")
        current = current.parent


def rel(root: Path, path: Path) -> str:
    root_abs = root.resolve()
    path_abs = path if path.is_absolute() else root / path
    try:
        return path_abs.absolute().relative_to(root_abs).as_posix()
    except ValueError:
        return path.as_posix()


def add_finding(findings: list[Finding], severity: str, check_id: str, surface: str, location: str, description: str, fix_hint: str) -> None:
    findings.append(Finding(severity, check_id, surface, location, description, fix_hint))


def iter_files(root: Path, suffixes: tuple[str, ...]) -> Iterable[Path]:
    if not root.exists():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if name not in SKIP_DIR_NAMES]
        for filename in filenames:
            path = Path(dirpath) / filename
            if path.suffix in suffixes:
                yield path


def markdown_link_targets(text: str) -> Iterable[tuple[str, int]]:
    code_fence_lines: set[int] = set()
    in_fence = False
    for number, line in enumerate(text.splitlines(), start=1):
        if line.lstrip().startswith("```"):
            code_fence_lines.add(number)
            in_fence = not in_fence
            continue
        if in_fence:
            code_fence_lines.add(number)

    line_starts = [0]
    for match in re.finditer(r"\n", text):
        line_starts.append(match.end())

    def line_for_index(index: int) -> int:
        lo = 0
        hi = len(line_starts) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if line_starts[mid] <= index:
                lo = mid + 1
            else:
                hi = mid - 1
        return hi + 1

    for match in MARKDOWN_LINK_RE.finditer(text):
        line_number = line_for_index(match.start())
        if line_number in code_fence_lines:
            continue
        line_start = line_starts[line_number - 1]
        line_end = text.find("\n", match.start())
        if line_end == -1:
            line_end = len(text)
        line_prefix = text[line_start : match.start()]
        line_suffix = text[match.end() : line_end]
        if line_prefix.count("`") % 2 == 1 and line_suffix.count("`") % 2 == 1:
            continue
        yield match.group(1), line_number


def normalize_link_target(raw: str) -> str | None:
    target = unquote(raw.strip().strip("<>"))
    if not target or target.startswith("#"):
        return None
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
        return None
    if " " in target and not Path(target).exists():
        target = target.split(" ", 1)[0].strip().strip("<>")
    target = target.split("#", 1)[0].strip()
    return target or None


def resolve_local_link(root: Path, source: Path, raw_target: str) -> Path | None:
    target = normalize_link_target(raw_target)
    if not target:
        return None
    if target.startswith("/"):
        return root / target.lstrip("/")
    relative = (source.parent / target).resolve()
    if relative.exists():
        return relative
    if not target.startswith(("./", "../")):
        root_relative = root / target
        if root_relative.exists():
            return root_relative.resolve()
    return relative


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text
    end = text.find("\n---", 4)
    if end == -1:
        return {}, text
    block = text[4:end]
    body = text[end + len("\n---") :].lstrip("\n")
    values: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line or line.startswith((" ", "\t")):
            continue
        key, value = line.split(":", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values, body


def memory_files(root: Path) -> list[Path]:
    shared = root / "knowledge/shared-memory"
    files = []
    for path in iter_files(shared, (".md",)):
        name = path.name
        rel_path = rel(root, path)
        if name in {"README.md", "MEMORY.md"}:
            continue
        if rel_path.startswith("knowledge/shared-memory/inbox/"):
            continue
        files.append(path)
    return sorted(files)


def inbox_candidate_files(root: Path) -> list[Path]:
    inbox = root / "knowledge/shared-memory/inbox"
    if not inbox.exists():
        return []
    return sorted(path for path in inbox.glob("*.md") if path.name != "README.md")


def workspace_memory_files(root: Path) -> list[Path]:
    workspace = root / "knowledge/shared-memory/workspace"
    if not workspace.exists():
        return []
    return sorted(path for path in workspace.glob("*.md") if path.name not in {"README.md", "MEMORY.md"})


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def expected_memory_scope(root: Path, path: Path) -> str | None:
    relative = path.relative_to(root / "knowledge/shared-memory")
    parts = relative.parts
    if not parts:
        return None
    if parts[0] == "workspace" and len(parts) == 2:
        return "workspace"
    if parts[0] == "module" and len(parts) >= 3:
        return f"module:{parts[1]}"
    if parts[0] == "capability" and len(parts) >= 3:
        return f"capability:{parts[1]}"
    return None


def inbox_candidate_date(path: Path, frontmatter: dict[str, str]) -> dt.date:
    captured_at = frontmatter.get("captured_at") or frontmatter.get("verified_at") or ""
    if ISO_DATE_RE.match(captured_at):
        return dt.date.fromisoformat(captured_at)
    return dt.datetime.fromtimestamp(path.stat().st_mtime).date()


def check_inbox_candidates(root: Path, findings: list[Finding]) -> None:
    inbox_files = inbox_candidate_files(root)
    inbox_max_count = env_int("SHARED_MEMORY_INBOX_MAX_COUNT", DEFAULT_INBOX_MAX_COUNT)
    inbox_max_age_days = env_int("SHARED_MEMORY_INBOX_MAX_AGE_DAYS", DEFAULT_INBOX_MAX_AGE_DAYS)
    today = dt.date.today()

    if len(inbox_files) > inbox_max_count:
        add_finding(
            findings,
            "warn",
            "memory-inbox-volume",
            "shared-memory",
            "knowledge/shared-memory/inbox",
            f"Shared-memory inbox contains {len(inbox_files)} candidates; threshold is {inbox_max_count}.",
            "Run the absorption workflow: python3 scripts/knowledge_absorb.py hook",
        )

    for path in inbox_files:
        text = path.read_text(encoding="utf-8")
        frontmatter, _ = parse_frontmatter(text)
        location = rel(root, path)
        for field in ("candidate_id", "captured_at", "capture_source", "source", "suggested_scope", "name", "description"):
            if not frontmatter.get(field):
                add_finding(
                    findings,
                    "warn",
                    "memory-frontmatter-invalid",
                    "shared-memory",
                    location,
                    f"Inbox candidate missing required field: {field}",
                    "Regenerate or repair the inbox candidate before absorption.",
                )
        age_days = (today - inbox_candidate_date(path, frontmatter)).days
        if age_days > inbox_max_age_days:
            add_finding(
                findings,
                "warn",
                "memory-inbox-aging",
                "shared-memory",
                location,
                f"Inbox candidate is {age_days} days old; threshold is {inbox_max_age_days}.",
                "Run the absorption workflow instead of leaving candidates in inbox.",
            )


def check_workspace_memory_pressure(root: Path, findings: list[Finding], workspace_count: int) -> None:
    workspace_max_count = env_int("SHARED_MEMORY_WORKSPACE_MAX_COUNT", DEFAULT_WORKSPACE_MAX_COUNT)
    if workspace_count > workspace_max_count:
        add_finding(
            findings,
            "warn",
            "memory-workspace-volume",
            "shared-memory",
            "knowledge/shared-memory/workspace",
            f"Curated workspace shared-memory has {workspace_count} active entries; recommended threshold is {workspace_max_count}.",
            "Run knowledge_absorb.py plan --include-workspace-backlog and move/promote/deprecate entries through the absorption workflow.",
        )


def build_pressure_summary(root: Path) -> dict[str, object]:
    inbox_files = inbox_candidate_files(root)
    today = dt.date.today()
    oldest_age = 0
    oldest_path = None
    for path in inbox_files:
        frontmatter, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
        age = max(0, (today - inbox_candidate_date(path, frontmatter)).days)
        if age >= oldest_age:
            oldest_age = age
            oldest_path = rel(root, path)

    active_workspace_count = 0
    for path in workspace_memory_files(root):
        frontmatter, _ = parse_frontmatter(path.read_text(encoding="utf-8"))
        if frontmatter.get("type") != "deprecated":
            active_workspace_count += 1

    thresholds = {
        "inboxMaxAgeDays": env_int("SHARED_MEMORY_INBOX_MAX_AGE_DAYS", DEFAULT_INBOX_MAX_AGE_DAYS),
        "inboxMaxCount": env_int("SHARED_MEMORY_INBOX_MAX_COUNT", DEFAULT_INBOX_MAX_COUNT),
        "workspaceMaxCount": env_int("SHARED_MEMORY_WORKSPACE_MAX_COUNT", DEFAULT_WORKSPACE_MAX_COUNT),
    }
    reasons = []
    if len(inbox_files) > thresholds["inboxMaxCount"]:
        reasons.append(f"inbox_count {len(inbox_files)} > {thresholds['inboxMaxCount']}")
    if inbox_files and oldest_age > thresholds["inboxMaxAgeDays"]:
        reasons.append(f"oldest_inbox_age_days {oldest_age} > {thresholds['inboxMaxAgeDays']}")
    if active_workspace_count > thresholds["workspaceMaxCount"]:
        reasons.append(f"workspace_memory_count {active_workspace_count} > {thresholds['workspaceMaxCount']}")

    return {
        "triggered": bool(reasons),
        "reasons": reasons,
        "thresholds": thresholds,
        "metrics": {
            "inboxCount": len(inbox_files),
            "oldestInboxAgeDays": oldest_age if inbox_files else None,
            "oldestInboxPath": oldest_path,
            "workspaceMemoryCount": active_workspace_count,
        },
    }


def check_shared_memory(root: Path, findings: list[Finding], fixes: dict[Path, str], staleness_threshold: int) -> None:
    shared_root = root / "knowledge/shared-memory"
    workspace_index = shared_root / "workspace/MEMORY.md"
    workspace_index_text = workspace_index.read_text(encoding="utf-8") if workspace_index.exists() else ""

    check_inbox_candidates(root, findings)
    active_workspace_count = 0

    if workspace_index.exists():
        for raw_target, line in markdown_link_targets(workspace_index_text):
            resolved = resolve_local_link(root, workspace_index, raw_target)
            if resolved and not resolved.exists():
                add_finding(
                    findings,
                    "error",
                    "memory-index-orphan",
                    "shared-memory",
                    f"{rel(root, workspace_index)}:{line}",
                    f"Shared-memory index link target is missing: {raw_target}",
                    "Update or remove the stale index entry.",
                )

    missing_workspace_index_lines: list[tuple[Path, dict[str, str]]] = []

    for path in memory_files(root):
        text = path.read_text(encoding="utf-8")
        frontmatter, body = parse_frontmatter(text)
        location = rel(root, path)
        expected_scope = expected_memory_scope(root, path)

        for field in ("name", "description", "type", "scope", "verified_at", "source"):
            if not frontmatter.get(field):
                add_finding(
                    findings,
                    "warn",
                    "memory-frontmatter-invalid",
                    "shared-memory",
                    location,
                    f"Missing required frontmatter field: {field}",
                    "Add the required shared-memory frontmatter field.",
                )

        memory_type = frontmatter.get("type", "")
        memory_scope = frontmatter.get("scope", "")
        verified_at = frontmatter.get("verified_at", "")

        if memory_type and memory_type not in VALID_MEMORY_TYPES:
            add_finding(
                findings,
                "warn",
                "memory-frontmatter-invalid",
                "shared-memory",
                location,
                f"Invalid shared-memory type: {memory_type}",
                f"Use one of: {', '.join(sorted(VALID_MEMORY_TYPES))}.",
            )
        if memory_scope and not VALID_MEMORY_SCOPE_RE.match(memory_scope):
            add_finding(
                findings,
                "warn",
                "memory-frontmatter-invalid",
                "shared-memory",
                location,
                f"Invalid shared-memory scope: {memory_scope}",
                "Use workspace, module:<name>, or capability:<name>.",
            )
        if expected_scope and memory_scope and memory_scope != expected_scope:
            add_finding(
                findings,
                "warn",
                "memory-frontmatter-invalid",
                "shared-memory",
                location,
                f"Scope {memory_scope} does not match path-implied scope {expected_scope}",
                "Move the file or update frontmatter so scope and path agree.",
            )
        if verified_at and not ISO_DATE_RE.match(verified_at):
            add_finding(
                findings,
                "warn",
                "memory-frontmatter-invalid",
                "shared-memory",
                location,
                f"verified_at is not an ISO date: {verified_at}",
                "Use YYYY-MM-DD.",
            )

        source = frontmatter.get("source", "")
        if source and re.match(r"^agent:(codex|pi|claude|openai|gemini)-", source):
            evidence_section = re.search(r"(?im)^##\s+Evidence\b[\s\S]*?^- ", body)
            if not evidence_section:
                add_finding(
                    findings,
                    "warn",
                    "memory-postcompact-evidence",
                    "shared-memory",
                    location,
                    "Agent-generated memory entry lacks a concrete Evidence section.",
                    "Manually review the entry and add evidence, narrow the scope, or deprecate it.",
                )

        if expected_scope == "workspace" and memory_type != "deprecated":
            active_workspace_count += 1
            if path.name not in workspace_index_text and rel(root, path) not in workspace_index_text:
                add_finding(
                    findings,
                    "warn",
                    "memory-file-unindexed",
                    "shared-memory",
                    location,
                    "Workspace shared-memory entry is missing from MEMORY.md.",
                    "Add a concise index line under the appropriate MEMORY.md section.",
                )
                missing_workspace_index_lines.append((path, frontmatter))

        if memory_type != "deprecated" and re.search(r"(?i)(promoted to|superseded by|stronger authority|moved to module docs|moved to skill)", body):
            add_finding(
                findings,
                "info",
                "memory-promoted-not-retired",
                "shared-memory",
                location,
                "Shared-memory entry appears promoted or superseded but remains active.",
                "Convert it to a concise pointer or mark it deprecated.",
            )

        check_memory_staleness(root, path, frontmatter, text, findings, staleness_threshold)

    check_workspace_memory_pressure(root, findings, active_workspace_count)

    if missing_workspace_index_lines and workspace_index.exists():
        fixes[workspace_index] = render_workspace_memory_index_fix(workspace_index_text, missing_workspace_index_lines)


def render_workspace_memory_index_fix(index_text: str, missing: list[tuple[Path, dict[str, str]]]) -> str:
    lines = []
    for path, frontmatter in missing:
        name = frontmatter.get("name") or path.stem.replace("-", " ").title()
        description = frontmatter.get("description") or "Unindexed shared-memory entry."
        lines.append(f"- [{name}]({path.name}) — {description}")

    if not lines:
        return index_text

    heading = "## Pitfalls / Operational Boundaries"
    marker = re.search(rf"^{re.escape(heading)}\s*$", index_text, flags=re.MULTILINE)
    if not marker:
        return index_text.rstrip() + "\n\n## Unindexed shared-memory entries\n\n" + "\n".join(lines) + "\n"

    next_heading = re.search(r"^##\s+", index_text[marker.end() :], flags=re.MULTILINE)
    insert_at = marker.end() + (next_heading.start() if next_heading else len(index_text[marker.end() :]))
    before = index_text[:insert_at].rstrip()
    after = index_text[insert_at:].lstrip("\n")
    return before + "\n" + "\n".join(lines) + "\n\n" + after


def extract_referenced_paths(root: Path, source: Path, text: str) -> set[Path]:
    candidates: set[Path] = set()
    for raw_target, _line in markdown_link_targets(text):
        resolved = resolve_local_link(root, source, raw_target)
        if resolved and resolved.exists():
            candidates.add(resolved)

    for match in PATH_TOKEN_RE.finditer(text):
        raw = match.group(1).split("#", 1)[0]
        path = root / raw
        if path.exists():
            candidates.add(path.resolve())

    return {path for path in candidates if path != source.resolve()}


def check_memory_staleness(root: Path, path: Path, frontmatter: dict[str, str], text: str, findings: list[Finding], threshold: int) -> None:
    if threshold <= 0:
        return

    verified_at = frontmatter.get("verified_at", "")
    if ISO_DATE_RE.match(verified_at):
        since = verified_at
    else:
        since = dt.datetime.fromtimestamp(path.stat().st_mtime).date().isoformat()

    referenced = sorted(extract_referenced_paths(root, path, text))
    if not referenced:
        return

    for referenced_path in referenced[:20]:
        git_path = rel(root, referenced_path)
        result = subprocess.run(
            ["git", "log", f"--since={since}", "--format=%H", "--", git_path],
            cwd=root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        count = len([line for line in result.stdout.splitlines() if line.strip()])
        if count >= threshold:
            add_finding(
                findings,
                "info",
                "memory-staleness",
                "shared-memory",
                rel(root, path),
                f"Referenced path {git_path} changed {count} commits since {since}.",
                "Re-verify the memory before relying on it; update verified_at if still current.",
            )


def check_module_map(root: Path, findings: list[Finding]) -> None:
    module_map_root = root / "knowledge/module-map"
    if not module_map_root.exists():
        return

    existing_pages = {
        path.stem
        for path in module_map_root.glob("*.md")
        if path.name not in {"README.md", "index.md"}
    }

    active = set()
    backend_root = root / "projects/backend/module"
    if backend_root.exists():
        for child in backend_root.iterdir():
            if child.is_dir() and child.name.endswith("-module") and (child / "RESPONSIBILITY.md").exists():
                active.add(child.name.removesuffix("-module"))
    frontend = root / "projects/frontend"
    if frontend.exists():
        for child in frontend.iterdir():
            if child.is_dir() and (child / "RESPONSIBILITY.md").exists():
                active.add(child.name)

    for module in sorted(active - existing_pages):
        add_finding(
            findings,
            "error",
            "module-map-orphan",
            "module-map",
            f"knowledge/module-map/{module}.md",
            f"Active module {module} has no module-map page.",
            "Add a module-map page or remove the module from active topology if it is retired.",
        )

    for page in sorted(existing_pages - active):
        add_finding(
            findings,
            "warn",
            "module-map-orphan",
            "module-map",
            f"knowledge/module-map/{page}.md",
            f"Module-map page {page}.md has no matching active module directory.",
            "Move it under concepts/ if it is conceptual, or remove/archive it if obsolete.",
        )


def check_markdown_links(root: Path, files: Iterable[Path], check_id: str, surface: str, findings: list[Finding]) -> None:
    for path in sorted(set(files)):
        if not path.exists() or path.is_symlink():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for raw_target, line in markdown_link_targets(text):
            resolved = resolve_local_link(root, path, raw_target)
            if resolved and not resolved.exists():
                add_finding(
                    findings,
                    "error",
                    check_id,
                    surface,
                    f"{rel(root, path)}:{line}",
                    f"Local markdown link target is missing: {raw_target}",
                    "Update the link target or remove the stale reference.",
                )


def workspace_guidance_files(root: Path) -> list[Path]:
    files = []
    agents = root / "AGENTS.md"
    if agents.exists():
        files.append(agents)
    files.extend(iter_files(root / "docs", (".md",)))
    files.extend(iter_files(root / "agent-workspace", (".md", ".json")))
    return files


def check_knowledge_viewport(root: Path, findings: list[Finding]) -> None:
    readme = root / "knowledge/README.md"
    if not readme.exists():
        add_finding(
            findings,
            "info",
            "vault-link-missing",
            "knowledge-viewport",
            "knowledge/README.md",
            "Knowledge viewport README is missing.",
            "Add README guidance for shared-memory, module-map, module symlinks.",
        )


def render_fix_diff(path: Path, old: str, new: str, root: Path) -> str:
    return "".join(
        difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            fromfile=f"a/{rel(root, path)}",
            tofile=f"b/{rel(root, path)}",
        )
    )


def output_findings(findings: list[Finding], args: argparse.Namespace) -> None:
    if args.format == "json":
        print(json.dumps([dataclasses.asdict(finding) for finding in findings], ensure_ascii=False, indent=2))
        return

    counts = {severity: 0 for severity in ("error", "warn", "info")}
    for finding in findings:
        counts[finding.severity] = counts.get(finding.severity, 0) + 1
    print(f"Knowledge lint: {counts['error']} error / {counts['warn']} warn / {counts['info']} info")

    visible = findings if args.include_info else [finding for finding in findings if finding.severity != "info"]
    if not visible:
        if findings and not args.include_info:
            print("Info findings hidden; rerun with --include-info to inspect them.")
        return

    for finding in visible:
        print(f"[{finding.severity}] {finding.surface} {finding.check_id} {finding.location}")
        print(f"  {finding.description}")
        print(f"  fix: {finding.fix_hint}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Lint workspace knowledge surfaces")
    parser.add_argument("--root", default=".", help="Workspace root or any path inside it")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    parser.add_argument("--include-info", action="store_true", help="Show info findings in text output")
    parser.add_argument("--staleness-threshold", type=int, default=DEFAULT_STALENESS_THRESHOLD)
    parser.add_argument(
        "--fail-on",
        choices=("error", "warn", "never"),
        default="error",
        help="Exit non-zero on error findings, warn-or-error findings, or never. Default: error.",
    )
    parser.add_argument("--fix", action="store_true", help="Print safe mechanical fix diff")
    parser.add_argument("--apply", action="store_true", help="Apply safe mechanical fixes; requires --fix")
    parser.add_argument("--pressure-summary", action="store_true", help="With --format json, include machine-readable shared-memory pressure summary")
    args = parser.parse_args()

    if args.apply and not args.fix:
        parser.error("--apply requires --fix")

    root = find_workspace_root(Path(args.root))
    findings: list[Finding] = []
    fixes: dict[Path, str] = {}

    check_shared_memory(root, findings, fixes, args.staleness_threshold)
    check_module_map(root, findings)
    check_markdown_links(root, workspace_guidance_files(root), "guidance-path-broken", "workspace-guidance", findings)
    check_knowledge_viewport(root, findings)

    if args.fix:
        emitted_diff = False
        for path, new_text in sorted(fixes.items(), key=lambda item: rel(root, item[0])):
            old_text = path.read_text(encoding="utf-8")
            if old_text == new_text:
                continue
            print(render_fix_diff(path, old_text, new_text, root))
            emitted_diff = True
            if args.apply:
                path.write_text(new_text, encoding="utf-8")
        if not emitted_diff:
            print("No safe mechanical fixes available.")
        elif args.apply:
            print("Applied safe mechanical fixes.")

    if args.format == "json" and args.pressure_summary:
        print(
            json.dumps(
                {
                    "findings": [dataclasses.asdict(finding) for finding in findings],
                    "pressure": build_pressure_summary(root),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        output_findings(findings, args)
    if args.fail_on == "never":
        return 0
    if args.fail_on == "warn":
        return 1 if any(finding.severity in {"error", "warn"} for finding in findings) else 0
    return 1 if any(finding.severity == "error" for finding in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
