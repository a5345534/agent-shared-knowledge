# Compact Review: Extract Durable Shared-Knowledge Candidates

You are reviewing an agent conversation session that is about to be compacted.
Your task is to identify any **durable, reusable facts** that should be preserved
as shared-knowledge entries for future sessions.

## What to look for

Extract ONLY these kinds of facts:

- **Architecture invariants**: decisions about project structure, module
  boundaries, dependency rules, conventions that span multiple sessions.
- **Operational workflows**: repeatable procedures, deployment steps, debugging
  recipes, CI/CD patterns.
- **Known pitfalls**: traps, gotchas, recurring issues, anti-patterns the team
  has learned to avoid.
- **Module/capability facts**: non-obvious behavior, contract requirements,
  integration notes about specific modules or capabilities.
- **Project conventions**: naming conventions, coding standards, testing
  patterns, documentation practices.

## What to IGNORE

- Task-local progress ("I fixed the bug", "the test passes now").
- Temporary debugging state ("tried X, got error Y, then fixed by Z" — Z may be
  worth capturing, but the debugging journey is not).
- Personal preferences that are not team conventions.
- Content already captured in existing shared-knowledge entries or documentation.
- Speculative design discussions with no decision.
- Chat, banter, greetings, status updates.

## Output format

When a `submit_shared_knowledge_candidates` tool is available, call that tool
exactly once with a `candidates` array and an optional `feedback_findings`
array. Otherwise, return a JSON object containing `candidates` and optional
`feedback_findings`. If no durable facts or feedback findings are found, submit
or return `{"candidates": []}`.

Each durable knowledge candidate object MUST have these fields:

```json
{
  "candidate_id": "kebab-case-unique-identifier",
  "name": "Short display name (max 80 chars)",
  "description": "One-line retrieval description (max 180 chars)",
  "type": "architectural-invariant | reference | project | feedback",
  "suggested_scope": "workspace | module:<name> | capability:<name>",
  "body": "Markdown body with evidence and rationale. Be specific and cite sources from the conversation.",
  "reason": "Why this fact is durable and reusable across sessions. (max 500 chars)",
  "evidence": ["Source-specific evidence from the conversation"]
}
```

### Session feedback findings

`feedback_findings` is optional. Use it only for a bounded, actionable observation
about session quality, a skill, an extension, a package, Pi, or the local
environment. It is independent from durable knowledge candidates; use an empty
or omitted array when no finding is justified.

Each finding MUST use this shape:

```json
{
  "classification": "upstream-bug | documentation-gap | ux-friction | feature-request | local-configuration | agent-behavior | unresolved-owner | insufficient-evidence",
  "component_kind": "extension | skill | package | pi-core | project | local | unknown",
  "component_id": "stable-component-identifier",
  "user_goal": "Short normalized user goal, not a quote",
  "expected": "Expected behavior",
  "observed": "Observed behavior",
  "operation": "optional-stable-operation",
  "error_category": "optional-normalized-error-category",
  "component_version": "optional-version",
  "workaround": "optional-safe-workaround-summary",
  "evidence_summary": "optional-safe-summary, never transcript text",
  "normalized_goal": "optional-short-semantic-key",
  "normalized_gap": "optional-short-semantic-key",
  "normalized_outcome": "optional-short-semantic-key"
}
```

Rules for `feedback_findings`:

- Prefer `local-configuration`, `agent-behavior`, `unresolved-owner`, or
  `insufficient-evidence` when an upstream component is not clearly at fault.
- Do not invent a GitHub repository, issue URL, version, or error code.
- Do not quote the conversation, copy tool output, include usernames, absolute
  paths, credentials, tokens, command argv, or private repository names.
- For UX/documentation friction, normalize the same goal, gap, and workaround
  consistently so independent sessions can be compared later.
- A finding is an observation, not a public issue. Never claim an issue was
  submitted or ask to submit one.

### Type guidance

| Type | When to use |
|------|-------------|
| `architectural-invariant` | A hard design constraint or decision that must not be violated |
| `reference` | Useful information that doesn't change often (API endpoints, conventions) |
| `project` | Project-level decision, roadmap item, or state |
| `feedback` | Learning or observation worth sharing |

### Scope guidance

| Scope | When to use |
|-------|-------------|
| `workspace` | Fact applies to the entire project/workspace |
| `module:<name>` | Fact applies to a specific module (e.g., `module:shared-knowledge`) |
| `capability:<name>` | Fact applies to a specific capability (e.g., `capability:inbox-absorption`) |

## Quality rules

- **Conservative**: If in doubt, leave it out. Missing a candidate is better than
  writing a noisy one.
- **Specific**: "The validation pipeline requires all hooks to be registered
  before the `on_commit` phase" is good. "There were some issues with the hooks"
  is not.
- **Durable**: Ask yourself: "Will this still be true and useful after 10 more
  sessions?" If not, skip it.
- **Correct scope**: Prefer narrower scope (`module:` or `capability:`) over
  `workspace` when the fact is module-specific. This keeps workspace-level
  entries focused and valuable.

## Response format reminder

Use the candidate submission tool when provided. Without that tool, return ONLY
valid JSON with no markdown wrapping or explanation text outside the JSON.
Example:

```json
{
  "candidates": [
    {
      "candidate_id": "pipeline-registration-order",
      "name": "Pipeline hook registration order constraint",
      "description": "Validation hooks must register before on_commit phase to avoid race conditions",
      "type": "architectural-invariant",
      "suggested_scope": "module:workflow-engine",
      "body": "## Pipeline hook registration\n\nThe workflow engine requires all validation hooks to be registered\n**before** the `on_commit` phase begins. Hooks registered during or\nafter `on_commit` will not be executed and produce a silent failure.\n\n### Evidence\n- Developer spent 3 hours debugging a hook that was registered in\nthe `on_commit` callback instead of the `pre_commit` setup.\n- The `ValidatorRegistry` explicitly documents this in `validate()`\nbut the error message is misleading (returns 200 with empty result).",
      "reason": "This affects all future pipeline development. Multiple developers have hit this silently.",
      "evidence": [
        "Debug session showed ValidatorRegistry.validate() returns 200 with no errors even when no hooks are registered",
        "Fix required moving hook registration from on_commit to pre_commit setup"
      ]
    }
  ]
}
```
