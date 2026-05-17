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

import { type PhaseSummary, getSessionRegistry, type SessionRegistry, type SessionState } from "./session-registry.js";
import { fmtTokenFooter } from "./viewport-renderer.js";
import { paintFooterLine, paintTailLine } from "./viewport-theme.js";

const WIDGET_KEY = "forge:thread-switcher";

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
		const footerText = fmtTokenFooter(phase?.usage);

		const bodyLines = lines.length === 0
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

// ── Chip-strip component: one row below the editor ──

class ChipStripComponent implements Component {
	private cursorIdx = 0;
	/** id of the chip whose tail is currently mirrored in the chat viewport.
	 *  "main" = pi default (no override). */
	private focusedChipId = "main";
	private stripActive = false;
	private invalidationCb?: () => void;

	constructor(
		private readonly registry: SessionRegistry,
		private readonly theme: Theme,
	) {
		const onChange = () => this.invalidationCb?.();
		registry.on("change", onChange);
		registry.on("tail", onChange);
		registry.on("preview", onChange);
		this.dispose = () => {
			registry.off("change", onChange);
			registry.off("tail", onChange);
			registry.off("preview", onChange);
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
		const p = this.chipPhase(chip);
		if (!p) return "·";
		if (this.focusedChipId === chip.id) return "●";
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
		if (session.status !== "running") return "";
		const idx = Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
		return SPINNER_FRAMES[idx];
	}

	render(width: number): string[] {
		const session = this.activeSession();
		if (!session) return []; // UX-B: hide entirely when no session.

		const chips = this.chips();
		// Clamp cursor.
		if (this.cursorIdx >= chips.length) this.cursorIdx = chips.length - 1;
		if (this.cursorIdx < 0) this.cursorIdx = 0;

		return this.stripActive ? this.renderActive(width, session, chips) : this.renderInactive(width, session);
	}

	private renderInactive(width: number, session: SessionState): string[] {
		const dim = (s: string) => this.theme.fg("dim", s);
		const accent = (s: string) => this.theme.fg("accent", s);

		const spin = this.spinnerFrame(session);
		const chips = this.chips();

		// Orchestrator chip stays bracketed + accent-colored (anchor identity).
		// Subagent chips render after it as `<glyph> <role>`, dimmed —
		// completed phases show ✓, failed ✗, live ◇ (or ◆ with unread).
		// This makes phase progression visible at a glance without expanding
		// the strip.
		const orchChip = accent(`[${session.taskId}]`);
		const phaseChips = chips
			.filter((c) => c.id !== "main")
			.map((c) => dim(`${this.chipGlyph(c)} ${c.label}`));
		const chipsLine = [orchChip, ...phaseChips].join("  ");

		const prefix = dim("threads ─ ");
		const hint = dim("  ↓ to navigate");
		const spinPart = spin ? `  ${spin}` : "";
		const previewText = session.currentTurnPreview ? `  "${session.currentTurnPreview}"` : "";

		const fixedWidth =
			visibleWidth(prefix) +
			visibleWidth(chipsLine) +
			visibleWidth(spinPart) +
			visibleWidth(hint);
		const previewBudget = Math.max(0, width - fixedWidth);
		const preview = previewText ? dim(truncateToWidth(previewText, previewBudget)) : "";

		let line = `${prefix}${chipsLine}${spinPart}${preview}${hint}`;
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

		const prefix = accent("threads ─ ");
		const hint = dim("  ←→ · enter · ↑ back · esc back+main");
		const spin = this.spinnerFrame(session);
		const spinPart = spin ? `  ${spin}` : "";
		const previewText = session.currentTurnPreview ? `  "${session.currentTurnPreview}"` : "";

		const chipsJoined = parts.join("   ");
		// Use visibleWidth (strips ANSI) so truncation maths are correct.
		const fixed =
			visibleWidth(prefix) +
			visibleWidth(chipsJoined) +
			visibleWidth(spinPart) +
			visibleWidth(hint);
		const previewBudget = Math.max(0, width - fixed);
		const preview = previewText ? dim(truncateToWidth(previewText, previewBudget)) : "";

		let line = `${prefix}${chipsJoined}${spinPart}${preview}${hint}`;
		// Hard cap as last-resort defence (visibleWidth is best-effort).
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

// ── Registrar ───────────────────────────────────────────────────────────────

export function registerThreadSwitcher(pi: ExtensionAPI): void {
	const registry = getSessionRegistry();
	let stripRef: ChipStripComponent | undefined;
	let tailRef: TailViewComponent | undefined;
	let tuiRef: TUI | undefined;
	// Theme captured at widget mount — needed for paintTailLine in the tail
	// component, which is constructed lazily on chip focus (not at mount time).
	let themeRef: Theme | undefined;
	let spinnerTimer: NodeJS.Timeout | undefined;
	let mounted = false;

	function ensureSpinnerTimer(): void {
		// Tick re-renders while any session is "running" so the spinner
		// glyph animates and the preview text refreshes between user input.
		// When all sessions are terminal, the timer stops itself.
		if (spinnerTimer) return;
		spinnerTimer = setInterval(() => {
			const anyRunning = registry.listSessions().some((s) => s.status === "running");
			if (!anyRunning) {
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
			mounted = true;

			// Bootstrap the spinner ticker on any session start so the
			// inactive-mode summary animates immediately.
			registry.on("change", () => ensureSpinnerTimer());
			ensureSpinnerTimer();

			ctx.ui.onTerminalInput((data) => {
				if (!stripRef) return undefined;

				if (!stripRef.getStripActive()) {
					if (!isDownArrow(data)) return undefined;
					const editorText = ctx.ui.getEditorText();
					if (editorText.includes("\n")) return undefined; // multi-line nav
					if (!stripRef.hasSession()) return undefined; // strip hidden anyway
					stripRef.setStripActive(true);
					// Park cursor on the currently-running subagent — that's
					// the chip the user almost always wants to see. Falls back
					// to orchestrator (index 0) when no phase is live.
					stripRef.parkCursorOnCurrentPhase();
					return { consume: true };
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
					commitFocus(ctx);
					return { consume: true };
				}
				if (isEsc(data)) {
					stripRef.setStripActive(false);
					setFocusToMain(ctx);
					return { consume: true };
				}
				return undefined;
			});
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
		ctx.ui.setOutputSource(tail);
		registry.markRead(chip.taskId, chip.id);
	}

	function setFocusToMain(ctx: ExtensionContext): void {
		stripRef?.setFocusedChipId("main");
		tailRef?.dispose?.();
		tailRef = undefined;
		ctx.ui.setOutputSource(null);
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
	pi.on("session_start", async (_event, ctx) => {
		mount(ctx);
	});
}
