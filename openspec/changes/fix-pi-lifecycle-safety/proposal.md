## Why

The packaged Pi lifecycle extension does not match the current Pi API and fails type checking, while both its producer and post-compaction absorber can mutate or commit directly in the active checkout. This is unsafe for adopters that require a clean `main` checkout and worktree/PR-only integration.

## What Changes

- Update the lifecycle extension to the current Pi model, compaction-event, message conversion, completion, and notification APIs.
- Separate candidate extraction from repository materialization through an explicit materializer policy; the safe default does not write into `ctx.cwd`.
- Add a no-git absorber mode and ensure lifecycle automation never assumes in-place commits are permitted.
- Make packaged and generated lifecycle installations use one canonical implementation and prevent duplicate lifecycle extension installation.
- Declare Pi core peer dependencies and add extension type-check/package smoke coverage.
- Document safe opt-in materialization and adopter-provided worktree/PR adapters.

## Capabilities

### New Capabilities
- `pi-lifecycle-safety`: Pi lifecycle extraction is API-compatible, checkout-safe by default, adapter-driven for materialization/Git integration, and loaded only once.

### Modified Capabilities

None.

## Impact

Affected areas include `.pi/extensions/shared-knowledge-lifecycle.ts`, `scripts/hooks/pi_lifecycle.py`, absorption hook options, package metadata, tests, and installation documentation. Existing direct in-place automation becomes explicit opt-in; CLI plan/apply behavior remains available for manual use.
