// Browse-TUI state model — pure data, no I/O (three-layer architecture).
//
// One screen (the run browser) plus an overlaid incremental-search mode, so
// no view stack is needed — far simpler than config-tui's View[] stack.

// Type-only import — erased at compile time, so the runtime module graph
// stays acyclic (transcripts-command imports this TUI in the other direction).
import type { ListRow } from "../../commands/transcripts-command.js";

export type { ListRow };

export type KindFilter = "all" | "task" | "bug" | "sprint";
export type OutcomeFilter = "all" | "complete" | "halted" | "error" | "incomplete" | "cancelled";
/** Recency window in days; null = no limit. Cycles 7 → 30 → 90 → null. */
export type SinceFilter = 7 | 30 | 90 | null;

export interface BrowseFilters {
	kind: KindFilter;
	outcome: OutcomeFilter;
	/** Project key to pin, or null for all projects. */
	projectKey: string | null;
	sinceDays: SinceFilter;
}

export interface BrowseState {
	/** All archived runs, loaded once by the caller (I/O stays outside). */
	rows: ListRow[];
	/** Known project keys, cycle order for the project filter. */
	knownProjects: string[];
	/** Cursor index into filteredRows(state) — NOT into rows. */
	cursor: number;
	filters: BrowseFilters;
	searchActive: boolean;
	searchQuery: string;
	shouldExit: boolean;
	/** Set by select-run; the component surfaces it via onSelect. */
	selectedRunId: string | null;
	/** Captured at init so the since-filter cutoff is pure + testable. */
	now: number;
}

export type BrowseAction =
	| { kind: "cursor-move"; delta: number }
	| { kind: "cursor-clamp"; max: number }
	| { kind: "cycle-kind" }
	| { kind: "cycle-outcome" }
	| { kind: "cycle-project" }
	| { kind: "cycle-since" }
	| { kind: "enter-search" }
	| { kind: "set-search"; query: string }
	| { kind: "exit-search" }
	| { kind: "select-run"; runId: string }
	| { kind: "request-quit" };
