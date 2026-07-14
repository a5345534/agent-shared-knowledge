# legacy-layout-migration Specification

## Purpose
TBD - created by archiving change migration-readiness. Update Purpose after archive.
## Requirements
### Requirement: Legacy migration is explicit and dry-runnable
The system SHALL provide `migrate-layout --from shared-memory-v1` and SHALL make no changes in dry-run mode.

#### Scenario: Dry-run existing layout
- **WHEN** an adopter runs migration with `--dry-run`
- **THEN** the system reports planned copies, rewrites, collisions, counts, and hashes without changing files

### Requirement: Migration preserves knowledge
Migration SHALL preserve curated and inbox content and SHALL refuse destructive cleanup unless destination parity is verified.

#### Scenario: Successful cutover
- **WHEN** a recognized legacy layout has no conflicting destinations
- **THEN** scope paths and inbox files are migrated, B1 references are rewritten once, hashes/counts match, and verified legacy files are removed

#### Scenario: Destination collision
- **WHEN** a destination exists with different content
- **THEN** migration fails before source deletion and reports the collision

