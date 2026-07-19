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

### Legacy environment materialization policy

The default lifecycle mode reports validated candidates but does not write, stage,
or commit anything under the active checkout. These environment variables remain
compatible as fallback policy when no session/workspace/global Pi materializer
policy is set. Choose a legacy materializer explicitly:

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

Invalid modes or command configuration fail closed without repository writes. New
installs should prefer `/knowledge-materializer` or `/knowledge-config`; Pi never
persists this command argv.
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
pi install -l git:github.com/a5345534/agent-shared-knowledge@v0.1.1
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

Pi loads one canonical lifecycle extension from either the Pi Package or a thin
submodule loader installed by `knowledge init`:

```
session_before_compact: normalize + atomically queue (no LLM/network)
         │
         ▼
Pi default compaction ──────────────► user continues
         │
         ▼
session_compact / agent_settled
         │
         ▼ background, idle-gated, concurrency 1
extract → validate → materialize → optional no-git absorb
```

Candidate extraction no longer adds an awaited LLM call to compaction. Background
failure is fail-open for the session and fail-closed for canonical mutation. The
response parser accepts the required candidate-submission tool envelope as a
normalized object or bounded strict JSON string. It retains direct, fenced, and
balanced text-envelope fallback for provider compatibility, while deterministic
candidate validation remains strict. Tool-only failures are classified separately
from malformed text, so normalized empty arguments no longer appear as `bytes=0`
text JSON failures. Diagnostics contain only allowlisted bounded shape metadata,
never response text, tool names/arguments, or candidate content; later attempts
receive tool- or text-specific correction instructions. Pi's OpenAI-compatible
adapter may normalize both empty and malformed streamed arguments to `{}`, so the
package reports only that observable shape rather than claiming access to discarded
raw fragments. The safe default `review` mode leaves the checkout unchanged;
explicit `inbox` and argv-based `command` materializers retain their existing
authority boundaries.

### Interactive background model configuration

Configure the extraction model inside Pi without changing the foreground model:

```text
/knowledge-model                              # TUI model + scope selector
/knowledge-model active --scope session
/knowledge-model openrouter/anthropic/claude-sonnet-4 --scope workspace
/knowledge-model reset --scope global
/knowledge-config                             # model/reset/status menu
/knowledge-status                             # effective policy + redacted queue counts
```

Scopes are `session` (memory only), `workspace` (the existing Git-private/XDG
runtime root's `config.json`), and `global` (`~/.pi/agent/shared-knowledge.json`,
or the configured Pi agent directory). Persistent writes are atomic, mode 0600,
and contain model identity only—credentials continue to resolve at attempt time
through Pi's model registry.

Precedence is environment → session → workspace → global → active Pi model.
`SHARED_KNOWLEDGE_EXTRACTION_MODEL` is a read-only lock in the UI. A malformed
non-empty environment value fails closed rather than falling through to a
possibly different-cost model. Fixed identities split only the first `/`, so
provider model IDs such as `openrouter/anthropic/claude-sonnet-4` remain exact.
Unavailable or unauthenticated fixed models also fail closed; pending and retry
jobs use configuration effective at their next attempt, while running requests
are not switched.

Under an environment lock, TUI writes require confirmation and explicit command
writes require `--allow-inactive`; the saved lower-scope value remains inactive
until the environment override is removed.

### Interactive materializer and job recovery

Materializer policy can now be configured in Pi using the same `session`,
`workspace`, and `global` scopes:

```text
/knowledge-materializer review --scope workspace
/knowledge-materializer inbox --scope session
/knowledge-materializer reset --scope workspace
/knowledge-config                              # guided model/materializer/recovery menu
/knowledge-jobs                                # failed-job recovery UI
```

Materializer precedence is `session → workspace → global → legacy environment
→ review`. This intentionally lets an operator use a scoped `review` policy to
safely recover from a legacy `SHARED_KNOWLEDGE_MATERIALIZER=command` deployment.
Resetting the scoped policy restores the legacy environment fallback. Unlike
model selection, legacy materializer environment configuration is a fallback,
not a UI lock.

`review` is checkout-safe. Selecting `inbox` requires confirmation because it
can write `knowledge/inbox` and invoke ordered no-git absorption. Selecting
`command` also requires confirmation and is available only when the process
already has a valid `SHARED_KNOWLEDGE_MATERIALIZER_COMMAND` JSON argv binding.
Pi stores only the mode, never command argv, credentials, headers, candidates,
or captured content. The command still runs with `shell: false`.

