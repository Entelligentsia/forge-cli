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

---

## Mode C artifacts (added FORGE-S22-T06)

Sprint FORGE-S22 (STORE-TIGHTEN) added **Mode C** tooling for fresh-corpus capture and live testbench verification. These are pre-merge gate tools — manual execution, no CI integration.

| File | Purpose |
|---|---|
| `MODE-C-RUNBOOK.md` | End-to-end Mode C process documentation |
| `mode-c-capture.sh` | Version-gated probe runner + corpus capture pipeline |
| `mode-c-replay.py` | Portable fresh-corpus replay (no SHA256 pinning, `parents[4]` path resolution) |
| `mode-c-smoke.test.sh` | 6 functional smoke tests (gate, filter args, replay accuracy, P7b, P10, probes) |

### Version-gate prerequisite

Both `mode-c-capture.sh` and `mode-c-replay.py` resolve store-cli from the **local development source** (`forge/forge/tools/store-cli.cjs`), not the plugin cache. The version gate validates the resolved CLI contains `ALIAS_MAP` (present in v0.43.19+). This ensures measurements reflect T02–T05 fixes.

```bash
bash mode-c-capture.sh --dry-run   # exits 0 if gate passes
```

### `filter-store-ops.py` CLI args

`filter-store-ops.py` now accepts `--root <dir>` and `--out <file>` CLI args:

```bash
python3 filter-store-ops.py \
    --root tmp/mode-c-corpus/ \
    --out  tmp/mode-c-corpus/store-ops-fresh.jsonl
```

Defaults (when flags omitted) fall through to the original hardcoded paths — existing invocations are unchanged.

### Probe execution environment

Adversarial probes (P1–P9) run against the **real project store** (`.forge/store/`), not a tmpdir. This is required because P1–P3 (`get*` alias probes) and P5 (FK-check) need real entity IDs and sprint records. The project store contains `FORGE-S22` and tasks T01–T06 without any seeding.

Write-path probe cleanup:
- **P8**: uses `X-TEST-1` (synthetic ID); `mode-c-capture.sh` removes `X-TEST-1.json` after the probe
- **P9**: emits `evt-probe-p9`; this event remains in the store as a benign probe artifact

### Probe JSONL semantics

Probe records in `probes.jsonl` contain `expectedIsError`/`expectedErrSnippet` (pre-set intent) alongside `isError`/`errSnippet` (observed after replay). `mode-c-replay.py --probes-file` re-executes probe commands and overwrites the observed fields in-place. The distinction is documented in `MODE-C-RUNBOOK.md`.

### Mode C vs. Mode A boundary

| | Mode A | Mode C |
|---|---|---|
| Fixture | SHA256-pinned (`store-ops.jsonl`) | Fresh corpus (`tmp/mode-c-corpus/`) |
| Pinned? | Yes — regression floor | No — measurement only |
| CI? | Yes (`store-friction-regression.test.ts`) | No — manual only |
| Gate | `aggregate_error_rate ≈ 21.8%` | `current_rate ≤ 12%` |
| Probe set | None | P1–P9 (adversarial) |

Mode C artifacts in `tmp/mode-c-corpus/` are gitignored. Only the scripts, runbook, and `SPRINT-COMPLETION-JUDGMENT.md` are committed.
