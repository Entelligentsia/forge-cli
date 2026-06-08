// run-task-types.ts — pipeline option/result interfaces shared between the
// pipeline file and the command handler. Extracted from run-task.ts (no logic
// changes). run-task.ts re-exports these.

import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import type { ForgeToolDefs } from "../../forge-tools.js";
import type { getSessionRegistry } from "../../session-registry.js";
import type { RunTaskState } from "./task-state.js";

// ── Pipeline extraction (FORGE-S21-T03) ──────────────────────────────────
//
// The per-task orchestrator pipeline extracted from registerRunTask so that
// run-sprint.ts can delegate per-task execution without duplicating phase-
// loop logic. registerRunTask becomes a thin wrapper: config discovery, resume
// detection, then delegate to runTaskPipeline.

export interface RunTaskPipelineOptions {
	taskId: string;
	cwd: string;
	ctx: ExtensionCommandContext;
	forgeRoot: string;
	storeCli: string;
	preflightGate: string;
	registry: ReturnType<typeof getSessionRegistry>;
	/** When provided, pipeline starts from this state instead of phase 0.
	 *  Used by run-sprint.ts for mid-task resume (REVIEW FIX #2, option b). */
	resumeFromState?: RunTaskState;
	/** Optional observer for phase events; called after emitEvent. */
	onPhaseEvent?: (event: Record<string, unknown>) => void;
	/**
	 * Test-only seam (forge-cli#17). When set, each phase's `runForgeSubagent`
	 * call receives `streamFn = streamFnFactory({...})`. Production callers
	 * leave this undefined. See helpers/scripted-subagent.ts and
	 * fixtures/sprint-fixture.ts.
	 */
	streamFnFactory?: (ctx: {
		kind: "task-phase";
		persona: string;
		phase: string;
		taskId: string;
	}) => import("@earendil-works/pi-agent-core").StreamFn | undefined;
	/**
	 * Optional AbortSignal from SessionRegistry. When provided, the pipeline
	 * checks signal.aborted between phases and passes the signal to
	 * runForgeSubagent so in-flight subagents can be aborted.
	 */
	signal?: AbortSignal;
	forgeToolDefs?: ForgeToolDefs;
	/**
	 * Extension factories forwarded to each subagent session via runForgeSubagent.
	 * Used by Mechanism E (FORGE-S30-T07) to inject the Forge-aware compaction
	 * handler when FORGE_CTX_GOVERNOR=1. No-op when undefined (default path unchanged).
	 */
	extensionFactories?: ExtensionFactory[];
}

export type RunTaskPipelineStatus = "completed" | "halted" | "escalated" | "failed" | "cancelled";

export interface RunTaskPipelineResult {
	status: RunTaskPipelineStatus;
	lastPhaseIndex: number;
	iterationCounts: Record<string, number>;
	lastError?: string;
	/** Model captured from last successful phase's subagent result (REVIEW FIX #1). */
	model?: string;
	/** Provider captured from last successful phase's subagent result (REVIEW FIX #1). */
	provider?: string;
	/**
	 * Project-local orchestrator JSONL path for this run
	 * (.forge/transcripts/<taskId>/<ISO>__<taskId>__orchestrator.jsonl).
	 * Callers (registerRunTask, run-sprint) hand it to archiveRun() to mirror
	 * the run into the central transcript archive. Unset only when the
	 * pipeline returned before the transcript writer was created (preflight).
	 */
	orchestratorTranscriptPath?: string;
}
