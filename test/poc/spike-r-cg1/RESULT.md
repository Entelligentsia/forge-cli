# Spike R-CG1 — tool_result mutation fidelity (FORGE-S30-T01)

**Verdict:** PASS
**Date:** 2026-06-03
**Spec:** `forge-cli/test/poc/spike-r-cg1/run.spec.ts` (7 tests, all passing)
**Helper:** `forge-cli/test/poc/spike-r-cg1/spike.ts`

## Summary

Returning `{ content: SHRUNK_CONTENT }` from a `tool_result` extension handler
**does** cause the next provider request (turn-2 streamFn call) to carry only
the shrunk content. The original fat payload is NOT re-expanded from session
storage.

This discharges the gate condition for FORGE-S30 context-governance. All
downstream tasks (T03, T04, T05, …) may proceed on the Mechanism A design.

## Acceptance Criteria — Evidence

| # | Criterion | Result |
|---|-----------|--------|
| AC1 | Extension factory registers a `tool_result` handler | PASS — `getCaptured().toolResultHandler` is a function; exactly one handler registered |
| AC1 | Handler returns `{ content: SHRUNK_CONTENT }` for fat payload | PASS — direct unit test against synthetic fat event |
| AC1 | Handler returns `undefined` (pass-through) for lean payload | PASS — lean payload does not contain `FAT_PAYLOAD_SENTINEL` |
| AC2 | Turn-2 `llmContext.messages` contains toolResult with `content = SHRUNK_CONTENT` | PASS — `evidence.capturedToolResultContent` equals `[{ type: "text", text: "SHRUNK" }]` |
| AC2 | Turn-2 context does NOT contain the fat sentinel string | PASS — `FAT_PAYLOAD_SENTINEL` absent from JSON.stringify(capturedTurn2Messages) |
| AC3 | `engineering/sprints/FORGE-S30/SPIKE-LESSONS.md` records verdict | PASS — written with mechanism + downstream implications |
| AC4 | `npm run typecheck` green | PASS — `tsc --noEmit` exits 0 |
| AC4 | `npm test` no new failures | PASS — 2 pre-existing timeouts in run-sprint.ceremony.test.ts unaffected |

## Test Output

```
 RUN  v3.2.4 /home/boni/src/forge-engineering/forge-cli

 ✓ test/poc/spike-r-cg1/run.spec.ts (7 tests) 60ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Start at  14:30:52
   Duration  1.73s (transform 67ms, setup 0ms, collect 1.20s, tests 60ms, environment 0ms, prepare 89ms)
```

## Mechanism Confirmed

The `tool_result` handler mutation path:

```
pi.on("tool_result", handler)
  → runner.emitToolResult() → handler returns { content: ["SHRUNK"] }
  → finalizeExecutedToolCall: result.content = ["SHRUNK"]
  → createToolResultMessage: .content = ["SHRUNK"]
  → context.messages.push(toolResultMsg)
  → convertToLlm(messages) → passes through unchanged
  → streamFn(model, llmContext, options)
  → llmContext.messages[i].role === "toolResult", .content === ["SHRUNK"]  ✓
```

The `ToolResultMessage` in `context.messages` is the sole source of truth for
subsequent LLM calls. No session-replay or back-expansion mechanism exists.

## Run Command

```bash
cd forge-cli && npx vitest run --config vitest.poc.config.ts test/poc/spike-r-cg1/run.spec.ts
```
