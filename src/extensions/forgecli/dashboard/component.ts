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
// Architecture (post-MVC-refactor, dashboard-mvc-audit.md V1–V7):
//   DashboardController owns the TreeViewModel, subscribes to model events,
//   manages the refresh timer, and handles input. DashboardComponent reads
//   only from the controller — never directly from the OrchestratorTree model.
//   This eliminates the boundary violations catalogued in the audit.
//
// Iron Laws conformance:
//   IL1 — All visible strings route through dashboard/theme.ts helpers or
//          theme.fg()/bg()/bold(). No raw glyphs.
//   IL2 — Dual-layer width safety: screen renderers call truncateLines(),
//          orchestrator applies truncateToWidth per line.
//   IL3 — DashboardComponent implements Focusable (focused: boolean = false).
//   IL7 — Timer unmount-safety: disposed flag guards interval callbacks.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import type { OrchestratorTree } from "../orchestrator-tree.js";
import { getSessionRegistry } from "../session-registry.js";
import { AskBroker } from "../ask-broker.js";
import type { AskRender, AskUserRequest } from "../ask-user-render.js";
import type { NodeViewModel, TreeViewModel } from "./view-model.js";
import { buildViewModel } from "./view-model.js";
import { fmtModelAndTokenFooter, fmtTokenFooter, toDisplayLines } from "../viewport/renderer.js";
import { paintTailLine } from "../viewport/theme.js";
import {
	cursor,
	nodeGlyph,
	statusLabel,
	dim,
	accent,
	accentBold,
	warn,
	bold,
	border,
	collapseIndicator,
	promptExpandIcon,
	cancelWarningGlyph,
	truncateLines,
} from "./theme.js";

// ── Word-wrap helper ───────────────────────────────────────────────────────────
//
// Splits a line (which may contain ANSI escape sequences) into multiple
// lines at word boundaries so it fits within `maxWidth` visible columns.
// Preserves ANSI styling across wrapped lines. Falls back to character-level
// truncation for individual tokens wider than maxWidth.

function wrapLine(line: string, maxWidth: number): string[] {
	// Row-integrity guard (layer 2 of the single-line invariant; layer 1 is
	// toDisplayLines at the appendTail model boundary): a raw \n inside a
	// composed pane row resets the terminal cursor to column 0 and the
	// remainder renders under the LEFT pane. visibleWidth() counts \n as an
	// ordinary character, so the short-line early-return below would pass a
	// multi-line string through intact — split first, wrap each part.
	if (/[\r\n]/.test(line)) {
		return line.split(/\r\n|\r|\n/).flatMap((part) => wrapLine(part, maxWidth));
	}
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
}

/** Last-resort flatten for the pane compose loop: replace any surviving line
 * break with a visible ⏎ so a single corrupted string can't shift the whole
 * row grid. Upstream layers (toDisplayLines at appendTail, wrapLine split)
 * should make this a no-op. */
function flattenRow(line: string): string {
	return /[\r\n]/.test(line) ? line.replace(/\r\n|\r|\n/g, " ⏎ ") : line;
}

// ── Refresh timer ───────────────────────────────────────────────────────────

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
	/** Activity-log expansion (ctrl+o): false = clamp long entries to a small
	 * row budget, true = render full content. Display policy lives entirely in
	 * the view — the model stores log entries verbatim. */
	logExpanded: boolean;
	/** Node ID targeted for cancellation confirmation, if active. */
	cancelTargetId: string | null;
	/** Scroll offset for the detail panel (0 = top). */
	detailScroll: number;
}

/**
 * A subagent `ask_user` marshalled to the dashboard overlay (Plan 16 Slice 3).
 * The overlay renders the prompt in its own z-layer (pi's editor-slot dialogs
 * render beneath it), captures input, and resolves `resolve` with the answer.
 * `choiceIndex`/`textBuf` hold the transient interaction state for the panel.
 */
interface PendingAsk {
	req: AskUserRequest;
	resolve: (r: AskRender) => void;
	choiceIndex: number;
	textBuf: string;
}

/** Max rendered rows per log entry when the activity log is clamped. */
const LOG_CLAMP_ROWS = 2;

/** Max prompt lines shown when expanded but not in full mode (ctrl+o). */
const PROMPT_CLAMP_LINES = 20;

// ── Controller ──────────────────────────────────────────────────────────────

export class DashboardController {
	private tree: OrchestratorTree;
	private vm: TreeViewModel;
	private state: DashboardState;
	private onInvalidate?: () => void;
	private refreshTimer?: NodeJS.Timeout;
	private disposed = false; // IL7: guards interval callbacks after dispose
	private readonly readOnly: boolean;
	private _handlers: Array<{ event: string; handler: (...args: any[]) => void }>;
	/** A subagent ask_user marshalled to this overlay, or null (Plan 16 Slice 3). */
	private pendingAsk: PendingAsk | null = null;

