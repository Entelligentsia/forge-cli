// phase-summary-map.ts — Single source of truth mapping bug-mode
// PhaseRole values to the canonical summary key written by the
// base-pack workflows. Hoisted out of fix-bug.ts (FORGE-BUG-040) so
// the new phase-guard.ts can compare a subagent's phase context
// against the `phase` argument passed to forge_store
// set-bug-summary / set-summary without inducing a circular import
// (fix-bug.ts → forge-tools.ts → phase-guard.ts → fix-bug.ts).
//
// Phases mapped to null use update-status bug instead of
// set-bug-summary for verdict tracking (Option B). Adding a new
// bug-mode phase requires extending this map AND PhaseRole in
// caller-context.ts.

export const BUG_SUMMARY_KEY_BY_ROLE: Record<string, string | null> = {
	triage: "triage",
	"plan-fix": "plan",
	"review-plan": "review_plan",
	implement: "implementation",
	"review-code": "code_review",
	approve: "approve", // read from bug.summaries.approve (set-bug-summary)
	commit: null, // commit transitions bug.status → fixed (terminal), no summaries entry
};

// Task-mode counterpart, keyed by TASK PhaseRole → store summaries key written
// by `set-summary` (mirrors the plugin's PHASE_TO_KIND / VALID_SUMMARY_PHASES).
// The phase-guard MUST pick this map for `set-summary` and BUG_SUMMARY_KEY_BY_ROLE
// for `set-bug-summary` — the task-only roles `plan` and `validate` are absent
// from the bug map, so using the bug map for task summaries wrongly rejects them
// (forge-cli phase-guard bug A, cartographer CART-S01-T02). A null value means
// the phase writes no summary (set-summary forbidden from it).
export const TASK_SUMMARY_KEY_BY_ROLE: Record<string, string | null> = {
	plan: "plan",
	"review-plan": "review_plan",
	implement: "implementation",
	"review-code": "code_review",
	validate: "validation",
	approve: "approve",
	writeback: null, // collator writes WRITEBACK-SUMMARY.json to disk, never via set-summary (Iron Law 1)
	commit: null, // commit writes no summary
};
