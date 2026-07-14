## Context

The target layout uses `knowledge/facts/{workspace,module,capability}`, `knowledge/inbox`, `knowledge/followups`, and a local SQLite index. Legacy adopters may have curated files and inbox candidates under `knowledge/shared-memory`, plus an existing AGENTS.md section without the new sentinel. Generic code also contains topology paths inherited from one workspace.

## Goals / Non-Goals

**Goals:** dry-run first migration, no semantic deletion, configurable adopter policy, extensible authorities, tested release pin.

**Non-Goals:** infer arbitrary undocumented layouts; automatically push migration commits; require OpenSpec in generic installations.

## Decisions

1. Add an explicit `migrate-layout --from shared-memory-v1` command; never overload `init` with implicit moves.
2. Build a migration plan before writes using the `shared-memory-v1` mapping below, reject destination collisions with differing content, copy before deleting, rewrite known B1 references once, and verify source/destination content hashes before cleanup.
   - `knowledge/shared-memory/workspace/**` → `knowledge/facts/workspace/**`
   - `knowledge/shared-memory/module/**` → `knowledge/facts/module/**`
   - `knowledge/shared-memory/capability/**` → `knowledge/facts/capability/**`
   - `knowledge/shared-memory/inbox/**` → `knowledge/inbox/**`
   - a root legacy `knowledge/shared-memory/MEMORY.md` maps to `knowledge/facts/workspace/MEMORY.md`
   Unknown legacy paths are reported and prevent cleanup rather than being guessed or deleted.
3. Gate legacy topology checks behind `SHARED_KNOWLEDGE_ADOPTER_TOPOLOGY_LINT=1`; generic facts/inbox/index/follow-up validation remains always active.
4. Load extra authorities from `SHARED_KNOWLEDGE_FOLLOWUP_AUTHORITIES` JSON. Each entry declares action, kind, directory, handoff, and default destination; built-ins remain defaults.
5. Schemas permit namespaced configurable strings while runtime validates configured actions. OpenSpec is an optional example, not a dependency.
6. Release tagging occurs after merge/archive and a clean test/package gate.

## Risks / Trade-offs

- [Legacy variants differ] → refuse unknown/colliding structures and preserve source on any parity failure.
- [Dynamic authority config can be malformed] → fail closed with actionable validation errors.
- [Disabling topology checks changes lint output] → document explicit opt-in for adopters relying on them.
