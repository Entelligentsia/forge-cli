// orchestrator-transcript.ts — JSONL log of the orchestrator loop's own
// activity (fix-bug, run-task, run-sprint). Sibling to the per-subagent
// transcripts but captures what the orchestrator did between phases:
// phase boundaries, verdicts, loop-backs, halt/cancel reasons.
//
// Filename mirrors the subagent-transcript scheme:
//   .forge/transcripts/<entityId>/<ISO-compact>__<entityId>__orchestrator.jsonl
//
// JSONL (one JSON object per line) so we can append safely even if the
// process crashes mid-stream. The reader stitches lines back together.

import * as fs from "node:fs";
import * as path from "node:path";

import { formatTranscriptTimestamp } from "../forge-subagent.js";

export type OrchestratorEvent =
	| { kind: "pipeline-start"; ts: string; entityKind: "bug" | "task" | "sprint"; entityId: string; sessionId?: string }
	| {
			kind: "phase-start";
			ts: string;
			phase: string;
			phaseIndex: number;
			phaseCount: number;
			attempt: number;
			workflowFile: string;
			persona: string;
	  }
	| {
			kind: "phase-end";
			ts: string;
			phase: string;
			phaseIndex: number;
			attempt: number;
			verdict: "approved" | "revision" | "n/a" | "error" | "cancelled" | "halted";
			elapsedMs: number;
			turns?: number;
			toolCount?: number;
			errCount?: number;
			subagentTranscriptPath?: string;
	  }
	| {
			kind: "phase-loopback";
			ts: string;
			fromPhase: string;
			toPhase: string;
			fromPhaseIndex: number;
			toPhaseIndex: number;
			reason: string;
	  }
	| { kind: "pipeline-end"; ts: string; outcome: "complete" | "halted" | "cancelled" | "error"; elapsedMs: number; reason?: string }
	| { kind: "notify"; ts: string; level: "info" | "warn" | "error" | "success"; message: string };

export interface OpenOrchestratorTranscriptOpts {
	cwd: string;
	entityKind: "bug" | "task" | "sprint";
	entityId: string;
	startedAt?: Date;
	sessionId?: string;
}

export class OrchestratorTranscriptWriter {
	readonly filePath: string;
	readonly startedAt: Date;
	private closed = false;

	constructor(opts: OpenOrchestratorTranscriptOpts) {
		this.startedAt = opts.startedAt ?? new Date();
		const base = path.join(opts.cwd, ".forge", "transcripts");
		const sanitizedId = opts.entityId
			.replace(/[^a-zA-Z0-9._-]/g, "_")
			.replace(/\.{2,}/g, "_")
			.slice(0, 80);
		const dir = path.join(base, sanitizedId);
		const ts = formatTranscriptTimestamp(this.startedAt);
		const filename = `${ts}__${sanitizedId}__orchestrator.jsonl`;
		this.filePath = path.join(dir, filename);
		fs.mkdirSync(dir, { recursive: true });
		this.record({
			kind: "pipeline-start",
			ts: this.startedAt.toISOString(),
			entityKind: opts.entityKind,
			entityId: opts.entityId,
			sessionId: opts.sessionId,
		});
	}

	/**
	 * Append a single event to the JSONL log. Non-fatal on write failure —
	 * the orchestrator transcript is observability data, not load-bearing.
	 */
	record(event: OrchestratorEvent): void {
		if (this.closed) return;
		try {
			fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf-8");
		} catch (err: unknown) {
			const e = err as { message?: string };
			process.stderr.write(`[orchestrator-transcript] append failed (non-fatal): ${e.message ?? "unknown"}\n`);
		}
		// A directly-recorded pipeline-end terminates the log just like
		// close() — makes the safety-net close() in the pipeline wrappers
		// idempotent (no duplicate pipeline-end lines).
		if (event.kind === "pipeline-end") this.closed = true;
	}

	close(outcome: "complete" | "halted" | "cancelled" | "error", reason?: string): void {
		if (this.closed) return;
		this.record({
			kind: "pipeline-end",
			ts: new Date().toISOString(),
			outcome,
			elapsedMs: Date.now() - this.startedAt.getTime(),
			reason,
		});
		this.closed = true;
	}
}
