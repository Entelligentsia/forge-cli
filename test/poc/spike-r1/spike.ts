/**
 * Spike R1 — forge_run_task orchestration via registerCommand + waitForIdle.
 *
 * FORGE-S15-T04 — Validates option (c) from the architectural review:
 * a registerCommand handler that drives session.sendUserMessage(...) +
 * polling session.isStreaming between phases can reliably orchestrate a
 * 2-phase subagent chain, with {previous} placeholder substitution executed
 * by the vendored subagent code path (subagent/index.ts:518).
 *
 * NOTE: This is spike-only code. Never carry the session-injection pattern
 * (closure setter) into production.
 */

import type { ExtensionAPI, AgentSession } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Evidence record — populated by event listeners and polling
// ---------------------------------------------------------------------------

export interface PhaseEvidence {
  phase: 1 | 2;
  messageSent: string;
  toolCallArgs?: unknown;          // tool_execution_start.args (pre-substitution)
  toolCallResult?: unknown;        // tool_execution_end.result (post-substitution)
  waitForIdleMs?: number;
}

export interface SpikeEvidence {
  phases: PhaseEvidence[];
  totalMs: number;
  piVersion: string;
  modelId: string;
  notifyCalled: boolean;
}

// ---------------------------------------------------------------------------
// Session injection via closure setter (preferred over globalThis singleton)
// PLAN_REVIEW iter2 caveat: use closure setter over globalThis if feasible.
// ---------------------------------------------------------------------------

let _injectedSession: AgentSession | null = null;

/** Inject the AgentSession before activating the extension. */
export function setSession(session: AgentSession): void {
  _injectedSession = session;
}

/** Retrieve the injected session — throws if not yet set. */
function getSession(): AgentSession {
  if (!_injectedSession) {
    throw new Error(
      "Spike R1: AgentSession not injected. Call setSession(session) before activating the extension.",
    );
  }
  return _injectedSession;
}

// ---------------------------------------------------------------------------
// Evidence storage — written by event listeners attached in registerPocRunTask
// ---------------------------------------------------------------------------

const evidence: SpikeEvidence = {
  phases: [],
  totalMs: 0,
  piVersion: "unknown",
  modelId: "unknown",
  notifyCalled: false,
};

export function getEvidence(): SpikeEvidence {
  return evidence;
}

// ---------------------------------------------------------------------------
// Phase message texts (exported for assertions in run.ts)
// ---------------------------------------------------------------------------

export const PHASE1_MESSAGE =
  'Use the subagent tool in chain mode with a single step: ' +
  '{ agent: "engineer", task: "Plan fixture task FIXTURE-T01 — output a 3-bullet implementation plan.", agentScope: "project" }.';

export const PHASE2_MESSAGE =
  'Use the subagent tool in chain mode with a single step: ' +
  '{ agent: "supervisor", task: "Review the plan. {previous}", agentScope: "project" }. ' +
  'The {previous} placeholder will be substituted by the subagent with the engineer output.';

// ---------------------------------------------------------------------------
// registerPocRunTask — called from forgecli/index.ts when FORGE_SPIKE_R1=1
// ---------------------------------------------------------------------------

export function registerPocRunTask(pi: ExtensionAPI): void {
  let currentPhase: 1 | 2 = 1;

  // Subscribe to tool_execution_start/end before registering the command
  // Note: handler signature is (event, ctx: ExtensionContext) — ctx here is NOT
  // the command context (no .ui). Only event.args/event.result are used.
  const debug = process.env.FORGE_SPIKE_R1_DEBUG === "1";

  pi.on("tool_execution_start", (event) => {
    if (debug) console.error(`[spike-r1] tool_execution_start phase=${currentPhase} tool=${event.toolName}`);
    if (event.toolName === "subagent") {
      const ev = evidence.phases.find((p) => p.phase === currentPhase);
      if (ev) {
        ev.toolCallArgs = event.args;
      }
    }
  });

  pi.on("tool_execution_end", (event) => {
    if (debug) console.error(`[spike-r1] tool_execution_end phase=${currentPhase} tool=${event.toolName}`);
    if (event.toolName === "subagent") {
      const ev = evidence.phases.find((p) => p.phase === currentPhase);
      if (ev) {
        ev.toolCallResult = event.result;
      }
    }
  });

  pi.registerCommand("forge-poc:r1", {
    description: "R1 spike: 2-phase subagent chain via sendUserMessage + isStreaming poll",
    // RegisteredCommand.handler signature: (args: string, ctx: ExtensionCommandContext)
    async handler(_args, ctx) {
      const session = getSession();
      const totalStart = Date.now();

      // ------------------------------------------------------------------
      // Phase 1 — engineer planning
      // ------------------------------------------------------------------
      currentPhase = 1;
      const phase1Evidence: PhaseEvidence = {
        phase: 1,
        messageSent: PHASE1_MESSAGE,
      };
      evidence.phases.push(phase1Evidence);

      ctx.ui.setStatus("forge-poc:r1", "Phase 1/2: engineer planning...");
      if (debug) console.error("[spike-r1] phase 1: sendUserMessage start");
      await session.sendUserMessage(PHASE1_MESSAGE);
      if (debug) console.error(`[spike-r1] phase 1: sendUserMessage returned, isStreaming=${session.isStreaming}`);

      const phase1Start = Date.now();
      let phase1Polls = 0;
      // Poll isStreaming — headless equivalent of waitForIdle
      while (session.isStreaming) {
        if (debug && phase1Polls % 50 === 0) {
          console.error(`[spike-r1] phase 1: still streaming after ${Date.now() - phase1Start}ms`);
        }
        phase1Polls++;
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      phase1Evidence.waitForIdleMs = Date.now() - phase1Start;
      if (debug) console.error(`[spike-r1] phase 1: idle after ${phase1Evidence.waitForIdleMs}ms`);

      // ------------------------------------------------------------------
      // Phase 2 — supervisor review (literal {previous} — NOT pre-interpolated)
      // ------------------------------------------------------------------
      currentPhase = 2;
      const phase2Evidence: PhaseEvidence = {
        phase: 2,
        messageSent: PHASE2_MESSAGE,
      };
      evidence.phases.push(phase2Evidence);

      ctx.ui.setStatus("forge-poc:r1", "Phase 2/2: supervisor review...");
      if (debug) console.error("[spike-r1] phase 2: sendUserMessage start");
      await session.sendUserMessage(PHASE2_MESSAGE);
      if (debug) console.error(`[spike-r1] phase 2: sendUserMessage returned, isStreaming=${session.isStreaming}`);

      const phase2Start = Date.now();
      let phase2Polls = 0;
      while (session.isStreaming) {
        if (debug && phase2Polls % 50 === 0) {
          console.error(`[spike-r1] phase 2: still streaming after ${Date.now() - phase2Start}ms`);
        }
        phase2Polls++;
        await new Promise<void>((r) => setTimeout(r, 100));
      }
      phase2Evidence.waitForIdleMs = Date.now() - phase2Start;
      if (debug) console.error(`[spike-r1] phase 2: idle after ${phase2Evidence.waitForIdleMs}ms`);

      evidence.totalMs = Date.now() - totalStart;

      ctx.ui.setStatus("forge-poc:r1", undefined);
      ctx.ui.notify("R1 spike complete", "info");
      evidence.notifyCalled = true;
    },
  });
}
