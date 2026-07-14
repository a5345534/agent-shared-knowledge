## 1. Legacy Migration

- [x] 1.1 Implement migrate-layout parser, planning, dry-run, collision checks, copy/rewrite, parity verification, and safe source cleanup
- [x] 1.2 Add migration tests for dry-run immutability, successful cutover, B1 deduplication, parity, and collision refusal

## 2. Policy Boundaries

- [x] 2.1 Gate adopter-specific topology lint behind explicit configuration while retaining generic checks
- [x] 2.2 Add default-off and opt-in topology lint regression tests

## 3. Follow-up Authorities

- [x] 3.1 Implement validated JSON authority configuration and integrate it with action classification, follow-up creation, paths, and lint
- [x] 3.2 Extend schemas for configured authority identifiers and add OpenSpec example configuration
- [x] 3.3 Add tests for built-ins, configured OpenSpec promotion, malformed config, and no-OpenSpec default

## 4. Release and Documentation

- [x] 4.1 Document migration, policy boundaries, authority configuration, and submodule/package source-of-truth rules
- [x] 4.2 Add release smoke checks that verify tests, package contents, clean working tree, and expected version

## 5. Verification

- [x] 5.1 Run Python/TypeScript tests, package smoke, migration fixtures, lint, and strict OpenSpec validation
