// Browse-TUI orchestrator — pi-tui Component + Focusable. Owns universal
// keys (q quit, Esc clear-search/quit), reducer dispatch, cursor clamping,
// and the exit callbacks. NEVER opens the dashboard itself: selection is
// surfaced via onSelect(runId) and the command owns overlay choreography
// (sequential overlays keep the input-router depth at exactly 1).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BrowseScreen } from "./screens/browse.js";
import type { InputResult } from "./screens/types.js";
import {
	type BrowseAction,
	type BrowseState,
	filteredRows,
	initialBrowseState,
	type ListRow,
	reducer,
} from "./state/index.js";

export interface BrowseTuiComponentOptions {
	/** Archived runs (caller does the archive I/O — collectListRows()). */
	rows: ListRow[];
	/** Known project keys (caller reads projects.json). */
	knownProjects: string[];
	theme: Theme;
	/** A run was chosen — the caller opens the replay dashboard. */
	onSelect: (runId: string) => void;
	/** The browser was closed without a selection. */
	onExit: () => void;
	/** Invalidate hook supplied by the TUI driver (forces re-render). */
	requestRender?: () => void;
	/** Test seam for the since-filter cutoff; defaults to Date.now(). */
	now?: number;
}

export class BrowseTuiComponent implements Component, Focusable {
	private state: BrowseState;
	private readonly opts: BrowseTuiComponentOptions;
	private readonly screen = new BrowseScreen();
	private exited = false;

	/** Focusable — pi sets this to true when the overlay has keyboard focus.
	 *  Without this, arrow keys don't route to handleInput (config-tui 07e886f). */
	focused: boolean = false;

	constructor(opts: BrowseTuiComponentOptions) {
		this.opts = opts;
		this.state = initialBrowseState({
			rows: opts.rows,
			knownProjects: opts.knownProjects,
			...(opts.now !== undefined ? { now: opts.now } : {}),
		});
	}

	invalidate(): void {
		// Stateless renderer; no cache to drop. (Iron Law 5: no render caching.)
	}

	render(width: number): string[] {
		const theme = this.opts.theme;
		const contentLines = this.screen.render(this.state, width, theme);

		const bgFn = (s: string) => theme.bg("selectedBg", s);
		const lines: string[] = [];
		lines.push(...new DynamicBorder((s) => theme.fg("borderAccent", s)).render(width));
		// Width-safety layer 2: truncate + pad each line so the background
		// fills the full row (visibleWidth ignores theme ANSI codes).
		for (const line of contentLines) {
			const truncated = truncateToWidth(line, width, "");
			const vis = visibleWidth(truncated);
			lines.push(bgFn(vis < width ? truncated + " ".repeat(width - vis) : truncated));
		}
		lines.push(...new DynamicBorder((s) => theme.fg("borderAccent", s)).render(width));
		return lines;
	}

	handleInput(data: string): void {
		if (this.state.shouldExit) return;

		// Universal keys — orchestrator-owned (screens must not intercept).
		if (matchesKey(data, Key.escape)) {
			if (this.state.searchActive || this.state.searchQuery) {
				// First Esc leaves search mode and clears the query.
				this.dispatch({ kind: "exit-search" });
				this.dispatch({ kind: "set-search", query: "" });
				return;
			}
			this.dispatch({ kind: "request-quit" });
			this.maybeFinish();
			return;
		}
		if (!this.state.searchActive && matchesKey(data, "q")) {
			this.dispatch({ kind: "request-quit" });
			this.maybeFinish();
			return;
		}

		this.handleResult(this.screen.handleInput(data, this.state));
		this.maybeFinish();
	}

	/** Test/inspection seam. */
	getState(): BrowseState {
		return this.state;
	}

	private handleResult(result: InputResult): void {
		switch (result.kind) {
			case "dispatch":
				this.dispatch(result.action);
				break;
			case "dispatch-seq":
				for (const action of result.actions) this.dispatch(action);
				break;
			case "quit":
				this.dispatch({ kind: "request-quit" });
				break;
			case "error":
			case "consumed":
				this.opts.requestRender?.();
				break;
			case "no-op":
				break;
		}
	}

	private dispatch(action: BrowseAction): void {
		this.state = reducer(this.state, action);
		// Cursor upper bound depends on the filtered view — clamp after
		// every action (the reducer only clamps the lower bound).
		const max = Math.max(0, filteredRows(this.state).length - 1);
		if (this.state.cursor > max) {
			this.state = reducer(this.state, { kind: "cursor-clamp", max });
		}
		this.opts.requestRender?.();
	}

	private maybeFinish(): void {
		if (!this.state.shouldExit || this.exited) return;
		this.exited = true;
		if (this.state.selectedRunId) this.opts.onSelect(this.state.selectedRunId);
		else this.opts.onExit();
	}
}
