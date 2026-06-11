// reset-pipeline.ts — FEAT-009 (halt-recovery UX): guardrailed pipeline-state
// reset for the run-task AND fix-bug pipelines.
//
// Encapsulates exactly the manual recovery an operator otherwise performs by
// hand after a halt: force the entity to the status a target phase expects, and
// rewrite the resume-state cache to re-enter at that phase. Deterministic and
// store-aware:
//   - the target phase must be a known phase for the entity's pipeline;
//   - the status it sets is the phase's documented pre-status, which lies within
//     that phase's own step-0b allowed-states set, so the phase guard accepts it
//     on resume;
//   - the FSM transition is applied via store-cli with the operator-gated
//     --force escape hatch (FORGE_ALLOW_FORCE=1), because terminal states
//     (blocked / fixed / escalated) are otherwise un-exitable by design.
//
// Sprint reset is intentionally NOT handled here: a sprint runs member tasks in
// dependency waves, so resetting it means rewinding the wave pointer and
// cascade-resetting member tasks coherently — a cross-entity, referential-
// integrity-sensitive operation that belongs in the guardrailed /forge:reset
// (FEAT-009 T03), not this single-entity deterministic helper.
//
// IL6 — store-cli is invoked via spawnSync argv array, never shell-string
// interpolation. The status-setter is injectable so unit tests need not spawn.

import { spawnSync } from "node:child_process";

import { BUG_PHASE_PRE_STATUS, bugPhaseIndexByRole } from "../bug/bug-phases.js";
import { deleteBugState, writeBugState } from "../bug/bug-state.js";
import { PHASE_PRE_STATUS, phaseIndexByRole } from "../task/task-phases.js";
import { writeState } from "../task/task-state.js";

export type ResetEntityKind = "task" | "bug";

export interface ResetPlan {
	role: string;
	phaseIndex: number;
	preStatus: string;
}

interface EntityProfile {
	preStatus: Record<string, string>;
	indexOf: (role: string) => number;
	/** store-cli entity verb for update-status. */
	storeEntity: ResetEntityKind;
	/** Rewrite the resume-state cache to re-enter at phaseIndex, non-halted. */
	writeResume: (cwd: string, id: string, phaseIndex: number) => void;
}

const PROFILES: Record<ResetEntityKind, EntityProfile> = {
	task: {
		preStatus: PHASE_PRE_STATUS,
		indexOf: phaseIndexByRole,
		storeEntity: "task",
		writeResume(cwd, id, phaseIndex) {
			// Leave `status` unset: with halted:false and no status, the resume
			// prompt labels it "interrupted" and offers to resume from this phase.
			writeState(cwd, {
				taskId: id,
				phaseIndex,
				iterationCounts: {},
				halted: false,
				savedAt: new Date().toISOString(),
			});
		},
	},
	bug: {
		preStatus: BUG_PHASE_PRE_STATUS,
		indexOf: bugPhaseIndexByRole,
		storeEntity: "bug",
		writeResume(cwd, id, phaseIndex) {
			// Bug state files are session-suffixed (fix-bug-state-<id>-<session>);
			// clear every session's file first so resume globs exactly one fresh
			// state, then write the rewound state.
			deleteBugState(cwd, id);
			writeBugState(cwd, {
				bugId: id,
				phaseIndex,
				iterationCounts: {},
				halted: false,
				savedAt: new Date().toISOString(),
			});
		},
	},
};

/**
 * Pure planner: resolve the target phase to its index + pre-status for the given
 * entity kind. Returns an `error` string for an unknown phase (no IO, fully
 * unit-testable).
 */
export function planReset(kind: ResetEntityKind, toPhase: string): ResetPlan | { error: string } {
	const profile = PROFILES[kind];
	const role = toPhase.trim();
	const phaseIndex = profile.indexOf(role);
	if (phaseIndex < 0) {
		const known = Object.keys(profile.preStatus).join(", ");
		return { error: `Unknown ${kind} phase '${role}'. Known phases: ${known}` };
	}
	const preStatus = profile.preStatus[role];
	if (!preStatus) {
		return { error: `No pre-status mapping for ${kind} phase '${role}'` };
	}
	return { role, phaseIndex, preStatus };
}

/** Result of a status-setter call. */
export interface SetStatusResult {
	ok: boolean;
	/** Status the record held before the transition, if known. */
	from?: string;
	/** Error detail on failure. */
	detail?: string;
}

export interface ResetPipelineParams {
	/** Which pipeline's state to reset. */
	kind: ResetEntityKind;
	cwd: string;
	/** Task or bug id. */
	id: string;
	/** Target phase role (e.g. "implement", "triage"). */
	toPhase: string;
	/** Absolute path to store-cli.cjs. */
	storeCli: string;
	/**
	 * Override the status-setter (tests inject a stub). Defaults to a
	 * force-transition via store-cli with FORGE_ALLOW_FORCE=1.
	 */
	setStatus?: (status: string) => SetStatusResult;
}

export interface ResetPipelineResult {
	ok: boolean;
	role?: string;
	phaseIndex?: number;
	preStatus?: string;
	detail?: string;
}

/**
 * Force an entity's status to the target phase's pre-status and rewrite the
 * resume-state cache so the pipeline re-enters at that phase. Returns
 * `{ok:false, detail}` rather than throwing on a planning or status-set failure;
 * the resume-state is written ONLY after the status transition succeeds, so a
 * failed reset never leaves a half-rewound pipeline.
 */
export function resetPipelineState(p: ResetPipelineParams): ResetPipelineResult {
	const plan = planReset(p.kind, p.toPhase);
	if ("error" in plan) {
		return { ok: false, detail: plan.error };
	}

	const profile = PROFILES[p.kind];
	const setStatus =
		p.setStatus ?? defaultForceSetStatus(p.storeCli, profile.storeEntity, p.id, p.cwd);
	const setResult = setStatus(plan.preStatus);
	if (!setResult.ok) {
		return {
			ok: false,
			role: plan.role,
			phaseIndex: plan.phaseIndex,
			preStatus: plan.preStatus,
			detail: setResult.detail ?? `failed to set status to ${plan.preStatus}`,
		};
	}

	profile.writeResume(p.cwd, p.id, plan.phaseIndex);

	return { ok: true, role: plan.role, phaseIndex: plan.phaseIndex, preStatus: plan.preStatus };
}

/**
 * Default status-setter: force-transition the entity via store-cli. Uses the
 * operator-gated --force escape hatch (FORGE_ALLOW_FORCE=1) so terminal states
 * (blocked / fixed / escalated) can be recovered. Argv array — no shell
 * interpolation.
 */
function defaultForceSetStatus(
	storeCli: string,
	storeEntity: ResetEntityKind,
	id: string,
	cwd: string,
): (status: string) => SetStatusResult {
	return (status: string): SetStatusResult => {
		const r = spawnSync(
			"node",
			[storeCli, "update-status", storeEntity, id, "status", status, "--force"],
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, FORGE_ALLOW_FORCE: "1" },
			},
		);
		if (r.status === 0) {
			return { ok: true };
		}
		const detail = (r.stderr || r.stdout || "").trim() || `store-cli exited ${r.status}`;
		return { ok: false, detail };
	};
}