`/knowledge-jobs` lists safe failed-job metadata only: ID, attempts, timestamps,
model hint, retained-payload availability, and an allowlisted failure category.
It offers retry-one, count-confirmed retry-all, and “set workspace review mode
then retry all.” Requeues use the durable queue and wait for normal idle-gated
background processing; they do not synchronously call a model or materializer.
Jobs whose retained payload has expired are shown as non-retryable. For retained
historical structured-submission failures, first set the workspace to safe `review`
mode (or select “Set workspace review mode and retry all”), then retry so the next
idle-gated attempt uses the updated tool-aware parser and guidance. Retry does not
silently switch models or run materialization synchronously. A command materializer
receiving zero validated candidates now succeeds as a no-op and is not spawned.

### Interactive review-ready approval

Use the dedicated local TUI to inspect candidates retained by the safe `review`
materializer:

```text
/knowledge-review
```

The first screen contains only redacted `review-ready` job metadata. After you
explicitly select a job, Pi shows one candidate at a time in a plaintext,
keyboard-driven viewer:

```text
↑↓ scroll · ←→ candidate · A approve to Inbox · R reject · S defer · Esc back
```

`A` always asks for confirmation. Approval stages exactly one validated candidate
under `knowledge/inbox/`; it does **not** call a model, command materializer,
absorber, Git staging/commit, or canonical promotion. Review decisions are
private durable queue state. After staging, use the normal deterministic flow:

```bash
knowledge-absorb --root . plan
knowledge-absorb --root . apply --safe-only
```

`R` is a semantic discard of exactly one candidate: it records a private
rejection without immediately deleting retained detail or changing the checkout;
`S` leaves the candidate pending. When a selected legacy-empty or already-purged
review job has no actionable content, the local TUI offers a separate confirmed
close. Closing preserves the job and idempotency record, changes private queue
state only, and never invokes a model, materializer, absorber, command, or Git.

Content is deliberately rendered only in the explicitly opened local TUI.
`/knowledge-status`, `/knowledge-jobs`, CLI `status`, RPC, print, and JSON modes
remain redacted; use an interactive local Pi terminal to review. Candidate and
decision detail follows the normal terminal retention window. Expiry atomically
moves unresolved pending counts to the safe `expired` aggregate, marks the job
done, and purges private detail so dead `review-ready` rows do not remain.

### Reviewed knowledge PR publishing

Reviewed Inbox candidates can be published without committing unrelated worktree
dirt. Publishing is opt-in and disabled by default:

```text
/knowledge-publisher off --scope workspace
/knowledge-publisher pr --scope workspace --acknowledge
/knowledge-publisher auto-merge --scope workspace --acknowledge
/knowledge-publisher flush
/knowledge-publisher retry
```

`pr` copies only exact approved Inbox files into a private temporary worktree at
the current remote base, runs filtered safe-only absorption, `knowledge-lint`, and
diff checks, then pushes a package-owned branch and opens a canonical-facts-only
GitHub PR. The active branch, HEAD, index, unrelated dirt, and canonical checkout
files are not modified. Once the branch and PR are verified durable, only
unchanged hash-matching local Inbox files are removed.

`auto-merge` performs the same publication and uses a normal squash merge only
when the recorded PR head remains exact and every reported GitHub check succeeds.
An empty check set is accepted after local validation. Pending or unsuccessful
checks, conflicts, required reviews, and branch protection block merge; the
publisher never uses `--admin`, self-approval, force push, or direct base-branch
push. It also does not pull/synchronize the active checkout after merge.

Persistent `auto-merge` is workspace-only; session use is also supported. Global
or `SHARED_KNOWLEDGE_PUBLISHER=auto-merge` configuration fails closed. Ambient
`git`/`gh` authentication is used without persistence. If canonical output such
as `knowledge/facts/` is ignored by `.gitignore` or `.git/info/exclude`, publishing
fails with `ignored-output`; remove that policy explicitly rather than force-add.

### Background job operations

Runtime payloads are stored outside tracked checkout content (prefer Git-private
state, otherwise XDG user state), with user-only permissions. Credentials and
authorization headers are never persisted.

```bash
knowledge-jobs --root . status
knowledge-jobs --root . show <job-id>   # explicit review-candidate detail
knowledge-jobs --root . retry <job-id>  # failed job only; requires retained payload
knowledge-jobs --root . close-review <job-id>  # exact legacy-empty/unavailable review job
knowledge-jobs --root . purge --retention-days 7 --dry-run
knowledge-jobs --root . purge --retention-days 7
```

