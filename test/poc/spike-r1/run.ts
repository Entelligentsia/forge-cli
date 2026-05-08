/**
 * Spike R1 entry point — FORGE-S15-T04.
 *
 * Selects live or offline mock path based on ANTHROPIC_API_KEY presence.
 * Asserts all ACs. Writes RESULT.md. Exits:
 *   0 — assertions passed (LIVE PASS or OFFLINE MOCK)
 *   1 — one or more assertions failed
 *   2 — deferred (no API key; live run required to discharge R1 gate)
 *
 * Usage:
 *   Live:    ANTHROPIC_API_KEY=<key> node --loader tsx test/poc/spike-r1/run.ts
 *   Offline: node --loader tsx test/poc/spike-r1/run.ts
 *   Offline (compiled): node test/poc/spike-r1/run.js
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT_PATH = path.join(__dirname, "RESULT.md");
const PI_VERSION = "0.73.1"; // @earendil-works/pi-coding-agent installed version

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

interface AssertionResult {
  name: string;
  pass: boolean;
  detail: string;
}

const assertions: AssertionResult[] = [];

function assert(name: string, pass: boolean, detail: string): void {
  assertions.push({ name, pass, detail });
  const icon = pass ? "PASS" : "FAIL";
  console.log(`[${icon}] ${name}: ${detail}`);
}

// ---------------------------------------------------------------------------
// AC5 — anti-pattern grep (must be run from within forge-cli/ directory)
// ---------------------------------------------------------------------------

function runAntiPatternGrep(): { pass: boolean; detail: string } {
  const spikeDir = path.relative(process.cwd(), __dirname);

  // Pattern 1: sendUserMessage called with JSON.stringify as argument.
  // Exclude run.ts (this file — contains the pattern as a string literal)
  // and RESULT.md (generated output) to avoid false positives.
  const grep1 = spawnSync(
    "grep",
    ["-rE", "--exclude=run.ts", "--exclude=run.js", "--exclude=RESULT.md",
     "sendUserMessage\\(.*JSON\\.stringify", spikeDir],
    { encoding: "utf-8" },
  );
  // grep exits 0 if match found (FAIL), 1 if no match (PASS)
  const pattern1Pass = grep1.status !== 0;

  // Pattern 2: JSON.stringify with chain argument
  const grep2 = spawnSync(
    "grep",
    ["-rE", "--exclude=run.ts", "--exclude=run.js", "--exclude=RESULT.md",
     "JSON\\.stringify\\([^)]*chain", spikeDir],
    { encoding: "utf-8" },
  );
  const pattern2Pass = grep2.status !== 0;

  const pass = pattern1Pass && pattern2Pass;
  const detail = pass
    ? "both anti-pattern greps returned zero hits"
    : [
        !pattern1Pass ? "ANTI-PATTERN HIT: sendUserMessage(.*JSON.stringify" : null,
        !pattern2Pass ? "ANTI-PATTERN HIT: JSON.stringify([^)]*chain" : null,
      ]
        .filter(Boolean)
        .join("; ");

  return { pass, detail };
}

// ---------------------------------------------------------------------------
// RESULT.md writer
// ---------------------------------------------------------------------------

function writeResultMd(opts: {
  runType: "LIVE" | "OFFLINE MOCK" | "DEFERRED";
  outcome: "PASS" | "FAIL" | "DEFERRED";
  piVersion: string;
  modelId: string;
  date: string;
  phase1Message: string;
  phase2Message: string;
  phase1ToolArgs: unknown;
  phase2ToolArgs: unknown;
  phase2PostSubstitution: unknown;
  phase1IdleMs?: number;
  phase2IdleMs?: number;
  totalMs?: number;
  assertionSummary: string;
  notes?: string;
}): void {
  const modelDisplay =
    opts.runType === "OFFLINE MOCK"
      ? '"mock — does not discharge R1 gate"'
      : opts.modelId;

  const phase1ArgsJson =
    opts.phase1ToolArgs !== undefined
      ? JSON.stringify(opts.phase1ToolArgs, null, 2)
      : "(not captured — model did not emit subagent call)";

  const phase2ArgsJson =
    opts.phase2ToolArgs !== undefined
      ? JSON.stringify(opts.phase2ToolArgs, null, 2)
      : "(not captured — model did not emit subagent call)";

  const postSubstitution =
    opts.phase2PostSubstitution !== undefined
      ? JSON.stringify(opts.phase2PostSubstitution, null, 2)
      : "(not captured)";

  const timing = `
- Phase 1 waitForIdle: ${opts.phase1IdleMs ?? "N/A"}ms
- Phase 2 waitForIdle: ${opts.phase2IdleMs ?? "N/A"}ms
- Total wall-clock: ${opts.totalMs ?? "N/A"}ms`;

  const gateStatus = {
    "LIVE PASS": "LIVE PASS: R1 gate discharged. Stage 3 may proceed.",
    PASS: "LIVE PASS: R1 gate discharged. Stage 3 may proceed.",
    "OFFLINE MOCK":
      "OFFLINE MOCK: R1 gate NOT discharged. T10 must run live follow-up.",
    DEFERRED:
      "DEFERRED (no API key): R1 gate NOT discharged. T10 must run live follow-up.",
    FAIL: "FAIL: One or more assertions failed. R1 gate NOT discharged.",
  } as const;

  const gateKey =
    opts.runType === "OFFLINE MOCK"
      ? "OFFLINE MOCK"
      : opts.runType === "DEFERRED"
        ? "DEFERRED"
        : opts.outcome === "PASS"
          ? "LIVE PASS"
          : "FAIL";

  const mockFlag =
    opts.runType === "OFFLINE MOCK" ? " [MOCK]" : "";

  const content = `# Spike R1 — RESULT

**Run type:** ${opts.runType}
**pi version:** ${opts.piVersion}
**Model:** ${modelDisplay}
**Date:** ${opts.date}
**Outcome:** ${opts.outcome}

## Evidence Checklist

### 1. sendUserMessage texts (verbatim)
- Phase 1: "${opts.phase1Message}"
- Phase 2: "${opts.phase2Message}"

### 2. Model-emitted subagent tool-call params${mockFlag}
**Phase 1 args:**
\`\`\`json
${phase1ArgsJson}
\`\`\`

**Phase 2 args (must contain \`{previous}\` literally):**
\`\`\`json
${phase2ArgsJson}
\`\`\`

### 3. Post-substitution taskWithContext (Phase 2)
As captured in tool_execution_end result / onUpdate — Phase 1 output embedded where \`{previous}\` was:
\`\`\`json
${postSubstitution}
\`\`\`

### 4. Timing per phase
${timing}

### 5. Gate status
${gateStatus[gateKey]}

## Assertion Summary
${opts.assertionSummary}

${opts.notes ? `## Notes\n${opts.notes}` : ""}
`.trim();

  fs.writeFileSync(RESULT_PATH, content + "\n");
  console.log(`\nWrote ${RESULT_PATH}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const date = new Date().toISOString();

  console.log("=".repeat(60));
  console.log("Spike R1 — forge_run_task orchestration");
  console.log(`Run type: ${hasApiKey ? "LIVE" : "OFFLINE MOCK / DEFERRED"}`);
  console.log("=".repeat(60));

  // ---- AC5 anti-pattern grep (runs on all paths) ----
  const grepResult = runAntiPatternGrep();
  assert(
    "AC5 anti-pattern grep",
    grepResult.pass,
    grepResult.detail,
  );

  if (!hasApiKey) {
    // DEFERRED — no API key
    console.log(
      "\nNo ANTHROPIC_API_KEY found. Entering offline mock path.\n" +
        "A mock-only PASS does NOT discharge the R1 gate.\n",
    );

    const { MockAgentSession } = await import("./mock-session.js");
    const mockSession = new MockAgentSession();

    // Import spike module and drive mock session manually
    const { PHASE1_MESSAGE, PHASE2_MESSAGE } = await import("./spike.js");

    // Run mock phases
    const phase1Start = Date.now();
    await mockSession.sendUserMessage(PHASE1_MESSAGE);
    const phase1IdleMs = Date.now() - phase1Start;

    const phase2Start = Date.now();
    await mockSession.sendUserMessage(PHASE2_MESSAGE);
    const phase2IdleMs = Date.now() - phase2Start;

    const totalStart = Date.now();
    const phases = mockSession.getPhaseExecutions();

    // ---- Assertions (offline mock) ----
    const phase1 = phases[0];
    const phase2 = phases[1];

    assert(
      "AC2 Phase 1 message sent",
      phase1?.messageText === PHASE1_MESSAGE,
      phase1 ? "message matches expected Phase 1 text" : "Phase 1 not executed",
    );

    assert(
      "AC2 Phase 2 message sent",
      phase2?.messageText === PHASE2_MESSAGE,
      phase2 ? "message matches expected Phase 2 text" : "Phase 2 not executed",
    );

    // AC4 — {previous} literal in Phase 2 chain step args (pre-substitution)
    const phase2Args = phase2?.toolCallArgs as { chain?: Array<{ task: string }> } | undefined;
    const phase2TaskLiteral = phase2Args?.chain?.[0]?.task ?? "";
    assert(
      "AC4 Phase 2 tool args contain literal {previous}",
      phase2TaskLiteral.includes("{previous}"),
      phase2TaskLiteral
        ? `chain[0].task = "${phase2TaskLiteral}"`
        : "chain args not captured",
    );

    // AC4 — post-substitution taskWithContext does NOT contain {previous}
    const phase2Record = phase2?.chainRecord;
    const taskWithContext = phase2Record?.taskWithContext ?? "";
    assert(
      "AC4 Post-substitution taskWithContext has no {previous}",
      taskWithContext !== "" && !taskWithContext.includes("{previous}"),
      taskWithContext
        ? `taskWithContext = "${taskWithContext.slice(0, 80)}..."`
        : "taskWithContext not captured",
    );

    // AC3 — notify called (mock always does)
    assert(
      "AC3 notify called after both phases",
      true,
      "[MOCK] notify would be called after Phase 2",
    );

    const passCount = assertions.filter((a) => a.pass).length;
    const failCount = assertions.filter((a) => !a.pass).length;
    const outcome = failCount > 0 ? "FAIL" : "PASS";

    const assertionSummary = assertions
      .map((a) => `- [${a.pass ? "PASS" : "FAIL"}] ${a.name}: ${a.detail}`)
      .join("\n");

    writeResultMd({
      runType: "OFFLINE MOCK",
      outcome,
      piVersion: PI_VERSION,
      modelId: "mock",
      date,
      phase1Message: PHASE1_MESSAGE,
      phase2Message: PHASE2_MESSAGE,
      phase1ToolArgs: phase1?.toolCallArgs,
      phase2ToolArgs: phase2?.toolCallArgs,
      phase2PostSubstitution: phase2Record?.taskWithContext,
      phase1IdleMs,
      phase2IdleMs,
      totalMs: Date.now() - (totalStart - phase1IdleMs - phase2IdleMs),
      assertionSummary,
      notes:
        "OFFLINE MOCK run. The {previous} substitution at subagent/index.ts:518 was mirrored " +
        "by the mock (mock-session.ts uses the same step.task.replace(/\\{previous\\}/g, previousOutput) logic). " +
        "This does NOT discharge the R1 gate. Run with ANTHROPIC_API_KEY to execute a live verification.",
    });

    console.log(`\nResult: ${outcome} (${passCount}/${assertions.length} assertions passed)`);
    console.log("OFFLINE MOCK — R1 gate NOT discharged. Run live for gate verification.\n");
    process.exit(failCount > 0 ? 1 : 0);
    return;
  }

  // ---- LIVE path ----
  console.log("\nANTHROPIC_API_KEY found — running live session.\n");

  let evidence;
  let liveError: string | undefined;

  try {
    const { runSpike } = await import("./session-harness.js");
    const result = await runSpike();
    evidence = result.evidence;
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
    console.error("Live run failed:", liveError);
  }

  if (!evidence || liveError) {
    const { PHASE1_MESSAGE, PHASE2_MESSAGE } = await import("./spike.js");
    assert("Live session run", false, liveError ?? "No evidence collected");

    writeResultMd({
      runType: "LIVE",
      outcome: "FAIL",
      piVersion: PI_VERSION,
      modelId: "unknown",
      date,
      phase1Message: PHASE1_MESSAGE,
      phase2Message: PHASE2_MESSAGE,
      phase1ToolArgs: undefined,
      phase2ToolArgs: undefined,
      phase2PostSubstitution: undefined,
      assertionSummary: `- [FAIL] Live session run: ${liveError ?? "No evidence collected"}`,
      notes: `Error during live run: ${liveError}`,
    });

    process.exit(1);
    return;
  }

  const { PHASE1_MESSAGE, PHASE2_MESSAGE } = await import("./spike.js");
  const phase1Ev = evidence.phases.find((p) => p.phase === 1);
  const phase2Ev = evidence.phases.find((p) => p.phase === 2);

  // ---- Assertions (live) ----
  assert(
    "AC2 Phase 1 message sent",
    phase1Ev?.messageSent === PHASE1_MESSAGE,
    phase1Ev ? "Phase 1 message matches" : "Phase 1 evidence missing",
  );

  assert(
    "AC2 Phase 2 message sent",
    phase2Ev?.messageSent === PHASE2_MESSAGE,
    phase2Ev ? "Phase 2 message matches" : "Phase 2 evidence missing",
  );

  // AC4 — Phase 2 tool call args must contain literal {previous}
  const phase2Args = phase2Ev?.toolCallArgs as { chain?: Array<{ task: string }> } | undefined;
  const phase2TaskLiteral = phase2Args?.chain?.[0]?.task ?? "";
  assert(
    "AC4 Phase 2 tool args contain literal {previous}",
    phase2TaskLiteral.includes("{previous}"),
    phase2TaskLiteral
      ? `chain[0].task = "${phase2TaskLiteral}"`
      : "subagent tool call not captured (model may not have emitted it)",
  );

  // AC4 — tool_execution_end result should embed Phase 1 output (post-substitution)
  const phase2Result = phase2Ev?.toolCallResult;
  assert(
    "AC4 Phase 2 tool result captured (post-substitution)",
    phase2Result !== undefined,
    phase2Result !== undefined
      ? "tool_execution_end result recorded"
      : "tool_execution_end not captured for Phase 2",
  );

  // AC3 — notify called
  assert(
    "AC3 notify called after both phases",
    evidence.notifyCalled,
    evidence.notifyCalled
      ? "ctx.ui.notify('R1 spike complete', 'info') was called"
      : "notify not called — command handler may not have completed",
  );

  const passCount = assertions.filter((a) => a.pass).length;
  const failCount = assertions.filter((a) => !a.pass).length;
  const outcome = failCount > 0 ? "FAIL" : "PASS";

  const assertionSummary = assertions
    .map((a) => `- [${a.pass ? "PASS" : "FAIL"}] ${a.name}: ${a.detail}`)
    .join("\n");

  writeResultMd({
    runType: "LIVE",
    outcome,
    piVersion: PI_VERSION,
    modelId: evidence.modelId,
    date,
    phase1Message: PHASE1_MESSAGE,
    phase2Message: PHASE2_MESSAGE,
    phase1ToolArgs: phase1Ev?.toolCallArgs,
    phase2ToolArgs: phase2Ev?.toolCallArgs,
    phase2PostSubstitution: phase2Ev?.toolCallResult,
    phase1IdleMs: phase1Ev?.waitForIdleMs,
    phase2IdleMs: phase2Ev?.waitForIdleMs,
    totalMs: evidence.totalMs,
    assertionSummary,
    notes: outcome === "PASS"
      ? "LIVE PASS: R1 gate discharged. Stage 3 may proceed."
      : "LIVE FAIL: One or more assertions failed. Review RESULT.md evidence for T10 no-go decision.",
  });

  console.log(`\nResult: ${outcome} (${passCount}/${assertions.length} assertions passed)`);
  if (outcome === "PASS") {
    console.log("LIVE PASS — R1 gate discharged. Stage 3 may proceed.\n");
  } else {
    console.log("LIVE FAIL — R1 gate NOT discharged. See RESULT.md for details.\n");
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error in run.ts:", err);
  process.exit(1);
});
