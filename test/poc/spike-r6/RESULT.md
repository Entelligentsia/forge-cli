# Spike R6 — Skill Frontmatter Compatibility (FORGE-S15-T09)

**Verdict:** PASS — Forge skill format is fully compatible with pi v0.73.1's `loadSkills()`.

**Date:** 2026-05-08
**Spec:** `forge-cli/test/poc/spike-r6/run.spec.ts` (5 tests, all passing)
**Helper:** `forge-cli/test/poc/spike-r6/spike.ts`
**Diagnostics dump:** `forge-cli/test/poc/spike-r6/diagnostics.json`

## Summary

Loaded all four Forge skills (`refresh-kb-links`, `store-custodian`,
`store-query-grammar`, `store-query-nlp`) through pi v0.73.1's `loadSkills()`
against an isolated tmp fixture. **Zero diagnostics emitted** for any of the
four skills. AC4's hard bar (zero diagnostics on `refresh-kb-links/SKILL.md`)
is met. The architectural-review §R5/§5 risk is discharged — Forge skill
frontmatter requires no normalisation to flow through the pi loader.

## Acceptance Criteria — Evidence

| AC  | Bar                                                                                       | Result                                                                                  |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AC1 | `loadSkills()` runs against fixture; returns four skills, no thrown error                  | PASS — `result.skills.length === 4`; all four parent-dir names present in returned set  |
| AC2 | Each skill has `name`/`description`/`filePath`/`baseDir`/`disableModelInvocation` fields  | PASS — runtime types verified per-skill; `name === parentDir` verified for all four     |
| AC3 | Field-level deltas enumerated in RESULT.md if any                                          | N/A — zero deltas to enumerate (delta table below empty)                                |
| AC4 | Zero blocking diagnostics on `refresh-kb-links/SKILL.md`                                   | PASS — `diagnostics.filter(d => d.path?.endsWith("refresh-kb-links/SKILL.md"))` is `[]` |

Plan-review advisory 3 (collision diagnostics) — PASS, zero `type: "collision"` entries.

## Delta Table

| Skill                  | Diagnostic kind | Message | Proposed normalisation |
| ---------------------- | --------------- | ------- | ---------------------- |
| _(empty — no deltas)_  | —               | —       | —                      |

## Test Output

```
RUN  v3.2.4 /home/boni/src/forge-engineering/forge-cli

 ✓ test/poc/spike-r6/run.spec.ts (5 tests) 15ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

## Loader Behaviour Confirmed

From `forge-cli/node_modules/@entelligentsia/pi-coding-agent/dist/core/skills.js`:

- `validateName` — enforces `^[a-z0-9-]+$`, ≤64 chars, no leading/trailing
  hyphen, no consecutive hyphens, must equal parent directory basename. All
  four Forge skill names comply.
- `validateDescription` — required, non-empty after trim, ≤1024 chars. All
  four Forge skill descriptions comply (single-sentence summaries well under
  the cap).
- Unknown frontmatter keys — silently ignored via `[key: string]: unknown`
  index signature on `SkillFrontmatter`. Any future Forge-side metadata
  (e.g. `tools:`, `model:`) will not raise diagnostics.
- Discovery — `loadSkillsFromDirInternal` finds `<root>/<name>/SKILL.md` and
  short-circuits further recursion under each skill dir. Confirmed against
  the fixture layout used here.

## Recommendation

No Forge-side or forge-cli-side normalisation needed. Stage-3 forge-cli
skill packaging may pass Forge's `forge/skills/` tree directly through
`loadSkills({ skillPaths: [...] })` without additional preprocessing.
