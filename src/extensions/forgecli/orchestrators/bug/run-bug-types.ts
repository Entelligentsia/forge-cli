// run-bug-types.ts — pipeline option/result/status types for the bug pipeline.
// Extracted VERBATIM from fix-bug.ts (FORGE-S31 file-size refactor); no logic
// changes.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { type ForgeToolDefs } from "../../forge-tools.js";
import { getSessionRegistry } from "../../session-registry.js";
import type { RunBugState } from "./bug-state.js";

// ── Bug pipeline result ──────────────────────────────────────────────────

export type RunBugPipelineStatus = "completed" | "halted" | "escalated" | "failed" | "cancelled";

export interface RunBugPipelineResult {
	status: RunBugPipelineStatus;
	lastPhaseIndex: number;
	iterationCounts: Record<string, number>;
	lastError?: string;
	model?: string;
	provider?: string;
	/**
	 * Project-local orchestrator JSONL path for this run. Callers hand it to
	 * archiveRun() to mirror the run into the central transcript archive.
	 * Unset only when the pipeline returned before the writer was created.
	 */
	orchestratorTranscriptPath?: string;
}

// ── Bug pipeline ──────────────────────────────────────────────────────────

export interface RunBugPipelineOptions {
	bugId: string;
	/** Original free-form text argument when creating a new bug (not a FORGE-BUG-NNN ID).
	 *  Passed to triage-phase subagent so it can create the bug with a meaningful description. */
	originalArg?: string;
	/** Whether this is a new bug (free-form text) vs. an existing FORGE-BUG-NNN ID. */
	isNewBug?: boolean;
	cwd: string;
	ctx: ExtensionCommandContext;
	forgeRoot: string;
	storeCli: string;
	preflightGate: string;
	registry: ReturnType<typeof getSessionRegistry>;
	resumeFromState?: RunBugState;
	/**
	 * Optional AbortSignal from SessionRegistry. When provided, the pipeline
	 * checks signal.aborted between phases and passes the signal to
	 * runForgeSubagent so in-flight subagents can be aborted.
	 */
	signal?: AbortSignal;
	forgeToolDefs?: ForgeToolDefs;
}
