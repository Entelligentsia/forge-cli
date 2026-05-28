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
