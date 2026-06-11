// bug-phases.ts — bug phase descriptor table, bug-event type tokens, terminal
// states, and the orchestrator-owned post-triage status transitions. Extracted
// VERBATIM from fix-bug.ts (FORGE-S31 file-size refactor); no logic changes.

import type { PhaseDescriptor } from "../task/task-phases.js";

// ── Bug phase descriptor table ──────────────────────────────────────────────
//
// Decoded from .forge/workflows/fix_bug.md and the task prompt's BUG_PHASES.
// triage / plan-fix / implement all read the same fix_bug.md body — the
// workflow handles all three phases through prose.

// FORGE-S25-T16: readPersonaDirBug / readPipelineNamesBug extracted to
// lib/catalog-helpers.ts and imported above with aliases (H-4, N-H-G).

export const BUG_PHASES: PhaseDescriptor[] = [
	// FORGE-BUG-040: each phase points at its own phase-scoped subagent workflow.
	// Previously triage/plan-fix/implement all pointed at fix_bug.md (the
	// orchestrator-only body), which caused the triage subagent to execute
	// the full lifecycle in a single invocation. plan-fix and implement reuse
	// plan_task.md / implement_plan.md (bug-mode) per meta-fix-bug.md
	// § Pipeline Phases — the bug-mode entity-kind detection is built into
	// those workflows already.
	{ role: "triage", workflowFile: "triage", personaNoun: "bug-fixer", isReview: false, maxIterations: 1 },
	{ role: "plan-fix", workflowFile: "plan_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-plan", workflowFile: "review_plan", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "implement", workflowFile: "implement_plan", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-code", workflowFile: "review_code", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "approve", workflowFile: "architect_approve", personaNoun: "architect", isReview: true, maxIterations: 3 },
	{ role: "commit", workflowFile: "commit_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
];

// FEAT-009 (halt-recovery UX): the bug status a record must hold for a given
// phase to (re-)run — the status `resetPipelineState` sets when rewinding the
// fix-bug pipeline to that phase. The bug FSM is intentionally coarse
// (reported → triaged → in-progress → fixed): `triage` owns reported→triaged→
// in-progress, then NO phase writes bug.status until `commit` does
// in-progress→fixed (meta-fix-bug.md § Iron Laws #2 — verdicts travel through
// summaries, not status). So every post-triage phase resets to `in-progress`;
// only `triage` resets to `reported`. The reset is therefore dominated by the
// resume-state phaseIndex, with status forced to the right coarse bucket.
export const BUG_PHASE_PRE_STATUS: Record<string, string> = {
	triage: "reported",
	"plan-fix": "in-progress",
	"review-plan": "in-progress",
	implement: "in-progress",
	"review-code": "in-progress",
	approve: "in-progress",
	commit: "in-progress",
};

/** Index of a bug phase in the BUG_PHASES table by role, or -1 if unknown. */
export function bugPhaseIndexByRole(role: string): number {
	return BUG_PHASES.findIndex((p) => p.role === role);
}

// ── Bug-event type tokens ──────────────────────────────────────────────────
// Explicit mapping per review finding #3. Non-review phases always emit the
// pass token. Review phases select pass or fail based on ec.judgement.verdict.
// The event-vocabulary contract test scans this literal block here.
export const BUG_TYPE_TOKENS: Record<string, { pass: string; fail: string }> = {
	triage: { pass: "bug-triaged", fail: "bug-triaged" },
	"plan-fix": { pass: "fix-planned", fail: "fix-planned" },
	"review-plan": { pass: "fix-review-passed", fail: "fix-review-failed" },
	implement: { pass: "fix-implemented", fail: "fix-implemented" },
	"review-code": { pass: "fix-code-review-passed", fail: "fix-code-review-failed" },
	approve: { pass: "fix-approved", fail: "fix-revision-requested" },
	commit: { pass: "bug-committed", fail: "bug-commit-failed" },
};

// ── Bug FSM transitions ────────────────────────────────────────────────────
// Mirrors store-cli BUG_TRANSITIONS. Terminal: `fixed`.
// `approved` and `verified` enum values were dropped in forge v0.44.0
// (FORGE-BUG-002 trap). The canonical source is store-cli.cjs.

export const BUG_TERMINAL_STATES = new Set(["fixed"]);

// Post-triage status transitions the ORCHESTRATOR owns (meta-fix-bug.md
// step 2: "On return, orchestrator transitions status: triaged then
// in-progress" — a required two-step state-machine contract; the FSM
// forbids the one-step reported → in-progress jump). First live firing of
// commit-task.cjs exposed this as unimplemented: bugs reached the commit
// phase still 'reported' and the terminal-status guard fired every run.
// Returns the ordered list of statuses to write from the given status —
// idempotent on resume (already in-progress / terminal → no-op).
export function postTriageTransitions(status: string | undefined): string[] {
	if (status === "reported") return ["triaged", "in-progress"];
	if (status === "triaged") return ["in-progress"];
	return [];
}
