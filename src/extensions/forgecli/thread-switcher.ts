// thread-switcher.ts — single-viewport thread switcher for forge:run-task.
//
// One-row chip strip below the editor. Each chip represents one thread the
// user can view in the main chat viewport: "main" (the default pi
// conversation) plus one chip per subagent phase that has run during the
// active run-task session.
//
// Activation: spatial. Press ↓ in the editor — the chip strip sits right
// below the editor, so falling out of the editor downward enters strip-focus
// mode. Activation only fires when:
//   (a) the editor's content has no newlines (preserves multi-line Down nav)
//   (b) there's at least one subagent chip to navigate to (main alone is
//       pointless — it's already focused by default)
//
// While focused:
//   ←/→        move cursor between chips
//   ↑          exit strip-focus mode, return to editor. Viewport unchanged.
//   Enter      commit cursor → focused; if non-main, swap chat viewport to
//              that phase's tail via ctx.ui.setOutputSource(component);
//              if main, restore default with setOutputSource(null).
//   Esc        exit strip-focus AND snap viewport back to main (muscle-memory
//              "go home" shortcut).
//
// /forge:threads slash command is also registered as a discoverable fallback.
//
// Chip glyphs:
//   ▸label     cursor (only one)
//   ●label     currently the focused source of the chat viewport
//   ◆label     subagent with unread warnings since last focused
//   ◇label     live subagent, no unread
//   ✓label     subagent that completed cleanly
//   ✗label     subagent that failed
//
// Data plane: SessionRegistry (session-registry.ts) — chips read phases from
// the most-recent run-task session; tail-view reads getTailLines(...) for
// the focused phase and re-renders on the "tail" event.

import type { ExtensionAPI, ExtensionContext, Theme } from "@entelligentsia/pi-coding-agent";
import type { Component } from "@entelligentsia/pi-tui";

import { type PhaseSummary, getSessionRegistry, type SessionRegistry, type SessionState } from "./session-registry.js";

const WIDGET_KEY = "forge:thread-switcher";

