// Skill usage tracker — FORGE-S24-T09.
//
// After a task completes, diff the actual tool-call sequence against each
// retrieved skill's declared workflow steps and emit a follow-up `skill_usage`
// event per retrieved skill with `used: true | false` and a populated
// `tool_call_success_rate`. Conforms to the canonical `skill_usage` event
// schema variant landed in FORGE-S24-T01 (plugin v0.45.0).
//
// Heuristic (per FORGE-S24-T09 acceptance criteria):
//   - Skill name appears in agent reasoning text                  → used: true
//   - ≥2 distinct workflow steps overlap with executed tool calls → used: true
//   - Otherwise                                                    → used: false
//
// `tool_call_success_rate` is the fraction of the skill's declared workflow
// steps that were observed in the trajectory (distinct overlaps / total
// steps), clamped to [0,1]. For skills with no declared steps, the rate is 0.
//
// Iron Laws (forge-cli-engineer):
//   IL2  — TypeScript + TypeBox. Runtime input is validated by `Value.Parse`
//          at the public emission entry point.
//   IL6  — No raw shell-string interpolation. `emitSkillUsageTrackingEvents`
//          calls `spawnSync("node", [storeCli, "emit", sprintId, JSON.stringify(event)])`
//          — argv array, no shell.
//   IL7  — No silent continuation past failures. A non-zero `store-cli emit`
//          exit increments the `failed` counter and the stderr text is
//          forwarded to the caller in the returned result; nothing is
//          swallowed.
//   IL10 — This module runs in **orchestrator context** (telemetry-actor
//          split — see `engineering/architecture/telemetry-actor-split.md`).
//          The orchestrator/caller supplies the runtime attribution
//          (model/provider/timestamps/durationMinutes) — never fabricated
//          here. The subagent NEVER invokes this tracker directly.
//
// Scope boundary: this module owns classification + emission. It does NOT
// crawl the filesystem for skills, parse subagent transcripts, or decide
// when "task close" is. The caller (Orchestrator handler — `run-task.ts`,
// `fix-bug.ts`, gated behind FORGE-S24-T12 feature flag) assembles the
// retrieved-skill list, trajectory, and runtime attribution, then invokes
// `emitSkillUsageTrackingEvents`.

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { spawnStoreCliEmit } from "../lib/spawn-store-cli.js";
import { isSkillCurationEnabled } from "./skill-curation-flag.js";

// ── Public schemas ───────────────────────────────────────────────────────

/**
 * One skill that was previously retrieved (T08) and is now being evaluated
 * for actual usage. `workflowSteps` is the list of declared step / tool /
 * action names the skill's SKILL.md (or workflow doc) advertises — these
 * are what we diff the trajectory against.
 *
 * Step matching is case-insensitive substring: a tool call's `name` matches
 * a workflow step if the step (after lowercasing + whitespace collapse)
 * appears anywhere in the tool call's name. This is intentionally permissive
 * — declared steps are human-authored phrases ("store-cli query"), and tool
 * call names may be qualified (`mcp__store__store-cli-query`). Misses bias
 * toward `used: false`, which is the safer of the two error modes for a
 * curation signal.
 */
export const RetrievedSkillForTrackingSchema = Type.Object({
	skillId: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	workflowSteps: Type.Array(Type.String()),
});
export type RetrievedSkillForTracking = Static<typeof RetrievedSkillForTrackingSchema>;

/** One observed tool invocation in the task's trajectory. */
export const ToolCallObservationSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
});
export type ToolCallObservation = Static<typeof ToolCallObservationSchema>;

/**
 * The observable trajectory of a closed task: the sequence of tool calls
 * the agent made, plus the concatenated reasoning / assistant text the
 * orchestrator captured. Both inputs are supplied by the caller — this
 * module does not read transcripts itself.
 */
export const TaskTrajectorySchema = Type.Object({
	toolCalls: Type.Array(ToolCallObservationSchema),
	reasoningText: Type.String(),
});
export type TaskTrajectory = Static<typeof TaskTrajectorySchema>;

/**
 * Runtime attribution supplied by the caller (orchestrator).
 * These are NEVER fabricated inside the tracker (IL10).
 */
export const EmitRuntimeSchema = Type.Object({
	storeCli: Type.String({ minLength: 1 }),
	cwd: Type.String({ minLength: 1 }),
	sprintId: Type.String({ minLength: 1 }),
	taskId: Type.String({ minLength: 1 }),
	role: Type.String({ minLength: 1 }),
	action: Type.String({ minLength: 1 }),
	phase: Type.Optional(Type.String()),
	iteration: Type.Optional(Type.Integer({ minimum: 1 })),
	startTimestamp: Type.String({ format: "date-time" }),
	endTimestamp: Type.String({ format: "date-time" }),
	durationMinutes: Type.Number({ minimum: 0 }),
	model: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
});
export type EmitRuntime = Static<typeof EmitRuntimeSchema>;

export interface EmitResult {
	emitted: number;
	failed: number;
	stderrs: string[];
}

/** Why the classifier ruled `used: true`, or `"none"` when it ruled false. */
export type UsageSignal = "overlap" | "reasoning" | "none";

export interface UsageVerdict {
	used: boolean;
	signal: UsageSignal;
	tool_call_success_rate: number;
}

// ── Classification ───────────────────────────────────────────────────────

