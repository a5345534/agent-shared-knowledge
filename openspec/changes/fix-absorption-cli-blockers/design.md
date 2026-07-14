## Context

`knowledge_absorb.py` is a stdlib-only CLI imported directly by multiple test modules and invoked by lifecycle hooks. A malformed f-string currently prevents parsing. Separately, `run_hook()` assumes an argparse field that the hook subparser does not define, but that path is reached only when pressure is triggered, so ordinary below-threshold tests miss it.

## Goals / Non-Goals

**Goals:**
- Restore Python compilation and imports.
- Preserve `superseded_by` rendering for scalar and list-like frontmatter input.
- Ensure pressure-triggered hook execution cannot fail from a missing parser attribute.
- Cover the triggered branch with regression tests.

**Non-Goals:**
- Redesign absorption policy, Git integration, or pressure thresholds.
- Add new CLI options beyond restoring consistent existing behavior.
- Change frontmatter or plan schemas.

## Decisions

1. Normalize `superseded_by` before interpolation rather than embedding parsing and quoting logic in one f-string. This is readable, valid on supported Python versions, and handles an empty parsed list defensively.
2. Define `--include-workspace-backlog` on the hook parser for consistency with plan/apply, while also using `getattr(..., False)` at the internal boundary. The parser option preserves useful behavior and the defensive read protects direct/internal Namespace construction.
3. Add a subprocess-level regression test that forces inbox pressure. This exercises parsing, argument construction, the trigger branch, and JSON emission together rather than only unit-testing a helper.

Alternatives considered:
- Only replace escaped quotes in the f-string: rejected because the expression remains difficult to review.
- Only use `getattr` without adding the hook option: safe but leaves the hook unable to request workspace backlog explicitly.

## Risks / Trade-offs

- [Triggered hook may perform Git operations in a fixture] → Construct a candidate whose action produces no changed paths or disable auto-apply where the test only needs parser coverage.
- [Scalar/list normalization could alter output] → Add focused assertions for both forms and retain the first value behavior already intended by the existing expression.
