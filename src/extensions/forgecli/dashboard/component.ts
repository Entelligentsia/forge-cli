// dashboard/component.ts — Two-panel orchestrator tree dashboard.
//
// Renders as a pi-tui overlay (ctx.ui.custom) with:
//   Left panel:  tree browser with depth-based indentation, status glyphs,
//                progress labels, and cursor highlighting.
//   Right panel: detail view of the selected node — status, model, metrics,
//                prompt preview, tail-buffer activity, outcome, and children.
//
// Keyboard:
//   ↑/↓     move cursor in tree
//   →       expand orchestrator / focus leaf detail
//   ←       collapse orchestrator / back to tree
//   Enter   toggle expand on orchestrator; focus detail on leaf
//   Esc     close overlay
//   x       request cancellation (with y/n confirm)
//   p       (reserved for pause)
//
// The component reads from OrchestratorTree (the model) and subscribes to
// its events for live updates. No writes flow through the component —
// the model is mutated by the orchestrator code, not the dashboard.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { OrchestratorNode, OrchestratorTree, NodeStatus } from "../orchestrator-tree.js";
import { getSessionRegistry } from "../session-registry.js";
import { fmtModelAndTokenFooter, fmtTokenMeter } from "../viewport-renderer.js";
import { paintTailLine } from "../viewport-theme.js";

// ── Word-wrap helper ───────────────────────────────────────────────────────
//
// Splits a line (which may contain ANSI escape sequences) into multiple
// lines at word boundaries so it fits within `maxWidth` visible columns.
// Preserves ANSI styling across wrapped lines. Falls back to character-level
// truncation for individual tokens wider than maxWidth.