	constructor(tree: OrchestratorTree, initialCursorId?: string, opts?: { readOnly?: boolean }) {
		this.readOnly = opts?.readOnly ?? false;
		this.tree = tree;
		this.vm = buildViewModel(tree);
		// Default cursor to the first active root, or empty string if tree is empty.
		const firstVisible = this.vm.roots.length > 0 ? this.vm.roots[0]! : "";
		this.state = {
			cursorId: initialCursorId ?? firstVisible,
			expanded: new Set(),
			focusPanel: "tree",
			promptExpanded: false,
			logExpanded: false,
			cancelTargetId: null,
			detailScroll: 0,
		};
		this._handlers = [];

		// V2 fix: subscriptions now owned by controller, not view.
		// On every model event, rebuild VM then invalidate the view.
		const onModelChange = () => {
			this.rebuildViewModel();
			if (!this.disposed) this.onInvalidate?.();
		};
		const onTreeChange = (id: string) => {
			this.rebuildViewModel();
			this.autoExpandNewNode(id);
			if (!this.disposed) this.onInvalidate?.();
		};

		this.tree.on("change", onModelChange);
		this.tree.on("tail", onModelChange);
		this.tree.on("preview", onModelChange);
		this.tree.on("tree", onTreeChange);

		this._handlers = [
			{ event: "change", handler: onModelChange },
			{ event: "tail", handler: onModelChange },
			{ event: "preview", handler: onModelChange },
			{ event: "tree", handler: onTreeChange },
		];

		// V3 fix: timer now owned by controller, not view.
		this.ensureRefreshTimer();
	}

	setOnInvalidate(cb: () => void): void {
		this.onInvalidate = cb;
	}

	// ── ViewModel projection ────────────────────────────────────────────────

	/** Rebuild the ViewModel from the live model. Called on every model event. */
	private rebuildViewModel(): void {
		this.vm = buildViewModel(this.tree);
	}

	/** Get a node from the current ViewModel. */
	getNode(id: string): NodeViewModel | undefined {
		return this.vm.nodes.get(id);
	}

	/** Get a node's children from the current ViewModel. */
	getChildren(id: string): NodeViewModel[] {
		const node = this.vm.nodes.get(id);
		if (!node) return [];
		return node.children
			.map((cid) => this.vm.nodes.get(cid))
			.filter((n): n is NodeViewModel => n !== undefined);
	}

	/** Get the progress (completed/total leaves) for a subtree. */
	getSubtreeProgress(id: string): { completed: number; total: number } {
		let completed = 0;
		let total = 0;
		const stack = [id];
		while (stack.length > 0) {
			const current = stack.pop()!;
			const node = this.vm.nodes.get(current);
			if (!node) continue;
			if (node.kind === "leaf") {
				total++;
				if (node.status === "completed") completed++;
			}
			stack.push(...node.children);
		}
		return { completed, total };
	}

	/** Aggregate token usage across all active roots. */
	getAggregateUsage(): { input: number; output: number; cacheRead: number } {
		const agg = { input: 0, output: 0, cacheRead: 0 };
		for (const rootId of this.vm.roots) {
			const stack = [rootId];
			while (stack.length > 0) {
				const current = stack.pop()!;
				const node = this.vm.nodes.get(current);
				if (!node) continue;
				agg.input += node.usage.input;
				agg.output += node.usage.output;
				agg.cacheRead += node.usage.cacheRead;
				stack.push(...node.children);
			}
		}
		return agg;
	}

	/** Aggregate compression across all active roots. */
	getAggregateCompression(): { calls: number; tokensSaved: number } {
		const agg = { calls: 0, tokensSaved: 0 };
		for (const rootId of this.vm.roots) {
			const stack = [rootId];
			while (stack.length > 0) {
				const current = stack.pop()!;
				const node = this.vm.nodes.get(current);
				if (!node) continue;
				if (node.compression) {
					agg.calls += node.compression.calls;
				agg.tokensSaved += node.compression.tokensSaved;
				}
				stack.push(...node.children);
			}
		}
		return agg;
	}

	/** Model/provider from the first running root, if any. */
	getActiveModel(): { provider?: string; model?: string } | undefined {
		for (const rootId of this.vm.roots) {
			const node = this.vm.nodes.get(rootId);
			if (node && node.model) {
				return { provider: node.provider, model: node.model };
			}
		}
		return undefined;
	}

	/** Check whether any active root is running or cancelling. */
	private hasRunningNodes(): boolean {
		for (const rootId of this.vm.roots) {
			const node = this.vm.nodes.get(rootId);
			if (node && (node.status === "running" || node.status === "cancelling")) {
				return true;
			}
		}
		return false;
	}

	// ── Visible node list (DFS respecting expand state) ────────────────────

	getVisibleNodes(): string[] {
		const result: string[] = [];
		const visit = (id: string) => {
			const node = this.vm.nodes.get(id);
			if (!node) return;
			result.push(id);
			if (node.kind === "orchestrator" && this.state.expanded.has(id)) {
				for (const childId of node.children) {
					visit(childId);
				}
			}
		};
		for (const rootId of this.vm.roots) {
			visit(rootId);
		}
		return result;
	}

	// ── Input handling ──────────────────────────────────────────────────────

	handleInput(data: string): void {
		// An active ask_user prompt takes top priority (HARD gate).
		if (this.pendingAsk) {
			this.handleAskInput(data);
			if (!this.disposed) this.onInvalidate?.();
			return;
		}

		// Cancel confirmation mode takes priority.
		if (this.state.cancelTargetId) {
			this.handleCancelConfirm(data);
			if (!this.disposed) this.onInvalidate?.();
			return;
		}

		// ctrl+o: toggle activity-log expansion (global — works in both panels).
		if (matchesKey(data, Key.ctrl("o"))) {
			this.state.logExpanded = !this.state.logExpanded;
			if (!this.disposed) this.onInvalidate?.();
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
		if (!this.disposed) this.onInvalidate?.();
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
		}
		// ESC in tree panel is handled in handleInput above — it closes
		// the overlay rather than navigating or setting a sentinel.
	}

