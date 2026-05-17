# Sprint Plan — Store-Tooling Friction Reduction

**Codename:** STORE-TIGHTEN
**Proposed ID:** FORGE-S22 (sequential after S21; can run parallel to Sprint C #26 since dogfood switch depends on this)
**Priority:** P0 — Sprint C dogfood switch unreliable until store-op failure rate < 12%
**Architect:** TBD (single architect; 1-2 engineers in parallel for sub-workflow tracks)
**Execution mode:** wave-parallel (T01 sequential, T02-T05 parallel, T06-T07 parallel after T01)

---

## Source-of-truth analysis

| Artifact | Path |
|---|---|
| Baseline corpus | `tmp/transcripts/hello/` (109 transcripts, frozen) — later mirrored to `forge-cli/test/fixtures/store-friction-baseline/` |
| Extracted store-ops | `tmp/transcripts-analysis/store-ops.jsonl` (927 records) |
| Aggregate findings | `doc/analysis/store-friction/FINDINGS.md` |
| Emit drill | `doc/analysis/store-friction/EMIT-DRILL.md` |
| Transition drill | `doc/analysis/store-friction/TRANSITION-DRILL.md` |
| Mode A v2 verify-bench | `doc/analysis/store-friction/VERIFY-BENCH.md` |

## Baseline measurement (frozen)

- **927 store-ops** across **109 transcripts** (mixed glm-5.1, claude-haiku-4-5, gemma4)
- **23.4%** raw CLI failure rate when replayed against current source
- **174 still-broken** baseline failures persist under current CLI (state-tracked replay)
- **22 already improved** by shipped meta-workflow + CLI fixes (describe/template/FSM-table-in-workflow/--force-gate)

## Already-shipped fixes (in current source, S22 NOT required)

| Commit | What it fixed | Impact (Mode A) |
|---|---|---|
| `1918b4c` v0.43.14 telemetry contract Slice 2 — orchestrator-emits-everything | Subagents told "don't emit phase events" in workflow markdown | Reduces NEW workflows from producing missing-field errors; baseline shows old workflow behavior |
| `9ca015d` inline FSM transition table in plan/review-plan/implement workflows | FSM visible inline | Some `update-status` recoveries observed |
| `3469e9e` embed store-cli verb cheat-sheet in workflows | Cheat-sheet visible | Partial vocab guidance |
| `fa58409` gate --force behind FORGE_ALLOW_FORCE | --force operator-gated | Hardening; intended regression |
| describe/template subcommands | New | 22 measured improvements |

---

## Goals (post-baseline, data-confirmed gaps)

### G3 — Subcommand aliases (`get*` family)
**Evidence:** 39 baseline errors, 89.7% failure rate on `get*`; unchanged in current CLI
**Scope:** Add aliases in `store-cli.cjs`:
- `get <entity> <id>` → `read <entity> <id>`
- `get-task <id>` → `read task <id>`
- `get-bug <id>` → `read bug <id>`
- `get-sprint <id>` → `read sprint <id>`
- `get-summary <taskId> <phase>` → returns named phase summary from task record (or 404)
- `get-bug-summary <bugId> <phase>` → same for bug

Help text updated. Tests in `tools/__tests__/store-cli.test.cjs`.
**Estimate:** S
**AC:** all 39 baseline `get*` errors resolve in v2 verify-bench re-run

### G4 — Vocab-drift detector + "Did you mean?" suggestions
**Evidence:** primary source of `unknown_subcommand` / `enum_invalid` / `missing_required_field` errors. Type drift (`task_planned` vs `task-planned`), field-name drift (`task` vs `taskId`, `timestamp` vs `startTimestamp`), status drift (`in-progress` vs `implementing`).

**Scope:** In `store-cli.cjs`:
- On schema validation error, compute Levenshtein distance to expected enum values + field names
- If distance ≤ 2 (configurable), append "Did you mean `<suggested>`?" to error per field
- Curated drift map for known patterns:
  - `task` → `taskId`
  - `timestamp` → `startTimestamp` + `endTimestamp`
  - `in-progress` / `in_progress` → `implementing`
  - `completed` (task) → `committed`
  - `task_planned` → `task-planned` (underscore→hyphen normalization)
  - `code-review-approved` → `review-passed`
- For undeclared-field errors, suggest the closest-name accepted field

**Estimate:** M
**AC:**
- All 4 drift patterns surface "Did you mean?" suggestion in verify-bench re-run
- Synthetic test fixtures for each drift class in `tools/__tests__/`

### G5 — Bundle plugin SKILL.md into forge-cli payload + wire `pi.loadSkills()`
**Evidence:** Spike R6 proves compatibility; production wiring missing. `store-query-grammar`/`store-custodian` SKILL.md not loaded by forge-cli.

**Scope:**
- Build-step: copy `forge/forge/skills/{store-custodian,store-query-grammar,store-query-nlp,refresh-kb-links}/` → `forge-cli/dist/forge-payload/skills/`
- Extension init: call `pi.loadSkills(payloadSkillsDir)` after `registerForgeTools()` in `forge-cli/src/extensions/forgecli/index.ts`
- Vitest covering: loadSkills returns 4 skills, zero diagnostics
- Smoke: pi-runtime session in hello testbench shows skill auto-loaded when agent calls forge_store

**Estimate:** M
**AC:**
- `pi.loadSkills()` integration vitest green
- Transcript from forge-cli smoke shows `store-custodian` skill loaded
- Re-run pi-runtime hello-init: `forge_store emit` failure should drop (skill provides template-first guidance)

### G7 — Emit FK-check + reserved-prefix carve-out
**Evidence:** 168 emit calls used bare-string sprintId (`S01` not `HLO-S01`) — accepted silently, creates orphan event dirs.

**Scope:** In `store-cli.cjs emit`:
- Validate sprintId argument exists in `.forge/store/sprints/` OR matches reserved prefix (`SYS-init`, `SYS-enhancement`, `SYS-*`)
- If neither: reject with `Unknown sprintId: <X>. Did you mean <closest>?` + list of valid prefixes
- Flag `--allow-synthetic` bypasses for milestone events
- Migration entry to flag orphan event dirs for cleanup (one-time)

**Estimate:** S
**AC:**
- Bare-sprintId emit rejected without `--allow-synthetic` in verify-bench
- Existing orphan dirs flagged by `validate-store.cjs`

### G9 — Verification harness (mandatory)
**Evidence:** Mode A v2 already drafted; needs hardening + CI integration.

**Scope:**
- Move `tmp/transcripts-analysis/` Python tooling → `doc/analysis/store-friction/` (permanence)
- Freeze `store-ops.jsonl` as committed fixture
- Add `forge-cli/test/extensions/forgecli/store-friction-regression.test.ts`:
  - Loads frozen `store-ops.jsonl` baseline
  - For each record: spawn tmpdir store, replay
  - Asserts: per-pattern error count ≤ thresholds set per goal
  - Fails CI if regression introduced

Three modes:
1. **Mode A** (deterministic, in this sprint) — replay CLI args, no LLM
2. **Mode B** (scripted-subagent harness, deferred to follow-up) — replay tool calls via streamFn-fake
3. **Mode C** (live LLM testbench, manual pre-merge gate) — full bench re-run

**Estimate:** M
**AC:**
- Mode A as CI gate: must run < 60s
- Per-pattern thresholds in fixture: max counts for each `errKey` (e.g. `unknown_subcommand:get` ≤ 0 after G3)
- Sprint-completion gate: aggregate error rate ≤ **12%** (down from 23.4%)

---

## Task Decomposition

| Task | Goal | Estimate | Deps | Wave |
|---|---|---|---|---|
| **T01** Verification harness foundation: move artifacts, freeze fixture, write `store-friction-regression.test.ts` Mode A skeleton, set thresholds at current baseline | G9 partial | M | — | 1 (blocking) |
| **T02** `get*` aliases + tests | G3 | S | T01 | 2 |
| **T03** Vocab-drift detector + "Did you mean?" + curated map | G4 | M | T01 | 2 |
| **T04** Bundle plugin SKILL.md + `pi.loadSkills()` wiring + vitest | G5 | M | T01 | 2 |
| **T05** Emit FK-check + reserved-prefix `--allow-synthetic` + orphan flagger | G7 | S | T01 | 2 |
| **T06** Harness finalization: per-pattern thresholds tightened post-T02-T05; CI gate enforced; Mode C runbook for pre-merge live testbench | G9 | S | T02-T05 | 3 |
| **T07** Documentation: update `forge/forge/CLAUDE.md` + `store-custodian/SKILL.md` with new aliases and drift-suggestion behavior; regenerate base-pack | docs | S | T02-T05 | 3 |

**Total:** 4 × M + 3 × S — typical single-architect sprint, completable in ≤ 1 week with 1-2 engineers parallel on T02-T05.

---

## Sprint Acceptance

1. Mode A v2 re-run on frozen baseline shows aggregate error rate ≤ **12%** (down from 23.4%)
2. Per-goal patterns reduced to thresholds:
   - `unknown_subcommand:get*` → **0**
   - Vocab-drift "Did you mean?" surfaces on each of 4 known drift patterns
   - Synthetic sprintId emit rejected without flag
   - pi-runtime smoke: skills auto-loaded
3. CI: `store-friction-regression.test.ts` green, blocks any regression
4. Forge plugin version bump (likely v0.43.16 → v0.44.0 due to CLI surface additions; minor under semver-by-meaning)
5. Migration entry for orphan event-dir cleanup
6. Mode C runbook documented (manual pre-merge gate)

## Out of Scope (carry-overs)

- Mode B scripted-subagent harness integration (deferred — follow-up sprint)
- Full re-architect of subagent vs orchestrator event-emission ownership (done at workflow level in S21; CLI-level relaxation NOT planned — schema stays strict, workflow guidance is the lever)
- `verified → fixed` bug transition (workflow-level decision; not CLI tooling)
- MCP-tool-per-action split (`forge_store_emit`, `forge_store_write_task`, ...) — addressed via tool-description enrichment in G4 indirectly

---

## Risks

| Risk | Mitigation |
|---|---|
| Frozen baseline becomes stale as workflows evolve | Re-run capture quarterly; baseline rotation policy in T01 |
| "Did you mean?" suggestions misdirect for novel inputs | Curated drift map limits scope; Levenshtein threshold conservative (≤ 2) |
| Skill bundling adds payload size | Spike R6 confirmed: 4 SKILL.md files ≈ small; progressive disclosure means runtime cost only on description match |
| FK-check on emit breaks existing init/enhancement flows | Reserved-prefix `--allow-synthetic` carve-out; explicit list of system-namespace prefixes |

---

## Verification Schedule

- **Per task:** Mode A regression test must pass with that task's thresholds tightened
- **End of sprint:** Mode A aggregate ≤ 12%; Mode C live testbench run (5-10 representative tasks) confirms LLM-driven path also improved
- **Post-sprint:** Sprint C #26 dogfood switch (T13) gated on this aggregate target
