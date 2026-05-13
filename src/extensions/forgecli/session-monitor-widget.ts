// session-monitor-widget.ts — embedded TUI for live subagent sessions.
//
// Renders below the input swimline via ctx.ui.setWidget(..., { placement: "belowEditor" }).
// Two-pane layout: sessions list (left) and events list (right), with a details
// footer for the highlighted event. Arrow keys navigate within the focused pane;
// Tab / →/← switch focus between panes; Esc closes.
//
// Subscribes to the shared SessionRegistry — every run-task subagent event causes
// a re-render request.

import type { Component } from "@earendil-works/pi-tui";
import { SelectList, type SelectItem } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

import {
	getSessionRegistry,
	type SessionRegistry,
	type SessionState,
	type ToolEventRecord,
} from "./session-registry.js";

const MAX_VISIBLE_ROWS = 10;
const DETAIL_LINES = 8;

interface WidgetDeps {
	theme: Theme;
	requestRender: () => void;
	onClose: () => void;
	/** Called once after the widget instance is constructed. The session-monitor
	 * controller uses this to capture a reference for onTerminalInput routing. */
	onMount?: (widget: SessionMonitorWidget) => void;
}

/**
 * Build the widget factory expected by ctx.ui.setWidget.
 * The factory captures dependencies (theme, render hook, close hook) and
 * returns a fresh Component on each setWidget() call.
 */
export function buildSessionMonitorWidget(
	deps: Omit<WidgetDeps, "theme">,
): (tui: unknown, theme: Theme) => Component & { dispose?(): void } {
	return (_tui, theme) => {
		const w = new SessionMonitorWidget({
			theme,
			requestRender: deps.requestRender,
			onClose: deps.onClose,
		});
		deps.onMount?.(w);
		return w;
	};
}


type Pane = "sessions" | "events";

export class SessionMonitorWidget implements Component {
	private registry: SessionRegistry;
	private listener: (taskId: string) => void;
	private focusedPane: Pane = "sessions";
	private selectedTaskId?: string;
	private selectedEventIndex = 0;
	private sessionsList: SelectList;
	private eventsList: SelectList;
	private deps: WidgetDeps;
	private disposed = false;

	constructor(deps: WidgetDeps) {
		this.deps = deps;
		this.registry = getSessionRegistry();

		const selectTheme = buildSelectListTheme(deps.theme);
		this.sessionsList = new SelectList([], MAX_VISIBLE_ROWS, selectTheme);
		this.eventsList = new SelectList([], MAX_VISIBLE_ROWS, selectTheme);

		this.sessionsList.onSelectionChange = (item) => {
			this.selectedTaskId = item.value;
			this.selectedEventIndex = 0;
			this.rebuildEvents();
			this.deps.requestRender();
		};

		this.eventsList.onSelectionChange = (item) => {
			const idx = Number.parseInt(item.value, 10);
			if (!Number.isNaN(idx)) {
				this.selectedEventIndex = idx;
				this.deps.requestRender();
			}
		};

		this.refreshSessions();

		this.listener = (_taskId: string) => {
			if (this.disposed) return;
			this.refreshSessions();
			if (this.focusedPane === "events" || this.selectedTaskId) this.rebuildEvents();
			this.deps.requestRender();
		};
		this.registry.on("change", this.listener);
	}

	dispose(): void {
		this.disposed = true;
		this.registry.off("change", this.listener);
	}

	invalidate(): void {
		this.sessionsList.invalidate();
		this.eventsList.invalidate();
	}

	handleInput(data: string): void {
		// Tab or → → focus events pane; ← → focus sessions pane.
		// Esc closes the widget.
		// Anything else is delegated to the focused pane.
		if (data === "") {
			this.deps.onClose();
			return;
		}
		if (data === "\t" || data === "[C" /* right arrow */) {
			if (this.focusedPane === "sessions") {
				this.focusedPane = "events";
				this.deps.requestRender();
				return;
			}
		}
		if (data === "[D" /* left arrow */) {
			if (this.focusedPane === "events") {
				this.focusedPane = "sessions";
				this.deps.requestRender();
				return;
			}
		}
		if (this.focusedPane === "sessions") this.sessionsList.handleInput(data);
		else this.eventsList.handleInput(data);
	}

