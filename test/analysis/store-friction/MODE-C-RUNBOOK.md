# Mode C Runbook — Fresh Corpus Capture & Live Testbench

**Sprint:** FORGE-S22 (STORE-TIGHTEN)
**Task:** FORGE-S22-T06
**Status:** Harness ready; Measurement A corpus capture deferred to operator (live LLM required)

---

## Overview

Mode C is the pragmatic pre-merge gate for FORGE-S22: live LLM sessions plus adversarial probes,
manual execution, no CI integration. It complements the Mode A regression floor (T01 SHA256-pinned
fixture + `store-friction-regression.test.ts`) by verifying that real agents using the corrected CLI
produce fewer errors in practice.

Three deliverables:
1. **Adversarial probe set** (P1–P9) — scripted, runnable without live LLM
2. **Fresh corpus measurement** (Measurement A) — live LLM required, capture deferred
3. **Baseline replay** (Measurement B) — replay T01 pinned fixture against v0.43.19+

---

## Prerequisites

### Version gate (REQUIRED first step)

All Mode C scripts resolve store-cli from the **local development source** (`forge/forge/tools/store-cli.cjs`),
NOT from the `$FORGE_ROOT` plugin cache (`/home/boni/.claude/plugins/cache/forge/forge/0.43.16`).

The plugin cache is v0.43.16 and lacks T02–T05 fix surfaces. Running probes or measurement against
the cache produces invalid results.

The version gate validates the resolved store-cli contains `ALIAS_MAP` (present in v0.43.19+):

```bash
# Dry-run: verify gate passes without mutations
cd /home/boni/src/forge-engineering
bash forge-cli/test/analysis/store-friction/mode-c-capture.sh --dry-run
```

Expected output:
```
✓ Version gate passed: .../forge/forge/tools/store-cli.cjs contains ALIAS_MAP
Dry-run complete. No mutations performed.
```

If the gate fails, ensure `forge/forge/tools/store-cli.cjs` exists and is v0.43.19+:
```bash
cd forge && git pull origin main && cd ..
grep -c "ALIAS_MAP" forge/forge/tools/store-cli.cjs
```

---

## Step 0: Smoke tests

Run all 6 smoke tests to verify the harness is operational:

```bash
bash forge-cli/test/analysis/store-friction/mode-c-smoke.test.sh
```

All 6 tests must pass before proceeding. The smoke tests verify:
1. Version gate (dry-run passes; negative test fails appropriately)
2. `filter-store-ops.py` `--root`/`--out` CLI args run without error
3. `mode-c-replay.py` against pinned fixture yields `current_rate < 0.218` (fix surfaces active)
4. P7b: 4 skill dirs present in `forge-cli/dist/forge-payload/skills/` + `load-skills.test.ts` passes
5. P10 regression: `store-cli describe task` exits 0
6. Adversarial probes P1–P9 produce expected outcomes

---

## Step 1: Adversarial probes (P1–P9)

Probes run against the **real project store** (`.forge/store/`), not a tmpdir. This is required because:
- P1–P3 (`get*` alias probes) call `read task`/`read sprint` which must find real entities
- P5 (`emit S01` FK-check) needs `resolveValidSprintIds()` to find project sprints to offer suggestions
- P8 and P9 reference `FORGE-S22` which exists in the project store

### Probe execution environment

The project store already contains `FORGE-S22` and tasks T01–T06 — no seeding required.

### Write-path probe cleanup

- **P8** uses entity ID `X-TEST-1` (synthetic). The script removes `X-TEST-1.json` after the probe:
  `rm -f "$STORE_ROOT/tasks/X-TEST-1.json"`
  Note: P8 is expected to **reject** the write (exit 1). If store-cli validates before writing, no file
  is created and cleanup is a no-op. The cleanup step is always safe to run.
- **P9** emits event `evt-probe-p9`. Events are append-only; this event remains in the store as a
  benign probe artifact. Engineers re-running probes will accumulate multiple `evt-probe-p9` entries —
  this is acceptable and harmless.

### Probe JSONL semantics

The probe JSONL records are pre-filled with **expected** values (`expectedIsError`, `expectedErrSnippet`)
for documentation. When `mode-c-replay.py` is run with `--probes-file`, it re-executes each probe
command and overwrites `isError`/`errSnippet` with **observed** values from re-execution. The pre-set
expected values are preserved as `expectedIsError`/`expectedErrSnippet` for comparison.

This means:
- `isError: false` on P1–P3 = "expected to succeed" — replay overwrites with actual exit code result
- `isError: true` on P4, P5 = "expected to fail with suggestion" — replay captures actual stderr
- The probe JSONL is self-documenting: pre-set = intent, post-replay = ground truth

