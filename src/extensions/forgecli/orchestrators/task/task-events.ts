// task-events.ts — orchestrator event composition + emission helpers.
// Extracted from run-task.ts (no logic changes). run-task.ts re-exports these.

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

import { type PhaseDescriptor, SUMMARY_KEY_BY_ROLE } from "./task-phases.js";
import type { TaskRecord } from "./task-record.js";

// Map phase.role → action token used in event.action / eventId.
export function actionForRole(role: string): string {
	return role.replace(/-/g, "_");
}

// Plan 11 / Slice 2: orchestrator composes the canonical phase event from
// runtime telemetry (model/provider/usage), known task ctx, bracketed wall
// times, and the judgement blob the subagent wrote to task.summaries[key].
// The subagent never calls store-cli emit itself.

export interface OrchestratorEmitContext {
	/** Entity identifier — required when entityType is "task". */
	taskId?: string;
	/** Entity identifier — required when entityType is "bug". */
	bugId?: string;
	/** Discriminator for entity-keyed event construction. */
	entityType: "task" | "bug";
	sprintId: string;
	phase: PhaseDescriptor;
	iteration: number;
	startMs: number;
	endMs: number;
	model: string;
	provider: string;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
	judgement: Record<string, unknown> | undefined;
	storeCli: string;
	cwd: string;
}

