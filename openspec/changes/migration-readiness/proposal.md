## Why

Mature workspaces cannot safely adopt the repository while the documented release tag is absent, old `knowledge/shared-memory` layouts are not recognized, generic lint embeds one adopter's topology, and follow-up authorities are closed enums. These gaps make structural cutover risky and encourage downstream forks.

## What Changes

- Add a dry-runnable `migrate-layout --from shared-memory-v1` workflow with collision checks, content parity verification, inbox migration, and B1 rewrite.
- Disable adopter-topology lint by default and expose it only through explicit configuration.
- Add configuration-driven follow-up authority kinds, including optional OpenSpec promotion, without requiring OpenSpec in core.
- Document submodule as the cross-platform source of truth and Pi Package as an optional integration surface.
- Add release verification and publish the documented `v0.1.0` tag only after tests and migration gates pass.

## Capabilities

### New Capabilities
- `legacy-layout-migration`: Existing shared-memory-v1 workspaces can dry-run and perform a parity-checked structural cutover.
- `generic-policy-boundaries`: Generic lint does not impose adopter-specific topology unless explicitly enabled.
- `configurable-followup-authorities`: Adopters can register additional promotion authorities through configuration.
- `release-readiness`: A tested, pinnable release and single-source installation contract are available.

### Modified Capabilities

None.

## Impact

Affected code includes query/init migration commands, lint policy, absorption/follow-up schema handling, documentation, tests, and release metadata. Existing layouts are not changed unless migration is explicitly invoked.