interface ChipTarget {
	/** "main" sentinel or phaseRole. */
	id: string;
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
	) {
		const onTail = (e: { taskId: string; phaseRole: string }) => {
			if (e.taskId === this.taskId && e.phaseRole === this.phaseRole) {
				this.invalidationCb?.();
			}
		};
		registry.on("tail", onTail);
		// Cache the unsubscribe so dispose() can release it.
		this.dispose = () => registry.off("tail", onTail);
	}

	render(_width: number): string[] {
		const lines = this.registry.getTailLines(this.taskId, this.phaseRole);
		if (lines.length === 0) {
			return [`(no output yet for ${this.phaseRole})`];
		}
		return lines;
	}

	invalidate(): void {
		// invalidate is called by pi-tui's render loop; nothing to do here —
		// the data is always read fresh in render(). The hook is here so the
		// "tail" event can trigger an upstream re-render via requestRender,
		// supplied by the registrar.
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
	 *  "main" = default (no override). */
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
		this.dispose = () => {
			registry.off("change", onChange);
			registry.off("tail", onChange);
		};
	}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
	}

	/** Snapshot of available chips at render time. */
	private chips(): ChipTarget[] {
		const out: ChipTarget[] = [{ id: "main", label: "main", taskId: null }];
		const session = this.activeSession();
		if (session) {
			// Most-recent phase per role wins (review-plan re-runs collapse to one chip).
			const seen = new Set<string>();
			for (let i = session.phases.length - 1; i >= 0; i--) {
				const p = session.phases[i];
				if (seen.has(p.role)) continue;
				seen.add(p.role);
				out.push({ id: p.role, label: p.role, taskId: session.taskId });
			}
			// Restore plan-order (phases were declared in pipeline order).
			out.sort((a, b) => {
				if (a.id === "main") return -1;
				if (b.id === "main") return 1;
				const ia = session.phases.findIndex((p) => p.role === a.id);
				const ib = session.phases.findIndex((p) => p.role === b.id);
				return ia - ib;
			});
		}
		return out;
	}

	private activeSession(): SessionState | undefined {
		// Most-recently-updated running or recently-completed session.
		const all = this.registry.listSessions();
		return all[0];
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

	render(width: number): string[] {
		const chips = this.chips();
		// Clamp cursor.
		if (this.cursorIdx >= chips.length) this.cursorIdx = chips.length - 1;
		if (this.cursorIdx < 0) this.cursorIdx = 0;

		const theme = this.theme;
		const dim = (s: string) => theme.fg("dim", s);
		const accent = (s: string) => theme.fg("accent", s);
		const bold = (s: string) => theme.bold(s);

		const parts = chips.map((c, i) => {
			const isCursor = this.stripActive && i === this.cursorIdx;
			const glyph = this.chipGlyph(c);
			const label = c.label;
			const inner = `${glyph} ${label}`;
			if (isCursor) return accent(bold(`▸${inner}`));
			if (this.focusedChipId === c.id) return bold(inner);
			return dim(inner);
		});

		const prefix = this.stripActive ? accent("threads ─ ") : dim("threads ─ ");
		const hint = this.stripActive
			? dim("  ←→ select · enter focus · ↑ back to editor · esc back+main")
			: dim("  ↓ to navigate");

		let line = prefix + parts.join("   ");
		// pi-tui truncates lines that exceed width, but we want to keep the
		// hint visible — drop chip labels first if needed. For v0, accept
		// natural truncation and just append hint.
		line = `${line}${hint}`;
		// Hard cap on line length to width (rough — exact ANSI-aware width
		// is the renderer's job).
		if (line.length > width) line = line.slice(0, width - 1) + "…";
		return [line];
	}

	invalidate(): void {
		// no-op; data read fresh in render(). External invalidationCb drives re-renders.
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

	chipCount(): number {
		return this.chips().length;
	}

	/** Returns the chip the cursor is currently on. */
	cursorChip(): ChipTarget | undefined {
		return this.chips()[this.cursorIdx];
	}

	setFocusedChipId(id: string): void {
		this.focusedChipId = id;
		this.invalidationCb?.();
	}

	getFocusedChipId(): string {
		return this.focusedChipId;
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
	// Bare ESC. Note: ESC is also the prefix for arrow sequences. The arrow
	// checks above run first; isEsc only fires if the input is exactly "\x1b"
	// (a real escape press, not a multi-byte sequence start).
	return d === "\x1b";
}

// ── Registrar ───────────────────────────────────────────────────────────────

export function registerThreadSwitcher(pi: ExtensionAPI): void {
	const registry = getSessionRegistry();
	let stripRef: ChipStripComponent | undefined;
	let tailRef: TailViewComponent | undefined;
	let mounted = false;

	function mount(ctx: ExtensionContext): void {
		if (mounted) return;
		try {
			ctx.ui.setWidget(
				WIDGET_KEY,
				(_tui, theme) => {
					const strip = new ChipStripComponent(registry, theme);
					strip.setInvalidationCallback(() => {
						// Trigger pi-tui re-render. setWidget redraws when the factory
						// component invalidates; we trigger via setStatus key bump as a
						// lightweight signal (no-op semantically, but ensures the render
						// tick fires). If pi exposes a direct requestRender on the widget
						// API, prefer that; for now, the registry events drive re-render
						// on the next user-input tick.
					});
					stripRef = strip;
					return strip;
				},
				{ placement: "belowEditor" },
			);
			mounted = true;

			// Install raw input interceptor. Two modes:
			//   1. Strip inactive: only intercept Down (to activate strip), and
			//      only when the editor has no multi-line content AND there's
			//      at least one subagent chip to focus.
			//   2. Strip active: arrows navigate; Up exits; Enter focuses;
			//      Esc exits + resets viewport to main.
			ctx.ui.onTerminalInput((data) => {
				if (!stripRef) return undefined;

				if (!stripRef.getStripActive()) {
					if (!isDownArrow(data)) return undefined;
					// Don't steal Down from a multi-line editor.
					const editorText = ctx.ui.getEditorText();
					if (editorText.includes("\n")) return undefined;
					// Don't activate when there are no subagent chips to navigate to.
					if (stripRef.chipCount() <= 1) return undefined;
					stripRef.setStripActive(true);
					// Park the cursor on the first non-main chip — main is already
					// where the viewport sits by default; the user almost always
					// wants a subagent.
					stripRef.setCursor(1);
					return { consume: true };
				}

				// Strip-active mode.
				if (isLeftArrow(data)) {
					stripRef.moveCursor(-1);
					return { consume: true };
				}
				if (isRightArrow(data)) {
					stripRef.moveCursor(1);
					return { consume: true };
				}
				if (isUpArrow(data)) {
					// Return to editor without changing the viewport.
					stripRef.setStripActive(false);
					return { consume: true };
				}
				if (isEnter(data)) {
					commitFocus(ctx);
					return { consume: true };
				}
				if (isEsc(data)) {
					// Exit strip-focus AND snap viewport back to main.
					stripRef.setStripActive(false);
					setFocusToMain(ctx);
					return { consume: true };
				}
				// Other keys: stay in strip-focus, pass through to the editor.
				// (e.g. user can keep typing while glancing at the strip;
				// they'll see chip glyph changes update in real time.)
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
		// Tear down any prior tail view; build a fresh one for the new phase.
		tailRef?.dispose?.();
		const tail = new TailViewComponent(registry, chip.taskId, chip.id);
		tail.setInvalidationCallback(() => {
			// Re-rendering of the chat viewport on tail update is driven by
			// pi-tui's internal render loop noticing the chatContainer's
			// sourceOverride.invalidate() fires. SourceOverridableContainer
			// already forwards invalidate(). The "tail" event on registry
			// triggers TailViewComponent.invalidationCb which here is a no-op;
			// we rely on next render tick to pick up the new lines.
		});
		tailRef = tail;
		ctx.ui.setOutputSource(tail);
		// Reading the phase clears its unread marker.
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
			"Easier: just press ↓ from the prompt when subagents are running. " +
			"While active: ←→ navigate · enter focus a thread in the chat viewport · " +
			"↑ return to editor · esc return to editor and snap viewport back to main.",
		async handler(_args, ctx) {
			mount(ctx);
			stripRef?.setStripActive(true);
		},
	});
}
