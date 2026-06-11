// reset-pipeline.ts — FEAT-009 (halt-recovery UX): guardrailed pipeline-state
// reset for the run-task pipeline.
//
// Encapsulates exactly the manual recovery an operator otherwise performs by
// hand after a halt: force the task to the status a target phase expects, and
// rewrite the run-task resume-state cache to re-enter at that phase. The reset
// is deterministic and store-aware:
//   - the target phase must be a known run-task phase;
//   - the status it sets is the phase's documented pre-status (PHASE_PRE_STATUS),
//     which lies within that phase's own step-0b allowed-states set, so the
//     phase guard accepts it on resume;
//   - the FSM transition is applied via store-cli with the operator-gated
//     --force escape hatch (FORGE_ALLOW_FORCE=1), because `blocked`/terminal
//     states are otherwise un-exitable by design.
//
// IL6 — store-cli is invoked via spawnSync argv array, never shell-string
// interpolation. The status-setter is injectable so unit tests need not spawn.

import { spawnSync } from "node:child_process";

import { PHASE_PRE_STATUS, phaseIndexByRole } from "./task-phases.js";
import { writeState } from "./task-state.js";

export interface ResetPlan {
	role: string;
	phaseIndex: number;
	preStatus: string;
}

/**
 * Pure planner: resolve the target phase to its index + pre-status. Returns an
 * `error` string for an unknown phase (no IO, fully unit-testable).
 */
export function planReset(toPhase: string): ResetPlan | { error: string } {
	const role = toPhase.trim();
	const phaseIndex = phaseIndexByRole(role);
	if (phaseIndex < 0) {
		const known = Object.keys(PHASE_PRE_STATUS).join(", ");
		return { error: `Unknown phase '${role}'. Known phases: ${known}` };
	}
	const preStatus = PHASE_PRE_STATUS[role];
	if (!preStatus) {
		return { error: `No pre-status mapping for phase '${role}'` };
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
	cwd: string;
	taskId: string;
	/** Target phase role (e.g. "implement", "plan"). */
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
 * Force a task's status to the target phase's pre-status and rewrite the
 * run-task resume-state cache so the pipeline re-enters at that phase.
 * Best-effort transparency: returns `{ok:false, detail}` rather than throwing
 * on a planning or status-set failure (the resume-state is only written once
 * the status transition succeeds, so a failed reset never leaves a half-rewound
 * pipeline).
 */
export function resetPipelineState(p: ResetPipelineParams): ResetPipelineResult {
	const plan = planReset(p.toPhase);
	if ("error" in plan) {
		return { ok: false, detail: plan.error };
	}

	const setStatus = p.setStatus ?? defaultForceSetStatus(p.storeCli, p.taskId, p.cwd);
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

	// Leave `status` unset: with halted:false and no status, run-task-command's
	// resume prompt labels it "interrupted" and offers to resume from this phase.
	writeState(p.cwd, {
		taskId: p.taskId,
		phaseIndex: plan.phaseIndex,
		iterationCounts: {},
		halted: false,
		savedAt: new Date().toISOString(),
	});

	return { ok: true, role: plan.role, phaseIndex: plan.phaseIndex, preStatus: plan.preStatus };
}

/**
 * Default status-setter: force-transition the task via store-cli. Uses the
 * operator-gated --force escape hatch (FORGE_ALLOW_FORCE=1) so terminal states
 * (blocked/escalated) can be recovered. Argv array — no shell interpolation.
 */
function defaultForceSetStatus(
	storeCli: string,
	taskId: string,
	cwd: string,
): (status: string) => SetStatusResult {
	return (status: string): SetStatusResult => {
		const r = spawnSync(
			"node",
			[storeCli, "update-status", "task", taskId, "status", status, "--force"],
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