| Variable | Default | Purpose |
|---|---:|---|
| `SHARED_KNOWLEDGE_ASYNC_EXTRACTION` | `1` | `0` disables automatic extraction; it never restores synchronous LLM work |
| `SHARED_KNOWLEDGE_JOB_DEBOUNCE_MS` | `3000` | Idle debounce before extraction |
| `SHARED_KNOWLEDGE_EXTRACTION_MODEL` | active Pi model | Optional `provider/model-id` override |
| `SHARED_KNOWLEDGE_JOB_MAX_ATTEMPTS` | `3` | Bounded attempts |
| `SHARED_KNOWLEDGE_JOB_TIMEOUT_MS` | `120000` | Per-attempt background model timeout |
| `SHARED_KNOWLEDGE_MAX_BATCH_JOBS` | `4` | Same-session pending jobs per extraction batch |
| `SHARED_KNOWLEDGE_MAX_JOB_BYTES` | `2097152` | Maximum normalized session payload |
| `SHARED_KNOWLEDGE_EXCLUDE_PATTERNS` | `[]` | JSON string array of lines to omit before capture |
| `SHARED_KNOWLEDGE_JOB_RETENTION_DAYS` | `7` | Terminal private-payload retention |
| `SHARED_KNOWLEDGE_RUNTIME_DIR` | Git/XDG state | Private runtime base override |
| `SHARED_KNOWLEDGE_MATERIALIZER` | `review` | Legacy materializer fallback: `review`, `inbox`, or `command` |
| `SHARED_KNOWLEDGE_MATERIALIZER_COMMAND` | none | Required JSON argv binding when effective mode is `command`; never persisted by Pi |
| `SHARED_KNOWLEDGE_PUBLISHER` | `off` | Read-only deployment fallback: `off` or `pr`; environment `auto-merge` is forbidden |

### Incremental evidence sources

OpenWiki-inspired ingestion separates deterministic collection from LLM
synthesis. Git is the initial source; raw manifests, cursors, snapshots, and run
summaries remain private and source text is untrusted evidence. Enqueued
synthesis can only produce governed candidates.

```bash
knowledge-source --root . list
knowledge-source --root . collect git --enqueue
knowledge-source --root . status
```

Optional `.shared-knowledge-sources.json`:

```json
{"version":1,"sources":[{"id":"git-backend","type":"git","path":"backend","enabled":true,"exclude":["knowledge/views/**","*.lock"]}]}
```

Source configuration rejects secret values. Cursors advance only after the
queued downstream job succeeds; failures retain the previous evidence window.

### Derived wiki views

OpenWiki-style navigation pages are optional projections, not canonical memory.
The default `knowledge/views/wiki/` output is excluded from facts scanning and
B1/B2/B3 injection. Writes are path-confined, pages are labeled
`authority: derived`, and metadata changes only when page content changes.

```bash
knowledge-view --root . update
knowledge-view --root . guidance --file AGENTS.md --file CLAUDE.md --dry-run
knowledge-view --root . workflow-init --dry-run
```

Headless generation uses `SHARED_KNOWLEDGE_VIEW_MODEL`,
`SHARED_KNOWLEDGE_VIEW_BASE_URL`, and `SHARED_KNOWLEDGE_VIEW_API_KEY`. The
package adapts incremental evidence, snapshots, write guards, managed sections,
and scheduled review PRs; it does not import OpenWiki/LangChain, and generated
prose never replaces scoped facts, FTS5 retrieval, or absorption review.

## Migrating `shared-memory-v1`

Use the explicit migration command; `init` never guesses or moves a legacy tree:

```bash
knowledge-query --root . migrate-layout --from shared-memory-v1 --dry-run
knowledge-query --root . migrate-layout --from shared-memory-v1
```

The command maps workspace/module/capability facts and inbox candidates to the
current layout, rewrites the B1 path once, verifies SHA-256 parity, and only then
removes verified source files. Unknown paths or differing destination content
block migration without source cleanup.

## Adopter policy and follow-up authorities

Generic lint excludes adopter-specific `projects/backend`, `module-map`, and
`agent-workspace` topology by default. Existing topology checks are opt-in:

```bash
SHARED_KNOWLEDGE_ADOPTER_TOPOLOGY_LINT=1 knowledge-lint --root .
```

Additional promotion authorities are a JSON array in
`SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES`. OpenSpec remains optional:

```bash
export SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES='[{"action":"promote_to_openspec","kind":"openspec_followup","directory":"openspec","handoff":"openspec-author","destination":"openspec/changes/<change>/"}]'
```

Malformed configuration fails closed. Built-in skill and module-doc authorities
remain available without configuration.

## Distribution source of truth

For Pi, Codex, OpenCode, and CI sharing one policy/scripts revision, pin this
repository as a Git submodule. The Pi Package is an optional Pi integration
surface and references the same canonical lifecycle implementation; do not
install a second generated lifecycle extension. Release `v0.1.1` is gated by
`npm run release:smoke` from a clean checkout.

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