	private handleDetailInput(data: string): void {
		// ESC in detail panel is handled in handleInput above — it closes
		// the overlay rather than just switching panels.
		if (matchesKey(data, Key.left)) {
			this.state.focusPanel = "tree";
			this.state.detailScroll = 0;
		} else if (matchesKey(data, Key.down) || data === "j" || data === "J") {
			this.state.detailScroll++;
		} else if (matchesKey(data, Key.up) || data === "k" || data === "K") {
			this.state.detailScroll = Math.max(0, this.state.detailScroll - 1);
		} else if (matchesKey(data, Key.enter)) {
			this.state.promptExpanded = !this.state.promptExpanded;
		} else if (data === "x") {
			this.startCancel();
		}
	}

	// ── ask_user overlay (Plan 16 Slice 3) ──────────────────────────────────

	/**
	 * Present a subagent's ask_user in this overlay and resolve when the user
	 * answers or dismisses. Registered with AskBroker by DashboardComponent so
	 * broker asks route here while the dashboard is mounted, instead of pi's
	 * editor-slot dialog (which renders beneath the overlay). Serialised upstream
	 * by AskBroker; the extra guard here is defence in depth.
	 */
	presentAsk(req: AskUserRequest, signal?: AbortSignal): Promise<AskRender> {
		if (this.disposed) return Promise.resolve({ ok: false, message: "forge:ask_user — dashboard closed" });
		if (this.pendingAsk) return Promise.resolve({ ok: false, message: "forge:ask_user — a prompt is already active" });
		return new Promise<AskRender>((resolve) => {
			if (signal?.aborted) {
				resolve({ ok: false, message: `forge:ask_user aborted before prompt — question: "${req.question}"` });
				return;
			}
			const onAbort = () => this.resolveAsk({ ok: false, message: `forge:ask_user aborted — question: "${req.question}"` });
			signal?.addEventListener("abort", onAbort, { once: true });
			const initialChoice =
				req.type === "choice" && req.default ? Math.max(0, (req.options ?? []).indexOf(req.default)) : 0;
			this.pendingAsk = {
				req,
				resolve: (r) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(r);
				},
				choiceIndex: initialChoice,
				textBuf: req.type === "text" ? (req.default ?? "") : "",
			};
			if (!this.disposed) this.onInvalidate?.();
		});
	}

	/** The active ask prompt (for the view), or null. */
	getPendingAsk(): PendingAsk | null {
		return this.pendingAsk;
	}

	/** Settle the active ask and clear it. */
	private resolveAsk(r: AskRender): void {
		const p = this.pendingAsk;
		this.pendingAsk = null;
		p?.resolve(r);
		if (!this.disposed) this.onInvalidate?.();
	}

	/**
	 * Input while an ask prompt is active. Enter/y/n resolve a confirm; ↑↓+Enter
	 * a choice; typing + Enter a text answer. A dismissal never returns the
	 * default — it resolves `{ ok: false }` so the tool reports isError, never a
	 * fabricated answer (Iron Law 7; forge#114). ESC is NOT handled here — the
	 * DashboardComponent intercepts ESC to close the whole overlay, which
	 * disposes and cancels the ask (also a non-answer).
	 */
	private handleAskInput(data: string): void {
		const p = this.pendingAsk;
		if (!p) return;
		const req = p.req;

		if (req.type === "confirm") {
			if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) this.resolveAsk({ ok: true, value: "Y" });
			else if (data === "n" || data === "N") this.resolveAsk({ ok: true, value: "N" });
			return;
		}

		if (req.type === "choice") {
			const opts = req.options ?? [];
			if (matchesKey(data, Key.up)) p.choiceIndex = Math.max(0, p.choiceIndex - 1);
			else if (matchesKey(data, Key.down)) p.choiceIndex = Math.min(Math.max(0, opts.length - 1), p.choiceIndex + 1);
			else if (matchesKey(data, Key.enter)) {
				const value = opts[p.choiceIndex];
				this.resolveAsk(
					value !== undefined
						? { ok: true, value }
						: { ok: false, message: `forge:ask_user — no option to select. question: "${req.question}"` },
				);
			}
			return;
		}

		// text
		if (matchesKey(data, Key.enter)) this.resolveAsk({ ok: true, value: p.textBuf });
		else if (matchesKey(data, Key.backspace)) p.textBuf = p.textBuf.slice(0, -1);
		else if (data.length === 1 && data >= " ") p.textBuf += data; // printable single char
	}

	private handleCancelConfirm(data: string): void {
		if (data === "y" || matchesKey(data, Key.enter)) {
			if (this.state.cancelTargetId) {
				this.cancelNodeAndSessions(this.state.cancelTargetId);
			}
			this.state.cancelTargetId = null;
		} else if (data === "n") {
			this.state.cancelTargetId = null;
		}
		// All other keys consumed silently in cancel mode. ESC is handled
		// by the view's handleInput (closes the overlay entirely).
	}

	/** Cancel the node in the OrchestratorTree for immediate visual
	 *  feedback, and propagate cancellation through SessionRegistry
	 *  for actual pipeline abort. Reads from VM; writes to model. */
	private cancelNodeAndSessions(nodeId: string): void {
		// Mutation: mark node as "cancelling" in the model for immediate
		// visual feedback. The model emits "change", which triggers a VM
		// rebuild via the controller's subscription.
		this.tree.requestCancel(nodeId);

		const registry = getSessionRegistry();

		// Walk up the tree to find the session (task-level) node in the registry.
		// Reads from the VM (pre-rebuild stale state is fine — parentId doesn't
		// change on cancel, and we re-read from VM).
		let currentId: string | null = nodeId;
		while (currentId) {
			const session = registry.getSession(currentId);
			if (session && (session.status === "running" || session.status === "cancelling")) {
				registry.requestCancel(currentId);
				return;
			}
			const node = this.vm.nodes.get(currentId);
			currentId = node?.parentId ?? null;
		}

		// No session found for this node or ancestors. If this is a
		// sprint-level orchestrator, cancel all running child sessions.
		const node = this.vm.nodes.get(nodeId);
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
		const node = this.vm.nodes.get(this.state.cursorId);
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
		const node = this.vm.nodes.get(this.state.cursorId);
		if (!node) return;
		if (node.kind === "orchestrator" && this.state.expanded.has(node.id)) {
			this.state.expanded.delete(node.id);
		} else if (node.parentId) {
			// Move cursor to parent.
			this.state.cursorId = node.parentId;
		}
	}

	/** Replay mode: read-only dashboards (archived trees) never cancel. */
	isReadOnly(): boolean {
		return this.readOnly;
	}

	private startCancel(): void {
		// Read-only replay: cancel is meaningless on an archived tree, and
		// cancelNodeAndSessions would touch the LIVE SessionRegistry
		// singleton. Single guard here covers both `x` entry points.
		if (this.readOnly) return;
		const node = this.vm.nodes.get(this.state.cursorId);
		if (!node) return;
		// Can cancel any node under a running subtree — find the nearest
		// cancellable ancestor (running or cancelling).
		let target: NodeViewModel | null = null;
		let current: NodeViewModel | undefined = node;
		while (current) {
			if (current.status === "running" || current.status === "cancelling") {
				target = current;
				break;
			}
			current = current.parentId ? this.vm.nodes.get(current.parentId) : undefined;
		}
		if (target) {
			this.state.cancelTargetId = target.id;
		}
	}

	private ensureAncestorsExpanded(id: string): void {
		let currentId: string | null = id;
		while (currentId) {
			const node = this.vm.nodes.get(currentId);
			if (!node) break;
			if (node.kind === "orchestrator") {
				this.state.expanded.add(currentId);
			}
			currentId = node.parentId;
		}
	}

	// ── Auto-expand: only expand the root and the direct parent of a new
	// leaf node (phase). Intermediate orchestrator nodes (tasks) are NOT
	// auto-expanded — the user expands them manually. This prevents the tree
	// from exploding into a fully-expanded state on every new node.

	autoExpandNewNode(id: string): void {
		const node = this.vm.nodes.get(id);
		if (!node) return;
		// Auto-expand the root level only: if this node IS a root (no parent),
		// expand it so it's visible. If this node is a leaf (phase), expand
		// only its direct parent (the task). Intermediate orchestrators
		// (tasks under a sprint) are NOT auto-expanded.
		if (node.kind === "leaf" && node.parentId) {
			// Leaf node (phase): expand its parent so the phase is visible,
			// but only if the parent is already visible (i.e., the user
			// has expanded the root).
			const parent = this.vm.nodes.get(node.parentId);
			if (parent && this.state.expanded.has(node.parentId) && parent.kind === "orchestrator") {
				// Parent is visible and is an orchestrator — leaf will show.
				// No need to expand further.
			}
			// Also ensure ancestors of the leaf are expanded so it's visible.
			this.ensureAncestorsExpanded(node.id);
		} else if (!node.parentId) {
			// Root node (sprint-level orchestrator): always expand.
			this.state.expanded.add(id);
		}
		// Default cursor to the newest running node if no cursor set.
		if (!this.state.cursorId || this.state.cursorId === "") {
			this.state.cursorId = id;
		}
	}

	// ── Refresh timer (V3 fix: owned by controller, not view) ──────────────

	private ensureRefreshTimer(): void {
		if (this.refreshTimer) return;
		this.refreshTimer = setInterval(() => {
			// IL7: guard against firing after dispose.
			if (this.disposed) {
				this.stopRefreshTimer();
				return;
			}
			if (!this.hasRunningNodes()) {
				// One last render to settle final frame, then stop timer.
				this.onInvalidate?.();
				this.stopRefreshTimer();
				return;
			}
			this.onInvalidate?.();
		}, REFRESH_INTERVAL_MS);
	}

	private stopRefreshTimer(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	// ── Cleanup ────────────────────────────────────────────────────────────

	dispose(): void {
		this.disposed = true; // IL7: set before clearing timer so callback sees it
		this.stopRefreshTimer();
		for (const { event, handler } of this._handlers) {
			this.tree.off(event, handler);
		}
		this._handlers = [];
		// A pending ask must not hang the waiting subagent when the overlay
		// closes — resolve it as a non-answer (never the default).
		if (this.pendingAsk) {
			const p = this.pendingAsk;
			this.pendingAsk = null;
			p.resolve({ ok: false, message: "forge:ask_user cancelled — dashboard closed before an answer" });
		}
	}

	getState(): DashboardState {
		return this.state;
	}
}