function wrapLine(line: string, maxWidth: number): string[] {
	if (maxWidth <= 0) return [line];
	const visW = visibleWidth(line);
	if (visW <= maxWidth) return [line];

	// Collect styled segments: each segment carries the ANSI prefix that
	// was active before its text. This lets us re-emit prefix + text on
	// wrapped lines without losing colour/bold/etc.
	interface Segment { prefix: string; text: string }
	const segments: Segment[] = [];

	const ANSI_RE = /(\x1b\[[0-9;]*m|\x1b\].*?(?:\x07|\x1b\\)|\x1b\[[^m]*m)/g;
	let currentPrefix = "";
	let lastIdx = 0;
	let m: RegExpExecArray | null;
	while ((m = ANSI_RE.exec(line)) !== null) {
		if (m.index > lastIdx) {
			segments.push({ prefix: currentPrefix, text: line.slice(lastIdx, m.index) });
		}
		currentPrefix += m[0];
		lastIdx = m.index + m[0].length;
	}
	if (lastIdx < line.length) {
		segments.push({ prefix: currentPrefix, text: line.slice(lastIdx) });
	}
	if (segments.length === 0) {
		return [truncateToWidth(line, maxWidth)];
	}

	// Tokenize: split each segment on whitespace, produce tokens that carry
	// their active ANSI prefix. Spaces between tokens are not separate tokens —
	// they become single-space gaps inserted by the line-fill loop.
	interface Token { prefix: string; text: string; visLen: number }
	const tokens: Token[] = [];
	for (const seg of segments) {
		const words = seg.text.split(/\s+/);
		for (const w of words) {
			if (w.length === 0) continue;
			tokens.push({ prefix: seg.prefix, text: w, visLen: visibleWidth(w) });
		}
	}

	// Greedy line-fill: accumulate tokens with single-space gaps until the
	// next token would exceed maxWidth, then start a new line.
	const lines: string[] = [];
	let curLine = "";
	let curLen = 0;

	for (const tok of tokens) {
		const gapLen = curLen > 0 ? 1 : 0; // one space between tokens
		const addedLen = tok.visLen + gapLen;

		if (curLen > 0 && curLen + addedLen > maxWidth) {
			// Emit current line and start fresh
			if (curLine.length > 0) lines.push(curLine);
			curLine = "";
			curLen = 0;
		}

		if (curLen === 0) {
			curLine = tok.prefix + tok.text;
			curLen = tok.visLen;
		} else {
			curLine += " " + tok.text;
			curLen += 1 + tok.visLen;
		}

		// If a single token is wider than maxWidth, hard-break via truncation.
		if (curLen > maxWidth) {
			const truncated = truncateToWidth(curLine, maxWidth);
			lines.push(truncated);
			curLine = "";
			curLen = 0;
		}
	}

	if (curLen > 0) {
		lines.push(curLine);
	}

	return lines.length > 0 ? lines : [line];
}// ── Refresh timer ───────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 1000;

// ── State ────────────────────────────────────────────────────────────────────

export interface DashboardState {
	/** Node ID the cursor is hovering on. */
	cursorId: string;
	/** Orchestrator node IDs whose children are expanded in the tree. */
	expanded: Set<string>;
	/** Which panel receives keyboard focus. */
	focusPanel: "tree" | "detail";
	/** Whether the detail panel's prompt section is expanded. */
	promptExpanded: boolean;
	/** Node ID targeted for cancellation confirmation, if active. */
	cancelTargetId: string | null;
	/** Scroll offset for the detail panel (0 = top). */
	detailScroll: number;
}

// ── Controller ──────────────────────────────────────────────────────────────

export class DashboardController {
	private tree: OrchestratorTree;
	private state: DashboardState;
	/** Callback to request a TUI re-render after state changes. */
	private onInvalidate?: () => void;

	constructor(tree: OrchestratorTree, initialCursorId?: string) {
		this.tree = tree;
		// Default cursor to the first active root, or empty string if tree is empty.
		const roots = tree.getActiveRoots();
		const firstVisible = roots.length > 0 ? roots[0]!.id : "";
		this.state = {
			cursorId: initialCursorId ?? firstVisible,
			expanded: new Set(),
			focusPanel: "tree",
			promptExpanded: false,
			cancelTargetId: null,
			detailScroll: 0,
		};
	}

	getState(): DashboardState {
		return this.state;
	}

	setOnInvalidate(cb: () => void): void {
		this.onInvalidate = cb;
	}

	// ── Visible node list (DFS respecting expand state) ────────────────────

	getVisibleNodes(): string[] {
		const result: string[] = [];
		const visit = (id: string) => {
			const node = this.tree.getNode(id);
			if (!node) return;
			result.push(id);
			if (node.kind === "orchestrator" && this.state.expanded.has(id)) {
				for (const childId of node.children) {
					visit(childId);
				}
			}
		};
		for (const root of this.tree.getActiveRoots()) {
			visit(root.id);
		}
		return result;
	}

	// ── Input handling ──────────────────────────────────────────────────────

	handleInput(data: string): void {
		// Cancel confirmation mode takes priority.
		if (this.state.cancelTargetId) {
			this.handleCancelConfirm(data);
			this.onInvalidate?.();
			return;
		}

		switch (this.state.focusPanel) {
			case "tree":
				this.handleTreeInput(data);
				break;
			case "detail":
				this.handleDetailInput(data);
				break;
		}
		this.onInvalidate?.();
	}

	private handleTreeInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.moveCursor(-1);
		} else if (matchesKey(data, Key.down)) {
			this.moveCursor(1);
		} else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.activateCursor();
		} else if (matchesKey(data, Key.left)) {
			this.collapseCursor();
		} else if (data === "x") {
			this.startCancel();
		} else if (matchesKey(data, Key.escape)) {
			// Esc in tree = request close. The done callback handles it.
			// Mark a sentinel so the mount code can close.
			this.state.cursorId = "__close__";
		}
		// Consume all keys while overlay is active (no passthrough).
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			this.state.focusPanel = "tree";
			this.state.detailScroll = 0;
		} else if (matchesKey(data, Key.down) || data === "j" || data === "J") {
			this.state.detailScroll++;
		} else if (matchesKey(data, Key.up) || data === "k" || data === "K") {
			this.state.detailScroll = Math.max(0, this.state.detailScroll - 1);
		} else if (matchesKey(data, Key.enter)) {
			// Toggle prompt expansion when in detail view
			this.state.promptExpanded = !this.state.promptExpanded;
		} else if (data === "x") {
			this.startCancel();
		}
	}

	private handleCancelConfirm(data: string): void {
		if (data === "y" || matchesKey(data, Key.enter)) {
			if (this.state.cancelTargetId) {
				this.cancelNodeAndSessions(this.state.cancelTargetId);
			}
			this.state.cancelTargetId = null;
		} else if (data === "n" || matchesKey(data, Key.escape)) {
			this.state.cancelTargetId = null;
		}
		// All other keys consumed silently in cancel mode.
	}

	/** Cancel the node in the OrchestratorTree for immediate visual
	 *  feedback, and propagate cancellation through SessionRegistry
	 *  for actual pipeline abort. */
	private cancelNodeAndSessions(nodeId: string): void {
		// Mark node as "cancelling" in the tree for immediate visual feedback.
		this.tree.requestCancel(nodeId);

		const registry = getSessionRegistry();

		// Walk up the tree to find the session (task-level) node in the registry.
		// Session IDs match task IDs (FORGE-S27-T01) or ceremony IDs
		// (FORGE-S27:ceremony).
		let currentId: string | null = nodeId;
		while (currentId) {
			const session = registry.getSession(currentId);
			if (session && (session.status === "running" || session.status === "cancelling")) {
				registry.requestCancel(currentId);
				return;
			}
			const node = this.tree.getNode(currentId);
			currentId = node?.parentId ?? null;
		}

		// No session found for this node or ancestors. If this is a
		// sprint-level orchestrator, cancel all running child sessions.
		const node = this.tree.getNode(nodeId);
		if (node?.kind === "orchestrator") {
			for (const childId of node.children) {
				const session = registry.getSession(childId);
				if (session && (session.status === "running" || session.status === "cancelling")) {
					registry.requestCancel(childId);
				}
			}
		}
	}

	private moveCursor(delta: number): void {
		const visible = this.getVisibleNodes();
		if (visible.length === 0) return;
		const idx = visible.indexOf(this.state.cursorId);
		const next = Math.max(0, Math.min(visible.length - 1, idx + delta));
		this.state.cursorId = visible[next]!;
		// Auto-expand ancestors so the cursor is always visible.
		this.ensureAncestorsExpanded(this.state.cursorId);
	}

	private activateCursor(): void {
		const node = this.tree.getNode(this.state.cursorId);
		if (!node) return;
		if (node.kind === "orchestrator") {
			this.toggleExpand(node.id);
		} else {
			this.state.focusPanel = "detail";
			this.state.detailScroll = 0;
		}
	}

	private toggleExpand(id: string): void {
		if (this.state.expanded.has(id)) {
			this.state.expanded.delete(id);
		} else {
			this.state.expanded.add(id);
		}
	}

	private collapseCursor(): void {
		const node = this.tree.getNode(this.state.cursorId);
		if (!node) return;
		if (node.kind === "orchestrator" && this.state.expanded.has(node.id)) {
			this.state.expanded.delete(node.id);
		} else if (node.parentId) {
			// Move cursor to parent.
			this.state.cursorId = node.parentId;
		}
	}

	private startCancel(): void {
		const node = this.tree.getNode(this.state.cursorId);
		if (!node) return;
		// Can cancel any node under a running subtree — find the nearest
		// cancellable ancestor (running or cancelling).
		let target: OrchestratorNode | null = null;
		let current: OrchestratorNode | undefined = node;
		while (current) {
			if (current.status === "running" || current.status === "cancelling") {
				target = current;
				break;
			}
			current = current.parentId ? this.tree.getNode(current.parentId) : undefined;
		}
		if (target) {
			this.state.cancelTargetId = target.id;
		}
	}

	private ensureAncestorsExpanded(id: string): void {
		for (const ancestor of this.tree.getAncestors(id)) {
			if (ancestor.kind === "orchestrator") {
				this.state.expanded.add(ancestor.id);
			}
		}
	}

	// ── Auto-expand: when a new running node appears, auto-expand its ────
	// parent so it's immediately visible in the tree.

	autoExpandNewNode(id: string): void {
		const node = this.tree.getNode(id);
		if (!node) return;
		if (node.kind === "orchestrator") {
			this.state.expanded.add(id);
		}
		if (node.parentId) {
			const parent = this.tree.getNode(node.parentId);
			if (parent?.kind === "orchestrator") {
				this.state.expanded.add(parent.id);
			}
		}
		// Default cursor to the newest running node if no cursor set.
		if (!this.state.cursorId || this.state.cursorId === "") {
			this.state.cursorId = id;
		}
	}

	isCloseRequested(): boolean {
		return this.state.cursorId === "__close__";
	}
}

