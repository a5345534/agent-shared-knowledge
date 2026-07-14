# absorption-cli-reliability Specification

## Purpose
TBD - created by archiving change fix-absorption-cli-blockers. Update Purpose after archive.
## Requirements
### Requirement: Absorption CLI is importable
The absorption CLI SHALL compile and import successfully on the project's supported Python runtime.

#### Scenario: Compile the absorption module
- **WHEN** an operator or test runner compiles `scripts/knowledge_absorb.py`
- **THEN** compilation completes without a syntax error

#### Scenario: Import absorption tests
- **WHEN** pytest collects modules that import `knowledge_absorb`
- **THEN** collection proceeds without an import-time syntax failure

### Requirement: Superseded-by frontmatter is rendered safely
The absorption workflow SHALL render `superseded_by` frontmatter without invalid Python syntax and SHALL preserve the intended scalar target when input is scalar or list-like.

#### Scenario: Scalar superseded-by value
- **WHEN** a candidate contains a scalar `superseded_by` value
- **THEN** the curated entry contains that scalar value

#### Scenario: List-like superseded-by value
- **WHEN** a candidate contains a list-like `superseded_by` value
- **THEN** the curated entry contains the first normalized target without raising an exception

### Requirement: Hook works across pressure states
The `hook` command SHALL emit a result without an argument-access failure when pressure is either below or above configured thresholds.

#### Scenario: Pressure is below threshold
- **WHEN** `knowledge-absorb hook --format json` runs below all pressure thresholds
- **THEN** it emits a result with `triggered` false and exits successfully

#### Scenario: Pressure is triggered
- **WHEN** `knowledge-absorb hook --format json` runs with inbox pressure above its configured threshold
- **THEN** it executes the triggered planning path without `AttributeError`

### Requirement: Hook workspace backlog option is consistent
The hook command SHALL accept the workspace-backlog inclusion option using the same semantics as plan and apply.

#### Scenario: Include workspace backlog explicitly
- **WHEN** an operator invokes `hook --include-workspace-backlog`
- **THEN** hook planning includes workspace backlog evaluation