// ── View ────────────────────────────────────────────────────────────────────

export class DashboardComponent implements Component, Focusable {
	/** IL3: Focusable — pi sets this to true when the overlay has
	 *  keyboard focus. Without this, arrow-key and Escape events are
	 *  swallowed at the overlay layer. (Lesson from config-TUI commit 07e886f.) */
	focused: boolean = false;

	private controller: DashboardController;
	private theme: Theme;
	private tui: TUI;
	private done: (result: null) => void;

	constructor(
		controller: DashboardController,
		tui: TUI,
		theme: Theme,
		done: (result: null) => void,
	) {
		this.controller = controller;
		this.tui = tui;
		this.theme = theme;
		this.done = done;

		// V2 fix: subscriptions are now owned by the controller.
		// The view only registers an invalidation callback for re-rendering.
		this.controller.setOnInvalidate(() => this.tui.requestRender());

		// Route subagent ask_user prompts to this overlay while it is mounted.
		// pi renders editor-slot dialogs (ctx.ui.select/confirm/input) BENEATH a
		// full-terminal overlay, so a subagent's ask would otherwise be invisible
		// and unfocused (Plan 16 Slice 3 spike). Cleared on dispose so asks fall
		// back to the editor slot once the dashboard closes.
		AskBroker.setOverlayRenderer((req, signal) => this.controller.presentAsk(req, signal));
	}