### Run probes

```bash
cd /home/boni/src/forge-engineering
bash forge-cli/test/analysis/store-friction/mode-c-capture.sh --probes-only
```

Expected: all 9 probes report PASS. Results written to `tmp/mode-c-corpus/probes.jsonl`.

| Probe | Command | Expected | Verifies |
|---|---|---|---|
| P1 | `get-task FORGE-S22-T01` | exits 0 | G3: alias resolution |
| P2 | `get-sprint FORGE-S22` | exits 0 | G3: alias resolution |
| P3 | `get-summary FORGE-S22-T01 plan` | exits 0 | G3: alias resolution |
| P4 | `update-status taske ... implementign` | exits 0 + "Did you mean?" | G4: vocab drift |
| P5 | `emit S01 ...` | exits 1 + "Did you mean FORGE-S01?" | G7: FK-check |
| P6 | `emit S01 ... --allow-synthetic` | no "Unknown sprintId" error | G7: --allow-synthetic bypass |
| P7a | `nlp "list tasks FORGE-S22"` | exits 0 | NLP query engine |
| P8 | `write task ...status:implementign...` | exits 1 + "implementing" suggestion | G4: schema validation drift |
| P9 | `emit FORGE-S22 {valid payload}` | exits 0 | G7: valid emit succeeds |

P10 (`describe task` exits 0) is in the smoke test suite (Test 5), not the adversarial probe set,
because it verifies a pre-T02 baseline improvement rather than a sprint-goal fix surface.

---

## Step 2: Measurement B — Baseline replay (fix verification)

Re-run `verify-bench.py` against current store-cli to show per-goal error resolution:

```bash
cd /home/boni/src/forge-engineering
python3 forge-cli/test/analysis/store-friction/verify-bench.py
```

**Machine-specific limitation:** `verify-bench.py` contains hardcoded absolute paths
(`/home/boni/src/forge-engineering/`). It runs correctly only on this machine. For portable
re-runs on other machines, use `mode-c-replay.py --store-cli` instead:

```bash
python3 forge-cli/test/analysis/store-friction/mode-c-replay.py \
    --store-cli forge/forge/tools/store-cli.cjs \
    --ops-file forge-cli/test/fixtures/store-ops.jsonl \
    --out-md tmp/VERIFY-BENCH-B.md \
    --out-json tmp/verify-bench-b.json
```

Expected Measurement B outcome (v0.43.19+):
- G3: all 39 `get*`-related errors resolve (alias resolution now works)
- G4: drift suggestion errors surface (suggestions shown, not hard failures)
- G7: bare sprintId emit attempts rejected with suggestions

Record results in `SPRINT-COMPLETION-JUDGMENT.md`.

---

## Step 3: Measurement A — Fresh corpus capture (DEFERRED — requires live LLM)

### Why deferred

Measurement A requires running ≥15 representative Forge task sessions with live LLM agents and
capturing the resulting transcripts. This subagent context does not have live LLM agent execution
capability. The harness (scripts, runbook, probes) is complete and ready; corpus capture is
deferred to operator execution.

### Escalation note

When live LLM sessions become available, the operator must:

1. **Capture corpus** (≥15 tasks per corpus design table in PLAN.md §Corpus design):
   ```bash
   # Set store-cli override for sessions
   export FORGE_STORE_CLI_OVERRIDE=/home/boni/src/forge-engineering/forge/forge/tools/store-cli.cjs

   # Run tasks 1-15 (see PLAN.md corpus design table for task types, personas, models)
   # Save each transcript as: tmp/mode-c-corpus/<task-label>_<persona>_<model>.json
   mkdir -p /home/boni/src/forge-engineering/tmp/mode-c-corpus
   ```

2. **Fallback models:** If `glm-5.1` is unavailable, use `claude-haiku-4-5`. If `gemma4:31b-cloud`
   is unavailable, use `claude-sonnet-4`. Document which model was used for each task.

3. **Op count check:** After capture, verify ≥150 organic store-ops:
   ```bash
   python3 forge-cli/test/analysis/store-friction/filter-store-ops.py \
       --root tmp/mode-c-corpus/ \
       --out tmp/mode-c-corpus/store-ops-fresh.jsonl
   wc -l tmp/mode-c-corpus/store-ops-fresh.jsonl
   ```

4. **<150 ops escalation path:** If fewer than 150 organic ops after ≥15 tasks:
   - Document observed op count and per-task breakdown
   - Run additional tasks (duplicating any task type) until ≥150 ops
   - If ≥150 ops cannot be reached after 30 total tasks, record actual count, proceed,
     and note caveat: "Corpus below minimum target; CI window is wider than ±5pp — treat as
     directional only."
   - Do NOT lower the ≤12% gate threshold due to insufficient corpus size.

