# Absorption Review Prompt

Use this prompt only when a human or agent wants semantic review beyond the deterministic `knowledge_absorb.py plan` heuristics.

Classify each inbox candidate into exactly one action:

- `retain_memory`
- `move_scope`
- `promote_to_module_doc`
- `promote_to_skill`
- `deprecate`
- `keep_inbox`

Return JSON matching `schemas/absorption-plan.schema.json`. Do not invent source evidence. Do not mark module-doc/skill promotions safe for hook auto-apply.