	// ── Component interface ──────────────────────────────────────────────────

	render(width: number): string[] {
		// Layout: left panel ~20% (min 22), right panel fills rest, borders.
		const leftWidth = Math.max(22, Math.floor(width * 0.20));
		const separatorWidth = 1;
		const rightWidth = Math.max(20, width - leftWidth - separatorWidth - 3);
		const contentWidth = width - 2; // minus left and right border chars

		const visible = this.controller.getVisibleNodes();
		const state = this.controller.getState();
		const selectedNode = this.controller.getNode(state.cursorId);

		// ── Left panel: tree browser ───────────────────────────────────
		const leftLines = this.renderTreePanel(visible, state, leftWidth);

		// ── Right panel: detail ─────────────────────────────────────────
		const rightLines = selectedNode
			? this.renderDetailPanel(selectedNode, rightWidth)
			: [dim("Select a node in the tree", this.theme)];

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

		// ── Header ──────────────────────────────────────────────────────
		const headerText = ` Orchestrator Dashboard `;
		const headerPad = contentWidth - visibleWidth(border("", this.theme)) - visibleWidth(accentBold(headerText, this.theme));
		lines.push(
			border("╭", this.theme) +
				accentBold(headerText, this.theme) +
				border("─".repeat(Math.max(0, headerPad)), this.theme) +
				border("╮", this.theme),
		);

		for (let i = 0; i < contentHeight; i++) {
			// Final row-integrity guard: by this point every line has passed
			// wrapLine/truncate, but a stray line break would corrupt the whole
			// row grid — flatten defensively (should never fire).
			const left = truncateToWidth(flattenRow(paddedLeftLines[i]!), leftWidth);
			const right = truncateToWidth(flattenRow(paddedRightLines[i]!), rightWidth);
			const lPad = leftWidth - visibleWidth(left);
			const rPad = rightWidth - visibleWidth(right);
			lines.push(
				border("│", this.theme) +
					left +
					" ".repeat(Math.max(0, lPad)) +
					border("│", this.theme) +
					" " +
					right +
					" ".repeat(Math.max(0, rPad)) +
					border("│", this.theme),
			);
		}

		// ── Footer: bottom border + key hints + model/token meter ────────
		const hintsBase = state.cancelTargetId
			? " y confirm · n dismiss · esc close"
			: this.controller.isReadOnly()
				? " ↑↓ nav · → expand · ← back · ⏎ focus · ^o log · esc close · replay (read-only)"
				: " ↑↓ nav · → expand · ← back · ⏎ focus · ^o log · x cancel · esc close";
		lines.push(border("╰", this.theme) + border("─".repeat(contentWidth), this.theme) + border("╯", this.theme));

		// Aggregate model + token footer (mirrors ViewportFooterComponent).
		const aggUsage = this.controller.getAggregateUsage();
		const aggCompression = this.controller.getAggregateCompression();
		const activeModel = this.controller.getActiveModel();
		const meter = fmtTokenFooter(aggUsage, aggCompression.tokensSaved > 0 ? aggCompression : undefined);
		const modelLabel = activeModel?.provider && activeModel?.model
			? `${activeModel.provider} ${activeModel.model}`
			: (activeModel?.provider ?? activeModel?.model ?? "");

		let footerLine = "";
		if (modelLabel && meter) {
			footerLine = `${hintsBase}   ${dim(modelLabel, this.theme)}  Σ ${meter}`;
		} else if (meter) {
			footerLine = `${hintsBase}   Σ ${meter}`;
		} else if (modelLabel) {
			footerLine = `${hintsBase}   ${dim(modelLabel, this.theme)}`;
		} else {
			footerLine = hintsBase;
		}
		lines.push(dim(truncateToWidth(footerLine, width), this.theme));

		// ── Overlay an active ask_user prompt on top of dashboard content ──
		const pendingAsk = this.controller.getPendingAsk();
		if (pendingAsk) {
			return this.overlayAsk(lines, width, pendingAsk);
		}

		// ── Overlay cancel confirmation on top of dashboard content ────
		if (state.cancelTargetId) {
			return this.overlayCancelConfirm(lines, width, state.cancelTargetId);
		}

		return lines;
	}

