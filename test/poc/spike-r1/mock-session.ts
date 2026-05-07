/**
 * Offline MockAgentSession for Spike R1.
 *
 * Used when ANTHROPIC_API_KEY is absent (CI without live model access).
 *
 * DESIGN: This mock does NOT call a real model. Instead it:
 *   1. Intercepts sendUserMessage() calls.
 *   2. Parses the injected subagent chain params from the message text.
 *   3. Directly executes the {previous} substitution mirroring subagent/index.ts:518:
 *        taskWithContext = step.task.replace(/\{previous\}/g, previousOutput)
 *   4. Records pre- and post-substitution values as evidence.
 *
 * A mock-only PASS does NOT discharge the R1 gate. RESULT.md will record
 * "OFFLINE MOCK — does not discharge R1 gate".
 *
 * NOTE: This is spike-only code. Never carry mock-injection patterns into production.
 */

import type { SpikeEvidence, PhaseEvidence } from "./spike.js";

// ---------------------------------------------------------------------------
// Chain step extraction from phase message text
// ---------------------------------------------------------------------------

interface ChainStep {
  agent: string;
  task: string;
  agentScope?: string;
}

function extractChainStep(messageText: string): ChainStep | null {
  // Extract agent
  const agentMatch = messageText.match(/agent:\s*["']([^"']+)["']/);
  const taskMatch = messageText.match(/task:\s*["']([^"']+)["']/);
  const scopeMatch = messageText.match(/agentScope:\s*["']([^"']+)["']/);

  if (!agentMatch || !taskMatch) return null;
  return {
    agent: agentMatch[1],
    task: taskMatch[1],
    agentScope: scopeMatch?.[1],
  };
}

// ---------------------------------------------------------------------------
// Fake subagent execution — mirrors subagent/index.ts:512-559 chain loop
//
// The core assertion we need to verify offline:
//   step.task.replace(/\{previous\}/g, previousOutput)  ← mirrors :518
// We record both the pre-substitution literal and the post-substitution result.
// ---------------------------------------------------------------------------

export interface MockChainExecutionRecord {
  stepIndex: number;
  agent: string;
  taskLiteral: string;            // the literal task field (may contain {previous})
  taskWithContext: string;        // after replace(/\{previous\}/g, previousOutput)
  previousOutput: string;         // what was substituted in
  mockOutput: string;             // what this mock step "returned"
}

export interface MockExecutionResult {
  chainRecords: MockChainExecutionRecord[];
  finalOutput: string;
}

/** Mirrors the chain loop at subagent/index.ts:512-559 without spawning processes. */
function runMockChain(
  steps: ChainStep[],
  mockOutputs: string[],
): MockExecutionResult {
  const records: MockChainExecutionRecord[] = [];
  let previousOutput = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // This is the exact substitution from subagent/index.ts:518
    const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
    const mockOutput = mockOutputs[i] ?? `[mock output for step ${i + 1}: ${step.agent}]`;

    records.push({
      stepIndex: i,
      agent: step.agent,
      taskLiteral: step.task,
      taskWithContext,
      previousOutput,
      mockOutput,
    });

    previousOutput = mockOutput;
  }

  return { chainRecords: records, finalOutput: previousOutput };
}

// ---------------------------------------------------------------------------
// Mock phase execution state
// ---------------------------------------------------------------------------

interface MockPhaseExecution {
  phase: 1 | 2;
  messageText: string;
  chainStep: ChainStep | null;
  chainRecord?: MockChainExecutionRecord;
  toolCallArgs?: unknown;   // what would have been tool_execution_start.args
  toolCallResult?: unknown; // what would have been tool_execution_end.result
  waitForIdleMs: number;
}

// ---------------------------------------------------------------------------
// MockAgentSession — wraps evidence collection for offline path
// ---------------------------------------------------------------------------

export class MockAgentSession {
  private _isStreaming = false;
  private _previousOutput = "";
  private _phaseExecutions: MockPhaseExecution[] = [];

  /** Simulated mock model outputs per phase */
  private readonly _mockOutputs = [
    "[MOCK] Phase 1 engineer output: 1. Analyse requirements. 2. Design schema. 3. Implement and test.",
    "[MOCK] Phase 2 supervisor output: Plan reviewed. All 3 bullets are coherent. Approved.",
  ];

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  async sendUserMessage(messageText: string): Promise<void> {
    const phaseIndex = this._phaseExecutions.length;
    const phase = (phaseIndex + 1) as 1 | 2;

    this._isStreaming = true;

    // Extract chain step from message text
    const chainStep = extractChainStep(messageText);
    const mockExec: MockPhaseExecution = {
      phase,
      messageText,
      chainStep,
      waitForIdleMs: 0,
    };

    if (chainStep) {
      // Mirror the chain loop: single-step chain with previous output
      const chainSteps = [chainStep];
      const mockOutputsForThisPhase = [this._mockOutputs[phaseIndex] ?? `[MOCK] phase ${phase} output`];
      const result = runMockChain(chainSteps, mockOutputsForThisPhase);
      const record = result.chainRecords[0];

      mockExec.chainRecord = record;
      mockExec.toolCallArgs = {
        chain: [{ agent: chainStep.agent, task: chainStep.task, agentScope: chainStep.agentScope }],
      };
      mockExec.toolCallResult = {
        content: [{ type: "text", text: record.mockOutput }],
        details: {
          mode: "chain",
          agentScope: chainStep.agentScope ?? "project",
          results: [{ agent: chainStep.agent, task: record.taskWithContext, exitCode: 0 }],
        },
      };

      // Advance previousOutput for next phase
      this._previousOutput = record.mockOutput;
    }

    this._phaseExecutions.push(mockExec);

    // Simulate brief async work then finish
    await new Promise<void>((r) => setTimeout(r, 10));
    this._isStreaming = false;
  }

  /**
   * Populate a SpikeEvidence record and PhaseEvidence array from mock executions.
   * Called by run.ts after both phases complete.
   */
  populateEvidence(
    evidence: SpikeEvidence,
    phaseRecords: PhaseEvidence[],
    piVersion: string,
  ): void {
    evidence.piVersion = piVersion;
    evidence.modelId = "mock";
    evidence.notifyCalled = true; // mock always "calls" notify

    for (const exec of this._phaseExecutions) {
      const phaseEv: PhaseEvidence = {
        phase: exec.phase,
        messageSent: exec.messageText,
        toolCallArgs: exec.toolCallArgs,
        toolCallResult: exec.toolCallResult,
        waitForIdleMs: exec.waitForIdleMs,
      };
      phaseRecords.push(phaseEv);
    }

    evidence.phases = phaseRecords;
  }

  /** Return all mock phase executions for assertion in run.ts */
  getPhaseExecutions(): MockPhaseExecution[] {
    return this._phaseExecutions;
  }
}
