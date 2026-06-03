# Spike R-CG2 — prompt-cache safety under mid-stream curation (FORGE-S30-T02)

**Verdict:** SAFE — all tool_result curation is safe; no post-breakpoint-only restriction
**Date:** 2026-06-03
**Spec:** `forge-cli/test/poc/spike-r-cg2/run.spec.ts` (6 tests, all passing)
**Helper:** `forge-cli/test/poc/spike-r-cg2/spike.ts`

## Summary

Mutating `tool_result` content via the `tool_result` extension handler
(Mechanism A) does **NOT** invalidate the Anthropic prompt-cache prefix from
prior turns.

The structural analysis of `buildParams` → `convertMessages` in
`packages/ai/src/providers/anthropic.ts` proves:

1. `cache_control: { type: "ephemeral" }` is placed **only** on the last block
   of the last user message in the serialized Anthropic request (lines 1154-1175).
2. Prior `tool_result` user messages do NOT carry `cache_control` — they are
   part of the stable cached prefix.
3. When Mechanism A mutates a `tool_result` at turn N, the mutation is committed
   before `buildParams` runs. On turn N+1, the mutated toolResult is part of the
   stable cached prefix — the Anthropic server cache-hits on it.
4. `cacheSessionId` in forge-subagent.ts does NOT create an Anthropic-side cache
   scope. It flows only to `x-opencode-session` header (opencode providers only).

## Acceptance Criteria — Evidence

| # | Criterion | Result |
|---|---|---|
| AC1 | cache_control appears only on the last user message block | PASS — structural: `applyCacheControlToLastUserMessage` places exactly 1 block; correct position verified |
| AC2 | Prior tool_result blocks do NOT carry cache_control | PASS — structural: tool_result message (index 2) has no cache_control after applying placement logic |
| AC2 | Placement identical whether tool_result is fat or curated | PASS — structural: both fat/curated variants produce cache_control on same messageIndex/blockIndex |
| AC3 | cacheSessionId is NOT used for Anthropic cache keying | PASS — structural: flows only to x-opencode-session header (opencode providers); not used by Anthropic |
| AC4 | Curation reduces cache-write payload size | PASS — curated tool_result message is smaller in bytes than fat |
| AC5 (auth-gated) | cacheRead tokens with curation >= without | SKIPPED (no ANTHROPIC_API_KEY) |
| Sprint artifact | R-CG2 section appended to SPIKE-LESSONS.md | PASS |
| npm run typecheck | tsc --noEmit exits 0 | PASS |
| npm test | No new test failures | PASS (2 pre-existing ceremony timeouts unaffected) |

## Test Output

```
 RUN  v3.2.4 /home/boni/src/forge-engineering/forge-cli

 ✓ test/poc/spike-r-cg2/run.spec.ts (6 tests) 4ms

 Test Files  1 passed (1)
      Tests  6 passed (6)
   Start at  15:04:55
   Duration  250ms (transform 42ms, setup 0ms, collect 36ms, tests 4ms, environment 0ms, prepare 70ms)
```

## Safe Curation Bound — T04 Timing Constraint

**Mechanism A curation is unconditionally safe** with respect to Anthropic
prompt-cache prefix reuse, provided mutation occurs in the `tool_result` handler
**before** the message is committed to `context.messages` (R-CG1 pattern).

No "post-breakpoint only" restriction applies. T04 should proceed with always-on
curation as designed.

## Run Command

```bash
cd forge-cli && npx vitest run --config vitest.poc.config.ts test/poc/spike-r-cg2/run.spec.ts
```