	handleInput(data: string): void {
		// ESC always closes the overlay, regardless of focus panel or
		// cancel-confirmation state. This takes priority over the controller's
		// ESC handling (which only dismissed cancel-confirm but didn't close).
		if (matchesKey(data, Key.escape)) {
			this.dispose();
			this.done(null);
			return;
		}
		this.controller.handleInput(data);
	}

	invalidate(): void {
		// No cached render state — pure function of VM + controller state.
	}

	dispose(): void {
		// Stop routing asks here BEFORE the controller disposes (which resolves any
		// in-flight ask as cancelled), so no ask can race onto a torn-down overlay.
		AskBroker.setOverlayRenderer(null);
		this.controller.dispose();
	}

	// ── Tree panel renderer ─────────────────────────────────────────────────

	private renderTreePanel(
		visibleIds: string[],
		state: DashboardState,
		width: number,
	): string[] {
		if (visibleIds.length === 0) {
			return [dim("No session running", this.theme)];
		}

		const lines: string[] = [];

		// Header
		lines.push(accentBold(" Phases", this.theme));

		for (const id of visibleIds) {
			const node = this.controller.getNode(id);
			if (!node) continue;
			const isCursor = id === state.cursorId;
			const depth = node.depth;
			const indent = " ".repeat(depth * 2);

			// IL1: themed cursor and glyphs — no raw characters.
			const cursorChar = cursor(isCursor, this.theme);

			// Status glyph
			const glyph = nodeGlyph(node.status, this.theme);

			// Progress label for orchestrators
			let label = node.label;
			if (node.kind === "orchestrator") {
				const prog = this.controller.getSubtreeProgress(id);
				label += ` ${prog.completed}/${prog.total}`;
			}

			// Expand/collapse indicator — themed
			const expandIndicator = node.kind === "orchestrator"
				? state.expanded.has(id)
					? " "
					: collapseIndicator(this.theme)
				: " ";

			// Combine
			const prefix = `${indent}${cursorChar} ${glyph} ${expandIndicator} `;
			const styled = isCursor
				? this.theme.bold(this.theme.fg("accent", `${prefix}${label}`))
				: `${prefix}${label}`;

			lines.push(truncateToWidth(styled, width));
		}

		// IL2: dual-layer width safety — first guard in screen renderer.
		return truncateLines(lines, width);
	}

