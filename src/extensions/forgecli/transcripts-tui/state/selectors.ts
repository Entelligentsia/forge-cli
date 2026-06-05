// Pure read helpers over BrowseState. filteredRows is the single source of
// truth for what's visible — the screen renders it and the component's
// Enter handler indexes into it, so cursor↔row mapping can never drift.

import type { BrowseState, KindFilter, ListRow, OutcomeFilter, SinceFilter } from "./model.js";

export function filteredRows(state: BrowseState): ListRow[] {
	const { kind, outcome, projectKey, sinceDays } = state.filters;
	const cutoff = sinceDays === null ? null : new Date(state.now - sinceDays * 86_400_000).toISOString();
	const query = state.searchQuery.trim().toLowerCase();

	return state.rows.filter((row) => {
		if (kind !== "all" && row.entityKind !== kind) return false;
		if (outcome !== "all" && row.outcome !== outcome) return false;
		if (projectKey !== null && row.projectKey !== projectKey) return false;
		if (cutoff !== null && row.startedAt < cutoff) return false;
		if (query) {
			const haystack = `${row.entityId} ${row.sprintId ?? ""} ${row.projectName}`.toLowerCase();
			if (!haystack.includes(query)) return false;
		}
		return true;
	});
}

/** Header line summarizing the active filters, e.g.
 *  "kind:bug · outcome:all · project:Cartographer · since:7d · /cart". */
export function activeFilterSummary(state: BrowseState): string {
	const { kind, outcome, projectKey, sinceDays } = state.filters;
	const parts = [
		`kind:${kind}`,
		`outcome:${outcome}`,
		`project:${projectKey ?? "all"}`,
		`since:${sinceDays === null ? "all" : `${sinceDays}d`}`,
	];
	if (state.searchQuery) parts.push(`/${state.searchQuery}`);
	return parts.join(" · ");
}

const KIND_CYCLE: KindFilter[] = ["all", "task", "bug", "sprint"];
const OUTCOME_CYCLE: OutcomeFilter[] = ["all", "complete", "halted", "error", "incomplete", "cancelled"];
const SINCE_CYCLE: SinceFilter[] = [null, 7, 30, 90];

export function nextKind(current: KindFilter): KindFilter {
	return KIND_CYCLE[(KIND_CYCLE.indexOf(current) + 1) % KIND_CYCLE.length];
}

export function nextOutcome(current: OutcomeFilter): OutcomeFilter {
	return OUTCOME_CYCLE[(OUTCOME_CYCLE.indexOf(current) + 1) % OUTCOME_CYCLE.length];
}

export function nextSince(current: SinceFilter): SinceFilter {
	return SINCE_CYCLE[(SINCE_CYCLE.indexOf(current) + 1) % SINCE_CYCLE.length];
}

/** null → first known project → … → last → null. */
export function nextProject(current: string | null, known: string[]): string | null {
	if (known.length === 0) return null;
	if (current === null) return known[0];
	const idx = known.indexOf(current);
	if (idx < 0 || idx === known.length - 1) return null;
	return known[idx + 1];
}
