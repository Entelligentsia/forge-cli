// bug-verdict.ts — read the routing verdict for a bug phase from the bug
// record (approve summary / commit status / review summaries). Extracted
// VERBATIM from fix-bug.ts (FORGE-S31 file-size refactor); no logic changes.

import type { BugRecord } from "./bug-id.js";

// ── Bug verdict reading ──────────────────────────────────────────────────

export type BugVerdict = "approved" | "revision" | "n/a" | "missing";

export function readBugVerdict(
	bugRecord: BugRecord | null,
	phaseRole: string,
	summaryKeyByRole: Record<string, string | null>,
): BugVerdict {
	if (!bugRecord) return "missing";

	// Approve phase: read approve summary verdict (set via set-bug-summary).
	// The forge v0.44.0 contract makes summaries.approve.verdict the canonical
	// approve signal for bugs — `bug.status` does NOT carry an "approved"
	// value (that enum was dropped). See read-verdict.cjs §
	// BUG_PHASE_VERDICT_SOURCE for the matching plugin-side wiring.
	if (phaseRole === "approve") {
		const summaryKey = summaryKeyByRole["approve"];
		if (summaryKey) {
			const summaries = bugRecord.summaries ?? {};
			const blob = (summaries as Record<string, unknown>)[summaryKey];
			if (blob && typeof blob === "object") {
				const verdict = (blob as Record<string, unknown>)?.verdict;
				if (typeof verdict === "string") {
					if (verdict === "approved") return "approved";
					if (verdict === "revision") return "revision";
				}
			}
		}
		return "missing";
	}

	// Commit phase: read bug status directly. Terminal target is `fixed`.
	if (phaseRole === "commit") {
		if (bugRecord.status === "fixed") return "approved";
		// in-progress means commit did not advance status — treat as revision-needed.
		if (bugRecord.status === "in-progress") return "revision";
		return "missing";
	}

	// Review phases: read from summaries via key map.
	const summaryKey = summaryKeyByRole[phaseRole];
	if (!summaryKey) return "missing";

	const summaries = bugRecord.summaries ?? {};
	const blob = (summaries as Record<string, unknown>)[summaryKey];
	if (!blob || typeof blob !== "object") return "missing";

	const verdict = (blob as Record<string, unknown>)?.verdict;
	if (typeof verdict !== "string") return "missing";
	if (verdict === "approved") return "approved";
	if (verdict === "revision") return "revision";
	return "missing";
}
