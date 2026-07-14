## 1. Restore CLI Parsing

- [x] 1.1 Refactor `superseded_by` normalization and rendering so the module compiles and handles scalar/list-like values
- [x] 1.2 Add the workspace-backlog option to the hook parser and make internal argument access defensive

## 2. Regression Coverage

- [x] 2.1 Add focused tests for scalar and list-like `superseded_by` rendering
- [x] 2.2 Add a regression test that forces pressure-triggered hook execution and verifies successful JSON output

## 3. Verification

- [x] 3.1 Run Python compilation and the complete pytest suite
- [x] 3.2 Validate the OpenSpec change artifacts