/** Lowercase + collapse whitespace; safe for substring comparison. */
function normalize(s: string): string {
	return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Count the number of distinct declared workflow steps that appear in the
 * observed tool-call sequence (case-insensitive substring). A step that
 * matches multiple tool calls is counted once.
 */
function countStepOverlap(steps: readonly string[], toolCalls: readonly ToolCallObservation[]): number {
	if (steps.length === 0 || toolCalls.length === 0) return 0;
	const observed = toolCalls.map((c) => normalize(c.name));
	let hits = 0;
	for (const step of steps) {
		const needle = normalize(step);
		if (needle.length === 0) continue;
		if (observed.some((o) => o.includes(needle))) hits++;
	}
	return hits;
}

/**
 * Apply the FORGE-S24-T09 heuristic to a single retrieved skill against
 * the observed task trajectory. Pure function — no IO, no allocation
 * beyond return value.
 */
export function classifySkillUsage(skill: RetrievedSkillForTracking, trajectory: TaskTrajectory): UsageVerdict {
	const overlap = countStepOverlap(skill.workflowSteps, trajectory.toolCalls);
	const totalSteps = skill.workflowSteps.length;

	let rate = 0;
	if (totalSteps > 0) {
		const raw = overlap / totalSteps;
		if (!Number.isFinite(raw) || raw < 0) rate = 0;
		else if (raw > 1) rate = 1;
		else rate = raw;
	}

	// Signal 1: skill name appears in agent reasoning. The reasoning text is
	// normalised the same way as steps so casing/whitespace doesn't cause
	// false negatives.
	const reasoning = normalize(trajectory.reasoningText);
	const skillNeedle = normalize(skill.name);
	const mentionedInReasoning = skillNeedle.length > 0 && reasoning.includes(skillNeedle);

	// Signal 2: ≥2 distinct workflow steps overlapped with executed tool calls.
	const overlapStrong = overlap >= 2;

	if (overlapStrong) {
		return { used: true, signal: "overlap", tool_call_success_rate: rate };
	}
	if (mentionedInReasoning) {
		return { used: true, signal: "reasoning", tool_call_success_rate: rate };
	}
	return { used: false, signal: "none", tool_call_success_rate: rate };
}

// ── Emission ─────────────────────────────────────────────────────────────

/** Compose an ISO-compact timestamp segment for the eventId. */
function isoCompact(iso: string): string {
	return iso.replace(/[-:.]/g, "").replace(/Z$/, "Z");
}

/**
 * Emit one `skill_usage` tracking event per retrieved skill via
 * `node <storeCli> emit <sprintId> <json>`. Each event carries the
 * classifier's `used` verdict and the observed `tool_call_success_rate`.
 *
 * `retrieval_score` is set to 0 — at tracking time, the score has already
 * been emitted in the T08 retrieval event; this follow-up captures the
 * usage signal only. (The schema requires the field to be present; it does
 * not require it to be re-derived per emission.)
 *
 * Never throws on subprocess failure — the failure is surfaced via the
 * returned counter and stderr text (IL7, explicit not silent).
 */
export function emitSkillUsageTrackingEvents(
	retrieved: readonly RetrievedSkillForTracking[],
	trajectory: TaskTrajectory,
	runtime: EmitRuntime,
): EmitResult {
	// FORGE-S24-T12 — gated rollout. Default off ⇒ no classification, no
	// events, no subprocess.
	if (!isSkillCurationEnabled(runtime.cwd)) {
		return { emitted: 0, failed: 0, stderrs: [] };
	}

	Value.Parse(EmitRuntimeSchema, runtime);
	Value.Parse(TaskTrajectorySchema, trajectory);
	for (const s of retrieved) Value.Parse(RetrievedSkillForTrackingSchema, s);

	let emitted = 0;
	let failed = 0;
	const stderrs: string[] = [];

	for (let i = 0; i < retrieved.length; i++) {
		const skill = retrieved[i];
		const verdict = classifySkillUsage(skill, trajectory);

		const eventId = `${isoCompact(runtime.startTimestamp)}_${runtime.taskId}_skill-usage-tracker_skill_usage_${i}_${skill.skillId}`;

		const event: Record<string, unknown> = {
			eventId,
			sprintId: runtime.sprintId,
			taskId: runtime.taskId,
			role: runtime.role,
			action: runtime.action,
			startTimestamp: runtime.startTimestamp,
			endTimestamp: runtime.endTimestamp,
			durationMinutes: runtime.durationMinutes,
			model: runtime.model,
			provider: runtime.provider,
			type: "skill_usage",
			skillId: skill.skillId,
			retrieved: true,
			used: verdict.used,
			tool_call_success_rate: verdict.tool_call_success_rate,
			retrieval_score: 0,
		};
		if (runtime.phase !== undefined) event.phase = runtime.phase;
		if (runtime.iteration !== undefined) event.iteration = runtime.iteration;

		// FORGE-S25-T17: adopt spawnStoreCliEmit; adds missing 10 s timeout (N-C-A).
		const emitResult = spawnStoreCliEmit(runtime.storeCli, runtime.sprintId, event, runtime.cwd);
		if (emitResult.ok) {
			emitted++;
		} else {
			failed++;
			stderrs.push(emitResult.stderr);
		}
	}

	return { emitted, failed, stderrs };
}
