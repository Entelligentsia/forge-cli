// Initial browse state. Pure — the caller does the archive I/O
// (collectListRows / readProjects) and hands the data in.

import type { BrowseState, ListRow } from "./model.js";

export interface BrowseInitOptions {
	rows: ListRow[];
	knownProjects: string[];
	/** Test seam; defaults to Date.now(). */
	now?: number;
}

export function initialBrowseState(opts: BrowseInitOptions): BrowseState {
	return {
		// Most recent first, guaranteed here rather than trusted from the
		// caller — ISO startedAt compares lexicographically as time.
		rows: [...opts.rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
		knownProjects: opts.knownProjects,
		cursor: 0,
		filters: { kind: "all", outcome: "all", projectKey: null, sinceDays: null },
		searchActive: false,
		searchQuery: "",
		shouldExit: false,
		selectedRunId: null,
		now: opts.now ?? Date.now(),
	};
}
