# Agent Shared Memory

A **workspace-level shared fact storage layer** for cross-agent, cross-platform,
cross-human-agent collaboration.

Shared memory provides a lightweight, git-tracked convention for capturing
durable workspace facts — architecture invariants, known pitfalls, operational
conventions, and project state — that every developer and agent in the workspace
should know.

## What It Solves

Large multi-repo workspaces accumulate undocumented conventions, unwritten
rules, and tribal knowledge. Shared memory makes these **discoverable and
machine-readable** so:

- Every agent session loads workspace facts automatically (B1 always-on)
- Skills declare which module/capability facts they need (B2 skill-body)
- Runtime task executors inject relevant facts from process variables (B3 adapter)
- Lint checks prevent staleness, orphaned entries, and inbox bloat

## Quick Start

### 1. Add this repository as a workspace submodule

From the workspace root:

```bash
git submodule add https://github.com/a5345534/agent-shared-knowledge.git shared-knowledge
```

If the submodule is already recorded but not checked out, initialize it:

```bash
git submodule update --init --recursive shared-knowledge
```

### 2. Run the init command

```bash
python3 shared-knowledge/scripts/knowledge_query.py --root . init
```

This creates `knowledge/`, copies starter files, injects the B1 section into
`AGENTS.md`, ignores the local SQLite index cache, builds the first query index,
and installs the best available hook adapter. Pi hooks are workspace-local by
default (`<workspace>/.pi/hooks/...`); use `--hook-scope global` only when you
explicitly want to write under `~/.pi`.

Useful variants:

```bash
python3 shared-knowledge/scripts/knowledge_query.py --root . init --skip-hook
python3 shared-knowledge/scripts/knowledge_query.py --root . init --dry-run
python3 shared-knowledge/scripts/knowledge_query.py --root . init --hook-scope global
```

### 3. Run periodic lint

```bash
python3 shared-knowledge/scripts/knowledge_lint.py --root .
```

## Alternate Install: Pi Package

