// Pure (state, action) → state reducer for the browse TUI.
//
// Cursor lower-bound clamps here; the UPPER bound depends on
// filteredRows().length, which the component knows — it dispatches an
// explicit cursor-clamp after every state change (mirrors config-tui's
// documented reducer/component split).

import type { BrowseAction, BrowseState } from "./model.js";
import { nextKind, nextOutcome, nextProject, nextSince } from "./selectors.js";

export function reducer(state: BrowseState, action: BrowseAction): BrowseState {
	switch (action.kind) {
		case "cursor-move":
			return { ...state, cursor: Math.max(0, state.cursor + action.delta) };
		case "cursor-clamp":
			return { ...state, cursor: Math.max(0, Math.min(state.cursor, action.max)) };
		case "cycle-kind":
			return {
				...state,
				cursor: 0,
				filters: { ...state.filters, kind: nextKind(state.filters.kind) },
			};
		case "cycle-outcome":
			return {
				...state,
				cursor: 0,
				filters: { ...state.filters, outcome: nextOutcome(state.filters.outcome) },
			};
		case "cycle-project":
			return {
				...state,
				cursor: 0,
				filters: { ...state.filters, projectKey: nextProject(state.filters.projectKey, state.knownProjects) },
			};
		case "cycle-since":
			return {
				...state,
				cursor: 0,
				filters: { ...state.filters, sinceDays: nextSince(state.filters.sinceDays) },
			};
		case "enter-search":
			return { ...state, searchActive: true };
		case "set-search":
			// Query change invalidates the selection — reset to the top match.
			return { ...state, searchQuery: action.query, cursor: 0 };
		case "exit-search":
			return { ...state, searchActive: false };
		case "select-run":
			return { ...state, selectedRunId: action.runId, shouldExit: true };
		case "request-quit":
			return { ...state, shouldExit: true };
	}
}
