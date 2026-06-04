// run-task.ts — /forge:run-task native Orchestrator handler (FORGE-S21-T02).
//
// Promotes /forge:run-task from stub to a full TS-driven Orchestrator-archetype
// native handler. Reads `.forge/workflows/orchestrate_task.md`, chains phases
// (plan → review-plan → implement → review-code → validate → approve →
// writeback → commit) by spawning a fresh runForgeSubagent per phase (IL10).
//
// Iron Laws enforced here:
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff calls here)
//
// sendKickoff is NEVER called from this file.
// Audit-grep: grep -n "sendKickoff(" run-task.ts must return empty.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
// ModelRegistry/AuthStorage no longer instantiated here — see fix-bug.ts note
// (FORGE-BUG-001). Use ctx.modelRegistry so session-registered providers are
// honored by validateModelConfig.
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { assertAudience, CallerContextStore } from "./audience-gate.js";
import type { PhaseRole } from "./subagent/caller-context.js";
import { loadLayeredConfig } from "./config-layer.js";
import { buildGovernorFactory } from "./context-governor.js";
import { buildForgeCompactionFactory } from "./context-governor-compaction.js";
import { loadForgePersona, runForgeSubagent } from "./forge-subagent.js";
import { type ForgeToolDefs, getSubagentTools } from "./forge-tools.js";
import { readPersonaDir, readPipelineNames } from "./lib/catalog-helpers.js";
import { discoverForgeConfigCached } from "./lib/forge-config.js";
import { resolveAdvisorModel, runHaltAdvisor } from "./lib/halt-advisor.js";
import { checkMaterialization } from "./lib/manifest-checker.js";
import { runOrchestratorPreflight } from "./lib/orchestrator-preflight.js";
import {
	isStateStale as isJsonStateStale,
	readJsonState,
	taskStateFilePath,
	writeJsonState,
} from "./lib/state-helpers.js";
import { resolveModelForPhase } from "./model-resolver.js";
import { type AudienceValue, loadWorkflow } from "./parsers/workflow-loader.js";
import { getSessionRegistry } from "./session-registry.js";
import { getOrchestratorTree } from "./orchestrator-tree.js";
import { OrchestratorTranscriptWriter } from "./subagent/orchestrator-transcript.js";
import { resolveToCanonicalId, resolveToolDir } from "./store-resolver.js";
import { attachViewportObserver } from "./viewport-events.js";
import { fmtPhaseSummary, type UsageDelta } from "./viewport-renderer.js";

// ── Non-interactive helpers ───────────────────────────────────────────────

export function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

// ── Phase descriptor table ─────────────────────────────────────────────────
//
// Decoded from .forge/workflows/orchestrate_task.md default pipeline.
// `isReview` phases have verdict-loop logic; non-review phases always advance.

export interface PhaseDescriptor {
	/** Workflow role name (also used as key for summaries and iteration tracking). */
	role: string;
	/** Filename under .forge/workflows/ (without extension). */
	workflowFile: string;
	/** Persona noun passed to loadForgePersona. */
	personaNoun: string;
	/** When true: read summaries.<role>.verdict after dispatch. */
	isReview: boolean;
	/** Max revision iterations before escalation. */
	maxIterations: number;
}

export const PHASES: PhaseDescriptor[] = [
	{ role: "plan", workflowFile: "plan_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-plan", workflowFile: "review_plan", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "implement", workflowFile: "implement_plan", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-code", workflowFile: "review_code", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "validate", workflowFile: "validate_task", personaNoun: "qa-engineer", isReview: true, maxIterations: 3 },
	{ role: "approve", workflowFile: "architect_approve", personaNoun: "architect", isReview: true, maxIterations: 3 },
	{ role: "writeback", workflowFile: "collator_agent", personaNoun: "collator", isReview: false, maxIterations: 1 },
	{ role: "commit", workflowFile: "commit_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
];

// Map phase.role → canonical summary key written by base-pack workflows
// (see forge/forge/tools/store-cli.cjs VALID_SUMMARY_PHASES). Phases whose
// workflows do not write a summaries entry (e.g. approve, which transitions
// task.status=approved instead) map to null and are verdict-checked via
// task status rather than the summaries map.
export const SUMMARY_KEY_BY_ROLE: Record<string, string | null> = {
	plan: "plan",
	"review-plan": "review_plan",
	implement: "implementation",
	"review-code": "code_review",
	validate: "validation",
	approve: null,
};

// ── State persistence ─────────────────────────────────────────────────────

export interface RunTaskState {
	taskId: string;
	phaseIndex: number;
	iterationCounts: Record<string, number>;
	halted: boolean;
	/** Set on cancellation so the resume prompt can say "cancelled" vs "halted". */
	status?: "cancelled" | "halted" | "running";
	lastError?: string;
	savedAt: string;
}

/** Validate that an ID contains no path-traversal characters. */
export function validateId(id: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(id) && !id.includes("..");
}

// FORGE-S25-T16 (N-H-B): state helpers delegate to lib/state-helpers.ts.
// Public API (readState, writeState, deleteState, isStateStale) is preserved —
// run-sprint.ts imports readState as readTaskState from this file.

function stateFilePath(cwd: string, taskId: string): string {
	if (!validateId(taskId)) {
		throw new Error(`Invalid taskId for state file path: ${taskId}`);
	}
	return taskStateFilePath(cwd, taskId);
}

export function readState(cwd: string, taskId: string): RunTaskState | null {
	return readJsonState<RunTaskState>(stateFilePath(cwd, taskId));
}

export function writeState(cwd: string, state: RunTaskState): void {
	writeJsonState(stateFilePath(cwd, state.taskId), state);
}

export function deleteState(cwd: string, taskId: string): void {
	const fp = stateFilePath(cwd, taskId);
	try {
		if (fs.existsSync(fp)) fs.unlinkSync(fp);
	} catch {
		// non-fatal
	}
}

export function isStateStale(state: RunTaskState): boolean {
	return isJsonStateStale(state.savedAt);
}

/**
 * Format an ISO timestamp for human display in the user's local timezone.
 * Falls back to the raw ISO string if parsing fails.
 */
export function formatLocalTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const date = d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	// Append short timezone abbreviation for unambiguous reading.
	const tz =
		new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
			.formatToParts(d)
			.find((p) => p.type === "timeZoneName")?.value ?? "";
	return tz ? `${date} ${tz}` : date;
}

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
}

// ── Verdict read from store-cli ────────────────────────────────────────────

type Verdict = "approved" | "revision" | "n/a" | "missing";

