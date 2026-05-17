# `test/analysis/store-friction/` — reference analysis tools

This directory holds the **historical, one-shot** Python analysis scripts and their JSON/Markdown outputs that produced the store-cli friction baseline used by the regression suite.

## Status

- **NOT part of the Vitest suite.** `biome.json` `files.includes` is `*.ts` only; lint and `vitest` never load these files.
- **NOT run by CI.** No npm script invokes them. They are reference artifacts kept under `test/` so they ship in the source tree alongside the fixture they generated.
- **NOT in the published tarball.** `forge-cli/package.json` `files` lists `[dist, agents, prompts, registry, skills, themes, workflows, README.md, CHANGELOG.md, LICENSE]`. `test/` is excluded → `npm pack` / `npm publish` do not ship `test/analysis/` or `test/fixtures/store-ops.jsonl`. Verified by `test/verify-publish.test.ts`.

## Contents

| File | Purpose |
|---|---|
| `FINDINGS.md` | Canonical empirical baseline (21.8% aggregate). Cited by the regression test. |
| `EMIT-DRILL.md`, `TRANSITION-DRILL.md`, `VERIFY-BENCH.md` | Drill-down narratives behind FINDINGS. |
| `SPRINT_PLAN.md` | Original sprint intake notes for STORE-TIGHTEN. |
| `analyze-store-ops.py` | Top-level aggregator that produced FINDINGS.md. |
| `drill-emit.py`, `drill-transitions.py` | Sub-aggregators for emit-shape and transition errors. |
| `filter-store-ops.py` | JSONL → filtered subset (used during data prep). |
| `verify-bench.py` | Regression-bench prototype that the Vitest suite supersedes. |
| `emit-intent-map.json`, `top-failures.json`, `verify-bench.json` | Cached intermediate outputs. |

## Running (optional, manual only)

```bash
cd forge-cli/test/analysis/store-friction
python3 analyze-store-ops.py ../../fixtures/store-ops.jsonl
```

Outputs may not byte-match the cached JSON if the source dataset is regenerated. The Vitest regression suite is the authoritative gate; these scripts are kept for forensic re-analysis only.

## Boundary

If you need to extend the baseline, update `FINDINGS.md` and the matching pinned constants in `test/extensions/forgecli/store-friction-regression.test.ts` in the same commit. Do not silently re-run the scripts and overwrite the JSON outputs without bumping both.
