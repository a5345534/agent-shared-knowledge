## Why

The absorption CLI on `main` cannot be imported because of a Python syntax error, which also prevents the test suite from collecting. Once that syntax error is repaired, pressure-triggered hook execution fails because the hook parser does not provide an argument that `run_hook()` reads.

## What Changes

- Repair `superseded_by` frontmatter rendering so `knowledge_absorb.py` compiles and preserves scalar/list values safely.
- Make the hook path provide or defensively read the workspace-backlog option.
- Add regression coverage for module compilation/import and a pressure-triggered hook invocation.
- Verify the complete Python test suite passes.

## Capabilities

### New Capabilities
- `absorption-cli-reliability`: The absorption CLI remains importable and its hook command executes correctly both below and above pressure thresholds.

### Modified Capabilities

None.

## Impact

Affected code is limited to `scripts/knowledge_absorb.py` and its Python tests. The CLI command surface remains backward compatible; no dependencies or data formats change.
