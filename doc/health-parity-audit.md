# /forge:health Parity Audit

**Task:** FORGE-S23-T07
**Date:** 2026-05-20
**Source:** `forge/forge/commands/health.md` (15 checks)
**forge-cli baseline:** `health-check.ts` (3 checks implemented before this task)

---

## Audit Table

| # | Check | Plugin `health.md` Step | forge-cli Status | Notes |
|---|---|---|---|---|
| 1 | Config completeness | Step 1 | ✅ Implemented | Full required-field validation, early-exit on missing config |
| 2 | KB freshness | Step 2 | ✅ Implemented (partial) | Hash comparison present; plugin uses line-filter normalization, forge-cli does not |
| 3 | Stale docs | Steps 3+arch scan | ✅ Implemented (this task) | Scans `engineering/architecture/*.md` mtime vs 90-day threshold |
| 4 | Orphaned entities | Step 5 | ❌ Missing | Requires ORM/type scanning; stretch for this sprint |
| 5 | Unused checklist items | Step 3 | ❌ Missing | Requires stack-checklist.md cross-reference; stretch |
| 6 | Coverage gaps | Step 3 | ❌ Missing | Architecture area enumeration needed; stretch |
| 7 | Writeback backlog | Step 4 | ❌ Missing | Requires parsing `[?]` markers in engineering docs; stretch |
| 8 | Store integrity | Step 6 | ✅ Implemented | Spawns `validate-store.cjs --dry-run` via `execFileSync` |
| 9 | Modified generated files | Step 7 | ✅ Implemented (this task) | Spawns `generation-manifest.cjs list --modified`; parses stdout |
| 10 | Generated file structure | Step 8 | ❌ Missing | Spawns `check-structure.cjs`; not in bundled tools; stretch |
| 11 | Skill gaps | Step 9 | ❌ Missing | Requires `list-skills.js` + `skill-recommendations.md`; stretch |
| 12 | Feature test coverage | Step 10 | ❌ Missing | Requires feature store scan + test-file grep; stretch |
| 13 | Concepts freshness | Step 11 | ❌ Missing | Requires mtime comparison of `docs/concepts/*.md`; stretch |
| 14 | Persona/context pack freshness | Steps 12–13 | ❌ Missing | Requires `build-persona-pack.cjs` hash computation; stretch |
| 15 | Plugin integrity | Step 14 | ✅ Implemented (this task) | Native TypeScript — reads `integrity.json` from forgeRoot, rehashes files |

## Summary

| Status | Count |
|---|---|
| Implemented before this task | 3 |
| Implemented in this task | 3 |
| **Total implemented** | **6 / 15** |
| Missing (stretch) | 9 |

## Binding Deliverables (FORGE-S23-T07)

The three new checks added in this task:

### Check 3: Stale Docs (`checkStaleDocs`)

- Scans `engineering/architecture/*.md` for files with mtime older than 90 days.
- Returns a `HealthGap` per stale file.
- Skips silently if the architecture directory does not exist.
- No `.forge/` dependency — runs regardless of config presence.

### Check 9: Modified Generated Files (`checkModifiedGeneratedFiles`)

- Spawns `bundleRoot/tools/generation-manifest.cjs list --modified` via `execFileSync`.
- Parses stdout for modified/missing file paths (one per line).
- Returns one `HealthGap` per file reported.
- Falls back silently if `generation-manifest.cjs` is absent.
- Requires config to be present (relies on `.forge/generation-manifest.json`).

### Check 15: Plugin Integrity (`checkPluginIntegrity`)

- Reads `integrity.json` from the installed forge plugin root (`forgeRoot` parameter).
- Re-hashes each file listed in `integrity.json.files`.
- Returns one `HealthGap` per modified or missing file.
- Falls back silently if `forgeRoot` is not provided or `integrity.json` is missing.
- This is a TypeScript-native implementation — no subprocess needed.

## Stretch Roadmap

The 9 remaining missing checks are candidates for a future sprint. Priority order (highest value first):

1. **Skill gaps** (Step 9) — actionable output, low implementation cost
2. **Orphaned entities** (Step 5) — high signal for architectural drift
3. **Feature test coverage** (Step 10) — directly actionable for QA
4. **Persona/context pack freshness** (Steps 12–13) — already has tooling (`build-persona-pack.cjs`)
5. **Generated file structure** (Step 8) — `check-structure.cjs` exists but not bundled
6. **Writeback backlog** (Step 7) — requires markdown parsing
7. **Concepts freshness** (Step 11) — mtime-based, low risk
8. **Unused checklist items** (Step 5) — lower priority
9. **Coverage gaps** (Step 6) — architecture enumeration complexity

## KB Freshness Note

The forge-cli KB freshness check (Check 2) uses a simpler hash than the plugin — it hashes the raw file content rather than filtering blank/comment lines first. This produces different hashes than the plugin's check. A future task should align the normalization to match the plugin's algorithm exactly (`split('\n').filter(l => l.trim() && !l.trim().startsWith('<!--'))`).