	private renderDetailPanel(node: NodeViewModel, width: number): string[] {
		const lines: string[] = [];

		// ── Header: label + status (wrap long model strings) ──────────────────
		const statusLabelStr = statusLabel(node.status);
		const modelPart = node.model ? ` · ${node.provider ?? ""} ${node.model}` : "";
		lines.push(...wrapLine(`${nodeGlyph(node.status, this.theme)} ${bold(statusLabelStr, this.theme)}${dim(modelPart, this.theme)}`, width));

		// ── Metrics line ────────────────────────────────────────────────
		const metrics = this.formatMetrics(node);
		if (metrics) lines.push(...wrapLine(dim(metrics, this.theme), width));
		lines.push("");

		// ── Orchestrator node: list children ─────────────────────────────
		if (node.kind === "orchestrator" && node.children.length > 0) {
			const children = this.controller.getChildren(node.id);
			lines.push(...wrapLine(dim(bold(`Agents · ${children.length}`, this.theme), this.theme), width));
			for (const child of children) {
				const cglyph = nodeGlyph(child.status, this.theme);
				const cmodel = child.model ? ` ${child.provider ?? ""} ${child.model}` : "";
				const cmetrics = this.formatMetrics(child);
				const cmetricsPart = cmetrics ? ` ${cmetrics}` : "";
				lines.push(
					...wrapLine(` ${cglyph} ${child.label}${dim(cmodel, this.theme)}${dim(cmetricsPart, this.theme)}`, width),
				);
			}
			lines.push("");
		}

		// ── Prompt preview (⏎ open/close, ctrl+o lifts the line cap) ────
		// Model stores the full body (storage-capped only); the view owns
		// clamping: ⏎ toggles the section, the clamp shows PROMPT_CLAMP_LINES,
		// and ctrl+o (the global full-content toggle) reveals everything.
		if (node.promptPreview) {
			const st = this.controller.getState();
			const expandIcon = promptExpandIcon(st.promptExpanded, this.theme);
			const promptLines = toDisplayLines(node.promptPreview);
			const lineCount = promptLines.length;
			const hint = st.promptExpanded ? (st.logExpanded ? "⏎ collapse · ^o clamp" : "⏎ collapse · ^o full") : "⏎ expand";
			lines.push(...wrapLine(dim(`${expandIcon} Prompt · ${lineCount} lines · ${hint}`, this.theme), width));
			if (st.promptExpanded) {
				const cap = st.logExpanded ? lineCount : PROMPT_CLAMP_LINES;
				for (const pline of promptLines.slice(0, cap)) {
					// Indent wrapped prompt lines by 2 spaces
					const wrapped = wrapLine(pline, Math.max(0, width - 4));
					for (let i = 0; i < wrapped.length; i++) {
						lines.push(dim(i === 0 ? `  ${wrapped[i]}` : `  ${wrapped[i]}`, this.theme));
					}
				}
				if (lineCount > cap) {
					lines.push(dim(`  … ${lineCount - cap} more lines · ^o expand`, this.theme));
				}
			}
			lines.push("");
		}

		// ── Activity: running log of all turns ───────────────────────────
		// Entries are stored verbatim in the model (full commands, full
		// errors, newlines and all); ALL display normalization happens here:
		// toDisplayLines splits/sanitizes, wrapLine fits the pane width, and
		// long entries clamp to LOG_CLAMP_ROWS unless expanded (ctrl+o).
		// Rendered for ALL node kinds: leaf nodes carry subagent tool-call
		// activity (via the viewport observer); orchestrator-kind root nodes
		// carry the orchestrator's own decision log (gates, verdicts,
		// escalations, halts) mirrored from its notify stream.
		if (node.tailBuffer.length > 0) {
			const expanded = this.controller.getState().logExpanded;
			const total = node.tailBuffer.length;
			const modeHint = expanded ? "^o clamp" : "^o expand";
			lines.push(
				...wrapLine(dim(`Activity · ${total} log entr${total === 1 ? "y" : "ies"} · ${modeHint}`, this.theme), width),
			);
			// A 2-column hanging indent keeps every continuation row inside the box
			// gutter, aligned under the ╭/│ connector instead of sliding to column
			// 0. A "continuation" is any row after the entry's head — whether it
			// came from a newline split (toDisplayLines, e.g. a multi-line
			// narration) or a width wrap (wrapLine). Only the head row carries the
			// connector; wrap to `width - gutter` so indented rows still fit.
			const TAIL_GUTTER = "  ";
			const wrapWidth = Math.max(0, width - TAIL_GUTTER.length);
			for (const tline of node.tailBuffer) {
				const rows: string[] = [];
				let entryHeadSeen = false;
				for (const displayLine of toDisplayLines(tline)) {
					for (const w of wrapLine(paintTailLine(displayLine, this.theme), wrapWidth)) {
						rows.push(entryHeadSeen ? TAIL_GUTTER + w : w);
						entryHeadSeen = true;
					}
				}
				if (expanded || rows.length <= LOG_CLAMP_ROWS) {
					lines.push(...rows);
				} else {
					lines.push(...rows.slice(0, LOG_CLAMP_ROWS));
					lines.push(dim(`  …(+${rows.length - LOG_CLAMP_ROWS} rows · ^o expand)`, this.theme));
				}
			}
			lines.push("");
		}

		// ── Outcome ─────────────────────────────────────────────────────
		if (node.outcomePreview) {
			lines.push(dim("Outcome", this.theme));
			for (const oline of node.outcomePreview.split("\n").slice(0, 8)) {
				const wrapped = wrapLine(oline, Math.max(0, width - 4));
				for (const wl of wrapped) {
					lines.push(`  ${wl}`);
				}
			}
			const lineCount = node.outcomePreview.split("\n").length;
			if (lineCount > 8) {
				lines.push(dim(`  … ${lineCount - 8} more lines`, this.theme));
			}
		}

		// IL2: dual-layer width safety — first guard in screen renderer.
		return truncateLines(lines, width);
	}

	/** Render a cancel-confirmation dialog overlaid on the dashboard.
	 *  The dashboard content stays visible above and below the dialog.
	 *  The outer frame borders (│ on each side) are preserved across the
	 *  dialog rows so the two-panel layout doesn't visually collapse.
	 *  The dialog is centered and accepts y/Enter to confirm or n/Esc to
	 *  dismiss. The overlay stays until the user decides — Esc only
	 *  dismisses the cancel prompt, not the dashboard.
	 */
	/**
	 * Render an active ask_user prompt as a centered modal over the dashboard
	 * (Plan 16 Slice 3). Mirrors overlayCancelConfirm's box + centering so the
	 * frame and outer │ borders stay intact; body varies by input type. All
	 * visible strings route through theme helpers (IL1); every row is clamped to
	 * the dialog width (IL2/IL10 via truncateToWidth/visibleWidth).
	 */
	private overlayAsk(baseLines: string[], width: number, ask: PendingAsk): string[] {
		const contentWidth = width - 2;
		const dialogW = Math.min(contentWidth, 72);
		const innerW = Math.max(1, dialogW - 4); // content area inside "│ " … " │"
		const req = ask.req;

		// ── Inner content lines (themed; each clamped to innerW visible cols) ──
		const body: string[] = [];
		body.push(warn("⚠ Forge needs your input", this.theme));
		for (const q of wrapLine(req.question, innerW)) body.push(bold(q, this.theme));
		body.push("");

		if (req.type === "confirm") {
			body.push(dim(truncateToWidth("y  yes     n  no", innerW), this.theme));
			body.push("");
			body.push(dim(truncateToWidth("y confirm · n dismiss · esc cancel", innerW), this.theme));
		} else if (req.type === "choice") {
			const opts = req.options ?? [];
			opts.forEach((opt, i) => {
				const selected = i === ask.choiceIndex;
				const label = truncateToWidth(opt, innerW - 2);
				body.push((selected ? accent("▸ ", this.theme) : "  ") + (selected ? accentBold(label, this.theme) : label));
			});
			body.push("");
			body.push(dim(truncateToWidth("↑↓ move · ⏎ select · esc cancel", innerW), this.theme));
		} else {
			// text — single-line buffer with a cursor block
			body.push(border("▏ ", this.theme) + truncateToWidth(`${ask.textBuf}▎`, innerW - 2));
			body.push("");
			body.push(dim(truncateToWidth("type · ⌫ delete · ⏎ submit · esc cancel", innerW), this.theme));
		}

		// ── Frame into a bordered box (each row padded to dialogW) ──
		const diagLines: string[] = [];
		const rule = border("─".repeat(dialogW - 2), this.theme);
		const blank = border("│", this.theme) + " ".repeat(dialogW - 2) + border("│", this.theme);
		diagLines.push(border("╭", this.theme) + rule + border("╮", this.theme));
		diagLines.push(blank);
		for (const row of body) {
			const pad = Math.max(0, dialogW - 4 - visibleWidth(row));
			diagLines.push(border("│", this.theme) + " " + row + " ".repeat(pad) + " " + border("│", this.theme));
		}
		diagLines.push(blank);
		diagLines.push(border("╰", this.theme) + rule + border("╯", this.theme));

		// ── Center within the content area, preserving outer │ borders ──
		const startRow = Math.max(0, Math.floor((baseLines.length - diagLines.length) / 2));
		const leftPad = Math.max(0, Math.floor((contentWidth - dialogW) / 2));
		const result: string[] = [...baseLines];
		for (let i = 0; i < diagLines.length && startRow + i < result.length; i++) {
			const diagLine = diagLines[i]!;
			const rightPad = Math.max(0, contentWidth - leftPad - visibleWidth(diagLine));
			result[startRow + i] =
				border("│", this.theme) + " ".repeat(leftPad) + diagLine + " ".repeat(rightPad) + border("│", this.theme);
		}
		return result;
	}