5. **Organic/provoked boundary:** Tasks 7–10 are semi-structured (agents given task descriptions
   that prompt specific store patterns) but agents still make autonomous command decisions. Their
   ops ARE counted as organic in Measurement A. The judgment document must note:
   "Tasks 7–10 are included in the organic aggregate. They increase probability of exercising
   specific fix surfaces, but the agent still determines the exact commands invoked."

6. **Run replay for Measurement A:**
   ```bash
   python3 forge-cli/test/analysis/store-friction/mode-c-replay.py \
       --store-cli forge/forge/tools/store-cli.cjs \
       --ops-file tmp/mode-c-corpus/store-ops-fresh.jsonl \
       --out-md tmp/mode-c-corpus/VERIFY-BENCH-FRESH.md \
       --out-json tmp/mode-c-corpus/verify-bench-fresh.json
   ```

7. **Sprint gate:** Measurement A passes if `current_rate ≤ 0.12` (12%). A CONDITIONAL verdict
   (≤12% observed but >17% CI upper bound) is recorded as conditional-pass with documented caveat.
   >12% is a FAIL — no relaxation of targets.

8. **Update SPRINT-COMPLETION-JUDGMENT.md** with Measurement A results.

---

## Step 4: Classify and analyze fresh corpus

```bash
# After store-ops-fresh.jsonl is generated:
python3 forge-cli/test/analysis/store-friction/analyze-store-ops.py \
    tmp/mode-c-corpus/store-ops-fresh.jsonl \
    > tmp/mode-c-corpus/FINDINGS-FRESH.md
```

---

## Step 5: Update sprint completion judgment

Edit `engineering/sprints/FORGE-S22/SPRINT-COMPLETION-JUDGMENT.md` with:
- Measurement A results (or "capture deferred" note with this runbook section as reference)
- Measurement B results (from verify-bench.py output)
- Adversarial probe results (all P1–P9)
- Verdict: PASS / FAIL / CONDITIONAL

---

## Artifact map

| Artifact | Location | Notes |
|---|---|---|
| `mode-c-capture.sh` | `forge-cli/test/analysis/store-friction/` | Probe runner + corpus pipeline |
| `mode-c-replay.py` | `forge-cli/test/analysis/store-friction/` | Fresh corpus replay (portable paths) |
| `mode-c-smoke.test.sh` | `forge-cli/test/analysis/store-friction/` | 6 functional smoke tests |
| `filter-store-ops.py` | `forge-cli/test/analysis/store-friction/` | Updated with --root/--out args |
| `MODE-C-RUNBOOK.md` | `forge-cli/test/analysis/store-friction/` | This file |
| `probes.jsonl` | `tmp/mode-c-corpus/` | Probe results (gitignored, ephemeral) |
| `store-ops-fresh.jsonl` | `tmp/mode-c-corpus/` | Fresh corpus ops (gitignored, NOT pinned) |
| `VERIFY-BENCH-FRESH.md` | `tmp/mode-c-corpus/` | Replay results (gitignored) |
| `SPRINT-COMPLETION-JUDGMENT.md` | `engineering/sprints/FORGE-S22/` | Sprint verdict (committed) |

**Note:** `tmp/mode-c-corpus/` is gitignored. Only the scripts, runbook, and judgment document
are committed to the repository.

---

## Verification commands (quick reference)

```bash
cd /home/boni/src/forge-engineering

# Version gate (dry-run)
bash forge-cli/test/analysis/store-friction/mode-c-capture.sh --dry-run

# All 6 smoke tests
bash forge-cli/test/analysis/store-friction/mode-c-smoke.test.sh

# Adversarial probes only
bash forge-cli/test/analysis/store-friction/mode-c-capture.sh --probes-only

# Measurement B (pinned fixture replay, machine-specific)
python3 forge-cli/test/analysis/store-friction/verify-bench.py

# Portable Measurement B (any machine)
python3 forge-cli/test/analysis/store-friction/mode-c-replay.py \
    --store-cli forge/forge/tools/store-cli.cjs \
    --ops-file forge-cli/test/fixtures/store-ops.jsonl

# Syntax checks
python3 -m py_compile forge-cli/test/analysis/store-friction/mode-c-replay.py
python3 -m py_compile forge-cli/test/analysis/store-friction/filter-store-ops.py
shellcheck forge-cli/test/analysis/store-friction/mode-c-capture.sh
shellcheck forge-cli/test/analysis/store-friction/mode-c-smoke.test.sh
```
