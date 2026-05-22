// Auto-emit friction events with 5 skill subkinds — FORGE-S24-T11.
//
// At task close, the orchestrator hands a snapshot of {retrieved skills,
// usage verdicts (T09), task outcome, observed tool errors, per-skill
// historical "unused" counts, pairwise retrieval overlaps} to this module.
// `computeFrictionSignals` is a pure classifier; `emitFrictionEvents` writes
// one `friction` event per signal via `node <storeCli> emit <sprintId> …`.
//
// Gating logic (acceptance criteria FORGE-S24-T11):
//   - skill_unused     : retrieved && !used && task.success
//   - skill_failed     : retrieved && used  && !task.success
//   - skill_missing    : !retrieved && task.success && tool_errors ≥ 2
//   - skill_stale      : retrieved && !used across 3 consecutive sprints
//   - skill_redundant  : two skills' retrieval overlap > 0.8 in this task
//
// Each event carries `{type: "friction", workflow, persona, issue, subkind,
// skillId, evidence, …runtime attribution}`. The required-trio
// `{workflow, persona, issue}` is what the event schema (plugin v0.45.x)
// enforces for `type === "friction"`.
//
// Telemetry-actor split (IL10):
//   - Orchestrator owns emission. Subagents never call this module directly.
//   - Runtime attribution (model/provider/timestamps/durationMinutes) is
//     SUPPLIED by the orchestrator — never fabricated here.
//
// Iron Laws (forge-cli-engineer):
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL2  — TypeScript + TypeBox. Runtime inputs validated via Value.Parse.
//   IL6  — argv-array spawn. No shell-string interpolation.
//   IL7  — failures surface in the returned counter and stderrs[]; nothing
//          is silently swallowed.
//   IL10 — orchestrator-side emission only; subagent never invokes.
//
// Scope boundary: this module classifies and emits. It does NOT crawl
// the trajectory, decide what counts as a "tool error", or compute
// retrieval overlaps. The caller (orchestrator handler in run-task.ts /
// fix-bug.ts, gated by FORGE-S24-T12 flag) does that and passes the
// shaped inputs in.

import { spawnSync } from "node:child_process";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

// ── Public schemas ──────────────────────────────────────────────────────────

/**
 * One retrieved-and-classified skill for the closed task. `retrieved`
 * comes from T08 (skill-retriever); `used` from T09 (skill-usage-tracker).
 * `retrievalScore` is the T08 score (informational — surfaces in evidence).
 */
export const RetrievedSkillSignalSchema = Type.Object({
	skillId: Type.String({ minLength: 1 }),
	retrieved: Type.Boolean(),
	used: Type.Boolean(),
	retrievalScore: Type.Number({ minimum: 0, maximum: 1 }),
});
export type RetrievedSkillSignal = Static<typeof RetrievedSkillSignalSchema>;

/** Per-skill historical signal — supplied by caller from sprint history. */
export const SkillHistorySchema = Type.Object({
	consecutiveUnusedSprints: Type.Integer({ minimum: 0 }),
});
export type SkillHistory = Static<typeof SkillHistorySchema>;

/** One pairwise retrieval-overlap measurement for the closed task. */
export const PairwiseOverlapSchema = Type.Object({
	skillA: Type.String({ minLength: 1 }),
	skillB: Type.String({ minLength: 1 }),
	overlap: Type.Number({ minimum: 0, maximum: 1 }),
});
export type PairwiseOverlap = Static<typeof PairwiseOverlapSchema>;

export const FrictionInputsSchema = Type.Object({
	retrievedSkills: Type.Array(RetrievedSkillSignalSchema),
	taskSuccess: Type.Boolean(),
	toolErrorCount: Type.Integer({ minimum: 0 }),
	history: Type.Record(Type.String(), SkillHistorySchema),
	pairwiseRetrievalOverlap: Type.Optional(Type.Array(PairwiseOverlapSchema)),
});
export type FrictionInputs = Static<typeof FrictionInputsSchema>;

export const FRICTION_SUBKINDS = [
	"skill_unused",
	"skill_failed",
	"skill_missing",
	"skill_stale",
	"skill_redundant",
] as const;
export type FrictionSubkind = (typeof FRICTION_SUBKINDS)[number];

/**
 * One classifier output. `skillId` is `undefined` for `skill_missing`
 * (no skill to attribute) but always set for the other four subkinds.
 */
export interface FrictionSignal {
	subkind: FrictionSubkind;
	skillId: string | undefined;
	evidence: Record<string, unknown>;
}

/** Runtime attribution supplied by the orchestrator (IL10). */
export const FrictionEmitRuntimeSchema = Type.Object({
	storeCli: Type.String({ minLength: 1 }),
	cwd: Type.String({ minLength: 1 }),
	sprintId: Type.String({ minLength: 1 }),
	taskId: Type.String({ minLength: 1 }),
	role: Type.String({ minLength: 1 }),
	action: Type.String({ minLength: 1 }),
	workflow: Type.String({ minLength: 1 }),
	persona: Type.String({ minLength: 1 }),
	phase: Type.Optional(Type.String()),
	iteration: Type.Optional(Type.Integer({ minimum: 1 })),
	startTimestamp: Type.String({ format: "date-time" }),
	endTimestamp: Type.String({ format: "date-time" }),
	durationMinutes: Type.Number({ minimum: 0 }),
	model: Type.String({ minLength: 1 }),
	provider: Type.String({ minLength: 1 }),
});
export type FrictionEmitRuntime = Static<typeof FrictionEmitRuntimeSchema>;

