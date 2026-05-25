// Canonical phase definitions for the "default" pipeline.
// Inlined here so the config-tui module doesn't import the orchestrator
// (which would pull in pi-coding-agent runtime). Stays in sync via tests.

export const CANONICAL_PHASES: ReadonlyArray<{ role: string; personaNoun: string }> = [
	{ role: "plan", personaNoun: "engineer" },
	{ role: "review-plan", personaNoun: "supervisor" },
	{ role: "implement", personaNoun: "engineer" },
	{ role: "review-code", personaNoun: "supervisor" },
	{ role: "validate", personaNoun: "qa-engineer" },
	{ role: "approve", personaNoun: "architect" },
	{ role: "writeback", personaNoun: "collator" },
	{ role: "commit", personaNoun: "engineer" },
];
