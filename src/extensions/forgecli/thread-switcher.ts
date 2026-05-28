// thread-switcher.ts — single-viewport thread switcher for forge:run-task.
//
// One-row strip below the editor with two render modes:
//
//   INACTIVE (default, ↓ not pressed):
//     threads ─ [HLO-S01-T04 · plan ⠋]  "Now update the task status…"
//
//     Compact summary line — orchestrator chip with current phase + cycling
//     spinner, followed by the latest assistant-turn preview. Replaces the
//     legacy ctx.ui.setStatus bottom line (the chip strip IS the live status).
//
//   ACTIVE (user pressed ↓):
//     threads ─ ▸● HLO-S01-T04   ◇ plan   ◆ review-plan   ✓ implement   ⠋  "…preview"
//
//     Full chip list with cursor/focus glyphs. ←→ navigates; Enter focuses
//     a chip into the main chat viewport via ctx.ui.setOutputSource; ↑
//     returns to editor without changing the viewport; Esc returns to
//     editor AND snaps viewport back to main.
//
// The strip is HIDDEN entirely (zero rows) when no run-task session has
// ever started in this pi conversation — pi default chat occupies the
// space normally.
//
// Activation key: ↓ from the editor when (a) the editor has no newlines
// (preserves multi-line Down nav) and (b) there's at least one session
// in the registry. /forge:threads slash command works as a fallback.
//
// Chip glyphs:
//   ▸<label>   cursor (only one)
//   ●<label>   currently the focused source of the chat viewport
//   ○<label>   orchestrator chip when something else is focused
//   ◇<label>   live subagent, no unread warnings
//   ◆<label>   live subagent with unread warnings since last focused
//   ✓<label>   subagent that completed cleanly
//   ✗<label>   subagent that failed
//
// Data plane: SessionRegistry (session-registry.ts) — chips read phases
// from the most-recent run-task session; tail-view reads getTailLines(...)
// for the focused phase. All re-renders are driven by tui.requestRender()
// (registry events → invalidationCb → requestRender → next render tick).

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { getInputRouter } from "./input-router.js";
import {
	getSessionRegistry,
	type PhaseSummary,
	type SessionRegistry,
	type SessionState,
	type SessionStatus,
} from "./session-registry.js";
import { fmtModelAndTokenFooter, fmtModelLabel, fmtTokenFooter } from "./viewport-renderer.js";
import { paintFooterLine, paintTailLine } from "./viewport-theme.js";

const WIDGET_KEY = "forge:thread-switcher";
const FOOTER_WIDGET_KEY = "forge:viewport-footer";

// Braille spinner frames — universally supported, 10 frames feels smooth at
// 100ms cadence.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

interface ChipTarget {
	/** "main" sentinel or phaseRole. */
	id: string;
	/** Display text (orchestrator taskId for main, phase role for subagents). */
	label: string;
	/** Source taskId (null for main). */
	taskId: string | null;
}

// ── Tail-view component: rendered into the chat viewport when a chip is focused ──

class TailViewComponent implements Component {
	private invalidationCb?: () => void;

	constructor(
		private readonly registry: SessionRegistry,
		private readonly taskId: string,
		private readonly phaseRole: string,
		private readonly theme: Theme | undefined,
	) {
		const onTail = (e: { taskId: string; phaseRole: string }) => {
			if (e.taskId === this.taskId && e.phaseRole === this.phaseRole) {
				this.invalidationCb?.();
			}
		};
		registry.on("tail", onTail);
		this.dispose = () => registry.off("tail", onTail);
	}

	render(width: number): string[] {
		const lines = this.registry.getTailLines(this.taskId, this.phaseRole);
		const session = this.registry.getSession(this.taskId);
		const phase = session?.phases.find((p) => p.role === this.phaseRole);
		const footerText = fmtModelAndTokenFooter(
			phase ? { provider: phase.provider, model: phase.model } : undefined,
			phase?.usage,
			phase?.compression,
		);

		const bodyLines =
			lines.length === 0
				? [truncateToWidth(`(no output yet for ${this.phaseRole})`, width)]
				: lines.map((line) => {
						const painted = paintTailLine(line, this.theme);
						return visibleWidth(painted) <= width ? painted : truncateToWidth(painted, width);
					});

		if (!footerText) return bodyLines;

		// Footer = right-aligned token summary on its own line. Sits at the
		// bottom of the tail view (right above the prompt) when pi-tui autoscroll
		// is at the tail end, which is the default after new output.
		const footer = paintFooterLine(footerText, width, this.theme);
		return [...bodyLines, footer];
	}

