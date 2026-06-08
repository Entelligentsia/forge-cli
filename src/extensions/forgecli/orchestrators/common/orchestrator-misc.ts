// orchestrator-misc.ts — generic orchestrator helpers shared across the
// task / sprint / bug pipelines. Extracted from run-task.ts (no logic changes)
// so the per-file architectural line cap is satisfied; run-task.ts re-exports
// these for backwards compatibility (fix-bug.ts and run-sprint.ts import them
// from run-task today).

// ── Non-interactive helpers ───────────────────────────────────────────────

export function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

/** Validate that an ID contains no path-traversal characters. */
export function validateId(id: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(id) && !id.includes("..");
}

/**
 * Format an ISO timestamp for human display in the user's local timezone.
 * Falls back to the raw ISO string if parsing fails.
 */
export function formatLocalTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const date = d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
	// Append short timezone abbreviation for unambiguous reading.
	const tz =
		new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
			.formatToParts(d)
			.find((p) => p.type === "timeZoneName")?.value ?? "";
	return tz ? `${date} ${tz}` : date;
}
