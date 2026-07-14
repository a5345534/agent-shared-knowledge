## ADDED Requirements

### Requirement: Release is pinnable and tested
The repository SHALL publish the documented version tag only from a commit that passes tests, package smoke, and migration verification.

#### Scenario: Pin documented release
- **WHEN** an adopter installs `@v0.1.0`
- **THEN** the ref exists and identifies the verified release commit

### Requirement: Cross-platform source of truth is unambiguous
Documentation SHALL identify the Git submodule as the shared cross-platform script/policy source and the Pi Package as an optional Pi integration that must not create a second lifecycle implementation.

#### Scenario: Submodule plus Pi usage
- **WHEN** an adopter uses the submodule across Pi, Codex, OpenCode, and CI
- **THEN** Pi integration references the same canonical implementation and duplicate lifecycle loading is avoided