// ── View ────────────────────────────────────────────────────────────────────

export class DashboardComponent implements Component {
	private tree: OrchestratorTree;
	private controller: DashboardController;
	private theme: Theme;
	private tui: TUI;
	private done: (result: null) => void;
	private refreshTimer?: NodeJS.Timeout;
	private _rerender?: () => void;
	private _onTreeChange?: (id: string) => void;

	constructor(
		tree: OrchestratorTree,
		tui: TUI,
		theme: Theme,
		done: (result: null) => void,
	) {
		this.tree = tree;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.controller = new DashboardController(tree);

		const rerender = () => this.tui.requestRender();
		const onTreeChange = (id: string) => {
			// Auto-expand the parent of newly-added nodes so they are visible.
			this.controller.autoExpandNewNode(id);
			rerender();
		};
		this.tree.on("change", rerender);
		this.tree.on("tail", rerender);
		this.tree.on("preview", rerender);
		this.tree.on("tree", onTreeChange);
		this.controller.setOnInvalidate(rerender);

		// Refresh timer: re-render at 1000ms intervals to update elapsed times.
		this.ensureRefreshTimer();

		this._rerender = rerender;
		this._onTreeChange = onTreeChange;
	}

	private ensureRefreshTimer(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => {
			const anyRunning = this.tree.getActiveRoots().some(
				(r) => r.status === "running" || r.status === "cancelling",
			);
			if (!anyRunning) {
				// One last render to settle final frame.
				this.tui.requestRender();
				if (this.refreshTimer) clearInterval(this.refreshTimer);
				this.refreshTimer = undefined;
				return;
			}
			this.tui.requestRender();
		}, REFRESH_INTERVAL_MS);
	}

	// ── Component interface ──────────────────────────────────────────────────

	render(width: number): string[] {
		// Check if close was requested.
		if (this.controller.isCloseRequested()) {
			this.dispose();
			this.done(null);
			return [];
		}

		// Layout: left panel ~20% (min 22), right panel fills rest, borders.
		const leftWidth = Math.max(22, Math.floor(width * 0.20));
		const separatorWidth = 1;
		const rightWidth = Math.max(20, width - leftWidth - separatorWidth - 3);
		const contentWidth = width - 2; // minus left and right border chars

		const visible = this.controller.getVisibleNodes();
		const state = this.controller.getState();
		const selectedNode = this.tree.getNode(state.cursorId);

		// ── Cancel confirmation overlay ────────────────────────────────
		if (state.cancelTargetId) {
			return this.renderCancelConfirm(width, state.cancelTargetId);
		}

		// ── Left panel: tree browser ───────────────────────────────────
		const leftLines = this.renderTreePanel(visible, state, leftWidth);

		// ── Right panel: detail ─────────────────────────────────────────
		const rightLines = selectedNode
			? this.renderDetailPanel(selectedNode, rightWidth)
			: [this.theme.fg("dim", "Select a node in the tree")];

		// ── Compose ─────────────────────────────────────────────────────
		const termHeight = this.tui.terminal.rows;
		// Deduct 3 lines for top border, bottom border, and hints footer
		const contentHeight = Math.max(8, termHeight - 3);

		// Compute detail panel scroll with auto-scrolling fallback for tree focus
		let activeScroll = state.detailScroll;
		if (state.focusPanel === "tree") {
			// Auto-scroll to the bottom so live dispatches are visible immediately
			activeScroll = Math.max(0, rightLines.length - contentHeight);
		} else {
			// Clamp user manual scroll within valid bounds
			const maxScroll = Math.max(0, rightLines.length - contentHeight);
			if (activeScroll > maxScroll) {
				activeScroll = maxScroll;
				state.detailScroll = maxScroll; // sync controller state
			}
		}

		const paddedLeftLines: string[] = [];
		for (let i = 0; i < contentHeight; i++) {
			paddedLeftLines.push(leftLines[i] ?? "");
		}

		const paddedRightLines: string[] = [];
		for (let i = 0; i < contentHeight; i++) {
			paddedRightLines.push(rightLines[i + activeScroll] ?? "");
		}

		const lines: string[] = [];
		const border = (s: string) => this.theme.fg("border", s);
		const accent = (s: string) => this.theme.fg("accent", s);

		// ── Header ──────────────────────────────────────────────────────
		const headerText = ` Orchestrator Dashboard `;
		const headerPad = contentWidth - visibleWidth(border("")) - visibleWidth(accent(headerText));
		lines.push(
			border("╭") +
				accent(headerText) +
				border("─".repeat(Math.max(0, headerPad))) +
				border("╮"),
		);

		for (let i = 0; i < contentHeight; i++) {
			const left = truncateToWidth(paddedLeftLines[i]!, leftWidth);
			const right = truncateToWidth(paddedRightLines[i]!, rightWidth);
			const lPad = leftWidth - visibleWidth(left);
			const rPad = rightWidth - visibleWidth(right);
			lines.push(
				border("│") +
					left +
					" ".repeat(Math.max(0, lPad)) +
					border("│") +
					" " +
					right +
					" ".repeat(Math.max(0, rPad)) +
					border("│"),
			);
		}

		// ── Footer with key hints ───────────────────────────────────────
		const dim = (s: string) => this.theme.fg("dim", s);
		const hints = " ↑↓ nav · → expand · ← back · ⏎ focus · x cancel · esc close";
		lines.push(border("╰") + border("─".repeat(contentWidth)) + border("╯"));
		lines.push(dim(truncateToWidth(hints, width)));

		return lines;
	}

	handleInput(data: string): void {
		this.controller.handleInput(data);
		this.tui.requestRender();
	}

	invalidate(): void {
		// No cached render state — pure function of tree + state.
	}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		if (this._rerender) {
			this.tree.off("change", this._rerender);
			this.tree.off("tail", this._rerender);
			this.tree.off("preview", this._rerender);
		}
		if (this._onTreeChange) {
			this.tree.off("tree", this._onTreeChange);
		}
	}

	// ── Tree panel renderer ─────────────────────────────────────────────────

	private renderTreePanel(
		visibleIds: string[],
		state: DashboardState,
		width: number,
	): string[] {
		if (visibleIds.length === 0) {
			return [this.theme.fg("dim", "No session running")];
		}

		const lines: string[] = [];

		// Header
		lines.push(this.theme.bold(this.theme.fg("accent", " Phases")));

		for (const id of visibleIds) {
			const node = this.tree.getNode(id);
			if (!node) continue;
			const isCursor = id === state.cursorId;
			const depth = this.tree.getDepth(id);
			const indent = " ".repeat(depth * 2);

			// Status glyph
			const glyph = this.nodeGlyph(node);

			// Progress label for orchestrators
			let label = node.label;
			if (node.kind === "orchestrator") {
				const prog = this.tree.getSubtreeProgress(id);
				label += ` ${prog.completed}/${prog.total}`;
			}

			// Expand indicator
			const expandIndicator = node.kind === "orchestrator"
				? state.expanded.has(id)
					? " "
					: "▸"
				: " ";

			// Combine
			const prefix = `${indent}${isCursor ? "❯" : " "} ${glyph} ${expandIndicator} `;
			const styled = isCursor
				? this.theme.bold(this.theme.fg("accent", `${prefix}${label}`))
				: `${prefix}${label}`;

			lines.push(truncateToWidth(styled, width));
		}

		return lines;
	}

	private nodeGlyph(node: OrchestratorNode): string {
		switch (node.status) {
			case "completed":
				return this.theme.fg("success", "✔");
			case "running":
				return this.theme.fg("accent", "●");
			case "cancelling":
				return this.theme.fg("warning", "⏳");
			case "cancelled":
				return this.theme.fg("muted", "⊘");
			case "failed":
				return this.theme.fg("error", "✗");
			case "escalated":
				return this.theme.fg("error", "▲");
			case "pending":
			default:
				return this.theme.fg("dim", "○");
		}
	}

	// ── Detail panel renderer ────────────────────────────────────────────────

	private renderDetailPanel(node: OrchestratorNode, width: number): string[] {
		const lines: string[] = [];
		const dim = (s: string) => this.theme.fg("dim", s);
		const accent = (s: string) => this.theme.fg("accent", s);
		const bold = (s: string) => this.theme.bold(s);
		const success = (s: string) => this.theme.fg("success", s);
		const warn = (s: string) => this.theme.fg("warning", s);

		// ── Header: label + status (wrap long model strings) ──────────────────
		const statusLabel = this.statusLabel(node.status);
		const modelPart = node.model ? ` · ${node.provider ?? ""} ${node.model}` : "";
		lines.push(...wrapLine(`${this.nodeGlyph(node)} ${bold(statusLabel)}${dim(modelPart)}`, width));

		// ── Metrics line ────────────────────────────────────────────────
		const metrics = this.formatMetrics(node);
		if (metrics) lines.push(...wrapLine(dim(metrics), width));
		lines.push("");

		// ── Orchestrator node: list children ─────────────────────────────
		if (node.kind === "orchestrator" && node.children.length > 0) {
			const children = this.tree.getChildren(node.id);
			lines.push(...wrapLine(dim(bold(`Agents · ${children.length}`)), width));
			for (const child of children) {
				const cglyph = this.nodeGlyph(child);
				const cmodel = child.model ? ` ${child.provider ?? ""} ${child.model}` : "";
				const cmetrics = this.formatMetrics(child);
				const cmetricsPart = cmetrics ? ` ${cmetrics}` : "";
				lines.push(
					...wrapLine(` ${cglyph} ${child.label}${dim(cmodel)}${dim(cmetricsPart)}`, width),
				);
			}
			lines.push("");
		}

		// ── Prompt preview (expandable) ─────────────────────────────────
		if (node.promptPreview) {
			const expandIcon = this.controller.getState().promptExpanded ? "▼" : "▶";
			const lineCount = node.promptPreview.split("\n").length;
			lines.push(...wrapLine(dim(`${expandIcon} Prompt · ${lineCount} lines · ⏎ expand`), width));
			if (this.controller.getState().promptExpanded) {
				for (const pline of node.promptPreview.split("\n").slice(0, 20)) {
					// Indent wrapped prompt lines by 2 spaces
					const wrapped = wrapLine(pline, Math.max(0, width - 4));
					for (let i = 0; i < wrapped.length; i++) {
						lines.push(dim(i === 0 ? `  ${wrapped[i]}` : `  ${wrapped[i]}`));
					}
				}
				if (lineCount > 20) {
					lines.push(dim(`  … ${lineCount - 20} more lines`));
				}
			}
			lines.push("");
		}

		// ── Activity: running full log of all turns ──────────────────────
		if (node.kind === "leaf" && node.tailBuffer.length > 0) {
			const total = node.tailBuffer.length;
			lines.push(...wrapLine(dim(`Activity · ${total} log line${total === 1 ? "" : "s"}`), width));
			for (const tline of node.tailBuffer) {
				const painted = paintTailLine(tline, this.theme);
				lines.push(...wrapLine(painted, width));
			}
			lines.push("");
		}

		// ── Outcome ─────────────────────────────────────────────────────
		if (node.outcomePreview) {
			lines.push(dim("Outcome"));
			for (const oline of node.outcomePreview.split("\n").slice(0, 8)) {
				const wrapped = wrapLine(oline, Math.max(0, width - 4));
				for (const wl of wrapped) {
					lines.push(`  ${wl}`);
				}
			}
			const lineCount = node.outcomePreview.split("\n").length;
			if (lineCount > 8) {
				lines.push(dim(`  … ${lineCount - 8} more lines`));
			}
		}

		return lines;
	}

	private renderCancelConfirm(width: number, targetId: string): string[] {
		const node = this.tree.getNode(targetId);
		const label = node?.label ?? targetId;
		const dim = (s: string) => this.theme.fg("dim", s);
		const warn = (s: string) => this.theme.fg("warning", s);
		const bold = (s: string) => this.theme.bold(s);
		const border = (s: string) => this.theme.fg("border", s);

		const prompt = warn(`⚠ Cancel ${bold(label)}?`);
		const actions = dim("y confirm · n/esc dismiss");
		const promptW = visibleWidth(prompt);
		const actionsW = visibleWidth(actions);

		const lines: string[] = [];
		lines.push(border("╭" + "─".repeat(width - 2) + "╮"));
		lines.push(border("│") + " ".repeat(width - 2) + border("│"));
		{
			const gap = Math.max(0, width - 4 - promptW - actionsW);
			lines.push(
				border("│") +
					" " +
					prompt +
					" ".repeat(gap) +
					" " +
					actions +
					" ".repeat(Math.max(0, width - 4 - promptW - actionsW - gap)) +
					border("│"),
			);
		}
		lines.push(border("│") + " ".repeat(width - 2) + border("│"));
		lines.push(border("╰" + "─".repeat(width - 2) + "╯"));

		return lines;
	}

	private statusLabel(status: NodeStatus): string {
		switch (status) {
			case "completed":
				return "Completed";
			case "running":
				return "Running";
			case "cancelling":
				return "Cancelling…";
			case "cancelled":
				return "Cancelled";
			case "failed":
				return "Failed";
			case "escalated":
				return "Escalated";
			case "pending":
				return "Pending";
		}
	}

	private formatMetrics(node: OrchestratorNode): string {
		const parts: string[] = [];
		if (node.usage.input || node.usage.output || node.usage.cacheRead) {
			parts.push(fmtTokenMeter(node.usage));
		}
		if (node.metrics.toolCount) {
			parts.push(`${node.metrics.toolCount} tool${node.metrics.toolCount === 1 ? "" : "s"}`);
		}
		if (node.metrics.errCount) {
			parts.push(`${node.metrics.errCount} err`);
		}
		if (node.startedAt) {
			const end = node.endedAt ?? Date.now();
			const secs = Math.floor((end - node.startedAt) / 1000);
			parts.push(secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`);
		}
		return parts.join(" · ");
	}
}