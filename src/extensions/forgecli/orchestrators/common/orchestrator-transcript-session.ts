// orchestrator-transcript-session.ts — shared transcript-writing concern for
// the orchestrator pipelines (run-task, fix-bug).
//
// Collapses three byte-identical duplications that previously lived in both
// run-task.ts and fix-bug.ts:
//   1. the ctx.ui.notify interception that records every notify line into the
//      orchestrator transcript,
//   2. the pipeline-wrapper dance (create writer → run inner → close with the
//      mapped outcome → surface the file path), and
//   3. the status→outcome mapping (transcriptOutcomeFor).
//
// Behavior contract preserved exactly:
//   - The writer is created INSIDE this helper, so callers must run their
//     config/preflight early-returns BEFORE calling withOrchestratorTranscript
//     (a failed preflight must not create a transcript file).
//   - On a clean run the inner loop records its own "complete" pipeline-end;
//     OrchestratorTranscriptWriter.record() marks the log closed, so the
//     trailing close() here is an idempotent no-op. On cancel/halt/fail the
//     inner returns without a pipeline-end and this close() is the guarantee
//     that the run is archived with its true outcome.
//   - ctx.ui.notify is restored in a finally, even if inner throws.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { OrchestratorResult, OrchestratorStatus } from "../../lib/orchestrator-types.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";
import { OrchestratorTranscriptWriter } from "../../subagent/orchestrator-transcript.js";

/** Map a pipeline status to the orchestrator-transcript outcome vocabulary.
 *  Shared by run-task and fix-bug (same status union). */
export function transcriptOutcomeFor(status: OrchestratorStatus): "complete" | "halted" | "cancelled" | "error" {
	switch (status) {
		case "completed":
			return "complete";
		case "cancelled":
			return "cancelled";
		case "halted":
		case "escalated":
			return "halted";
		case "failed":
			return "error";
	}
}

/** Handle passed to the inner pipeline loop — exposes the live transcript
 *  writer for structured phase-boundary records. */
export interface OrchestratorTranscriptSession {
	readonly writer: OrchestratorTranscriptWriter;
}

export interface WithOrchestratorTranscriptOpts {
	cwd: string;
	entityKind: "bug" | "task" | "sprint";
	entityId: string;
	ctx: ExtensionCommandContext;
}

/**
 * Create the orchestrator transcript writer, intercept ctx.ui.notify so every
 * notification is recorded, run `inner(session)`, then close the writer with
 * the result's mapped outcome and surface its path on the result. Restores the
 * original ctx.ui.notify in a finally.
 */
export async function withOrchestratorTranscript<
	T extends OrchestratorResult & { orchestratorTranscriptPath?: string },
>(opts: WithOrchestratorTranscriptOpts, inner: (session: OrchestratorTranscriptSession) => Promise<T>): Promise<T> {
	const { cwd, entityKind, entityId, ctx } = opts;
	const writer = new OrchestratorTranscriptWriter({ cwd, entityKind, entityId });
	const tree = getOrchestratorTree();
	const origNotify: typeof ctx.ui.notify = ctx.ui.notify.bind(ctx.ui);
	ctx.ui.notify = ((msg: string, level?: Parameters<typeof origNotify>[1]) => {
		origNotify(msg, level);
		const text = typeof msg === "string" ? msg : String(msg);
		writer.record({
			kind: "notify",
			ts: new Date().toISOString(),
			level: (level ?? "info") as "info" | "warn" | "error" | "success",
			message: text,
		});
		// Mirror the orchestrator's decision log onto its root node so the
		// dashboard surfaces it. Leaf phase nodes carry subagent tool-call
		// activity (via the viewport observer); this root node (entityId) carries
		// the orchestrator's own narrative — gates, verdicts, escalations, halts.
		tree.appendTail(entityId, text, level === "error" || level === "warning" ? { warning: true } : undefined);
	}) as typeof ctx.ui.notify;

	try {
		const result = await inner({ writer });
		writer.close(transcriptOutcomeFor(result.status), result.lastError);
		result.orchestratorTranscriptPath = writer.filePath;
		return result;
	} finally {
		ctx.ui.notify = origNotify;
	}
}