	private overlayCancelConfirm(baseLines: string[], width: number, targetId: string): string[] {
		const node = this.controller.getNode(targetId);
		const label = node?.label ?? targetId;

		// Content width is the full width minus the two outer │ borders.
		const contentWidth = width - 2;

		// Build the dialog box (narrower than the full content area so it
		// floats with padding on each side).
		const dialogW = Math.min(contentWidth, 60);
		const diagLines: string[] = [];

		const prompt = warn(`⚠ Cancel ${bold(label, this.theme)}?`, this.theme);
		const actions = dim("y confirm · n dismiss · esc close", this.theme);
		const promptW = visibleWidth(prompt);
		const actionsW = visibleWidth(actions);

		diagLines.push(border("╭", this.theme) + border("─".repeat(dialogW - 2), this.theme) + border("╮", this.theme));
		diagLines.push(border("│", this.theme) + " ".repeat(dialogW - 2) + border("│", this.theme));
		{
			// Place prompt and actions side by side when they fit; stack otherwise.
			const sideBySide = promptW + actionsW + 4 <= dialogW - 2;
			if (sideBySide) {
				const contentGap = Math.max(1, dialogW - 4 - promptW - actionsW);
				const contentLine =
					border("│", this.theme) + " " + prompt + " ".repeat(contentGap) + actions + " " + border("│", this.theme);
				if (visibleWidth(contentLine) < dialogW) {
					// Pad content line to full dialog width.
					const pad = dialogW - 2 - visibleWidth(contentLine.slice(1, -1));
					diagLines.push(
						border("│", this.theme) +
						" " + prompt + " ".repeat(contentGap + Math.max(0, pad)) + actions +
						" " + border("│", this.theme),
					);
				} else {
					diagLines.push(contentLine);
				}
			} else {
				// Stacked: prompt on one line, actions on the next.
				const promptPad = Math.max(0, dialogW - 2 - 1 - promptW - 1);
				diagLines.push(border("│", this.theme) + " " + prompt + " ".repeat(promptPad) + border("│", this.theme));
				const actionsPad = Math.max(0, dialogW - 2 - 1 - actionsW - 1);
				diagLines.push(border("│", this.theme) + " " + actions + " ".repeat(actionsPad) + border("│", this.theme));
			}
		}
		diagLines.push(border("│", this.theme) + " ".repeat(dialogW - 2) + border("│", this.theme));
		diagLines.push(border("╰", this.theme) + border("─".repeat(dialogW - 2), this.theme) + border("╯", this.theme));

		// Center the dialog vertically within the content rows and
		// horizontally within the content area, preserving the outer │
		// borders on every row so the frame stays intact.
		const totalLines = baseLines.length;
		const diagH = diagLines.length;
		const startRow = Math.max(0, Math.floor((totalLines - diagH) / 2));
		const leftPad = Math.max(0, Math.floor((contentWidth - dialogW) / 2));

		const result: string[] = [...baseLines];
		for (let i = 0; i < diagH && startRow + i < result.length; i++) {
			const diagLine = diagLines[i]!;
			const diagVisW = visibleWidth(diagLine);
			const rightPad = Math.max(0, contentWidth - leftPad - diagVisW);
			// Preserve the outer │ borders: left border + centered dialog + right border.
			result[startRow + i] =
				border("│", this.theme) + " ".repeat(leftPad) + diagLine + " ".repeat(rightPad) + border("│", this.theme);
		}

		return result;
	}

	private formatMetrics(node: NodeViewModel): string {
		const parts: string[] = [];
		if (node.usage.input || node.usage.output || node.usage.cacheRead) {
			parts.push(fmtTokenFooter(node.usage));
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