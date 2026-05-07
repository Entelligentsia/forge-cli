# Spike R1 — RESULT

**Run type:** OFFLINE MOCK
**pi version:** 0.73.1
**Model:** "mock — does not discharge R1 gate"
**Date:** 2026-05-07T18:21:04.900Z
**Outcome:** PASS

## Evidence Checklist

### 1. sendUserMessage texts (verbatim)
- Phase 1: "Use the subagent tool in chain mode with a single step: { agent: "engineer", task: "Plan fixture task FIXTURE-T01 — output a 3-bullet implementation plan.", agentScope: "project" }."
- Phase 2: "Use the subagent tool in chain mode with a single step: { agent: "supervisor", task: "Review the plan. {previous}", agentScope: "project" }. The {previous} placeholder will be substituted by the subagent with the engineer output."

### 2. Model-emitted subagent tool-call params [MOCK]
**Phase 1 args:**
```json
{
  "chain": [
    {
      "agent": "engineer",
      "task": "Plan fixture task FIXTURE-T01 — output a 3-bullet implementation plan.",
      "agentScope": "project"
    }
  ]
}
```

**Phase 2 args (must contain `{previous}` literally):**
```json
{
  "chain": [
    {
      "agent": "supervisor",
      "task": "Review the plan. {previous}",
      "agentScope": "project"
    }
  ]
}
```

### 3. Post-substitution taskWithContext (Phase 2)
As captured in tool_execution_end result / onUpdate — Phase 1 output embedded where `{previous}` was:
```json
"Review the plan. "
```

### 4. Timing per phase

- Phase 1 waitForIdle: 10ms
- Phase 2 waitForIdle: 10ms
- Total wall-clock: 21ms

### 5. Gate status
OFFLINE MOCK: R1 gate NOT discharged. T10 must run live follow-up.

## Assertion Summary
- [PASS] AC5 anti-pattern grep: both anti-pattern greps returned zero hits
- [PASS] AC2 Phase 1 message sent: message matches expected Phase 1 text
- [PASS] AC2 Phase 2 message sent: message matches expected Phase 2 text
- [PASS] AC4 Phase 2 tool args contain literal {previous}: chain[0].task = "Review the plan. {previous}"
- [PASS] AC4 Post-substitution taskWithContext has no {previous}: taskWithContext = "Review the plan. ..."
- [PASS] AC3 notify called after both phases: [MOCK] notify would be called after Phase 2

## Notes
OFFLINE MOCK run. The {previous} substitution at subagent/index.ts:518 was mirrored by the mock (mock-session.ts uses the same step.task.replace(/\{previous\}/g, previousOutput) logic). This does NOT discharge the R1 gate. Run with ANTHROPIC_API_KEY to execute a live verification.
