# pi-lifecycle-safety Specification

## Purpose
TBD - created by archiving change fix-pi-lifecycle-safety. Update Purpose after archive.
## Requirements
### Requirement: Lifecycle extension matches current Pi APIs
The packaged lifecycle extension SHALL type-check against the declared supported Pi APIs and SHALL use the active model, compaction preparation messages, provider credentials, and supported completion signature.

#### Scenario: Package extension type check
- **WHEN** the extension type-check gate runs
- **THEN** it completes without API signature or notification-level errors

#### Scenario: Compaction extraction
- **WHEN** Pi emits `session_before_compact` with messages and an authenticated active model
- **THEN** the extension converts and serializes those messages and requests candidate JSON through that model

### Requirement: Default lifecycle behavior preserves checkout cleanliness
Without explicit materializer configuration, lifecycle extraction SHALL NOT create, modify, stage, or commit files under `ctx.cwd`.

#### Scenario: Compact from clean main without configuration
- **WHEN** a session compacts from a clean main checkout and no materializer is configured
- **THEN** the checkout remains clean and validated candidates are reported without repository materialization

### Requirement: Materialization is adapter-driven
The lifecycle extension SHALL support explicit legacy inbox materialization and an external command materializer receiving validated candidate data without shell interpretation.

#### Scenario: Explicit inbox materializer
- **WHEN** `SHARED_KNOWLEDGE_MATERIALIZER=inbox` is configured
- **THEN** validated candidates are written to `knowledge/inbox` and the behavior is identified as explicit in-checkout materialization

#### Scenario: External command materializer
- **WHEN** command mode and a valid JSON argv configuration are provided
- **THEN** the extension sends validated candidate JSON to that command and does not directly write repository files

#### Scenario: Invalid materializer configuration
- **WHEN** a materializer mode or command configuration is invalid
- **THEN** the extension fails closed and leaves the checkout unchanged

### Requirement: Absorption Git policy is explicit
The hook command SHALL support no-git and commit modes, and no-git mode SHALL never invoke Git staging or commit operations.

#### Scenario: Hook in no-git mode
- **WHEN** pressure-triggered hook absorption runs with `--git-mode none`
- **THEN** safe file actions may be reported or applied but no `git add` or `git commit` command is executed

#### Scenario: Explicit commit mode
- **WHEN** an operator invokes pressure-triggered hook absorption with `--git-mode commit`
- **THEN** changed paths are staged and committed using existing commit behavior

### Requirement: Only one canonical lifecycle implementation loads
The package SHALL contain one canonical lifecycle implementation, generated project integration SHALL reference that implementation, and init SHALL avoid installing a project-local duplicate when the Pi package is declared.

#### Scenario: Pi package already configured
- **WHEN** init detects `agent-shared-knowledge` in project Pi package settings
- **THEN** it skips installing another lifecycle extension

#### Scenario: Submodule integration without package
- **WHEN** init runs for a submodule-based adopter without the Pi package
- **THEN** it installs a thin loader referencing the canonical extension rather than embedding a divergent implementation

### Requirement: Pi package dependencies are declared
The package SHALL declare imported Pi core packages as peer dependencies and SHALL provide package/type-check smoke tests.

#### Scenario: Package metadata validation
- **WHEN** package smoke tests inspect `package.json`
- **THEN** required Pi peer dependencies and the extension type-check script are present

