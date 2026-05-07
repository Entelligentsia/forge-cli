/**
 * Session harness for Spike R1 — LIVE path.
 *
 * Creates a real pi AgentSession via createAgentSession(), loads the vendored
 * subagent tool and the spike command via extension factories, subscribes to
 * evidence events, and invokes the spike command to run the 2-phase chain.
 *
 * Requirements met:
 * - PLAN_REVIEW iter2: dynamic import is awaited before spike runner activates.
 * - Closure setter (setSession) used instead of globalThis singleton.
 * - Evidence collected via tool_execution_start / tool_execution_end events.
 *
 * NOTE: This is spike-only code. Never carry harness patterns into production.
 */

import {
  createAgentSession,
  SessionManager,
  createExtensionRuntime,
  loadExtensionFromFactory,
  createEventBus,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import registerSubagentTool from "../../../src/extensions/forgecli/subagent/index.js";
import {
  registerPocRunTask,
  setSession,
  getEvidence,
  type SpikeEvidence,
} from "./spike.js";

// ---------------------------------------------------------------------------
// Live spike runner
// ---------------------------------------------------------------------------

export interface LiveRunResult {
  evidence: SpikeEvidence;
  elapsedMs: number;
  error?: string;
}

export async function runSpike(): Promise<LiveRunResult> {
  const start = Date.now();

  // -----------------------------------------------------------------------
  // 1. Create agent session with cheap model, in-memory session (no disk state)
  //    noTools:"builtin" + extension registration supplies the subagent tool
  // -----------------------------------------------------------------------
  const model = getModel("anthropic", "claude-3-5-haiku-20241022");

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "min",
    noTools: "builtin",         // disable built-in read/bash/edit/write
    sessionManager: SessionManager.inMemory(),
    cwd: process.cwd(),
  });

  // -----------------------------------------------------------------------
  // 2. Wire the session reference into the spike extension via closure setter
  //    PLAN_REVIEW iter2 caveat: closure setter preferred over globalThis.
  // -----------------------------------------------------------------------
  setSession(session);

  // -----------------------------------------------------------------------
  // 3. Load extensions via loadExtensionFromFactory — both must be awaited
  //    before the spike command is invoked (PLAN_REVIEW iter2 advisory).
  // -----------------------------------------------------------------------
  const eventBus = createEventBus();
  const runtime = createExtensionRuntime();

  // Register the vendored subagent tool
  await loadExtensionFromFactory(
    (pi: ExtensionAPI) => {
      registerSubagentTool(pi);
    },
    process.cwd(),
    eventBus,
    runtime,
    "subagent-extension",
  );

  // Register the spike command (registerPocRunTask also subscribes to
  // tool_execution_start/end via pi.on — must be called before any turns)
  await loadExtensionFromFactory(
    (pi: ExtensionAPI) => {
      registerPocRunTask(pi);
    },
    process.cwd(),
    eventBus,
    runtime,
    "spike-r1-extension",
  );

  // -----------------------------------------------------------------------
  // 4. Activate the spike command — session.prompt dispatches the command
  //    handler synchronously through the extension runner.
  //    The handler drives Phase 1 + Phase 2 internally before returning.
  // -----------------------------------------------------------------------
  await session.prompt("/forge-poc:r1 FIXTURE-T01");

  // Wait until the session is no longer streaming (should already be done
  // since the command handler awaits both phases before returning)
  while (session.isStreaming) {
    await new Promise<void>((r) => setTimeout(r, 100));
  }

  const evidence = getEvidence();
  evidence.totalMs = Date.now() - start;

  // Capture model id from session
  const sessionModel = session.model;
  if (sessionModel) {
    evidence.modelId = sessionModel.id;
  }

  return {
    evidence,
    elapsedMs: evidence.totalMs,
  };
}