export function isoCompact(ms: number): string {
	return new Date(ms)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

export function buildPhaseEvent(ec: OrchestratorEmitContext): Record<string, unknown> {
	const action = actionForRole(ec.phase.role);
	const entityId = ec.entityType === "bug" ? ec.bugId! : ec.taskId!;
	const eventId = `${isoCompact(ec.startMs)}_${entityId}_${ec.phase.personaNoun}_${action}`;
	const durationMs = Math.max(0, ec.endMs - ec.startMs);
	const event: Record<string, unknown> = {
		eventId,
		sprintId: ec.sprintId,
		role: ec.phase.role,
		action: `/forge:${action.replace(/_/g, "-")}`,
		phase: ec.phase.role,
		iteration: ec.iteration,
		startTimestamp: new Date(ec.startMs).toISOString(),
		endTimestamp: new Date(ec.endMs).toISOString(),
		durationMinutes: Math.round((durationMs / 60000) * 100) / 100,
		model: ec.model,
		provider: ec.provider,
	};
	if (ec.entityType === "bug") {
		event.bugId = ec.bugId;
	} else {
		event.taskId = ec.taskId;
	}
	if (ec.usage.input > 0 || ec.usage.output > 0 || ec.usage.cacheRead > 0 || ec.usage.cacheWrite > 0) {
		event.inputTokens = ec.usage.input;
		event.outputTokens = ec.usage.output;
		event.cacheReadTokens = ec.usage.cacheRead;
		event.cacheWriteTokens = ec.usage.cacheWrite;
		event.tokenSource = "reported";
	}
	if (ec.judgement && typeof ec.judgement === "object") {
		const j = ec.judgement as Record<string, unknown>;
		if (typeof j.verdict === "string") event.verdict = j.verdict;
		if (typeof j.notes === "string") event.notes = j.notes;
	}
	return event;
}

export function emitEvent(
	storeCli: string,
	cwd: string,
	sprintId: string,
	event: Record<string, unknown>,
): { ok: boolean; stderr: string } {
	const result = spawnSync("node", [storeCli, "emit", sprintId, JSON.stringify(event)], {
		cwd,
		encoding: "utf8",
	});
	return { ok: result.status === 0, stderr: typeof result.stderr === "string" ? result.stderr : "" };
}

/**
 * Emit a phase event for an INCOMPLETE attempt (cancelled / failed) so its
 * provider-billed tokens reach the store. Bug B: the cancel and halt-on-failure
 * branches used to return without emitting, so collate's COST_REPORT
 * under-counted real spend by exactly the aborted passes (CART-S02-T03
 * baseline: 259,950 tokens across two aborted plan attempts, invisible).
 *
 * The event is the canonical phase event (schema-unchanged) with
 * `verdict: "aborted" | "failed"` marking the outcome.
 *
 * Zero-token attempts are skipped — there is no spend to account, and a
 * token-less event would be flagged as a husk by collate's ingestion-quality
 * pass. Never throws: emission must not perturb the cancel/halt return paths.
 *
 * @param opts.decorate  Optional event mutation hook applied before emit
 *                       (fix-bug uses it for the BUG_TYPE_TOKENS `type` field).
 * @returns true when the event was emitted and store-cli accepted it.
 */
export function emitIncompletePhaseEvent(opts: {
	emitCtx: OrchestratorEmitContext;
	outcome: "aborted" | "failed";
	notes?: string;
	decorate?: (event: Record<string, unknown>) => void;
	onDebug?: (rec: Record<string, unknown>) => void;
}): boolean {
	try {
		const { emitCtx, outcome } = opts;
		const u = emitCtx.usage;
		if (u.input + u.output + u.cacheRead + u.cacheWrite <= 0) {
			opts.onDebug?.({ kind: "incomplete_emit_skipped", reason: "no-tokens", outcome });
			return false;
		}
		const judgement: Record<string, unknown> = { verdict: outcome };
		if (opts.notes) judgement.notes = opts.notes;
		const event = buildPhaseEvent({ ...emitCtx, judgement });
		opts.decorate?.(event);
		const res = emitEvent(emitCtx.storeCli, emitCtx.cwd, emitCtx.sprintId, event);
		opts.onDebug?.(
			res.ok
				? { kind: "incomplete_emit_ok", eventId: event.eventId, outcome }
				: { kind: "incomplete_emit_failed", stderr: res.stderr, outcome },
		);
		return res.ok;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		opts.onDebug?.({ kind: "incomplete_emit_failed", stderr: msg, outcome: opts.outcome });
		return false;
	}
}

export function judgementFromSummary(
	record: TaskRecord | null,
	phaseRole: string,
	summaryKeyByRole?: Record<string, string | null>,
): Record<string, unknown> | undefined {
	if (!record || !record.summaries) return undefined;
	const keyMap = summaryKeyByRole ?? SUMMARY_KEY_BY_ROLE;
	const summaryKey = keyMap[phaseRole];
	if (!summaryKey) return undefined;
	const blob = (record.summaries as Record<string, unknown>)[summaryKey];
	return blob && typeof blob === "object" ? (blob as Record<string, unknown>) : undefined;
}

// Drain .forge/cache/FRICTION-{phase}.jsonl: stamp each judgement-only record
// with the subagent's runtime attribution and emit as event type "friction".
// Truncate only after all emits succeed (Plan-11 open-question A.3).
export function drainFrictionFile(
	frictionPath: string,
	ec: OrchestratorEmitContext,
): { emitted: number; failed: number } {
	if (!fs.existsSync(frictionPath)) return { emitted: 0, failed: 0 };
	const raw = fs.readFileSync(frictionPath, "utf8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return { emitted: 0, failed: 0 };

	let emitted = 0;
	let failed = 0;
	for (let i = 0; i < lines.length; i++) {
		let judgement: Record<string, unknown>;
		try {
			judgement = JSON.parse(lines[i]) as Record<string, unknown>;
		} catch {
			failed++;
			continue;
		}
		const action = actionForRole(ec.phase.role);
		const entityId = ec.entityType === "bug" ? ec.bugId! : ec.taskId!;
		const eventId = `${isoCompact(ec.startMs)}_${entityId}_${ec.phase.personaNoun}_friction_${i}`;
		const event: Record<string, unknown> = {
			eventId,
			sprintId: ec.sprintId,
			role: ec.phase.role,
			action: `/forge:${action.replace(/_/g, "-")}`,
			phase: ec.phase.role,
			iteration: ec.iteration,
			startTimestamp: new Date(ec.startMs).toISOString(),
			endTimestamp: new Date(ec.endMs).toISOString(),
			durationMinutes: Math.round(((ec.endMs - ec.startMs) / 60000) * 100) / 100,
			model: ec.model,
			provider: ec.provider,
			type: "friction",
			workflow: typeof judgement.workflow === "string" ? judgement.workflow : ec.phase.role,
			persona: typeof judgement.persona === "string" ? judgement.persona : ec.phase.personaNoun,
			issue: judgement.issue,
		};
		if (ec.entityType === "bug") {
			event.bugId = ec.bugId;
		} else {
			event.taskId = ec.taskId;
		}
		if (judgement.subkind !== undefined) event.subkind = judgement.subkind;
		if (judgement.evidence !== undefined) event.evidence = judgement.evidence;
		if (judgement.notes !== undefined) event.notes = judgement.notes;
		const r = emitEvent(ec.storeCli, ec.cwd, ec.sprintId, event);
		if (r.ok) emitted++;
		else failed++;
	}

	if (failed === 0) {
		try {
			fs.unlinkSync(frictionPath);
		} catch {
			/* non-fatal */
		}
	}
	return { emitted, failed };
}
