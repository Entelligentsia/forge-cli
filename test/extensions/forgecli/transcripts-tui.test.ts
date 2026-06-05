// Browse-TUI tests: reducer, selectors, screen render (mock theme, WIDTH=80),
// and component keystroke behavior (onSelect/onExit callbacks).

import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ListRow } from "../../../src/extensions/forgecli/commands/transcripts-command.js";
import { BrowseTuiComponent } from "../../../src/extensions/forgecli/transcripts-tui/component.js";
import { BrowseScreen, windowRows } from "../../../src/extensions/forgecli/transcripts-tui/screens/browse.js";
import {
	activeFilterSummary,
	filteredRows,
	initialBrowseState,
	nextProject,
	reducer,
} from "../../../src/extensions/forgecli/transcripts-tui/state/index.js";

const WIDTH = 80;
const NOW = Date.parse("2026-06-05T12:00:00.000Z");

const mockTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

function row(overrides: Partial<ListRow>): ListRow {
	return {
		runId: "20260601T100000Z",
		projectKey: "cart-aaaaaaaa",
		projectName: "Cartographer",
		entityId: "CART-BUG-001",
		entityKind: "bug",
		startedAt: "2026-06-01T10:00:00.000Z",
		outcome: "complete",
		input: 1000,
		output: 200,
		cost: 0.5,
		durationMs: 660000,
		...overrides,
	};
}

const ROWS: ListRow[] = [
	row({}),
	row({
		runId: "20260520T090000Z",
		entityId: "FORGE-S30-T07",
		entityKind: "task",
		sprintId: "FORGE-S30",
		projectKey: "forge-bbbbbbbb",
		projectName: "Forge",
		startedAt: "2026-05-20T09:00:00.000Z",
		outcome: "halted",
	}),
	row({
		runId: "20260410T080000Z",
		entityId: "CART-S01-T02",
		entityKind: "task",
		sprintId: "CART-S01",
		startedAt: "2026-04-10T08:00:00.000Z",
		outcome: "incomplete",
	}),
];

function freshState(rows: ListRow[] = ROWS) {
	return initialBrowseState({ rows, knownProjects: ["cart-aaaaaaaa", "forge-bbbbbbbb"], now: NOW });
}

// ── reducer ──────────────────────────────────────────────────────────────

describe("browse reducer", () => {
	it("cursor moves clamp at zero; cursor-clamp bounds the top end", () => {
		let s = freshState();
		s = reducer(s, { kind: "cursor-move", delta: -5 });
		expect(s.cursor).toBe(0);
		s = reducer(s, { kind: "cursor-move", delta: 10 });
		s = reducer(s, { kind: "cursor-clamp", max: 2 });
		expect(s.cursor).toBe(2);
	});

	it("filter cycling resets the cursor and walks the cycle back to all", () => {
		let s = freshState();
		s = reducer(s, { kind: "cursor-move", delta: 2 });
		s = reducer(s, { kind: "cycle-kind" });
		expect(s.filters.kind).toBe("task");
		expect(s.cursor).toBe(0);
		s = reducer(s, { kind: "cycle-kind" });
		s = reducer(s, { kind: "cycle-kind" });
		s = reducer(s, { kind: "cycle-kind" });
		expect(s.filters.kind).toBe("all");
	});

	it("search lifecycle: enter → set → exit; set resets cursor", () => {
		let s = freshState();
		s = reducer(s, { kind: "enter-search" });
		expect(s.searchActive).toBe(true);
		s = reducer(s, { kind: "cursor-move", delta: 2 });
		s = reducer(s, { kind: "set-search", query: "cart" });
		expect(s.searchQuery).toBe("cart");
		expect(s.cursor).toBe(0);
		s = reducer(s, { kind: "exit-search" });
		expect(s.searchActive).toBe(false);
		expect(s.searchQuery).toBe("cart"); // sticky filter
	});

	it("select-run records the run and requests exit", () => {
		const s = reducer(freshState(), { kind: "select-run", runId: "20260601T100000Z" });
		expect(s.selectedRunId).toBe("20260601T100000Z");
		expect(s.shouldExit).toBe(true);
	});
});

// ── selectors ────────────────────────────────────────────────────────────

describe("browse selectors", () => {
	it("filteredRows applies each dimension", () => {
		const s = freshState();
		expect(filteredRows(s)).toHaveLength(3);
		expect(filteredRows({ ...s, filters: { ...s.filters, kind: "bug" } }).map((r) => r.entityId)).toEqual([
			"CART-BUG-001",
		]);
		expect(filteredRows({ ...s, filters: { ...s.filters, outcome: "halted" } })).toHaveLength(1);
		expect(filteredRows({ ...s, filters: { ...s.filters, projectKey: "forge-bbbbbbbb" } })).toHaveLength(1);
		// since 7d from NOW (2026-06-05): only the 2026-06-01 run survives
		expect(filteredRows({ ...s, filters: { ...s.filters, sinceDays: 7 } })).toHaveLength(1);
	});

	it("search matches entityId, sprintId, and project name (case-insensitive)", () => {
		const s = freshState();
		expect(filteredRows({ ...s, searchQuery: "forge-s30" })).toHaveLength(1);
		expect(filteredRows({ ...s, searchQuery: "CART" })).toHaveLength(2);
		expect(filteredRows({ ...s, searchQuery: "cartographer" })).toHaveLength(2);
		expect(filteredRows({ ...s, searchQuery: "nope" })).toHaveLength(0);
	});

	it("combined filters intersect", () => {
		const s = freshState();
		const out = filteredRows({
			...s,
			filters: { ...s.filters, kind: "task", projectKey: "cart-aaaaaaaa" },
		});
		expect(out.map((r) => r.entityId)).toEqual(["CART-S01-T02"]);
	});

	it("activeFilterSummary reflects state", () => {
		const s = freshState();
		expect(activeFilterSummary(s)).toBe("kind:all · outcome:all · project:all · since:all");
		const busy = {
			...s,
			searchQuery: "cart",
			filters: { kind: "bug" as const, outcome: "complete" as const, projectKey: "cart-aaaaaaaa", sinceDays: 7 as const },
		};
		expect(activeFilterSummary(busy)).toBe("kind:bug · outcome:complete · project:cart-aaaaaaaa · since:7d · /cart");
	});

	it("nextProject cycles null → each known → null", () => {
		const known = ["a", "b"];
		expect(nextProject(null, known)).toBe("a");
		expect(nextProject("a", known)).toBe("b");
		expect(nextProject("b", known)).toBe(null);
		expect(nextProject(null, [])).toBe(null);
	});
});

