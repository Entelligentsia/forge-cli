// phase-vocab.ts — single phase-vocabulary module for the context governor.
// FORGE-BUG-043 PR 1.
//
// One canonical table mapping run-task pipeline phase keys
// (`${personaNoun}/${role}`) to the PLUGIN-owned summary vocabulary:
//
//   summaryKey      — the `summaries.*` key written by `store-cli set-summary`.
//                     Mirror of forge/tools/store-cli.cjs VALID_SUMMARY_PHASES
//                     (underscore spellings).
//   summaryFilename — the durable {PHASE}-SUMMARY.json artifact filename.
//                     Mirror of forge/tools/lib/artifact-kinds.cjs
//                     ARTIFACT_CATALOG via PHASE_TO_KIND (hyphen spellings —
//                     REVIEW-PLAN-SUMMARY.json, REVIEW-CODE-SUMMARY.json).
//
// Before this module, context-governor.ts and context-governor-compaction.ts
// each carried their own copy of these maps, and both had drifted from the
// plugin catalog: they invented REVIEW_PLAN-SUMMARY.json / CODE_REVIEW-SUMMARY.json
// spellings that never exist on disk, so warm-tier reads silently missed and
// steer messages named phantom files. The catalog contract is pinned by
// test/extensions/forgecli/phase-vocab.test.ts.
//
// Scope note — this is the governor's vocabulary, NOT a verdict-source map:
//   - run-task.ts SUMMARY_KEY_BY_ROLE maps approve → null because run-task
//     reads the approve VERDICT from task.status, not from summaries.approve.
//   - subagent/phase-summary-map.ts TASK_SUMMARY_KEY_BY_ROLE is the
//     phase-guard's write-PERMISSION map.
//   Here approve → "approve" because the store accepts and pipelines do write
//   summaries.approve (67/279 task records as of 2026-06-04) — the Mechanism C
//   sentinel may legitimately probe it. Three maps, three concerns; this module
//   owns only the governor's view.
//
// A follow-up task promotes this (plus the Mechanism D policy table) to
// plugin-generated project config so the vocabulary is sourced from
// .forge/config.json rather than mirrored here.

/** One governed pipeline phase's summary vocabulary. */
export interface PhaseVocabEntry {
	/** `${personaNoun}/${role}` — the governor's policy/lookup key. */
	phaseKey: string;
	/** Workflow role name (run-task PHASES.role). */
	role: string;
	/** Persona noun (run-task PHASES.personaNoun). */
	personaNoun: string;
	/** `summaries.*` store key, or null when the phase writes no summary entry. */
	summaryKey: string | null;
	/** Catalog {PHASE}-SUMMARY.json filename, or null when the phase has none. */
	summaryFilename: string | null;
}

/**
 * Vocabulary for every run-task PHASE_PIPELINE phase.
 * Order mirrors run-task.ts PHASES.
 */
export const PHASE_VOCAB: readonly PhaseVocabEntry[] = [
	{ phaseKey: "engineer/plan", role: "plan", personaNoun: "engineer", summaryKey: "plan", summaryFilename: "PLAN-SUMMARY.json" },
	{ phaseKey: "supervisor/review-plan", role: "review-plan", personaNoun: "supervisor", summaryKey: "review_plan", summaryFilename: "REVIEW-PLAN-SUMMARY.json" },
	{ phaseKey: "engineer/implement", role: "implement", personaNoun: "engineer", summaryKey: "implementation", summaryFilename: "IMPLEMENTATION-SUMMARY.json" },
	{ phaseKey: "supervisor/review-code", role: "review-code", personaNoun: "supervisor", summaryKey: "code_review", summaryFilename: "REVIEW-CODE-SUMMARY.json" },
	{ phaseKey: "qa-engineer/validate", role: "validate", personaNoun: "qa-engineer", summaryKey: "validation", summaryFilename: "VALIDATION-SUMMARY.json" },
	{ phaseKey: "architect/approve", role: "approve", personaNoun: "architect", summaryKey: "approve", summaryFilename: "APPROVE-SUMMARY.json" },
	// writeback's artifact is written to disk by the collator (never via
	// set-summary — Iron Law 1); commit writes no summary at all.
	{ phaseKey: "collator/writeback", role: "writeback", personaNoun: "collator", summaryKey: null, summaryFilename: "WRITEBACK-SUMMARY.json" },
	{ phaseKey: "engineer/commit", role: "commit", personaNoun: "engineer", summaryKey: null, summaryFilename: "COMMIT-SUMMARY.json" },
];

/**
 * Legacy design-time keys retained verbatim from the pre-consolidation maps.
 * The pipeline never produces them; existing mechanism-b/c test fixtures do.
 * (CODE_REVIEW-SUMMARY.json here is the legacy invented spelling, kept only
 * so the legacy fixture key keeps resolving to what it always resolved to.)
 */
const LEGACY_PHASE_VOCAB: Record<string, { summaryKey: string | null; summaryFilename: string }> = {
	"architect/plan": { summaryKey: "plan", summaryFilename: "PLAN-SUMMARY.json" },
	"engineer/review": { summaryKey: "review_plan", summaryFilename: "REVIEW-SUMMARY.json" },
	"engineer/code-review": { summaryKey: "code_review", summaryFilename: "CODE_REVIEW-SUMMARY.json" },
};

const VOCAB_BY_PHASE_KEY: ReadonlyMap<string, { summaryKey: string | null; summaryFilename: string | null }> =
	new Map([
		...PHASE_VOCAB.map(
			(e) => [e.phaseKey, { summaryKey: e.summaryKey, summaryFilename: e.summaryFilename }] as const,
		),
		...Object.entries(LEGACY_PHASE_VOCAB),
	]);

/**
 * Resolve the summary vocabulary for a phase key.
 * Returns undefined for unknown keys (e.g. custom config.pipelines phases) —
 * callers must degrade gracefully, never invent placeholder names.
 */
export function vocabForPhaseKey(
	phaseKey: string,
): { summaryKey: string | null; summaryFilename: string | null } | undefined {
	return VOCAB_BY_PHASE_KEY.get(phaseKey);
}

/** Catalog summary filename for a phase key, or null (unknown key / no artifact). */
export function summaryFilenameFor(phaseKey: string): string | null {
	return vocabForPhaseKey(phaseKey)?.summaryFilename ?? null;
}

/** Store `summaries.*` key for a phase key, or null (unknown key / no summary). */
export function summaryKeyFor(phaseKey: string): string | null {
	return vocabForPhaseKey(phaseKey)?.summaryKey ?? null;
}