	invalidate(): void {
		// Re-render is driven by external invalidationCb → tui.requestRender().
	}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
	}

	dispose: () => void;
}

// ── Main-viewport footer: sticky Σ aggregate token meter ──
//
// Rendered as a widget at `aboveEditor` placement so it sits at the bottom
// of the main chat viewport (matching the position of the per-phase TailView
// footer). Subscribes to registry events and right-aligns
// `Σ ↑input ↓output ⇪cacheRead`.

class ViewportFooterComponent implements Component {
	private invalidationCb?: () => void;

	constructor(
		private readonly registry: SessionRegistry,
		private readonly theme: Theme,
		/**
		 * Returns the parent pi session's current (provider, model) — the
		 * "outer orchestrator" model. Caller closes over ExtensionContext
		 * and is responsible for guarding stale-ctx access; return undefined
		 * on failure or when no model is set. When undefined, the footer
		 * just shows `Σ ↑X ↓Y`.
		 */
		private readonly getOrchestratorModel?: () => { provider?: string; model?: string } | undefined,
	) {
		const onChange = () => this.invalidationCb?.();
		registry.on("change", onChange);
		registry.on("tail", onChange);
		registry.on("turn", onChange);
		this.dispose = () => {
			registry.off("change", onChange);
			registry.off("tail", onChange);
			registry.off("turn", onChange);
		};
	}

	render(width: number): string[] {
		// Only show the footer when an orchestrator session is active.
		// When all sessions are terminal (completed/failed/cancelled) or
		// when no session exists, hide the footer — main viewport has no
		// subagent aggregate to display.
		const sessions = this.registry.listSessions();
		const hasActive = sessions.some((s) => s.status === "running" || s.status === "cancelling");
		if (!hasActive) return [];

		const tokens = fmtTokenFooter(this.registry.getAggregateUsage(), this.registry.getAggregateCompression());
		const orchModel = fmtModelLabel(this.getOrchestratorModel?.());
		if (!tokens && !orchModel) return [];
		const left = orchModel ? `⌂ ${orchModel}` : "";
		const right = tokens ? `Σ ${tokens}` : "";
		const text = left && right ? `${left}  ${right}` : left || right;
		return [paintFooterLine(text, width, this.theme)];
	}

	invalidate(): void {
		// Re-render driven by external invalidationCb → tui.requestRender().
	}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
	}

	dispose: () => void;
}

// ── Chip-strip component: one row below the editor ──

class ChipStripComponent implements Component {
	private cursorIdx = 0;
	/** id of the chip whose tail is currently mirrored in the chat viewport.
	 *  "main" = pi default (no override). */
	private focusedChipId = "main";
	private stripActive = false;
	private invalidationCb?: () => void;
	/** When non-null, the strip shows a cancellation confirmation prompt
	 *  for this chip instead of the normal chip view. */
	private cancelTarget: ChipTarget | null = null;