// ── screen render ────────────────────────────────────────────────────────

describe("BrowseScreen render", () => {
	const screen = new BrowseScreen();

	it("renders header, filter summary, rows, cursor marker, and hints — width-safe", () => {
		const s = freshState();
		const lines = screen.render(s, WIDTH, mockTheme);
		const joined = lines.join("\n");
		expect(joined).toContain("Transcript Archive");
		expect(joined).toContain("kind:all · outcome:all");
		expect(joined).toContain("CART-BUG-001");
		expect(joined).toContain("⏎ replay");
		// Cursor on first row
		const cursorLines = lines.filter((l) => l.includes("▸"));
		expect(cursorLines).toHaveLength(1);
		expect(cursorLines[0]).toContain("CART-BUG-001");
		// Width safety: no line exceeds WIDTH visible chars (truncateToWidth
		// may append ANSI even with a mock theme — measure visible width)
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});

	it("renders the empty state when no rows match", () => {
		const s = { ...freshState(), searchQuery: "zzz" };
		const joined = screen.render(s, WIDTH, mockTheme).join("\n");
		expect(joined).toContain("no archived runs match");
	});

	it("renders search mode with the query inline", () => {
		let s = freshState();
		s = reducer(s, { kind: "enter-search" });
		s = reducer(s, { kind: "set-search", query: "car" });
		const joined = screen.render(s, WIDTH, mockTheme).join("\n");
		expect(joined).toContain("search: car");
		expect(joined).toContain("esc clear");
	});

	it("windowRows centers the cursor and reports above/below counts", () => {
		const items = Array.from({ length: 40 }, (_, i) => i);
		const win = windowRows(items, 20, 15);
		expect(win.visible).toHaveLength(15);
		expect(win.aboveCount).toBeGreaterThan(0);
		expect(win.belowCount).toBeGreaterThan(0);
		expect(win.visible).toContain(20);
	});
});

// ── component behavior ───────────────────────────────────────────────────

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };

function buildComponent(rows: ListRow[] = ROWS) {
	const events: Array<{ kind: string; runId?: string }> = [];
	const component = new BrowseTuiComponent({
		rows,
		knownProjects: ["cart-aaaaaaaa", "forge-bbbbbbbb"],
		theme: mockTheme,
		now: NOW,
		onSelect: (runId) => events.push({ kind: "select", runId }),
		onExit: () => events.push({ kind: "exit" }),
	});
	return { component, events };
}

describe("BrowseTuiComponent", () => {
	it("Enter on the cursor row emits onSelect with that runId", () => {
		const { component, events } = buildComponent();
		component.handleInput(KEY.down);
		component.handleInput(KEY.enter);
		expect(events).toEqual([{ kind: "select", runId: "20260520T090000Z" }]);
	});

	it("q emits onExit without a selection", () => {
		const { component, events } = buildComponent();
		component.handleInput("q");
		expect(events).toEqual([{ kind: "exit" }]);
	});

	it("Esc clears search first, then quits", () => {
		const { component, events } = buildComponent();
		component.handleInput("/");
		component.handleInput("c");
		component.handleInput("a");
		expect(component.getState().searchQuery).toBe("ca");
		component.handleInput(KEY.escape);
		expect(component.getState().searchQuery).toBe("");
		expect(component.getState().searchActive).toBe(false);
		expect(events).toEqual([]);
		component.handleInput(KEY.escape);
		expect(events).toEqual([{ kind: "exit" }]);
	});

	it("filter keys narrow the table and cursor clamps to the filtered view", () => {
		const { component } = buildComponent();
		component.handleInput(KEY.down);
		component.handleInput(KEY.down); // cursor 2
		component.handleInput("k"); // kind: task → 2 rows, cursor reset by reducer
		expect(component.getState().filters.kind).toBe("task");
		expect(component.getState().cursor).toBe(0);
		const visible = filteredRows(component.getState());
		expect(visible).toHaveLength(2);
	});

	it("search typing narrows; Enter accepts and then selects", () => {
		const { component, events } = buildComponent();
		component.handleInput("/");
		for (const ch of "forge-s30") component.handleInput(ch);
		expect(filteredRows(component.getState())).toHaveLength(1);
		component.handleInput(KEY.enter); // accept search
		expect(component.getState().searchActive).toBe(false);
		component.handleInput(KEY.enter); // select the single match
		expect(events).toEqual([{ kind: "select", runId: "20260520T090000Z" }]);
	});

	it("render wraps content in borders and respects width", () => {
		const { component } = buildComponent();
		const lines = component.render(WIDTH);
		expect(lines.length).toBeGreaterThan(5);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});
});
