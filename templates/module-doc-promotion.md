# Promote to Module Doc

Use when an inbox candidate (or curated workspace memory entry) describes module-owned architecture, operations, or runbook guidance that belongs in the owning module's `docs/` tree.

Destination: `<module>/docs/{architecture,operations,runbooks}/<name>.md`

Rules:

- This is review-gated; hooks do not auto-apply module-doc promotions.
- Keep a concise pointer in shared memory or mark the original entry `type: deprecated`.
- Module docs remain owned by their module repo.
