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

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";

import { assertAudience, CallerContextStore } from "./audience-gate.js";
import { checkMaterialization } from "./plan.js";
import { loadForgePersona, runForgeSubagent } from "./forge-subagent.js";
import { discoverForgeConfig } from "./forge-root.js";
import { loadWorkflow, type AudienceValue } from "./loaders/workflow-loader.js";
import { getSessionRegistry } from "./session-registry.js";

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
	lastError?: string;
	savedAt: string;
}

/** Validate that an ID contains no path-traversal characters. */
export function validateId(id: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(id) && !id.includes("..");
}

function stateFilePath(cwd: string, taskId: string): string {
	if (!validateId(taskId)) {
		throw new Error(`Invalid taskId for state file path: ${taskId}`);
	}
	return path.join(cwd, ".forge", "cache", `run-task-state-${taskId}.json`);
}

export function readState(cwd: string, taskId: string): RunTaskState | null {
	const fp = stateFilePath(cwd, taskId);
	try {
		if (!fs.existsSync(fp)) return null;
		const raw = fs.readFileSync(fp, "utf8");
		return JSON.parse(raw) as RunTaskState;
	} catch {
		return null;
	}
}

export function writeState(cwd: string, state: RunTaskState): void {
	const fp = stateFilePath(cwd, state.taskId);
	const dir = path.dirname(fp);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(fp, JSON.stringify(state, null, 2), "utf8");
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
	const savedAt = new Date(state.savedAt).getTime();
	const ageMs = Date.now() - savedAt;
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
	return ageMs > sevenDaysMs;
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
}

export type RunTaskPipelineStatus = "completed" | "halted" | "escalated" | "failed";

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