	constructor(
		private readonly registry: SessionRegistry,
		private readonly theme: Theme,
	) {
		const onChange = () => this.invalidationCb?.();
		registry.on("change", onChange);
		registry.on("tail", onChange);
		registry.on("preview", onChange);
		registry.on("turn", onChange);
		this.dispose = () => {
			registry.off("change", onChange);
			registry.off("tail", onChange);
			registry.off("preview", onChange);
			registry.off("turn", onChange);
		};
	}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
	}

	private activeSession(): SessionState | undefined {
		// Most-recently-updated session (running or recently terminal).
		return this.registry.listSessions()[0];
	}

	hasSession(): boolean {
		return this.activeSession() !== undefined;
	}

	/** Snapshot of available chips at render time. Empty when no session. */
	private chips(): ChipTarget[] {
		const session = this.activeSession();
		if (!session) return [];

		// Orchestrator chip: label = taskId (the orchestrator's identity in
		// this pi conversation). id stays "main" so focus/output-source
		// semantics ("main" = setOutputSource(null) = pi default) are stable.
		const out: ChipTarget[] = [{ id: "main", label: session.taskId, taskId: null }];

		// Dedupe phases by role, keep most-recent attempt (review loops),
		// then restore pipeline order via findIndex.
		const seen = new Set<string>();
		for (let i = session.phases.length - 1; i >= 0; i--) {
			const p = session.phases[i];
			if (seen.has(p.role)) continue;
			seen.add(p.role);
			out.push({ id: p.role, label: p.role, taskId: session.taskId });
		}
		out.sort((a, b) => {
			if (a.id === "main") return -1;
			if (b.id === "main") return 1;
			const ia = session.phases.findIndex((p) => p.role === a.id);
			const ib = session.phases.findIndex((p) => p.role === b.id);
			return ia - ib;
		});
		return out;
	}

	private chipPhase(chip: ChipTarget): PhaseSummary | undefined {
		if (chip.id === "main" || !chip.taskId) return undefined;
		const s = this.registry.getSession(chip.taskId);
		if (!s) return undefined;
		for (let i = s.phases.length - 1; i >= 0; i--) {
			if (s.phases[i].role === chip.id) return s.phases[i];
		}
		return undefined;
	}

	private chipGlyph(chip: ChipTarget): string {
		if (chip.id === "main") return this.focusedChipId === "main" ? "●" : "○";
		const session = this.activeSession();
		const p = this.chipPhase(chip);
		if (!p) return "·";
		if (this.focusedChipId === chip.id) return "●";
		// Cancelling/cancelled glyphs are session-level, not phase-level.
		// Show ⏳ for any phase when the session is cancelling, ⊘ when cancelled.
		if (session?.status === "cancelled" && p.status !== "completed" && p.status !== "failed") return "⊘";
		if (session?.status === "cancelling" && p.status === "running") return "⏳";
		if (p.status === "cancelled") return "⊘";
		if (p.status === "completed") return "✓";
		if (p.status === "failed") return "✗";
		if (p.unreadWarnings > 0) return "◆";
		return "◇";
	}

	private currentPhaseRole(session: SessionState): string | undefined {
		// Prefer a currently-running phase; else fall back to the most-recent
		// phase (whatever happened last, even if completed).
		for (let i = session.phases.length - 1; i >= 0; i--) {
			if (session.phases[i].status === "running") return session.phases[i].role;
		}
		return session.phases[session.phases.length - 1]?.role;
	}

	private spinnerFrame(session: SessionState): string {
		if (session.status !== "running" && session.status !== "cancelling") return "";
		const idx = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
		return SPINNER_FRAMES[idx];
	}

	render(width: number): string[] {
		const session = this.activeSession();
		if (!session) return []; // UX-B: hide entirely when no session.

		// If user is confirming cancellation, show the confirmation prompt.
		if (this.cancelTarget) {
			return this.renderCancelPrompt(width, this.cancelTarget);
		}

		const chips = this.chips();
		// Clamp cursor.
		if (this.cursorIdx >= chips.length) this.cursorIdx = chips.length - 1;
		if (this.cursorIdx < 0) this.cursorIdx = 0;

		return this.stripActive ? this.renderActive(width, session, chips) : this.renderInactive(width, session);
	}

	private renderInactive(width: number, session: SessionState): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const accent = (s: string) => this.theme.fg("accent", s);

		const chips = this.chips();
		const spin = this.spinnerFrame(session);

		// Orchestrator chip: bracketed + accent-colored (anchor identity).
		// Subagent chips: <glyph> <role>, dimmed.
		const orchChip = accent(`[${session.taskId}]`);
		const phaseChips = chips.filter((c) => c.id !== "main").map((c) => dim(`${this.chipGlyph(c)} ${c.label}`));
		const chipsLine = [orchChip, ...phaseChips].join("  ");

		// Right-side: status · spinner · command hints.
		// Cancelled sessions show "r resume" affordance; all others show "↓ to navigate".
		const statusLabel =
			session.status === "cancelled" ? "cancelled" : session.status === "cancelling" ? "cancelling…" : "";
		const statusPart = statusLabel ? dim(`  ${statusLabel}`) : "";
		const spinPart = spin ? `  ${spin}` : "";
		const hint = session.status === "cancelled" ? dim("  ↓ nav · r resume") : dim("  ↓ to navigate");

		// Truncate preview text from the MIDDLE of the line to keep chips and hints visible.
		const previewText = session.currentTurnPreview ? `"${session.currentTurnPreview}"` : "";
		// Priority: chips + status + spinner + hint are fixed.
		// Truncate preview first, then truncate from the right as fallback.
		const fixedRight = visibleWidth(statusPart) + visibleWidth(spinPart) + visibleWidth(hint);
		const previewBudget = Math.max(0, width - fixedRight - 4); // 4 = safety margin
		let preview = "";
		if (previewText) {
			// Truncate the preview text itself to fit the budget
			const truncated = truncateToWidth(previewText, previewBudget);
			if (visibleWidth(truncated) > 0) preview = dim(`  ${truncated}`);
		}

		// Build line; truncate from the right (preview tail) if still over-width.
		let line = `${chipsLine}${statusPart}${spinPart}${preview}${hint}`;
		if (visibleWidth(line) > width) {
			// Truncate preview tail first (not chips)
			const budget = Math.max(0, width - visibleWidth(chipsLine) - fixedRight);
			const previewOnly = truncateToWidth(previewText, budget);
			preview = previewOnly ? dim(`  ${previewOnly}`) : "";
			line = `${chipsLine}${statusPart}${spinPart}${preview}${hint}`;
		}
		if (visibleWidth(line) > width) line = truncateToWidth(line, width);
		return [line];
	}

	private renderActive(width: number, session: SessionState, chips: ChipTarget[]): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const accent = (s: string) => this.theme.fg("accent", s);
		const bold = (s: string) => this.theme.bold(s);

		const parts = chips.map((c, i) => {
			const isCursor = i === this.cursorIdx;
			const glyph = this.chipGlyph(c);
			const label = c.label;
			const inner = `${glyph} ${label}`;
			if (isCursor) return accent(bold(`▸${inner}`));
			if (this.focusedChipId === c.id) return bold(inner);
			return dim(inner);
		});

		const prefix = "";
		// "r resume" shown only for cancelled sessions; "x cancel" for running ones.
		const cancelWord = session.status === "cancelled" ? dim("r resume") : dim("x cancel");
		const navHints = dim(" ←→ · enter · ↑ back · esc back+main");
		// Show status-based text for non-running sessions
		let statusPart = "";
		if (session.status === "cancelling") {
			statusPart = "  cancelling…";
		} else if (session.status === "cancelled") {
			statusPart = "  cancelled";
		}
		const spin = this.spinnerFrame(session);
		const spinPart = spin ? `  ${spin}` : "";
		const previewText = session.currentTurnPreview ? `  "${session.currentTurnPreview}"` : "";

		const chipsJoined = parts.join("   ");
		// Use visibleWidth (strips ANSI) so truncation maths are correct.
		const fixed =
			visibleWidth(prefix) +
			visibleWidth(chipsJoined) +
			visibleWidth(spinPart) +
			visibleWidth(statusPart) +
			visibleWidth(cancelWord) +
			visibleWidth(navHints);
		const previewBudget = Math.max(0, width - fixed);
		const preview = previewText ? dim(truncateToWidth(previewText, previewBudget)) : "";

		let line = `${prefix}${chipsJoined}${spinPart}${statusPart}${preview}   ${cancelWord}  ${navHints}`;
		// Hard cap as last-resort defence (visibleWidth is best-effort).
		if (visibleWidth(line) > width) line = truncateToWidth(line, width);
		return [line];
	}

	/**
	 * Render the cancellation confirmation prompt. Replaces the normal
	 * chip strip when cancelTarget is non-null.
	 *   ⚠ Cancel [taskId] → [phaseRole]?  y/n · esc to abort
	 */
	private renderCancelPrompt(width: number, target: ChipTarget): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const warning = (s: string) => this.theme.fg("warning", s);
		const bold = (s: string) => this.theme.bold(s);

		const taskLabel = target.taskId ?? target.label;
		const phaseLabel = target.id === "main" ? "session" : target.label;

		// "cancel" sits right after the prompt — most visible position.
		// Truncation sacrifices the dim dismiss-hints from the END, keeping
		// the action word and the warning always readable.
		const actionWord = dim("cancel");
		const hints = dim(" · n/esc dismiss · y confirm");
		const prompt = warning(`⚠ Cancel ${bold(taskLabel)} → ${bold(phaseLabel)}? `);

		const budget = Math.max(0, width - visibleWidth(prompt) - visibleWidth(actionWord));
		const tail = budget > 0 ? dim(` · n/esc dismiss · y confirm`) : "";
		const budgetedTail =
			visibleWidth(tail) > budget ? dim(truncateToWidth(` · n/esc dismiss · y confirm`, budget)) : tail;

		let line = `${prompt}${actionWord}${budgetedTail}`;
		if (visibleWidth(line) > width) line = truncateToWidth(line, width);
		return [line];
	}

	invalidate(): void {
		// Re-render driven by external invalidationCb → tui.requestRender().
	}

	dispose: () => void;

	// ── Input handling ──────────────────────────────────────────────────────

	setStripActive(active: boolean): void {
		if (this.stripActive === active) return;
		this.stripActive = active;
		this.invalidationCb?.();
	}

	/** Initiate cancel confirmation for a chip. Sets cancelTarget so the
	 *  next render shows the confirmation prompt. */
	requestCancelChip(chip: ChipTarget): void {
		this.cancelTarget = chip;
		this.invalidationCb?.();
	}

	/** Confirm the pending cancellation (user pressed y). */
	confirmCancel(): ChipTarget | null {
		const target = this.cancelTarget;
		this.cancelTarget = null;
		this.invalidationCb?.();
		return target;
	}

	/** Dismiss the cancel prompt (user pressed n/Esc). */
	dismissCancel(): void {
		this.cancelTarget = null;
		this.invalidationCb?.();
	}

	/** Whether a cancel confirmation prompt is active. */
	isCancelPromptActive(): boolean {
		return this.cancelTarget !== null;
	}

	/** Check if the chip at the current cursor is a running phase that can be cancelled. */
	isCursorCancellable(): boolean {
		const chip = this.cursorChip();
		if (!chip) return false;
		if (chip.id === "main") {
			const session = this.activeSession();
			return (session?.status ?? "") === "running";
		}
		const p = this.chipPhase(chip);
		if (!p) return false;
		return p.status === "running";
	}

	/** True when the current session is cancelled — r key triggers resume. */
	isCursorResumable(): boolean {
		const session = this.activeSession();
		return session?.status === "cancelled";
	}

	getStripActive(): boolean {
		return this.stripActive;
	}

	moveCursor(delta: number): void {
		const chips = this.chips();
		this.cursorIdx = Math.max(0, Math.min(chips.length - 1, this.cursorIdx + delta));
		this.invalidationCb?.();
	}

	setCursor(idx: number): void {
		const chips = this.chips();
		this.cursorIdx = Math.max(0, Math.min(chips.length - 1, idx));
		this.invalidationCb?.();
	}

	/**
	 * Park the cursor on the currently-running subagent chip if there is one,
	 * else fall back to the orchestrator chip (index 0). Called on ↓ activation
	 * so the user lands on the most interesting chip by default — the live
	 * phase — instead of having to ←→ walk to find it.
	 */
	parkCursorOnCurrentPhase(): void {
		const chips = this.chips();
		const session = this.activeSession();
		const runningRole = session ? this.currentPhaseRole(session) : undefined;
		if (runningRole) {
			const idx = chips.findIndex((c) => c.id === runningRole);
			if (idx >= 0) {
				this.cursorIdx = idx;
				this.invalidationCb?.();
				return;
			}
		}
		this.cursorIdx = 0;
		this.invalidationCb?.();
	}

	chipCount(): number {
		return this.chips().length;
	}

	cursorChip(): ChipTarget | undefined {
		return this.chips()[this.cursorIdx];
	}

	setFocusedChipId(id: string): void {
		this.focusedChipId = id;
		this.invalidationCb?.();
	}
}