	render(width: number): string[] {
		const theme = this.deps.theme;
		const sessions = this.registry.listSessions();

		// Layout: left pane = 40 cols (or 40% if narrow), right pane = remainder.
		const leftWidth = Math.max(28, Math.min(44, Math.floor(width * 0.4)));
		const rightWidth = Math.max(20, width - leftWidth - 3); // 3 cols for gutter "│ "

		const header = theme.bold(
			theme.fg("accent", "Forge Sessions ") +
				theme.fg("muted", `(${sessions.length})   `) +
				theme.fg("muted", "[↑↓ nav  Tab/→ pane  Esc close]"),
		);

		const sessionLines =
			sessions.length === 0
				? [theme.fg("muted", "  (no live subagent sessions yet)")]
				: this.sessionsList.render(leftWidth);

		const focusedSession = this.selectedTaskId
			? this.registry.getSession(this.selectedTaskId)
			: undefined;

		const rightHeaderText = focusedSession
			? `Events: ${focusedSession.taskId} (${focusedSession.events.length})`
			: "Events";
		const rightHeader = theme.bold(theme.fg("accent", rightHeaderText));

		const eventLines = focusedSession
			? this.eventsList.render(rightWidth)
			: [theme.fg("muted", "  (select a session on the left)")];

		const sessionsPaneTitle =
			this.focusedPane === "sessions" ? theme.inverse(" sessions ") : theme.fg("muted", " sessions ");
		const eventsPaneTitle =
			this.focusedPane === "events" ? theme.inverse(" events ") : theme.fg("muted", " events ");

		const leftPane = [sessionsPaneTitle, ...sessionLines];
		const rightPane = [eventsPaneTitle, rightHeader, ...eventLines];

		const stitched = stitchPanes(leftPane, rightPane, leftWidth, rightWidth, theme);

		const detailLines = renderDetails(
			focusedSession,
			this.selectedEventIndex,
			width,
			theme,
		);

		return [header, "", ...stitched, "", ...detailLines];
	}

	private refreshSessions(): void {
		const sessions = this.registry.listSessions();
		const items: SelectItem[] = sessions.map((s) => ({
			value: s.taskId,
			label: formatSessionLabel(s),
			description: formatSessionDescription(s),
		}));
		this.sessionsList.invalidate();
		// SelectList has no public setItems(); rebuild via constructor isn't ideal,
		// but mutating its private items[] would be even uglier. Easiest: replace
		// the instance. Keep the selected taskId stable across rebuilds.
		const prior = this.selectedTaskId;
		const selectedIndex = prior
			? Math.max(0, items.findIndex((i) => i.value === prior))
			: 0;
		this.sessionsList = new SelectList(items, MAX_VISIBLE_ROWS, buildSelectListTheme(this.deps.theme));
		this.sessionsList.setSelectedIndex(selectedIndex);
		this.sessionsList.onSelectionChange = (item) => {
			this.selectedTaskId = item.value;
			this.selectedEventIndex = 0;
			this.rebuildEvents();
			this.deps.requestRender();
		};
		if (!this.selectedTaskId && items[0]) {
			this.selectedTaskId = items[0].value;
			this.rebuildEvents();
		}
	}

	private rebuildEvents(): void {
		const s = this.selectedTaskId ? this.registry.getSession(this.selectedTaskId) : undefined;
		if (!s) {
			this.eventsList = new SelectList([], MAX_VISIBLE_ROWS, buildSelectListTheme(this.deps.theme));
			return;
		}
		// Pair tool_start + tool_end into a single line; show errors with a marker.
		const items: SelectItem[] = [];
		const startsByCallId = new Map<string, ToolEventRecord>();
		s.events.forEach((ev, idx) => {
			if (ev.kind === "tool_start") {
				startsByCallId.set(ev.toolCallId, ev);
				items.push({
					value: String(idx),
					label: formatEventLabel(ev, undefined, this.deps.theme),
					description: shortArgHint(ev.args),
				});
			} else {
				const start = startsByCallId.get(ev.toolCallId);
				if (start) {
					// Update the existing item's label with completion marker.
					const lastIdx = items.findIndex((i) => i.value === String(idx - 1));
					if (lastIdx >= 0) {
						items[lastIdx] = {
							...items[lastIdx],
							label: formatEventLabel(start, ev, this.deps.theme),
						};
					}
				} else {
					items.push({
						value: String(idx),
						label: formatEventLabel(ev, ev, this.deps.theme),
						description: ev.isError ? "errored" : "ok",
					});
				}
			}
		});
		this.eventsList = new SelectList(items, MAX_VISIBLE_ROWS, buildSelectListTheme(this.deps.theme));
		const idx = Math.min(this.selectedEventIndex, Math.max(0, items.length - 1));
		this.eventsList.setSelectedIndex(idx);
		this.eventsList.onSelectionChange = (item) => {
			const i = Number.parseInt(item.value, 10);
			if (!Number.isNaN(i)) {
				this.selectedEventIndex = i;
				this.deps.requestRender();
			}
		};
	}
}

