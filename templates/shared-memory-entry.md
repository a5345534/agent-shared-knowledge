---
name: <short display name>
description: <one-line retrieval description>
type: feedback | project | reference | architectural-invariant
scope: workspace | module:<name> | capability:<name>
verified_at: <YYYY-MM-DD>
source: human:<name> | agent:<id>
# Optional cross-reference fields:
# supersedes:
#   - knowledge/inbox/<candidate>.md
# superseded_by: knowledge/facts/module/<name>/<entry>.md
# see_also:
#   - knowledge/facts/module/<name>/<related>.md
---

# <Fact Title>

<State the reusable fact, convention, pitfall, or durable project state. Keep it
short and useful to another developer or agent.>

## Evidence

- <Source path, change, PR, or command output that justifies the fact>

## Not This Destination When

- The item is long module-owned documentation; promote it to module docs.
- The item is a repeatable procedure with commands/templates; promote it to a
  reusable skill.

## Cross-Reference Fields (Optional)

These optional frontmatter fields help maintain a clean, deduplicated knowledge surface:

| Field | Type | Purpose |
|---|---|---|
| `supersedes` | list of paths | Inbox candidates or older entries merged into this entry. Auto-populated by absorb merge. |
| `superseded_by` | single path | When `type: deprecated`, points to the replacement entry. |
| `see_also` | list of paths | Peer references to related entries. Add manually. |

Example:
```yaml
supersedes:
  - knowledge/inbox/2026-07-07-d6-repair-orchestrator-read-only-intent.md
see_also:
  - knowledge/facts/module/bpmn-drawer-repair-orchestrator/d4-execution-report.md
```

## Index Step

If `scope: workspace`, update:

- `knowledge/facts/workspace/MEMORY.md`
- Your workspace guide file's embedded shared-memory index
