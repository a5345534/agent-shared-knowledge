## 1. Canonical Pi Extension

- [x] 1.1 Update the packaged extension to current compaction, model registry, message conversion, completion, and UI APIs
- [x] 1.2 Implement review-only, explicit inbox, and external-command materializer modes with fail-closed validation
- [x] 1.3 Ensure post-compaction absorption runs only for explicit inbox mode and uses no-git policy
- [x] 1.4 Add lifecycle/materializer tests proving review-only leaves the checkout untouched, inbox mode is explicit, command mode passes JSON argv/stdin without a shell, and invalid configuration fails closed

## 2. Absorber Git Policy

- [x] 2.1 Add `--git-mode none|commit` to the hook command and prevent all Git commands in no-git mode
- [x] 2.2 Add regression tests for no-git and explicit commit behavior

## 3. Single Implementation and Installation

- [x] 3.1 Replace the generated embedded extension with a thin loader for the canonical package extension
- [x] 3.2 Detect project Pi package configuration and skip duplicate lifecycle extension installation
- [x] 3.3 Add installation tests covering package-present and submodule-loader paths

## 4. Package Quality Gates

- [x] 4.1 Declare Pi peer dependencies and TypeScript development/type-check configuration
- [x] 4.2 Add extension type-check and package metadata smoke tests
- [x] 4.3 Document safe defaults, materializer configuration, and migration behavior

## 5. Verification

- [x] 5.1 Run Python tests, TypeScript type checking, package dry-run, and OpenSpec strict validation