export function readVerdict(
	taskId: string,
	phaseRole: string,
	storeCli: string,
	cwd: string,
): Verdict {
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
		const candidates = [
			summaryKey ?? "",
			underscoreKey,
			phaseRole,
		].filter(Boolean);
		let verdict: string | undefined;
		for (const k of candidates) {
			if (summaries[k]?.verdict) { verdict = summaries[k].verdict; break; }
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
	return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function buildPhaseEvent(ec: OrchestratorEmitContext): Record<string, unknown> {
	const action = actionForRole(ec.phase.role);
	const entityId = ec.entityType === "bug" ? ec.bugId! : ec.taskId!;
	const eventId = `${isoCompact(ec.startMs)}_${entityId}_${ec.phase.personaNoun}_${action}`;
	const durationMs = Math.max(0, ec.endMs - ec.startMs);
	const event: Record<string, unknown> = {
		eventId,
		sprintId:        ec.sprintId,
		role:            ec.phase.role,
		action:          `/forge:${action.replace(/_/g, "-")}`,
		phase:           ec.phase.role,
		iteration:       ec.iteration,
		startTimestamp:  new Date(ec.startMs).toISOString(),
		endTimestamp:    new Date(ec.endMs).toISOString(),
		durationMinutes: Math.round((durationMs / 60000) * 100) / 100,
		model:           ec.model,
		provider:        ec.provider,
	};
	if (ec.entityType === "bug") {
		event.bugId = ec.bugId;
	} else {
		event.taskId = ec.taskId;
	}
	if (ec.usage.input > 0 || ec.usage.output > 0 || ec.usage.cacheRead > 0 || ec.usage.cacheWrite > 0) {
		event.inputTokens      = ec.usage.input;
		event.outputTokens     = ec.usage.output;
		event.cacheReadTokens  = ec.usage.cacheRead;
		event.cacheWriteTokens = ec.usage.cacheWrite;
		event.tokenSource      = "reported";
	}
	if (ec.judgement && typeof ec.judgement === "object") {
		const j = ec.judgement as Record<string, unknown>;
		if (typeof j.verdict === "string") event.verdict = j.verdict;
		if (typeof j.notes   === "string") event.notes   = j.notes;
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
			sprintId:        ec.sprintId,
			role:            ec.phase.role,
			action:          `/forge:${action.replace(/_/g, "-")}`,
			phase:           ec.phase.role,
			iteration:       ec.iteration,
			startTimestamp:  new Date(ec.startMs).toISOString(),
			endTimestamp:    new Date(ec.endMs).toISOString(),
			durationMinutes: Math.round(((ec.endMs - ec.startMs) / 60000) * 100) / 100,
			model:           ec.model,
			provider:        ec.provider,
			type:            "friction",
			workflow:        typeof judgement.workflow === "string" ? judgement.workflow : ec.phase.role,
			persona:         typeof judgement.persona  === "string" ? judgement.persona  : ec.phase.personaNoun,
			issue:           judgement.issue,
		};
		if (ec.entityType === "bug") {
			event.bugId = ec.bugId;
		} else {
			event.taskId = ec.taskId;
		}
		if (judgement.subkind  !== undefined) event.subkind  = judgement.subkind;
		if (judgement.evidence !== undefined) event.evidence = judgement.evidence;
		if (judgement.notes    !== undefined) event.notes    = judgement.notes;
		const r = emitEvent(ec.storeCli, ec.cwd, ec.sprintId, event);
		if (r.ok) emitted++;
		else failed++;
	}

	if (failed === 0) {
		try { fs.unlinkSync(frictionPath); } catch { /* non-fatal */ }
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

export function composeTaskBody(subWorkflowMd: string, taskId: string): string {
	return [
		`Read the workflow below and follow it. Task ID: ${taskId}.`,
		"",
		"---",
		"",
		subWorkflowMd.trim(),
	].join("\n");
}

// ── Preflight gate ────────────────────────────────────────────────────────

export type PreflightResult = "proceed" | "halt" | "escalate";

export function runPreflightGate(
	preflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
	entityType?: "task" | "bug",
): PreflightResult {
	const entityFlag = entityType === "bug" ? "--bug" : "--task";
	const result = spawnSync("node", [preflightGate, "--phase", role, entityFlag, taskId], { cwd });
	if (result.status === 0) return "proceed";
	if (result.status === 2) return "escalate";
	return "halt";
}

// ── Per-task orchestrator pipeline (FORGE-S21-T03 extracted) ──────────────
// The entire phase loop was inline in registerRunTask. It is now a standalone
// exported function so that run-sprint.ts can delegate per-task execution
// without duplicating phase-loop logic. registerRunTask becomes a thin
// wrapper: config discovery, resume detection, then delegate to runTaskPipeline.

const STATUS_KEY = "forge:run-task";
const MESSAGE_KEY = "forge:run-task:message";

/**
 * Extract the last assistant-authored text from a turn_end message and
 * collapse it to a single-line preview (max 120 chars). Returns "" if the
 * message has no text content (e.g. all-tool-call turn).
 */
export function extractTurnPreview(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as { role?: string; content?: unknown };
	if (msg.role !== "assistant") return "";
	const content = msg.content;
	if (!Array.isArray(content)) return "";
	for (const c of content) {
		if (!c || typeof c !== "object") continue;
		const part = c as { type?: string; text?: unknown };
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			const flat = part.text.replace(/\s+/g, " ").trim();
			return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
		}
	}
	return "";
}

// ── runTaskPipeline ──────────────────────────────────────────────────────

export async function runTaskPipeline(opts: RunTaskPipelineOptions): Promise<RunTaskPipelineResult> {
	const { taskId, cwd, ctx, forgeRoot, storeCli, preflightGate, registry, resumeFromState, onPhaseEvent } = opts;

	// Determine starting phase from resumeFromState (if provided) or phase 0.
	let currentPhaseIndex = resumeFromState?.phaseIndex ?? 0;
	let iterationCounts: Record<string, number> = resumeFromState?.iterationCounts ?? {};

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

	while (currentPhaseIndex < PHASES.length) {
		const phase = PHASES[currentPhaseIndex];
		if (!phase) {
			ctx.ui.notify(`× forge:run-task — invalid phase index ${currentPhaseIndex}`, "error");
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `invalid phase index ${currentPhaseIndex}` };
		}

		ctx.ui.setStatus?.(
			STATUS_KEY,
			`run-task ${taskId}: phase ${currentPhaseIndex + 1}/${PHASES.length} (${phase.role})`,
		);
		ctx.ui.notify(
			`→ ${taskId}: ${phase.role} (phase ${currentPhaseIndex + 1}/${PHASES.length})`,
			"info",
		);

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
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `sub-workflow read failed: ${e.message ?? "unknown"}` };
		}

		// ── 6a. Preflight gate ────────────────────────────────────────
		if (fs.existsSync(preflightGate)) {
			const preflightResult = runPreflightGate(preflightGate, phase.role, taskId, cwd);
			if (preflightResult === "halt") {
				ctx.ui.notify(
					`× forge:run-task — preflight gate failed for phase ${phase.role} (exit 1); halting.`,
					"error",
				);
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 1 for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				return { status: "halted", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `preflight gate exit 1 for ${phase.role}` };
			}
			if (preflightResult === "escalate") {
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
				return { status: "escalated", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `preflight gate exit 2 (escalate) for ${phase.role}` };
			}
		}

		// ── 6. Materialization-marker check ───────────────────────────
		const markerCheck = checkMaterialization(subWorkflowPath, subWorkflowMd);
		if (!markerCheck.ok) {
			for (const marker of markerCheck.missing) {
				ctx.ui.notify(
					`× workflow regression: ${marker} not found in ${subWorkflowPath}`,
					"error",
				);
			}
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `materialization markers missing: ${markerCheck.missing.join(", ")}` };
		}

		// ── 5. Audience check ─────────────────────────────────────────
		// Wrap with CallerContextStore.asSubagent so assertAudience treats
		// this as a subagent context (IL10: we ARE dispatching from subagent chain).
		const audienceOk = CallerContextStore.asSubagent(() =>
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
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `audience check failed for ${phase.workflowFile}` };
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
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `persona load failed: ${e.message ?? "unknown"}` };
		}

		// ── 4. Dispatch via runForgeSubagent (IL10) ───────────────────
		// NEVER sendKickoff here — that would reproduce issue #30 (same-context inline = no fork).
		const taskBody = composeTaskBody(subWorkflowMd, taskId);

		// Phase-scoped progress counters (drive the status line + summary notify).
		const phaseStart = Date.now();
		let turn = 0;
		let toolCount = 0;
		let errCount = 0;
		let lastTool = "";
		// Capture tool args at _start so we can echo the failing command on _end isError.
		const argsByCallId = new Map<string, unknown>();

		// Stabilization debug log — every subagent event appended as JSONL.
		const debugLogPath = path.join(
			cwd,
			".forge",
			"cache",
			`run-task-debug-${taskId}.jsonl`,
		);
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
		registry.startPhase(taskId, phase.role, currentPhaseIndex);

		const argHint = (toolName: string, args: unknown): string => {
			if (!args || typeof args !== "object") return "";
			const a = args as Record<string, unknown>;
			const fp = (a.file_path ?? a.path) as unknown;
			if (typeof fp === "string") return path.basename(fp);
			if (typeof a.command === "string") {
				const head = a.command.split(/\s+/).slice(0, 2).join(" ");
				return head.length > 40 ? `${head.slice(0, 40)}…` : head;
			}
			if (typeof a.pattern === "string") return a.pattern.slice(0, 40);
			if (typeof a.query === "string") return a.query.slice(0, 40);
			return "";
		};

		// ── Tail-line formatters ─────────────────────────────────────
		const formatTime = (ms: number): string => {
			const d = new Date(ms);
			const pad = (n: number) => String(n).padStart(2, "0");
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		};
		const tailPrefix = () => `[${phase.role} ${formatTime(Date.now())}]`;
		const extractErrorSummary = (result: unknown): string => {
			const raw =
				typeof result === "string"
					? result
					: typeof result === "object" && result !== null
					? JSON.stringify(result)
					: String(result);
			const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? raw;
			return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
		};
		const appendTail = (line: string, opts?: { warning?: boolean }) => {
			registry.appendTail(taskId, phase.role, line, opts);
		};

		appendTail(`${tailPrefix()} ─── phase ${phase.role} begin ───`);

		const refreshStatus = () => {
			if (process.env.FORGE_VERBOSE !== "1") return;
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			const tail = lastTool ? ` · ${lastTool}` : "";
			ctx.ui.setStatus?.(
				STATUS_KEY,
				`run-task ${taskId}: ${phase.role} · t${turn} · tools ${toolCount}${errCount ? ` · err ${errCount}` : ""} · ${elapsed}s${tail}`,
			);
		};

		let result;
		try {
			result = await runForgeSubagent({
				persona,
				task: taskBody,
				cwd,
				exportTag: `${taskId}__${phase.role}`,
				cacheSessionId,
				onEvent: (event) => {
					switch (event.type) {
						case "turn_start": {
							turn++;
							lastTool = "";
							registry.bumpTurn(taskId);
							refreshStatus();
							break;
						}
						case "turn_end": {
							const preview = extractTurnPreview(event.message);
							if (preview) {
								registry.setTurnPreview(taskId, preview);
								if (process.env.FORGE_VERBOSE === "1") {
									ctx.ui.setStatus?.(MESSAGE_KEY, `  "${preview}"`);
								}
								appendTail(`${tailPrefix()} » "${preview}"`);
							}
							break;
						}
						case "tool_execution_start": {
							toolCount++;
							argsByCallId.set(event.toolCallId, event.args);
							const hint = argHint(event.toolName, event.args);
							lastTool = `${event.toolName}${hint ? ` ${hint}` : ""}`;
							writeDebug({
								kind: "tool_start",
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								args: event.args,
							});
							registry.recordToolStart(
								taskId,
								event.toolCallId,
								event.toolName,
								event.args,
							);
							appendTail(`${tailPrefix()} → ${event.toolName}${hint ? ` ${hint}` : ""}`);
							refreshStatus();
							break;
						}
						case "tool_execution_end": {
							const startArgs = argsByCallId.get(event.toolCallId);
							argsByCallId.delete(event.toolCallId);
							writeDebug({
								kind: "tool_end",
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								isError: event.isError,
								args: startArgs,
								result: event.result,
							});
							registry.recordToolEnd(
								taskId,
								event.toolCallId,
								event.toolName,
								event.isError,
								event.result,
							);
							if (event.isError) {
								errCount++;
								appendTail(
									`${tailPrefix()} ⚠ ${event.toolName} failed: ${extractErrorSummary(event.result)}`,
									{ warning: true },
								);
							} else {
								appendTail(`${tailPrefix()} ← ${event.toolName} ok`);
							}
							refreshStatus();
							break;
						}
						case "compaction_start": {
							ctx.ui.notify(
								`◌ ${phase.role}: context compacting (${event.reason})…`,
								"info",
							);
							appendTail(`${tailPrefix()} ◌ compacting (${event.reason})`);
							break;
						}
						case "auto_retry_start": {
							const err = event.errorMessage ?? "";
							ctx.ui.notify(
								`↻ ${phase.role}: model retry ${event.attempt}/${event.maxAttempts}${err ? `\n${err}` : ""}`,
								"warning",
							);
							appendTail(
								`${tailPrefix()} ↻ retry ${event.attempt}/${event.maxAttempts}${err ? `: ${extractErrorSummary(err)}` : ""}`,
								{ warning: true },
							);
							break;
						}
					}
				},
			});
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
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}` };
		}

		// ── Halt-on-failure ───────────────────────────────────────────
		if (result.exitCode !== 0) {
			ctx.ui.notify(
				`× forge:run-task — phase ${phase.role} failed (exit ${result.exitCode})` +
					(result.errorMessage ? `: ${result.errorMessage}` : "") +
					(result.stopReason ? ` [${result.stopReason}]` : ""),
				"error",
			);
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
				savedAt: new Date().toISOString(),
			});
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero" };
		}

		// Capture model/provider from subagent result (REVIEW FIX #1).
		if (result.model) lastModel = result.model;
		if (result.provider) lastProvider = result.provider;

		// Phase-complete liveliness ping (counts + duration).
		{
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			ctx.ui.notify(
				`✓ ${phase.role}: ${turn} turn${turn === 1 ? "" : "s"} · ${toolCount} tool call${toolCount === 1 ? "" : "s"}${errCount ? ` · ${errCount} err` : ""} · ${elapsed}s`,
				"info",
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
				iteration:  phaseIteration,
				startMs:    phaseStart,
				endMs:      phaseEndMs,
				model:      result.model    ?? "unknown",
				provider:   result.provider ?? "unknown",
				usage:      {
					input:      result.usage.input,
					output:     result.usage.output,
					cacheRead:  result.usage.cacheRead,
					cacheWrite: result.usage.cacheWrite,
				},
				judgement:  judgementFromSummary(taskRecord, phase.role),
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
						"Subagent may have crashed or failed to write summaries. Escalating.",
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
				return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `verdict missing for ${phase.role}` };
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
					return { status: "escalated", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `revision cap reached for ${phase.role}` };
				}

				// Loop back to predecessor non-review phase
				const predIndex = findPredecessorIndex(PHASES, currentPhaseIndex);
				ctx.ui.notify(
					`⟳ forge:run-task — ${phase.role} returned revision; looping to ${PHASES[predIndex]?.role ?? predIndex} ` +
						`(attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
					"info",
				);
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

		// ── Advance to next phase ─────────────────────────────────────
		registry.completePhase(taskId, phase.role, "completed");
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
	return { status: "completed", lastPhaseIndex: PHASES.length - 1, iterationCounts, model: lastModel, provider: lastProvider };
}