function formatSessionLabel(s: SessionState): string {
	const phase = s.currentPhaseRole ?? s.phases[s.phases.length - 1]?.role ?? "—";
	const marker =
		s.status === "running" ? "▶" : s.status === "failed" || s.status === "escalated" ? "✗" : "✓";
	return `${marker} ${s.taskId}  ${phase}`;
}

function formatSessionDescription(s: SessionState): string {
	const p = s.phases[s.phases.length - 1];
	if (!p) return "";
	const errPart = p.errCount ? ` · err ${p.errCount}` : "";
	const elapsed = Math.floor(((p.endedAt ?? Date.now()) - p.startedAt) / 1000);
	return `t${p.turn} · tools ${p.toolCount}${errPart} · ${elapsed}s`;
}

function formatEventLabel(
	start: ToolEventRecord,
	end: ToolEventRecord | undefined,
	theme: Theme,
): string {
	const ts = new Date(start.ts).toISOString().slice(11, 19);
	const hint = shortArgHint(start.args);
	const status = end ? (end.isError ? theme.fg("error", "✗") : theme.fg("success", "✓")) : "·";
	return `${ts} ${status} ${start.toolName}${hint ? ` ${hint}` : ""}`;
}

function shortArgHint(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const fp = (a.file_path ?? a.path) as unknown;
	if (typeof fp === "string") {
		const base = fp.split("/").pop() ?? fp;
		return base.length > 28 ? `${base.slice(0, 28)}…` : base;
	}
	if (typeof a.command === "string") {
		const head = a.command.split(/\s+/).slice(0, 3).join(" ");
		return head.length > 36 ? `${head.slice(0, 36)}…` : head;
	}
	if (typeof a.pattern === "string") return a.pattern.slice(0, 36);
	if (typeof a.query === "string") return a.query.slice(0, 36);
	return "";
}

function renderDetails(
	session: SessionState | undefined,
	eventIndex: number,
	width: number,
	theme: Theme,
): string[] {
	if (!session) return [];
	const ev = session.events[eventIndex];
	if (!ev) return [theme.fg("muted", "  (no event selected)")];

	const lines: string[] = [];
	lines.push(theme.bold(theme.fg("accent", `Details: ${ev.toolName}`)));
	if (ev.args !== undefined) {
		lines.push(theme.fg("muted", "  args:"));
		lines.push(...indent(jsonLines(ev.args), 4));
	}
	if (ev.kind === "tool_end") {
		const label = ev.isError ? theme.fg("error", "  result (errored):") : theme.fg("muted", "  result:");
		lines.push(label);
		lines.push(...indent(jsonLines(ev.result), 4));
	}
	// Truncate to DETAIL_LINES so the widget doesn't grow unbounded.
	const truncated = lines.slice(0, DETAIL_LINES + 1);
	if (lines.length > DETAIL_LINES + 1) {
		truncated.push(theme.fg("muted", `  … (${lines.length - DETAIL_LINES - 1} more lines; see .forge/cache/run-task-debug-${session.taskId}.jsonl)`));
	}
	// Hard-wrap any line that exceeds width.
	return truncated.map((l) => (visibleLen(l) > width ? l.slice(0, Math.max(0, width - 1)) + "…" : l));
}

function jsonLines(value: unknown): string[] {
	try {
		const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
		return s.split("\n");
	} catch {
		return [String(value)];
	}
}

function indent(lines: string[], spaces: number): string[] {
	const pad = " ".repeat(spaces);
	return lines.map((l) => pad + l);
}

function visibleLen(s: string): number {
	// Strip ANSI escape sequences for a rough visible-width estimate.
	return s.replace(/\[[0-9;]*m/g, "").length;
}

function stitchPanes(
	left: string[],
	right: string[],
	leftWidth: number,
	rightWidth: number,
	theme: Theme,
): string[] {
	const rows = Math.max(left.length, right.length);
	const gutter = theme.fg("borderMuted", " │ ");
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		const l = padVisible(left[i] ?? "", leftWidth);
		const r = padVisible(right[i] ?? "", rightWidth);
		out.push(l + gutter + r);
	}
	return out;
}

function padVisible(s: string, width: number): string {
	const len = visibleLen(s);
	if (len >= width) return s;
	return s + " ".repeat(width - len);
}

function buildSelectListTheme(theme: Theme): SelectListThemeShape {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", "▸") + " " + t,
		selectedText: (t: string) => theme.bold(theme.fg("accent", t)),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("muted", t),
		noMatch: (t: string) => theme.fg("muted", t),
	};
}

type SelectListThemeShape = {
	selectedPrefix: (t: string) => string;
	selectedText: (t: string) => string;
	description: (t: string) => string;
	scrollInfo: (t: string) => string;
	noMatch: (t: string) => string;
};
