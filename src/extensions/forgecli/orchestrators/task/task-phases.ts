// task-phases.ts — phase descriptor table for the /forge:run-task pipeline.
// Extracted from run-task.ts (no logic changes). run-task.ts re-exports these.

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