// ── Thin wrapper registration ────────────────────────────────────────────

export interface RegisterRunTaskOptions {
	cwd?: string;
}

export function registerRunTask(pi: ExtensionAPI, options: RegisterRunTaskOptions = {}): void {
	pi.registerCommand("forge:run-task", {
		description:
			"Run the full task pipeline (plan → review → implement → validate → approve → commit). " +
			"Usage: /forge:run-task <TASK_ID>. " +
			"Orchestrator archetype: each phase is an isolated subagent session (IL10).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const taskId = args.trim();

			if (!taskId) {
				ctx.ui.notify("× forge:run-task — task ID required. Usage: /forge:run-task <TASK_ID>", "error");
				return;
			}

			ctx.ui.setStatus?.(STATUS_KEY, `run-task ${taskId}: initializing…`);

			// Register the session in the live registry that the thread-switcher reads from.
			const registry = getSessionRegistry();
			registry.startSession(taskId);

			// ── Discover forge config ────────────────────────────────────────
			const forgeConfig = discoverForgeConfig(cwd);
			if (!forgeConfig) {
				ctx.ui.notify("× forge:run-task — no Forge project found at cwd. Run /forge:init first.", "error");
				registry.completeSession(taskId, "failed");
				ctx.ui.setStatus?.(STATUS_KEY, undefined);
				ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
				return;
			}
			const forgeRoot = forgeConfig.forgeRoot;

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
							registry.completeSession(taskId, "failed");
							ctx.ui.setStatus?.(STATUS_KEY, undefined);
							ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
							return;
						}
					} else {
						// Non-interactive: auto-abort on stale state
						ctx.ui.notify("forge:run-task — stale state; non-interactive mode auto-aborting.", "info");
						registry.completeSession(taskId, "failed");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}
				} else {
					// Fresh state: offer resume
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume ${taskId}?`,
							`Cached state found at phase ${existing.phaseIndex} (saved at ${formatLocalTime(existing.savedAt)}). Resume from here?`,
						);
						if (resume) {
							resumeFromState = existing;
							ctx.ui.notify(
								`forge:run-task — resuming ${taskId} from phase ${PHASES[existing.phaseIndex]?.role ?? existing.phaseIndex}`,
								"info",
							);
						} else {
							// Restart from beginning
							deleteState(cwd, taskId);
						}
					} else {
						// Non-interactive + halted state: auto-abort
						ctx.ui.notify(
							`forge:run-task — cached state for ${taskId} found but non-interactive mode; aborting.`,
							"info",
						);
						registry.completeSession(taskId, "failed");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}
				}
			}

			// ── Delegate to pipeline ─────────────────────────────────────────
			const pipelineResult = await runTaskPipeline({
				taskId,
				cwd,
				ctx,
				forgeRoot,
				storeCli,
				preflightGate,
				registry,
				resumeFromState,
			});

			// ── Handle result ────────────────────────────────────────────────
			if (pipelineResult.status === "completed") {
				registry.completeSession(taskId, "completed");
				ctx.ui.notify(
					`〇 forge:run-task — ${taskId} pipeline complete (${PHASES.length} phases).`,
					"info",
				);
			} else {
				registry.completeSession(taskId, "failed");
			}

			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
		},
	});
}