export interface FrictionEmitResult {
	emitted: number;
	failed: number;
	stderrs: string[];
}

// ── Classification ──────────────────────────────────────────────────────────

const STALE_THRESHOLD_SPRINTS = 3;
const REDUNDANCY_OVERLAP_FLOOR = 0.8;
const MISSING_TOOL_ERROR_FLOOR = 2;

/**
 * Apply the five gating rules and return one signal per matching emit.
 * Pure: no IO, no subprocess. Caller decides whether/when to emit.
 *
 * The `skill_unused` and `skill_failed` gates are mutually exclusive by
 * design — on a failed task we emit `skill_failed` (when used) rather
 * than `skill_unused`, so the two signals never double-count the same
 * outcome.
 */
export function computeFrictionSignals(
	inputs: FrictionInputs,
): FrictionSignal[] {
	Value.Parse(FrictionInputsSchema, inputs);

	const signals: FrictionSignal[] = [];

	for (const s of inputs.retrievedSkills) {
		// skill_unused — retrieved, not used, task succeeded.
		if (s.retrieved && !s.used && inputs.taskSuccess) {
			signals.push({
				subkind: "skill_unused",
				skillId: s.skillId,
				evidence: {
					retrievalScore: s.retrievalScore,
					taskSuccess: true,
				},
			});
		}

		// skill_failed — retrieved, used, task failed.
		if (s.retrieved && s.used && !inputs.taskSuccess) {
			signals.push({
				subkind: "skill_failed",
				skillId: s.skillId,
				evidence: {
					retrievalScore: s.retrievalScore,
					toolErrorCount: inputs.toolErrorCount,
				},
			});
		}

		// skill_stale — retrieved, not used, and the same {retrieved && !used}
		// pattern has held across STALE_THRESHOLD_SPRINTS consecutive sprints.
		if (s.retrieved && !s.used) {
			const hist = inputs.history[s.skillId];
			if (hist && hist.consecutiveUnusedSprints >= STALE_THRESHOLD_SPRINTS) {
				signals.push({
					subkind: "skill_stale",
					skillId: s.skillId,
					evidence: {
						consecutiveUnusedSprints: hist.consecutiveUnusedSprints,
					},
				});
			}
		}
	}

	// skill_missing — no skill retrieved AND task succeeded AND ≥2 tool errors.
	// Emitted once per task (no skillId — there's nothing to attribute).
	if (
		inputs.retrievedSkills.length === 0 &&
		inputs.taskSuccess &&
		inputs.toolErrorCount >= MISSING_TOOL_ERROR_FLOOR
	) {
		signals.push({
			subkind: "skill_missing",
			skillId: undefined,
			evidence: {
				toolErrorCount: inputs.toolErrorCount,
			},
		});
	}

	// skill_redundant — pairwise retrieval overlap strictly > 0.8. Emit one
	// signal per pair, attributed to the FIRST skill in the pair (skillA).
	for (const p of inputs.pairwiseRetrievalOverlap ?? []) {
		if (p.overlap > REDUNDANCY_OVERLAP_FLOOR) {
			signals.push({
				subkind: "skill_redundant",
				skillId: p.skillA,
				evidence: {
					pairedWith: p.skillB,
					overlap: p.overlap,
				},
			});
		}
	}

	return signals;
}

// ── Emission ────────────────────────────────────────────────────────────────

/** ISO-compact timestamp segment for eventId composition. */
function isoCompact(iso: string): string {
	return iso.replace(/[-:.]/g, "").replace(/Z$/, "Z");
}

/**
 * Emit one `friction` event per signal via
 * `node <storeCli> emit <sprintId> <json>`. Runtime attribution
 * (model/provider/timestamps/eventId) is supplied by the caller — never
 * fabricated. Failures surface in the result counter; nothing is thrown
 * for subprocess failure.
 */
export function emitFrictionEvents(
	signals: readonly FrictionSignal[],
	runtime: FrictionEmitRuntime,
): FrictionEmitResult {
	Value.Parse(FrictionEmitRuntimeSchema, runtime);

	let emitted = 0;
	let failed = 0;
	const stderrs: string[] = [];

	for (let i = 0; i < signals.length; i++) {
		const sig = signals[i];

		const idTail = sig.skillId ?? "none";
		const eventId =
			`${isoCompact(runtime.startTimestamp)}_${runtime.taskId}_friction_${sig.subkind}_${i}_${idTail}`;

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
			type: "friction",
			workflow: runtime.workflow,
			persona: runtime.persona,
			issue: sig.subkind,
			subkind: sig.subkind,
			evidence: sig.evidence,
		};
		if (sig.skillId !== undefined) event.skillId = sig.skillId;
		if (runtime.phase !== undefined) event.phase = runtime.phase;
		if (runtime.iteration !== undefined) event.iteration = runtime.iteration;

		const result = spawnSync(
			"node",
			[runtime.storeCli, "emit", runtime.sprintId, JSON.stringify(event)],
			{ cwd: runtime.cwd, encoding: "utf8" },
		);
		if (result.status === 0) {
			emitted++;
		} else {
			failed++;
			const stderr = typeof result.stderr === "string" ? result.stderr : "";
			stderrs.push(stderr);
		}
	}

	return { emitted, failed, stderrs };
}