export function readVerdict(taskId: string, phaseRole: string, storeCli: string, cwd: string): Verdict {
	const result = spawnSync("node", [storeCli, "read", "task", taskId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return "missing";
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		const record = JSON.parse(raw) as {
			status?: string;
			summaries?: Record<string, { verdict?: string }>;
		};

		// Phases like `approve` do not write a summaries entry; they
		// transition task.status to "approved" instead. For those, the
		// verdict source is task.status.
		const summaryKey = SUMMARY_KEY_BY_ROLE[phaseRole];
		if (summaryKey === null) {
			return record.status === "approved" ? "approved" : "missing";
		}

		// Verdict lookup with three fallbacks:
		//   1. Canonical mapped summary key (e.g. "code_review" for review-code).
		//   2. Underscore-swapped phase role ("review_code") — legacy/defensive.
		//   3. Raw hyphenated phase role ("review-code") — defensive only.
		const summaries = record.summaries ?? {};
		const underscoreKey = phaseRole.replace(/-/g, "_");
		const candidates = [summaryKey ?? "", underscoreKey, phaseRole].filter(Boolean);
		let verdict: string | undefined;
		for (const k of candidates) {
			if (summaries[k]?.verdict) {
				verdict = summaries[k].verdict;
				break;
			}
		}
		if (!verdict) return "missing";
		if (verdict === "approved") return "approved";
		if (verdict === "revision") return "revision";
		return "missing";
	} catch {
		return "missing";
	}
}

// ── Task record + summary helpers (Plan 11 / Slice 2) ────────────────────

export interface TaskRecord {
	sprintId?: string;
	status?: string;
	summaries?: Record<string, unknown>;
}

export function readTaskRecord(taskId: string, storeCli: string, cwd: string): TaskRecord | null {
	const result = spawnSync("node", [storeCli, "read", "task", taskId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return null;
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		return JSON.parse(raw) as TaskRecord;
	} catch {
		return null;
	}
}

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

// ── Find predecessor non-review phase for revision loop ───────────────────

export function findPredecessorIndex(phases: PhaseDescriptor[], reviewIndex: number): number {
	for (let i = reviewIndex - 1; i >= 0; i--) {
		if (!phases[i].isReview) return i;
	}
	return 0;
}

// ── Task body composition ─────────────────────────────────────────────────

interface PhaseSummary {
	objective?: string;
	key_changes?: string[];
	findings?: string[];
	verdict?: string;
	artifact_ref?: string;
}

// Phase ordering for summary injection — earlier phases first.
const PHASE_ORDER: readonly string[] = ["plan", "review_plan", "implementation", "code_review", "validation"];

export function buildSummariesBlock(
	summaries: Record<string, unknown> | undefined,
): string {
	if (!summaries) return "";
	const lines: string[] = [];
	for (const key of PHASE_ORDER) {
		const raw = summaries[key];
		if (!raw || typeof raw !== "object") continue;
		const s = raw as PhaseSummary;
		const parts: string[] = [`### ${key}`];
		if (s.objective) parts.push(`Objective: ${s.objective}`);
		if (s.verdict) parts.push(`Verdict: ${s.verdict}`);
		if (s.key_changes?.length) parts.push(`Key changes: ${s.key_changes.join("; ")}`);
		if (s.findings?.length) parts.push(`Findings: ${s.findings.join("; ")}`);
		if (s.artifact_ref) parts.push(`Full artifact: ${s.artifact_ref}`);
		lines.push(parts.join("\n"));
	}
	if (lines.length === 0) return "";
	return ["## Prior phase summaries (carry-forward)", "", ...lines].join("\n");
}

export function composeTaskBody(
	subWorkflowMd: string,
	taskId: string,
	summariesBlock?: string,
): string {
	const parts = [`Read the workflow below and follow it. Task ID: ${taskId}.`, "", "---", ""];
	if (summariesBlock) {
		parts.push(summariesBlock, "", "---", "");
	}
	parts.push(subWorkflowMd.trim());
	return parts.join("\n");
}

// ── Preflight gate ────────────────────────────────────────────────────────

export type PreflightResult = "proceed" | "halt" | "escalate";

/** Structured gate failure shape emitted by preflight-gate.cjs on stdout (exit 1). */
export interface GateFailureData {
	phase: string;
	reasonCode: string;
	detail: string;
	remediation: string;
}

/** Extended result carrying the structured failure alongside the status enum. */
export interface PreflightOutcome {
	result: PreflightResult;
	/** Parsed structured failure from stdout, or null on pass / escalate. */
	gateFailure: GateFailureData | null;
}

export function runPreflightGate(
	preflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
	entityType?: "task" | "bug",
): PreflightResult {
	const outcome = runPreflightGateWithData(preflightGate, role, taskId, cwd, entityType);
	return outcome.result;
}

/**
 * Run postflight-gate.cjs after a phase subagent returns, before FSM advance.
 * Mirrors runPreflightGateWithData — same argv-array discipline, same structured-JSON
 * parsing from stdout on exit 1.
 *
 * Returns:
 *   "ok"          — gate passed (or no outputs block for this phase); advance may proceed.
 *   "unsatisfied" — gate failed; do NOT advance FSM; halt and call runHaltAdvisor.
 *   "error"       — gate binary missing or parse error; treat as pass-through (additive).
 */
export function runPostflightGate(
	postflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
): { result: "ok" | "unsatisfied" | "error"; gateFailure: GateFailureData | null } {
	if (!fs.existsSync(postflightGate)) {
		// postflight-gate.cjs not present in this forgeRoot — pass through (additive).
		return { result: "ok", gateFailure: null };
	}
	const spawnResult = spawnSync("node", [postflightGate, "--phase", role, "--task", taskId], { cwd, encoding: "utf8" });
	if (spawnResult.status === 0) return { result: "ok", gateFailure: null };
	if (spawnResult.status === 2) return { result: "error", gateFailure: null };
	// Exit 1: parse structured JSON from stdout
	let gateFailure: GateFailureData | null = null;
	try {
		const stdout = typeof spawnResult.stdout === "string" ? spawnResult.stdout.trim() : "";
		if (stdout) {
			const parsed = JSON.parse(stdout) as GateFailureData;
			if (parsed && typeof parsed.reasonCode === "string") {
				gateFailure = parsed;
			}
		}
	} catch {
		// stdout not valid JSON — gate failure but no structured data
	}
	return { result: "unsatisfied", gateFailure };
}

/**
 * Upgraded variant that returns structured failure data alongside the status enum.
 * Callers that need the advisory data should use this function directly.
 */
export function runPreflightGateWithData(
	preflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
	entityType?: "task" | "bug",
): PreflightOutcome {
	const entityFlag = entityType === "bug" ? "--bug" : "--task";
	const spawnResult = spawnSync("node", [preflightGate, "--phase", role, entityFlag, taskId], { cwd, encoding: "utf8" });
	if (spawnResult.status === 0) return { result: "proceed", gateFailure: null };
	if (spawnResult.status === 2) return { result: "escalate", gateFailure: null };
	// Exit 1: parse structured JSON from stdout
	let gateFailure: GateFailureData | null = null;
	try {
		const stdout = typeof spawnResult.stdout === "string" ? spawnResult.stdout.trim() : "";
		if (stdout) {
			const parsed = JSON.parse(stdout) as GateFailureData;
			if (parsed && typeof parsed.reasonCode === "string") {
				gateFailure = parsed;
			}
		}
	} catch {
		// stdout not valid JSON — gate failure but no structured data
	}
	return { result: "halt", gateFailure };
}

// ── Per-task orchestrator pipeline (FORGE-S21-T03 extracted) ──────────────
// The entire phase loop was inline in registerRunTask. It is now a standalone
// exported function so that run-sprint.ts can delegate per-task execution
// without duplicating phase-loop logic. registerRunTask becomes a thin
// wrapper: config discovery, resume detection, then delegate to runTaskPipeline.

const STATUS_KEY = "forge:run-task";
const MESSAGE_KEY = "forge:run-task:message";

// extractTurnPreview moved to viewport-renderer.ts; re-exported below for
// backwards-compatibility with existing imports (e.g. tests).
export { extractTurnPreview } from "./viewport-renderer.js";

// ── runTaskPipeline ──────────────────────────────────────────────────────

export async function runTaskPipeline(opts: RunTaskPipelineOptions): Promise<RunTaskPipelineResult> {
	const { taskId, cwd, ctx, forgeRoot, storeCli, preflightGate, registry, resumeFromState, onPhaseEvent } = opts;

	// Bridge: OrchestratorTree for the dashboard overlay.
	const tree = getOrchestratorTree();

	// Load per-phase model routing config once at task entry (Plan 16 Slice 2).
	// Empty / absent config produces inherit for every phase — no behaviour change.
	// N-B-E: surface schema errors to caller (Decision 9 — orchestrators fail-fast).
	// See doc/decisions/layered-config-error-policy.md.
	const { merged: modelRoutingConfig, errors: layeredConfigErrors } = loadLayeredConfig(cwd);
	if (layeredConfigErrors.length > 0) {
		for (const e of layeredConfigErrors) {
			ctx.ui.notify(`× forge:run-task — forge-cli config schema error: ${e}`, "error");
		}
		return {
			status: "failed",
			lastPhaseIndex: 0,
			iterationCounts: {},
			lastError: `forge-cli config schema errors: ${layeredConfigErrors.join("; ")}`,
		};
	}

	// Pre-flight model config validation (Plan 16 Slice 3).
	// Warns on unknown persona names / unavailable models; errors on unresolvable
	// overrides / unknown pipelines. With FORGE_STRICT_MODELS=1, warnings → errors.
	// FORGE-S25-T17: delegated to lib/orchestrator-preflight.ts (H-13).
	{
		const personasDir = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"forge-payload",
			".base-pack",
			"personas",
		);
		const personaCatalogue = readPersonaDir(personasDir);
		const forgeCfgPath = path.join(cwd, ".forge", "config.json");
		const pipelineCatalogue = readPipelineNames(forgeCfgPath);
		const availableModels = ctx.modelRegistry?.getAvailable?.() ?? [];

		const preflightResult = runOrchestratorPreflight({
			mode: "task",
			ctx,
			notifyPrefix: "forge:run-task",
			personaCatalogue,
			pipelineCatalogue,
			modelRoutingConfig,
			availableModels: availableModels.map((m) => ({ provider: m.provider, id: m.id })),
		});
		if (!preflightResult.proceed) {
			return preflightResult.result as RunTaskPipelineResult;
		}
	}

	// Determine starting phase from resumeFromState (if provided) or phase 0.
	let currentPhaseIndex = resumeFromState?.phaseIndex ?? 0;
	const iterationCounts: Record<string, number> = resumeFromState?.iterationCounts ?? {};

	// Track model/provider from last successful subagent result (REVIEW FIX #1).
	let lastModel: string | undefined;
	let lastProvider: string | undefined;

	// Resolve the task's sprintId once for prompt-cache session affinity. All
	// phases in this task share the cache key `forge:${sprintId}` so the
	// system-prompt + project orientation prefix (which is identical across
	// personas) stays warm on Anthropic and shares a stable prompt_cache_key
	// on OpenAI. Falls back to a task-scoped key if the task is unattached.
	const taskRecordAtStart = readTaskRecord(taskId, storeCli, cwd);
	const cacheSessionId = taskRecordAtStart?.sprintId ? `forge:${taskRecordAtStart.sprintId}` : `forge:task:${taskId}`;

	// ── Orchestrator transcript ──────────────────────────────────────────
	// FORGE-BUG-040 follow-up: one JSONL file per pipeline run, ISO-prefixed
	// in its filename so review-loop iterations preserve their own logs
	// instead of overwriting. Captures every ctx.ui.notify line plus
	// structured phase-boundary events.
	const orchTranscript = new OrchestratorTranscriptWriter({
		cwd,
		entityKind: "task",
		entityId: taskId,
	});
	const __origNotify: typeof ctx.ui.notify = ctx.ui.notify.bind(ctx.ui);
	ctx.ui.notify = ((msg: string, level?: Parameters<typeof __origNotify>[1]) => {
		__origNotify(msg, level);
		orchTranscript.record({
			kind: "notify",
			ts: new Date().toISOString(),
			level: (level ?? "info") as "info" | "warn" | "error" | "success",
			message: typeof msg === "string" ? msg : String(msg),
		});
	}) as typeof ctx.ui.notify;
	const pipelineStartMs = Date.now();

	try {
	while (currentPhaseIndex < PHASES.length) {
		// ── Between-phase cancellation gate ────────────────────────────
		if (opts.signal?.aborted) {
			ctx.ui.notify(`⊘ forge:run-task — ${taskId} cancelled by user.`, "info");
			registry.completePhase(taskId, PHASES[currentPhaseIndex]?.role ?? "unknown", "cancelled");
			registry.confirmCancelled(taskId);
			// ADR-S21-01: preserve state file so cancelled runs are resumable
			// from the beginning of the cancelled phase (not deleted).
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: false,
				status: "cancelled",
				lastError: undefined,
				savedAt: new Date().toISOString(),
			});
			return { status: "cancelled", lastPhaseIndex: currentPhaseIndex, iterationCounts };
		}

		const phase = PHASES[currentPhaseIndex];
		if (!phase) {
			ctx.ui.notify(`× forge:run-task — invalid phase index ${currentPhaseIndex}`, "error");
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `invalid phase index ${currentPhaseIndex}`,
			};
		}

		ctx.ui.setStatus?.(
			STATUS_KEY,
			`run-task ${taskId}: phase ${currentPhaseIndex + 1}/${PHASES.length} (${phase.role})`,
		);
		ctx.ui.notify(`→ ${taskId}: ${phase.role} (phase ${currentPhaseIndex + 1}/${PHASES.length})`, "info");
		orchTranscript.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: phase.role,
			phaseIndex: currentPhaseIndex,
			phaseCount: PHASES.length,
			attempt: (iterationCounts[phase.role] ?? 0) + 1,
			workflowFile: phase.workflowFile,
			persona: phase.personaNoun,
		});

		const subWorkflowPath = path.join(cwd, ".forge", "workflows", `${phase.workflowFile}.md`);

		// ── Read sub-workflow ─────────────────────────────────────────
		let subWorkflowMd: string;
		let subWorkflowAudience: AudienceValue = "any";
		try {
			const loaded = loadWorkflow(subWorkflowPath);
			subWorkflowMd = loaded.rawMarkdown;
			subWorkflowAudience = loaded.audience;
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× forge:run-task — failed to read sub-workflow for ${phase.role}: ${e.message ?? "unknown"}`,
				"error",
			);
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `sub-workflow read failed: ${e.message ?? "unknown"}`,
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `sub-workflow read failed: ${e.message ?? "unknown"}`,
			};
		}

		// ── 6a. Preflight gate ────────────────────────────────────────
		if (fs.existsSync(preflightGate)) {
			const preflightOutcome = runPreflightGateWithData(preflightGate, phase.role, taskId, cwd);
			if (preflightOutcome.result === "halt") {
				// Render structured failure reason if available.
				if (preflightOutcome.gateFailure) {
					ctx.ui.notify(
						`× forge:run-task — preflight gate failed for phase ${phase.role} ` +
						`[${preflightOutcome.gateFailure.reasonCode}]: ${preflightOutcome.gateFailure.detail}`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:run-task — preflight gate failed for phase ${phase.role} (exit 1); halting.`,
						"error",
					);
				}
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 1 for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				// Spawn halt-recovery advisor (Tier 1, best-effort — non-fatal).
				if (preflightOutcome.gateFailure) {
					const advisorModel = resolveAdvisorModel(
						modelRoutingConfig,
						ctx.model as any,
					);
					void runHaltAdvisor({
						gateFailure: preflightOutcome.gateFailure,
						advisorModel,
						taskId,
						cwd,
						ctx: { ui: ctx.ui as any },
						forgeRoot,
					});
				}
				return {
					status: "halted",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `preflight gate exit 1 for ${phase.role}`,
				};
			}
			if (preflightOutcome.result === "escalate") {
				ctx.ui.notify(
					`× forge:run-task — preflight gate escalated for phase ${phase.role} (exit 2); manual intervention required.`,
					"error",
				);
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 2 (escalate) for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				return {
					status: "escalated",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `preflight gate exit 2 (escalate) for ${phase.role}`,
				};
			}
		}

		// ── 6. Materialization-marker check ───────────────────────────
		const markerCheck = checkMaterialization(subWorkflowPath, subWorkflowMd);
		if (!markerCheck.ok) {
			for (const marker of markerCheck.missing) {
				ctx.ui.notify(`× workflow regression: ${marker} not found in ${subWorkflowPath}`, "error");
			}
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `materialization markers missing: ${markerCheck.missing.join(", ")}`,
			};
		}

		// ── 5. Audience check ─────────────────────────────────────────
		// Wrap with CallerContextStore.asSubagent so assertAudience treats
		// this as a subagent context (IL10: we ARE dispatching from subagent chain).
		const audienceOk = CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
			assertAudience({ workflowName: phase.workflowFile, audience: subWorkflowAudience }, ctx),
		);
		if (!audienceOk) {
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `audience check failed for ${phase.workflowFile}`,
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `audience check failed for ${phase.workflowFile}`,
			};
		}

		// ── Persona load ──────────────────────────────────────────────
		let persona;
		try {
			persona = loadForgePersona(phase.personaNoun, cwd);
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× forge:run-task — persona '${phase.personaNoun}' not found for phase ${phase.role}: ${e.message ?? "unknown"}. ` +
					"Run /forge:regenerate to materialize persona files.",
				"error",
			);
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `persona load failed: ${e.message ?? "unknown"}`,
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `persona load failed: ${e.message ?? "unknown"}`,
			};
		}

		// ── 4. Dispatch via runForgeSubagent (IL10) ───────────────────
		// NEVER sendKickoff here — that would reproduce issue #30 (same-context inline = no fork).
		// Read fresh task record to carry forward prior phase summaries (forge-cli#19).
		const taskRecordForSummaries = currentPhaseIndex > 0 ? readTaskRecord(taskId, storeCli, cwd) : null;
		const summariesBlock = buildSummariesBlock(taskRecordForSummaries?.summaries);
		const taskBody = composeTaskBody(subWorkflowMd, taskId, summariesBlock || undefined);

		// Log whether carry-forward summaries were injected (forge-cli#19).
		if (summariesBlock) {
			const debugCarryPath = path.join(cwd, ".forge", "cache", `run-task-debug-${taskId}.jsonl`);
			try {
				fs.mkdirSync(path.dirname(debugCarryPath), { recursive: true });
				fs.appendFileSync(
					debugCarryPath,
					`${JSON.stringify({ ts: new Date().toISOString(), phase: phase.role, kind: "carry_forward_injected", summariesLength: summariesBlock.length, summariesBlock })}\n`,
					"utf8",
				);
			} catch { /* best-effort debug log */ }
		}

		// Resolve per-phase model from layered config (Plan 16 Slice 2).
		// Pipeline name "default" matches the Forge plugin's shipped pipeline.
		// When config is absent or cascade bottoms out, resolves to inherit
		// (model: undefined) — setModel is skipped and pi's current model is used.
		const modelResolution = resolveModelForPhase("default", phase.role, phase.personaNoun, modelRoutingConfig);

		const phaseStart = Date.now();

		// Stabilization debug log — every subagent event appended as JSONL.
		const debugLogPath = path.join(cwd, ".forge", "cache", `run-task-debug-${taskId}.jsonl`);
		const writeDebug = (rec: Record<string, unknown>) => {
			try {
				fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
				fs.appendFileSync(
					debugLogPath,
					`${JSON.stringify({ ts: new Date().toISOString(), phase: phase.role, ...rec })}\n`,
					"utf8",
				);
			} catch {
				// non-fatal; debug log is best-effort
			}
		};
		writeDebug({ kind: "phase_start", phaseIndex: currentPhaseIndex });
		writeDebug({
			kind: "requested_model",
			requested: modelResolution.model ?? null,
			source: modelResolution.source,
			persona: phase.personaNoun,
		});
		registry.startPhase(taskId, phase.role, currentPhaseIndex);

		// Bridge: register phase in OrchestratorTree.
		const iteration = (opts.resumeFromState?.iterationCounts?.[phase.role] ?? 0) + 1;
		const phaseNodeId = `${taskId}:${phase.role}:${iteration}`;
		tree.startNode(phaseNodeId, {
			parentId: taskId,
			label: `${phase.role}:${iteration}`,
			kind: "leaf",
			promptPreview: taskBody.slice(0, 200),
		});

		// Capture the first stream-observed model on turn_end (IL10 visibility).
		// If pi auto-substitutes or setModel silently no-ops, this line will diverge
		// from requested_model — exactly the diagnostic signal we want.
		let modelObservedLogged = false;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const wrappedOnEvent = (event: any) => {
			if (!modelObservedLogged && event?.type === "turn_end" && typeof event?.message?.model === "string") {
				modelObservedLogged = true;
				writeDebug({
					kind: "model_observed",
					provider: event.message.provider ?? null,
					model: event.message.model,
				});
			}
			observer.onEvent(event);
		};

		const refreshStatus = () => {
			if (process.env.FORGE_VERBOSE !== "1") return;
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			const tail = observer.state.lastTool ? ` · ${observer.state.lastTool}` : "";
			ctx.ui.setStatus?.(
				STATUS_KEY,
				`run-task ${taskId}: ${phase.role} · t${observer.state.turn} · tools ${observer.state.toolCount}${observer.state.errCount ? ` · err ${observer.state.errCount}` : ""} · ${elapsed}s${tail}`,
			);
		};

		const observer = attachViewportObserver({
			registry,
			sessionId: taskId,
			phaseRole: phase.role,
			beginHeader: `─── phase ${currentPhaseIndex + 1}/${PHASES.length} ${phase.role} begin · ${taskId} ───`,
			writeDebug,
			notify: (msg, level) => ctx.ui.notify(msg, level),
			setStatusVerbose: process.env.FORGE_VERBOSE === "1" ? (k, v) => ctx.ui.setStatus?.(k, v) : undefined,
			verboseKeys: { messageKey: MESSAGE_KEY },
			afterEach: refreshStatus,
		});

		// ── Context governor injection (completes FORGE-S30-T07) ──────
		// Per-phase factories built HERE because only the pipeline knows the
		// `${personaNoun}/${role}` phase key — pi never sets persona/phase on
		// ExtensionContext, and the parent session's registerHookDispatcher
		// governor never sees subagent tool traffic (dormant-governor defect,
		// CART-S02-T03 benchmark). Flag-gated: FORGE_CTX_GOVERNOR=1.
		//   buildGovernorFactory        — Mechanisms A/B/C/D in the subagent
		//   buildForgeCompactionFactory — Mechanism E with warm-tier path opts
		//     (previously injected from index.ts with NO opts → warm-tier dead)
		const phaseKey = `${phase.personaNoun}/${phase.role}`;
		const sprintIdForSummaries = /^(.*)-T\d+$/.exec(taskId)?.[1];
		const governorFactories: ExtensionFactory[] =
			process.env.FORGE_CTX_GOVERNOR === "1"
				? [
						buildGovernorFactory({ phaseKey, cwd }),
						buildForgeCompactionFactory({
							cwd,
							phaseKey,
							entityId: taskId,
							sprintId: sprintIdForSummaries,
						}),
					]
				: [];
		const phaseExtensionFactories = [...(opts.extensionFactories ?? []), ...governorFactories];

		let result;
		try {
			// FORGE-BUG-040: wrap the runForgeSubagent dispatch in the phase
			// caller context (parity with fix-bug.ts) so the phase-ownership
			// guard can verify tool calls from the subagent. Single setter
			// of phase context for the task pipeline.
			result = await CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
				runForgeSubagent({
				persona,
				task: taskBody,
				cwd,
				exportTag: `${taskId}__${phase.role}`,
				cacheSessionId,
				streamFn: opts.streamFnFactory?.({ kind: "task-phase", persona: persona.name, phase: phase.role, taskId }),
				onEvent: wrappedOnEvent,
				requestedModel: modelResolution.model,
				modelRegistry: ctx.modelRegistry,
				signal: opts.signal,
				customTools: opts.forgeToolDefs ? getSubagentTools(opts.forgeToolDefs, persona.name) : undefined,
				extensionFactories: phaseExtensionFactories.length > 0 ? phaseExtensionFactories : undefined,
				}),
			);
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× forge:run-task — runForgeSubagent threw for phase ${phase.role}: ${e.message ?? "unknown"}`,
				"error",
			);
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}`,
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}`,
			};
		}

		// ── Post-subagent abort detection ─────────────────────────────────
		// If the abort signal fired during the subagent run, treat it as
		// cancellation regardless of the exit code (subagent may have been
		// mid-turn when aborted — exitCode could be 0 or 1).
		// This check MUST come before halt-on-failure so that
		// stopReason="aborted" + exitCode=1 is classified as cancellation,
		// not a phase failure.
		if (result.stopReason === "aborted" || opts.signal?.aborted) {
			ctx.ui.notify(`⊘ forge:run-task — ${taskId} phase ${phase.role} cancelled.`, "info");
			registry.completePhase(taskId, phase.role, "cancelled");
			tree.completeNode(phaseNodeId, "cancelled");
			registry.confirmCancelled(taskId);
			// Bug B: account the billed tokens of this aborted attempt before returning.
			{
				const abortSprintId = readTaskRecord(taskId, storeCli, cwd)?.sprintId;
				if (abortSprintId) {
					emitIncompletePhaseEvent({
						emitCtx: {
							entityType: "task",
							taskId,
							sprintId: abortSprintId,
							phase,
							iteration: (iterationCounts[phase.role] ?? 0) + 1,
							startMs: phaseStart,
							endMs: Date.now(),
							model: result.model ?? "unknown",
							provider: result.provider ?? "unknown",
							usage: {
								input: result.usage.input,
								output: result.usage.output,
								cacheRead: result.usage.cacheRead,
								cacheWrite: result.usage.cacheWrite,
							},
							judgement: undefined,
							storeCli,
							cwd,
						},
						outcome: "aborted",
						notes: result.errorMessage ?? result.stopReason ?? undefined,
						onDebug: writeDebug,
					});
				} else {
					writeDebug({ kind: "incomplete_emit_skipped", reason: "no-sprintId", outcome: "aborted" });
				}
			}
			// ADR-S21-01: preserve state file so cancelled runs are resumable
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: false,
				status: "cancelled",
				lastError: undefined,
				savedAt: new Date().toISOString(),
			});
			return { status: "cancelled", lastPhaseIndex: currentPhaseIndex, iterationCounts };
		}

		// ── Halt-on-failure ───────────────────────────────────────────
		if (result.exitCode !== 0) {
			ctx.ui.notify(
				`× forge:run-task — phase ${phase.role} failed (exit ${result.exitCode})` +
					(result.errorMessage ? `: ${result.errorMessage}` : "") +
					(result.stopReason ? ` [${result.stopReason}]` : ""),
				"error",
			);
			// Bug B: account the billed tokens of this failed attempt before returning.
			{
				const failSprintId = readTaskRecord(taskId, storeCli, cwd)?.sprintId;
				if (failSprintId) {
					emitIncompletePhaseEvent({
						emitCtx: {
							entityType: "task",
							taskId,
							sprintId: failSprintId,
							phase,
							iteration: (iterationCounts[phase.role] ?? 0) + 1,
							startMs: phaseStart,
							endMs: Date.now(),
							model: result.model ?? "unknown",
							provider: result.provider ?? "unknown",
							usage: {
								input: result.usage.input,
								output: result.usage.output,
								cacheRead: result.usage.cacheRead,
								cacheWrite: result.usage.cacheWrite,
							},
							judgement: undefined,
							storeCli,
							cwd,
						},
						outcome: "failed",
						notes: result.errorMessage ?? result.stopReason ?? undefined,
						onDebug: writeDebug,
					});
				} else {
					writeDebug({ kind: "incomplete_emit_skipped", reason: "no-sprintId", outcome: "failed" });
				}
			}
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
			};
		}

		// Capture model/provider from subagent result (REVIEW FIX #1).
		if (result.model) lastModel = result.model;
		if (result.provider) lastProvider = result.provider;

		// Phase-complete liveliness ping (counts + duration).
		{
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			const { turn, toolCount, errCount, cumUsage } = observer.state;
			ctx.ui.notify(
				`✓ ${phase.role}: ${turn} turn${turn === 1 ? "" : "s"} · ${toolCount} tool call${toolCount === 1 ? "" : "s"}${errCount ? ` · ${errCount} err` : ""} · ${elapsed}s`,
				"info",
			);
			orchTranscript.record({
				kind: "phase-end",
				ts: new Date().toISOString(),
				phase: phase.role,
				phaseIndex: currentPhaseIndex,
				attempt: (iterationCounts[phase.role] ?? 0) + 1,
				verdict: "n/a",
				elapsedMs: Date.now() - phaseStart,
				turns: turn,
				toolCount,
				errCount,
			});
			const { cumCompression } = observer.state;
			registry.appendTail(
				taskId,
				phase.role,
				fmtPhaseSummary({
					role: phase.role,
					turns: turn,
					tools: toolCount,
					errors: errCount,
					wallSeconds: elapsed,
					usage: cumUsage,
					model: result.model,
					provider: result.provider,
					compression: cumCompression.tokensSaved > 0 ? cumCompression : undefined,
				}),
			);
		}

		// ── Plan 11 / Slice 2: orchestrator emits phase event ─────────
		const phaseEndMs = Date.now();
		const taskRecord = readTaskRecord(taskId, storeCli, cwd);
		const sprintId = taskRecord?.sprintId;
		if (!sprintId) {
			ctx.ui.notify(
				`⚠ forge:run-task — could not resolve sprintId for ${taskId}; ` +
					`skipping orchestrator emit for phase ${phase.role}`,
				"warning",
			);
			writeDebug({ kind: "emit_skipped", reason: "no-sprintId" });
		} else {
			const phaseIteration = (iterationCounts[phase.role] ?? 0) + 1;
			const emitCtx: OrchestratorEmitContext = {
				entityType: "task",
				taskId,
				sprintId,
				phase,
				iteration: phaseIteration,
				startMs: phaseStart,
				endMs: phaseEndMs,
				model: result.model ?? "unknown",
				provider: result.provider ?? "unknown",
				usage: {
					input: result.usage.input,
					output: result.usage.output,
					cacheRead: result.usage.cacheRead,
					cacheWrite: result.usage.cacheWrite,
				},
				judgement: judgementFromSummary(taskRecord, phase.role),
				storeCli,
				cwd,
			};
			const phaseEvent = buildPhaseEvent(emitCtx);
			const emitResult = emitEvent(storeCli, cwd, sprintId, phaseEvent);
			if (!emitResult.ok) {
				ctx.ui.notify(
					`⚠ forge:run-task — phase event emit failed for ${phase.role}: ${emitResult.stderr.trim()}`,
					"warning",
				);
				writeDebug({ kind: "emit_failed", stderr: emitResult.stderr });
			} else {
				writeDebug({ kind: "emit_ok", eventId: phaseEvent.eventId });
			}

			// Notify sprint-level observer (FORGE-S21-T03).
			if (onPhaseEvent) onPhaseEvent(phaseEvent);

			// Drain friction file for this phase, if any.
			const frictionPath = path.join(cwd, ".forge", "cache", `FRICTION-${phase.role}.jsonl`);
			const drain = drainFrictionFile(frictionPath, emitCtx);
			if (drain.emitted + drain.failed > 0) {
				writeDebug({ kind: "friction_drain", ...drain });
				if (drain.failed > 0) {
					ctx.ui.notify(
						`⚠ forge:run-task — friction drain for ${phase.role}: ${drain.emitted} ok, ${drain.failed} failed`,
						"warning",
					);
				}
			}
		}

		// ── 6b. Verdict check (review phases only) ────────────────────
		if (phase.isReview) {
			const verdict = readVerdict(taskId, phase.role, storeCli, cwd);

			if (verdict === "missing") {
				ctx.ui.notify(
					`× forge:run-task — verdict missing for phase ${phase.role} after subagent completed. ` +
						"Subagent may have crashed or failed to write summaries. Halting for advisory.",
					"error",
				);
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `verdict missing for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				// A missing verdict IS a postflight-outputs failure: the canonical
				// phase summary the subagent must write (e.g. summaries.code_review)
				// was never recorded, so there is no verdict to route on. review-phase
				// workflows declare no `outputs` block, so runPostflightGate is a
				// pass-through here — this readVerdict check is the effective gate.
				// Route it through the halt-recovery advisor (FORGE-S26-T18), the same
				// hand-off the postflight-gate-unsatisfied branch uses, instead of a
				// bare escalation — so the strongest configured model can diagnose the
				// missing-summary cause. Best-effort, non-fatal (FORGE-S26-T19 parity).
				const gateFailure: GateFailureData = {
					phase: phase.role,
					reasonCode: "verdict-missing",
					detail:
						`Phase '${phase.role}' completed but no verdict was found in the store. ` +
						"The canonical phase summary was not written, so the orchestrator has no verdict to route on.",
					remediation:
						"Re-run the phase and ensure the subagent's forge_store set-summary call " +
						'uses args:["<recordId>", "<phaseKey>"] with the literal phase key as args[1] ' +
						"(e.g. code_review), and that the call exits zero before the subagent returns.",
				};
				const advisorModel = resolveAdvisorModel(
					modelRoutingConfig,
					ctx.model as any,
				);
				void runHaltAdvisor({
					gateFailure,
					advisorModel,
					taskId,
					cwd,
					ctx: { ui: ctx.ui as any },
					forgeRoot,
				});
				return {
					status: "halted",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `verdict missing for ${phase.role}`,
				};
			}

			if (verdict === "revision") {
				// Increment iteration count for this review phase
				iterationCounts[phase.role] = (iterationCounts[phase.role] ?? 0) + 1;

				if (iterationCounts[phase.role] >= phase.maxIterations) {
					ctx.ui.notify(
						`× forge:run-task — revision cap reached for phase ${phase.role} ` +
							`(${iterationCounts[phase.role]}/${phase.maxIterations} iterations). Escalating.`,
						"error",
					);
					writeState(cwd, {
						taskId,
						phaseIndex: currentPhaseIndex,
						iterationCounts,
						halted: true,
						lastError: `revision cap reached for ${phase.role}`,
						savedAt: new Date().toISOString(),
					});
					return {
						status: "escalated",
						lastPhaseIndex: currentPhaseIndex,
						iterationCounts,
						lastError: `revision cap reached for ${phase.role}`,
					};
				}

				// Loop back to predecessor non-review phase
				const predIndex = findPredecessorIndex(PHASES, currentPhaseIndex);
				ctx.ui.notify(
					`⟳ forge:run-task — ${phase.role} returned revision; looping to ${PHASES[predIndex]?.role ?? predIndex} ` +
						`(attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
					"info",
				);
				orchTranscript.record({
					kind: "phase-loopback",
					ts: new Date().toISOString(),
					fromPhase: phase.role,
					toPhase: PHASES[predIndex]?.role ?? String(predIndex),
					fromPhaseIndex: currentPhaseIndex,
					toPhaseIndex: predIndex,
					reason: `${phase.role} returned revision (attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
				});
				// Write intermediate state (not halted — still running)
				writeState(cwd, {
					taskId,
					phaseIndex: predIndex,
					iterationCounts,
					halted: false,
					savedAt: new Date().toISOString(),
				});
				currentPhaseIndex = predIndex;
				continue;
			}

			// verdict === "approved": fall through to advance
		}

		// Postflight gate: evaluate `outputs` block after subagent returns,
		// before FSM status advance (FORGE-S26-T19). Hard enforcement in forge-cli;
		// plugin LLM route treats postflight as advisory. On UNSATISFIED: do not
		// advance currentPhaseIndex, halt, hand off to existing runHaltAdvisor.
		{
			const postflightGatePath = preflightGate.replace("preflight-gate.cjs", "postflight-gate.cjs");
			const postflightOutcome = runPostflightGate(postflightGatePath, phase.role, taskId, cwd);
			if (postflightOutcome.result === "unsatisfied") {
				if (postflightOutcome.gateFailure) {
					ctx.ui.notify(
						`× forge:run-task — postflight gate failed for phase ${phase.role} ` +
							`[${postflightOutcome.gateFailure.reasonCode}]: ${postflightOutcome.gateFailure.detail}`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:run-task — postflight gate failed for phase ${phase.role}; halting.`,
						"error",
					);
				}
				// Do NOT advance FSM — write state at current phaseIndex (halted)
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `postflight gate exit 1 for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				// Spawn halt-recovery advisor (Tier 1, best-effort — non-fatal).
				if (postflightOutcome.gateFailure) {
					const advisorModel = resolveAdvisorModel(
						modelRoutingConfig,
						ctx.model as any,
					);
					void runHaltAdvisor({
						gateFailure: postflightOutcome.gateFailure,
						advisorModel,
						taskId,
						cwd,
						ctx: { ui: ctx.ui as any },
						forgeRoot,
					});
				}
				return {
					status: "halted",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `postflight gate exit 1 for ${phase.role}`,
				};
			}
			// "ok" or "error" — proceed to advance
		}

		// ── Advance to next phase ─────────────────────────────────────
		registry.completePhase(taskId, phase.role, "completed");
		tree.completeNode(phaseNodeId, "completed");
		tree.setNodeUsage(phaseNodeId, { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead });
		if (result.model) tree.setNodeModel(phaseNodeId, result.model, result.provider ?? "");
		writeState(cwd, {
			taskId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: false,
			savedAt: new Date().toISOString(),
		});
		currentPhaseIndex++;
	}

	// ── All phases complete ───────────────────────────────────────────
	deleteState(cwd, taskId);
	orchTranscript.record({
		kind: "pipeline-end",
		ts: new Date().toISOString(),
		outcome: "complete",
		elapsedMs: Date.now() - pipelineStartMs,
	});
	return {
		status: "completed",
		lastPhaseIndex: PHASES.length - 1,
		iterationCounts,
		model: lastModel,
		provider: lastProvider,
	};
	} finally {
		ctx.ui.notify = __origNotify;
	}
}

// ── Thin wrapper registration ────────────────────────────────────────────

export interface RegisterRunTaskOptions {
	cwd?: string;
	forgeToolDefs?: ForgeToolDefs;
	/** Extension factories forwarded to each subagent (see RunTaskPipelineOptions). */
	extensionFactories?: ExtensionFactory[];
}

export function registerRunTask(pi: ExtensionAPI, options: RegisterRunTaskOptions = {}): void {
	pi.registerCommand("forge:run-task", {
		description:
			"Run the full task pipeline (plan → review → implement → validate → approve → commit). " +
			"Usage: /forge:run-task <TASK_ID>. " +
			"Orchestrator archetype: each phase is an isolated subagent session (IL10).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			let taskId = args.trim();

			if (!taskId) {
				ctx.ui.notify("× forge:run-task — task ID required. Usage: /forge:run-task <TASK_ID>", "error");
				return;
			}

			ctx.ui.setStatus?.(STATUS_KEY, `run-task ${taskId}: initializing…`);

			// ── Discover forge config ────────────────────────────────────────
			const forgeConfig = discoverForgeConfigCached(cwd);
			if (!forgeConfig) {
				ctx.ui.notify("× forge:run-task — no Forge project found at cwd. Run /forge:init first.", "error");
				ctx.ui.setStatus?.(STATUS_KEY, undefined);
				ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
				return;
			}
			const forgeRoot = forgeConfig.forgeRoot;

			// ── Resolve task ID (prefix-normalize, suffix-match, NLP fallback) ──
			// Handles unprefixed IDs like "S22-T03" → "FORGE-S22-T03".
			// Issue #20: unprefixed task IDs silently poisoned substitutions.
			// NOTE: resolveToCanonicalId may surface ctx.ui.select (disambiguation)
			// or ctx.ui.confirm prompts. The session must NOT be registered yet
			// at this point — the chip strip would appear before the user has
			// chosen which task they meant, stealing arrow keys from the dialog.
			const toolDir = resolveToolDir(forgeRoot);
			const resolvedTaskId = await resolveToCanonicalId(taskId, toolDir, cwd, "task", {
				ctx,
				commandLabel: "forge:run-task",
			});
			if (!resolvedTaskId) {
				// Error already emitted by resolver
				ctx.ui.setStatus?.(STATUS_KEY, undefined);
				ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
				return;
			}

			// Replace raw arg with canonical ID for all subsequent operations
			// (state files, store reads, preflight gates, orchestrator emits).
			// Issue #20: unprefixed task IDs silently poisoned substitutions.
			taskId = resolvedTaskId;

			// Update status with canonical ID so the user sees the resolved form.
			ctx.ui.setStatus?.(STATUS_KEY, `run-task ${taskId}: ready`);

			// Tool paths
			const storeCli = path.join(forgeRoot, "tools", "store-cli.cjs");
			const preflightGate = path.join(forgeRoot, "tools", "preflight-gate.cjs");

			// ── Resume detection ─────────────────────────────────────────────
			const existing = readState(cwd, taskId);
			let resumeFromState: RunTaskState | undefined;

			if (existing) {
				if (isStateStale(existing)) {
					// Stale state: notify + offer purge
					ctx.ui.notify(
						`⚠ forge:run-task — cached state for ${taskId} is stale (>7 days old, saved at ${formatLocalTime(existing.savedAt)}). ` +
							"Offering purge.",
						"warning",
					);
					if (!isNonInteractive()) {
						const purge = await ctx.ui.confirm(
							`Purge stale state for ${taskId}?`,
							"The cached state is older than 7 days. Purge and restart from the beginning?",
						);
						if (purge) {
							deleteState(cwd, taskId);
						} else {
							ctx.ui.notify("forge:run-task — stale state kept; aborting.", "info");
							ctx.ui.setStatus?.(STATUS_KEY, undefined);
							ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
							return;
						}
					} else {
						// Non-interactive: auto-abort on stale state
						ctx.ui.notify("forge:run-task — stale state; non-interactive mode auto-aborting.", "info");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}
				} else {
					// Fresh state: offer resume for ALL non-stale states — halted=true
					// (explicit failure), halted=false (cancelled/interrupted), and
					// any state with existing.status set (ADR-S21-01).
					const stateStatus = existing.status ?? (existing.halted ? "halted" : "interrupted");
					const statusLabel =
						stateStatus === "cancelled" ? "cancelled" : stateStatus === "halted" ? "halted" : "interrupted";
					const phaseRole = PHASES[existing.phaseIndex]?.role ?? existing.phaseIndex;
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume ${taskId}?`,
							`Cached state — phase ${existing.phaseIndex} (${phaseRole}), ${statusLabel}, ` +
								`saved at ${formatLocalTime(existing.savedAt)}. Resume from here?`,
						);
						if (resume) {
							resumeFromState = existing;
							ctx.ui.notify(
								`forge:run-task — resuming ${taskId} from phase ${phaseRole} (${statusLabel})`,
								"info",
							);
						} else {
							deleteState(cwd, taskId);
						}
					} else {
						// Non-interactive: auto-resume from state (no confirmation).
						// Cancelled/interrupted states are valid resume points.
						resumeFromState = existing;
						ctx.ui.notify(`forge:run-task — resuming ${taskId} from phase ${phaseRole} (${statusLabel})`, "info");
					}
				}
			}

			// ── Register session & delegate to pipeline ────────────────────
			// Session registration MUST happen after all interactive disambiguation
			// (resolveToCanonicalId, resume confirm) so the chip strip doesn't appear
			// before the user has confirmed which task they meant — the strip would
			// steal arrow keys from ctx.ui.select / ctx.ui.confirm dialogs.
			const registry = getSessionRegistry();
			registry.startSession(taskId);

			// Bridge: also register in OrchestratorTree for the dashboard overlay.
			const tree = getOrchestratorTree();
			tree.startNode(taskId, { label: taskId, kind: "orchestrator" });

			const signal = registry.getAbortSignal(taskId);
			const pipelineResult = await runTaskPipeline({
				taskId,
				cwd,
				ctx,
				forgeRoot,
				storeCli,
				preflightGate,
				registry,
				resumeFromState,
				signal,
				forgeToolDefs: options.forgeToolDefs,
				extensionFactories: options.extensionFactories,
			});

			// ── Handle result ────────────────────────────────────────────────
			if (pipelineResult.status === "completed") {
				registry.completeSession(taskId, "completed");
				tree.completeNode(taskId, "completed");
				ctx.ui.notify(`〇 forge:run-task — ${taskId} pipeline complete (${PHASES.length} phases).`, "info");
			} else if (pipelineResult.status === "cancelled") {
				// confirmCancelled was already called by the pipeline, but
				// completeSession("cancelled") ensures the session ends cleanly.
				registry.completeSession(taskId, "cancelled");
				tree.completeNode(taskId, "cancelled");
			} else {
				registry.completeSession(taskId, "failed");
				tree.completeNode(taskId, "failed");
			}

			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
		},
	});
}
