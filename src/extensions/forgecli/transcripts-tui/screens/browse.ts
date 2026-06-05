// Browse screen — the archived-run table with filters, cursor, and
// incremental search. Pure: render(state, width, theme) → string[];
// handleInput(data, state) → InputResult. No state mutation, no I/O.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { BrowseState, ListRow } from "../state/model.js";
import { activeFilterSummary, filteredRows } from "../state/selectors.js";
import { accent, accentBold, cursor, muted, padOrTruncate, rule, safeLines } from "../theme.js";
import type { InputResult, Screen } from "./types.js";

/** Rows visible in the table window (list scrolls around the cursor). */
const WINDOW_ROWS = 15;

// ── Cell formatters (display-only; mirror the text-command columns) ─────

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function fmtDuration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// Column widths (visible chars; ANSI-safe via padOrTruncate).
const COLS = { started: 16, project: 14, entity: 22, run: 16, outcome: 10, tokens: 12, time: 7 } as const;

function headerRow(theme: Theme): string {
	return muted(
		"  " +
			[
				padOrTruncate("started", COLS.started),
				padOrTruncate("project", COLS.project),
				padOrTruncate("entity", COLS.entity),
				padOrTruncate("run", COLS.run),
				padOrTruncate("outcome", COLS.outcome),
				padOrTruncate("in/out", COLS.tokens),
				padOrTruncate("time", COLS.time),
			].join("  "),
		theme,
	);
}

function dataRow(row: ListRow, selected: boolean, theme: Theme): string {
	const entity = row.entityId + (row.sprintId ? ` (${row.sprintId})` : "");
	const cells = [
		padOrTruncate(row.startedAt.slice(0, 16).replace("T", " "), COLS.started),
		padOrTruncate(row.projectName, COLS.project),
		padOrTruncate(entity, COLS.entity),
		padOrTruncate(row.runId, COLS.run),
		padOrTruncate(row.outcome, COLS.outcome),
		padOrTruncate(`${fmtTokens(row.input)}/${fmtTokens(row.output)}`, COLS.tokens),
		padOrTruncate(fmtDuration(row.durationMs), COLS.time),
	].join("  ");
	return selected ? `${cursor(true, theme)} ${accent(cells, theme)}` : `${cursor(false, theme)} ${cells}`;
}

/** Windowed slice of rows around the cursor (same shape as config-tui's windowList). */
export function windowRows<T>(
	items: T[],
	cursorIndex: number,
	maxRows = WINDOW_ROWS,
): { visible: T[]; start: number; aboveCount: number; belowCount: number } {
	if (items.length <= maxRows) return { visible: items, start: 0, aboveCount: 0, belowCount: 0 };
	const half = Math.floor(maxRows / 2);
	let start = Math.max(0, cursorIndex - half);
	if (start + maxRows > items.length) start = items.length - maxRows;
	return {
		visible: items.slice(start, start + maxRows),
		start,
		aboveCount: start,
		belowCount: items.length - start - maxRows,
	};
}

function isPrintableInput(data: string): boolean {
	if (data.length === 0) return false;
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		return code >= 0x20 && code <= 0x7e;
	}
	return data.charCodeAt(0) !== 0x1b;
}

export class BrowseScreen implements Screen {
	render(state: BrowseState, width: number, theme: Theme): string[] {
		const rows = filteredRows(state);
		const lines: string[] = [];

		lines.push(accentBold(" Transcript Archive", theme));
		lines.push(muted(` ${activeFilterSummary(state)}`, theme));
		if (state.searchActive) {
			lines.push(`${accent(" search: ", theme)}${state.searchQuery}${accent("▏", theme)}${state.searchQuery ? "" : muted(" type to filter…", theme)}`);
		}
		lines.push(rule(width, theme));
		lines.push(headerRow(theme));

		if (rows.length === 0) {
			lines.push(muted("  (no archived runs match the active filters)", theme));
		} else {
			const win = windowRows(rows, state.cursor);
			if (win.aboveCount > 0) lines.push(muted(`  ↑ ${win.aboveCount} more`, theme));
			win.visible.forEach((row, i) => {
				lines.push(dataRow(row, win.start + i === state.cursor, theme));
			});
			if (win.belowCount > 0) lines.push(muted(`  ↓ ${win.belowCount} more`, theme));
		}

		lines.push(rule(width, theme));
		lines.push(
			muted(
				state.searchActive
					? " type to filter · backspace delete · ⏎ accept · esc clear"
					: " ↑↓ nav · ⏎ replay · k kind · o outcome · p project · s since · / search · esc/q close",
				theme,
			),
		);

		return safeLines(lines, width);
	}

	handleInput(data: string, state: BrowseState): InputResult {
		// Search mode: printable input edits the query; Enter accepts (keeps
		// the query as a sticky filter); Esc is the component's job.
		if (state.searchActive) {
			if (matchesKey(data, Key.backspace)) {
				return { kind: "dispatch", action: { kind: "set-search", query: state.searchQuery.slice(0, -1) } };
			}
			if (matchesKey(data, "ctrl+u")) {
				return { kind: "dispatch", action: { kind: "set-search", query: "" } };
			}
			if (matchesKey(data, Key.enter)) {
				return { kind: "dispatch", action: { kind: "exit-search" } };
			}
			if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
				// Allow navigating results without leaving search mode.
				return { kind: "dispatch", action: { kind: "cursor-move", delta: matchesKey(data, Key.up) ? -1 : 1 } };
			}
			if (isPrintableInput(data)) {
				return { kind: "dispatch", action: { kind: "set-search", query: state.searchQuery + data } };
			}
			return { kind: "no-op" };
		}

		if (matchesKey(data, Key.up)) return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		if (matchesKey(data, Key.down)) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
		if (matchesKey(data, Key.pageUp)) return { kind: "dispatch", action: { kind: "cursor-move", delta: -WINDOW_ROWS } };
		if (matchesKey(data, Key.pageDown)) return { kind: "dispatch", action: { kind: "cursor-move", delta: WINDOW_ROWS } };

		if (matchesKey(data, "k")) return { kind: "dispatch", action: { kind: "cycle-kind" } };
		if (matchesKey(data, "o")) return { kind: "dispatch", action: { kind: "cycle-outcome" } };
		if (matchesKey(data, "p")) return { kind: "dispatch", action: { kind: "cycle-project" } };
		if (matchesKey(data, "s")) return { kind: "dispatch", action: { kind: "cycle-since" } };
		if (matchesKey(data, "/")) return { kind: "dispatch", action: { kind: "enter-search" } };

		if (matchesKey(data, Key.enter)) {
			const rows = filteredRows(state);
			const row = rows[state.cursor];
			if (!row) return { kind: "no-op" };
			return { kind: "dispatch", action: { kind: "select-run", runId: row.runId } };
		}

		return { kind: "no-op" };
	}
}
