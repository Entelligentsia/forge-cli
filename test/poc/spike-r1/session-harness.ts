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
  DefaultResourceLoader,
  getAgentDir,
} from "@entelligentsia/pi-coding-agent";
import { getModel } from "@entelligentsia/pi-ai";
import type { ExtensionAPI, ExtensionFactory } from "@entelligentsia/pi-coding-agent";

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
  // 1. Build a resourceLoader carrying the spike's extension factories.
  //    pi v0.73 does not re-export `loadExtensionFromFactory` from its main
  //    entrypoint, so the factories ride in via DefaultResourceLoader's
  //    `extensionFactories` option. createAgentSession awaits reload()
  //    before getExtensions(), so both factories run before any prompt.
  // -----------------------------------------------------------------------
  const cwd = process.cwd();
  const agentDir = getAgentDir();

  const factories: ExtensionFactory[] = [
    (pi: ExtensionAPI) => {
      registerSubagentTool(pi);
    },
    (pi: ExtensionAPI) => {
      registerPocRunTask(pi);
    },
  ];

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: factories,
    noExtensions: true,         // skip auto-discovery; only inline factories
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  // pi v0.73 quirk: createAgentSession only invokes reload() when it builds
  // its own DefaultResourceLoader. Custom-provided loaders are assumed to be
  // pre-reloaded by the caller. Without this, inline extensionFactories
  // never run and the spike command never gets registered.
  await resourceLoader.reload();

  // -----------------------------------------------------------------------
  // 2. Create agent session — resourceLoader.reload() runs the inline
  //    factories before the session is constructed.
  // -----------------------------------------------------------------------
  const model = getModel("anthropic", "claude-haiku-4-5");

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "min",
    tools: ["subagent"],        // explicit allowlist — only subagent active
    sessionManager: SessionManager.inMemory(),
    cwd,
    resourceLoader,
  });

  // -----------------------------------------------------------------------
  // 3. Wire the session reference into the spike extension via closure setter.
  //    Set AFTER createAgentSession returns: factories already ran (registering
  //    the command), but the command HANDLER reads the session at invoke time.
  //    PLAN_REVIEW iter2 caveat: closure setter preferred over globalThis.
  // -----------------------------------------------------------------------
  setSession(session);

  // -----------------------------------------------------------------------
  // 4. Diagnostic: inspect what extensions/commands actually loaded.
  //    Both factories should have produced one extension each, with the
  //    spike registering "forge-poc:r1" and the subagent registering its tool.
  // -----------------------------------------------------------------------
  if (process.env.FORGE_SPIKE_R1_DEBUG === "1") {
    const extResult = resourceLoader.getExtensions();
    console.error(
      `[spike-r1 diag] extensions loaded: ${extResult.extensions.length}, errors: ${extResult.errors.length}`,
    );
    for (const e of extResult.extensions) {
      console.error(
        `[spike-r1 diag] ext path=${e.path} commands=[${[...e.commands.keys()].join(",")}] tools=[${[...e.tools.keys()].join(",")}]`,
      );
    }
    for (const err of extResult.errors) {
      console.error(`[spike-r1 diag] ERROR path=${err.path}: ${err.error}`);
    }
  }

  // -----------------------------------------------------------------------
  // 5. Activate the spike command — session.prompt dispatches the command
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
