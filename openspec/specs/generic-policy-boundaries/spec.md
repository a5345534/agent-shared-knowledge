# generic-policy-boundaries Specification

## Purpose
TBD - created by archiving change migration-readiness. Update Purpose after archive.
## Requirements
### Requirement: Generic lint excludes adopter topology by default
The lint command SHALL run generic facts, inbox, index, and follow-up checks without assuming adopter-specific project or agent-workspace paths.

#### Scenario: Default lint
- **WHEN** lint runs without adopter topology configuration
- **THEN** paths such as `projects/backend/module`, `knowledge/module-map`, and `agent-workspace` do not create topology findings

#### Scenario: Explicit topology opt-in
- **WHEN** the adopter topology lint setting is enabled
- **THEN** the existing topology checks run with their documented behavior