This repo is also a [Pi Package](https://github.com/earendil-works/pi) —
installable into any workspace with a single command. The extension, prompts,
and CLI tools are loaded automatically.

```bash
# 1. Install into workspace (project-local)
pi install -l git:github.com/a5345534/agent-shared-knowledge@main
pi update --extensions

# 2. Build the query index (one-time per workspace)
# The CLI tools are on PATH via pi install
knowledge-query --root . rebuild-index

# 3. Run absorption / lint via CLI wrappers
knowledge-absorb --root . plan
knowledge-lint --root .
```

> **Tip:** The Pi Package install automatically loads the `shared-knowledge-lifecycle`
> extension. Candidate extraction is checkout-safe and review-only by default;
> repository materialization requires an explicit policy. The `knowledge-absorb`,
> `knowledge-lint`, and `knowledge-query` commands are available via the package.

### Pi lifecycle materialization policy

The default lifecycle mode reports validated candidates but does not write, stage,
or commit anything under the active checkout. Choose a materializer explicitly:

```bash
# Legacy in-checkout inbox writes (explicit opt-in). Post-compact absorption uses
# --git-mode none, so it never stages or commits automatically.
export SHARED_KNOWLEDGE_MATERIALIZER=inbox

# Delegate to an adopter-owned worktree/PR materializer. The command is a JSON
# argv array, is executed without a shell, and receives {version,cwd,candidates}
# as JSON on stdin.
export SHARED_KNOWLEDGE_MATERIALIZER=command
export SHARED_KNOWLEDGE_MATERIALIZER_COMMAND='["/absolute/path/materialize", "--json"]'
```

Invalid modes or command configuration fail closed without repository writes.
For manual pressure-triggered absorption, Git policy is explicit:

```bash
knowledge-absorb --root . hook --git-mode none    # never stage/commit
knowledge-absorb --root . hook --git-mode commit  # explicit legacy commit behavior
```

Use either the Pi Package extension or the submodule-generated loader, not both.
`knowledge-query init` skips loader installation when project or global Pi
settings already declare the `agent-shared-knowledge` package.

**Version pinning:**

```bash
pi install -l git:github.com/a5345534/agent-shared-knowledge@v0.1.0
```

**Update:**

```bash
pi update --extension git:github.com/a5345534/agent-shared-knowledge
```

## Directory Structure

```
knowledge/
├── facts/
│   ├── README.md                # Convention docs + contributing guide
│   ├── workspace/               # Workspace-wide, always-on loaded
│   │   ├── README.md
│   │   ├── MEMORY.md            # Index (SHALL NOT exceed 200 lines)
│   │   └── <name>.md            # Entry body
│   ├── module/                  # Single-module scope
│   │   ├── README.md
│   │   └── <module>/<name>.md
│   └── capability/              # Single-capability scope
│       ├── README.md
│       └── <capability>/<name>.md
├── inbox/                       # Generated candidates; not always-on
│   └── README.md
├── followups/                   # Absorption → downstream handoff
│   ├── README.md
│   ├── skill/                   # promote_to_skill follow-up artifacts
│   └── module-doc/              # promote_to_module_doc follow-up artifacts
└── .index/                      # Local SQLite FTS5 cache (git-ignored)
    ├── memory.sqlite
    └── manifest.json
```

## Frontmatter Schema

Every entry requires 6 YAML frontmatter fields:

```yaml
---
name: Short display name (< 60 chars)
description: One-line retrieval description (< 150 chars)
type: feedback | project | reference | architectural-invariant | deprecated
scope: workspace | module:<name> | capability:<name>
verified_at: 2026-06-22   # ISO date, last verified
source: human:<name>       # or agent:<id>
---
```

| Field | Rule |
|---|---|
| `name` | Display name |
| `description` | One-line, used for retrieval/index |
| `type` | One of 6 values; `deprecated` for superseded entries |
| `scope` | **Must** match the file's parent directory |
| `verified_at` | Today's date on write; update when body changes |
| `source` | Writer identity for audit |

## Injection Mechanisms

| Mechanism | Who | Strength |
|---|---|---|
| **B1 always-on** | Any platform reading the workspace guide file | Index guaranteed; body instruction-driven |
| **B2 skill-body** | Individual skills declaring `## Pre-execution context` | Module/capability scope only |
| **B3 runtime adapter** | Task-aware runtimes injecting from process variables | Module/capability scope per task context |

## Tools

### `knowledge_absorb.py` — Inbox Absorption

Manages the lifecycle of inbox candidates: classifies them, applies safe
mechanical promotions, and triggers hook-based auto-absorption when pressure
thresholds are exceeded.

```bash
# Check pressure
python3 shared-knowledge/scripts/knowledge_absorb.py --root . pressure

# Build plan
python3 shared-knowledge/scripts/knowledge_absorb.py --root . plan --format json

# Apply safe mechanical actions
python3 shared-knowledge/scripts/knowledge_absorb.py --root . apply --safe-only

# Run hook (pressure check + safe auto-apply)
python3 shared-knowledge/scripts/knowledge_absorb.py --root . hook
```

### `knowledge_lint.py` — Knowledge Surface Lint

Validates shared memory entries, module maps, workspace guidance, knowledge
viewport for drift, staleness, and structural errors. Also validates follow-up
artifact contract compliance and aging, and optionally checks the query index.

```bash
# Full lint
python3 shared-knowledge/scripts/knowledge_lint.py --root .

# JSON output with pressure summary
python3 shared-knowledge/scripts/knowledge_lint.py --root . --format json --pressure-summary

# Dry-run mechanical fixes
python3 shared-knowledge/scripts/knowledge_lint.py --root . --fix

# Apply safe mechanical fixes
python3 shared-knowledge/scripts/knowledge_lint.py --root . --fix --apply

# Also check query index staleness
python3 shared-knowledge/scripts/knowledge_lint.py --root . --check-query-index

# Custom follow-up aging threshold
SHARED_MEMORY_FOLLOWUP_MAX_AGE_DAYS=60 python3 shared-knowledge/scripts/knowledge_lint.py --root .
```

### `knowledge_query.py` — Deterministic Query CLI

Builds a local SQLite FTS5 index from curated shared memory entries and provides
subcommands for search, scope-based resolve, prompt-ready injection, and
explainable scoring.

```bash
# Build the query index
python3 shared-knowledge/scripts/knowledge_query.py --root . rebuild-index

# List entries with filters
python3 shared-knowledge/scripts/knowledge_query.py --root . list --scope workspace
python3 shared-knowledge/scripts/knowledge_query.py --root . list --type architectural-invariant

# Full-text search with BM25 + boost/penalty scoring
python3 shared-knowledge/scripts/knowledge_query.py --root . search "validation hook"

# Resolve relevant entries by module/capability scope
python3 shared-knowledge/scripts/knowledge_query.py --root . resolve --module workflow --capability agent-orchestration

# Produce prompt-ready Markdown injection
python3 shared-knowledge/scripts/knowledge_query.py --root . inject --module workflow --budget-chars 4000 --format markdown

# Explain why entries were selected or excluded
python3 shared-knowledge/scripts/knowledge_query.py --root . explain --query "validation hook"
```

### Follow-up Artifact Workflow

When absorption classifies an inbox candidate as `promote_to_skill` or
`promote_to_module_doc`, a structured JSON follow-up artifact is created under
`knowledge/followups/`. The artifact tracks status, evidence,
recommended outputs, and (when completed) actual outputs — without creating
skills or writing module docs.

```bash
# Apply safe actions (creates follow-up artifacts)
python3 shared-knowledge/scripts/knowledge_absorb.py --root . apply --safe-only

# Apply + rebuild query index
python3 shared-knowledge/scripts/knowledge_absorb.py --root . apply --safe-only --rebuild-query-index
```

Follow-up artifact status lifecycle:

| Status | Meaning |
|--------|---------|
| `open` | Created but not yet picked up |
| `in_progress` | An agent is working on it |
| `done` | Completed; `outputs` field must be non-empty |
| `rejected` | Reviewed and rejected |
| `superseded` | Replaced by another follow-up or artifact |

## Pi Platform Integration

On Pi, the shared-knowledge pipeline is fully automatic via a TypeScript
extension installed by `knowledge init`:

```
Pi session compact triggers
  │
  ├─ session_before_compact
  │   └─ shared-knowledge-lifecycle.ts
  │       └─ spawn (detached) knowledge_compact_producer.py produce-stdin
  │           └─ LLM reviews session → writes candidates to knowledge/inbox/
  │
  ├─ Pi default compaction (summarize + append CompactionEntry)
  │
  └─ session_compact
      └─ shared-knowledge-lifecycle.ts
          └─ spawn (detached) knowledge_absorb.py hook
              └─ Absorbs inbox candidates under pressure
```

Both stages run in detached background processes and never block the session.
Candidates generated by the producer are absorbed on the **next** compact
cycle (they persist in `knowledge/inbox/` in the meantime).

## Contributing

### Writing a new entry

1. Determine scope (`workspace`, `module:<name>`, or `capability:<name>`)
2. Create the file under the matching directory
3. Fill frontmatter + body
4. If `workspace` scope: update `workspace/MEMORY.md` index + your workspace guide file's embedded index
5. Commit and PR

### Deprecation

When an entry is superseded:
1. Change `type: deprecated`
2. Add `⚠ Superseded by <new entry path>` at top of body
3. Keep the file (git history remains searchable)
4. Remove from always-on index

### Routing Decision

```
New fact → useful to another dev?
├── Yes (workspace shared)
│   └── Spans multiple modules/capabilities?
│       ├── Yes → knowledge/facts/workspace/
│       ├── One module → knowledge/facts/module/<name>/
│       └── One capability → knowledge/facts/capability/<name>/
└── No (personal preference)
    └── Keep in user-local agent memory/config (don't track in git)
```

## Pressure Thresholds

| Metric | Default | Env Override |
|---|---|---|
| Inbox max age | 14 days | `SHARED_MEMORY_INBOX_MAX_AGE_DAYS` |
| Inbox max count | 20 | `SHARED_MEMORY_INBOX_MAX_COUNT` |
| Workspace max entries | 20 | `SHARED_MEMORY_WORKSPACE_MAX_COUNT` |
| Auto-apply disable | — | `SHARED_MEMORY_ABSORB_AUTO_APPLY=0` |
| Follow-up max age | 30 days | `SHARED_MEMORY_FOLLOWUP_MAX_AGE_DAYS` |
| Require query index | no | `SHARED_MEMORY_REQUIRE_QUERY_INDEX=1` |

## License

MIT