// ── Key recognition ─────────────────────────────────────────────────────────

function isLeftArrow(d: string): boolean {
	return d === "\x1b[D";
}
function isRightArrow(d: string): boolean {
	return d === "\x1b[C";
}
function isDownArrow(d: string): boolean {
	return d === "\x1b[B" || d === "\x1bOB";
}
function isUpArrow(d: string): boolean {
	return d === "\x1b[A" || d === "\x1bOA";
}
function isEnter(d: string): boolean {
	return d === "\r" || d === "\n";
}
function isEsc(d: string): boolean {
	// Bare ESC. Multi-byte arrow sequences start with ESC but are matched
	// by the arrow checks above first.
	return d === "\x1b";
}

function isXKey(d: string): boolean {
	return d === "x";
}
function isRKey(d: string): boolean {
	return d === "r" || d === "R";
}
function isYKey(d: string): boolean {
	return d === "y" || d === "Y";
}
function isNKey(d: string): boolean {
	return d === "n" || d === "N";
}

// ── Registrar ───────────────────────────────────────────────────────────────

/**
 * Custom renderer for the `forge:turn` chat-history rows we append on every
 * subagent turn_end. Paints the `[displayRole]` prefix accent + bold, the
 * `tN` marker dim, and leaves the preview body in the default text colour.
 */
function registerTurnMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<{ displayRole?: string; turn?: number }>("forge:turn", (message, _opts, theme) => {
		const rawContent =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c as { text?: string }).text ?? "").join("");
		const m = rawContent.match(/^\[([^\]]+)\]\s+t(\d+)\s+(.*)$/);
		let line: string;
		if (m) {
			const [, role, turn, body] = m;
			line = `${theme.bold(theme.fg("accent", `[${role}]`))} ${theme.fg("dim", `t${turn}`)} ${body}`;
		} else {
			line = rawContent;
		}
		return {
			render: (_w: number) => [line],
			invalidate: () => {},
			setInvalidationCallback: () => {},
		};
	});
}

export function registerThreadSwitcher(pi: ExtensionAPI): void {
	registerTurnMessageRenderer(pi);
	const registry = getSessionRegistry();
	let stripRef: ChipStripComponent | undefined;
	let tailRef: TailViewComponent | undefined;
	let tuiRef: TUI | undefined;
	// Theme captured at widget mount — needed for paintTailLine in the tail
	// component, which is constructed lazily on chip focus (not at mount time).
	let themeRef: Theme | undefined;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let mounted = false;
	// Pi invalidates the ExtensionContext after newSession / fork /
	// switchSession / reload. The input-router handler and the focus
	// helpers are registered once at mount but fire after arbitrary
	// session replacements — they must read the *live* ctx, not the
	// one captured at mount time. We refresh this on every
	// session_start and on every forge:threads command invocation.
	let currentCtx: ExtensionContext | undefined;

	function ensureSpinnerTimer(): void {
		// Tick re-renders while any session is "running" or "cancelling" so the
		// spinner glyph animates and the preview text refreshes between user input.
		// When all sessions are terminal, the timer stops itself.
		if (spinnerTimer) return;
		spinnerTimer = setInterval(() => {
			const anyActive = registry.listSessions().some((s) => s.status === "running" || s.status === "cancelling");
			if (!anyActive) {
				if (spinnerTimer) clearInterval(spinnerTimer);
				spinnerTimer = undefined;
				// One last render to settle the spinner into its final frame.
				tuiRef?.requestRender();
				return;
			}
			tuiRef?.requestRender();
		}, SPINNER_INTERVAL_MS);
	}

	function mount(ctx: ExtensionContext): void {
		currentCtx = ctx;
		if (mounted) return;
		process.stderr.write("[forge:threads] mount() invoked\n");
		try {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					tuiRef = tui;
					themeRef = theme;
					const strip = new ChipStripComponent(registry, theme);
					strip.setInvalidationCallback(() => tui.requestRender());
					stripRef = strip;
					return strip;
				},
				{ placement: "belowEditor" },
			);

			// Aggregate Σ token meter — sticky right-bottom of the main chat
			// viewport (mirrors the per-phase footer rendered inside TailView
			// when a subagent chip is focused).
			ctx.ui.setWidget(
				FOOTER_WIDGET_KEY,
				(tui, theme) => {
					// Guard against stale-ctx access after session replacement
					// (newSession / fork / switchSession / reload) — touching
					// ctx.model on a stale ctx throws and would crash the row.
					const getOrchestratorModel = (): { provider?: string; model?: string } | undefined => {
						try {
							const m = ctx.model;
							if (!m) return undefined;
							return { provider: m.provider, model: m.id };
						} catch {
							return undefined;
						}
					};
					const footer = new ViewportFooterComponent(registry, theme, getOrchestratorModel);
					footer.setInvalidationCallback(() => tui.requestRender());
					return footer;
				},
				{ placement: "aboveEditor" },
			);

			// Bubble each subagent's turn-complete event into the parent
			// (main) viewport as a new custom message — pi APPENDS one row per
			// call rather than replacing a single notification line. Users see
			// every subagent's turns stream into the main chat history in
			// order, identified by `[displayRole]`. triggerTurn:false so no
			// LLM round-trip; the message is render-only.
			registry.on("turn", (evt) => {
				// Skip silent turns (no preview, no thinking) — would just add
				// noise rows to the parent chat history.
				if (!evt.preview && !evt.thinking) return;
				const body = evt.preview ? `"${evt.preview}"` : `✱ ${evt.thinking}`;
				try {
					pi.sendMessage(
						{
							customType: "forge:turn",
							content: `[${evt.displayRole}] t${evt.turn} ${body}`,
							display: true,
							details: { ...evt },
						},
						{ triggerTurn: false },
					);
				} catch {
					// pi.sendMessage may throw if called before session is
					// fully ready or if the session has shut down — non-fatal.
				}
			});

			mounted = true;

			// Bootstrap the spinner ticker on any session start so the
			// inactive-mode summary animates immediately.
			registry.on("change", () => ensureSpinnerTimer());
			ensureSpinnerTimer();

			// Plan 16 Slice 4c: register via forge-input-router so that overlays
			// (e.g. /forge:config) suppress the ↓ activator while mounted.
			getInputRouter().register(
				(data) => {
					if (!stripRef) return undefined;
					const live = currentCtx;
					if (!live) return undefined;

					if (!stripRef.getStripActive()) {
						if (!isDownArrow(data)) return undefined;
						let editorText = "";
						try {
							editorText = live.ui.getEditorText();
						} catch {
							return undefined;
						}
						if (editorText.includes("\n")) return undefined; // multi-line nav
						if (!stripRef.hasSession()) return undefined; // strip hidden anyway
						stripRef.setStripActive(true);
						stripRef.parkCursorOnCurrentPhase();
						return { consume: true };
					}

					// ── Cancel-confirmation handling (cancelTarget active) ────────
					// When the strip shows a cancel prompt, y/Enter confirms,
					// n/Esc dismisses. All other keys are consumed (no passthrough).
					if (stripRef.isCancelPromptActive()) {
						if (isYKey(data) || isEnter(data)) {
							const target = stripRef.confirmCancel();
							if (target?.taskId) {
								registry.requestCancel(target.taskId);
							}
							stripRef.setStripActive(false);
							setFocusToMain(live);
							return { consume: true };
						}
						// Dismiss: n, Esc
						if (isNKey(data) || isEsc(data)) {
							stripRef.dismissCancel();
							stripRef.setStripActive(false);
							return { consume: true };
						}
						// Any other key in cancel-confirmation mode is consumed silently.
						return { consume: true };
					}

					if (isXKey(data)) {
						const chip = stripRef.cursorChip();
						if (chip && stripRef.isCursorCancellable()) {
							stripRef.requestCancelChip(chip);
							return { consume: true };
						}
						return undefined;
					}

					if (isRKey(data)) {
						// Resume a cancelled session. The state file is preserved on cancel
						// (ADR-S21-01). Write the slash command to the editor and simulate
						// Enter — exactly mirrors how a user types and submits the command.
						const session = registry.listSessions()[0];
						if (session && stripRef.isCursorResumable()) {
							const entityId = session.taskId;
							const cmd = entityId.startsWith("FORGE-BUG-")
								? `forge:fix-bug ${entityId}`
								: `forge:run-task ${entityId}`;
							stripRef.setStripActive(false);
							try {
								live.ui.setEditorText(`/${cmd}`);
							} catch {
								// Non-fatal — editor may not be accessible in all contexts.
								live.ui.notify(`↻ Resume: /${cmd}`, "info");
							}
							// Return Enter to submit the command. The router dispatches
							// normally; pi processes it as a slash-command submit.
							return { data: "\r" };
						}
						return undefined;
					}

					if (isLeftArrow(data)) {
						stripRef.moveCursor(-1);
						return { consume: true };
					}
					if (isRightArrow(data)) {
						stripRef.moveCursor(1);
						return { consume: true };
					}
					if (isUpArrow(data)) {
						stripRef.setStripActive(false);
						return { consume: true };
					}
					if (isEnter(data)) {
						commitFocus(live);
						return { consume: true };
					}
					if (isEsc(data)) {
						stripRef.setStripActive(false);
						setFocusToMain(live);
						return { consume: true };
					}
					return undefined;
				},
				{ name: "thread-switcher-strip", skipWhenOverlayActive: true },
			);
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(`forge:threads failed to mount: ${e.message ?? "unknown"}`, "error");
		}
	}

	function commitFocus(ctx: ExtensionContext): void {
		if (!stripRef) return;
		const chip = stripRef.cursorChip();
		if (!chip) return;
		stripRef.setFocusedChipId(chip.id);
		if (chip.id === "main" || !chip.taskId) {
			setFocusToMain(ctx);
			return;
		}
		tailRef?.dispose?.();
		const tail = new TailViewComponent(registry, chip.taskId, chip.id, themeRef);
		// Wire the same requestRender hook so new tail lines surface
		// without needing user input.
		if (tuiRef) tail.setInvalidationCallback(() => tuiRef?.requestRender());
		tailRef = tail;
		try {
			ctx.ui.setOutputSource(tail);
		} catch {
			// ctx went stale between keypress and dispatch — drop quietly;
			// the next session_start will refresh currentCtx.
		}
		registry.markRead(chip.taskId, chip.id);
	}

	function setFocusToMain(ctx: ExtensionContext): void {
		stripRef?.setFocusedChipId("main");
		tailRef?.dispose?.();
		tailRef = undefined;
		try {
			ctx.ui.setOutputSource(null);
		} catch {
			// see commitFocus
		}
	}

	pi.registerCommand("forge:threads", {
		description:
			"Activate the Forge thread-switcher strip below the editor. " +
			"Easier: press ↓ from the prompt when a run-task is active. " +
			"While active: ←→ navigate · enter focus · ↑ back to editor · esc back to editor + viewport to main.",
		async handler(_args, ctx) {
			mount(ctx);
			stripRef?.setStripActive(true);
		},
	});

	// Mount at session_start so the Down listener + chip strip are live
	// from the first keystroke. mount() is idempotent.
	// session_start fires for the initial session and for every
	// post-replacement session (newSession / fork / switchSession /
	// reload), so mount() refreshing currentCtx here is the single
	// chokepoint for keeping the input-router handler's ctx live.
	pi.on("session_start", async (_event, ctx) => {
		mount(ctx);
	});
}
