// orchestrator-status-bar.ts — One-line status bar for running orchestrations.
//
// Two render modes, distinguished by focus indicator:
//
//   INACTIVE (outline ○ prefix — navigation hint):
//     ○ [CART-S03-T01 · writeback:1 ⠋] "preview…"  ↓ dashboard
//
//     ○ signals "you can ↓ here". Colour carries status: green=completed,
//     red=failed, accent=running, muted=other terminal.
//
//   ACTIVE (filled ● prefix — focus confirmation):
//     ● [CART-S03-T01 · writeback:1 ⠋] "preview…"  ⏎ open · esc back
//
//     ● signals "you're here". ↑/Esc returns focus to the prompt.
//
// Visual semantics (two dimensions on one circle):
//   Shape:  ○ = not focused,  ● = focused
//   Colour: accent=running, success=completed, error=failed, muted=terminal
//   ⠋ spinner: shows activity (only for running/cancelling nodes)
//
// Focus lifecycle:  ↓ activates → ↑/Esc deactivates → prompt gets focus.
// All activation/deactivation is handled by the ForgeInputRouter listener
// in thread-switcher.ts (not by this widget's handleInput, which is dead
// code for setWidget components since pi-tui routes input to the prompt
// editor before setWidget components).
//
// Iron Laws conformance:
//   IL1 — All visible strings route through theme.fg()/bg()/bold(). No raw glyphs.
//   IL7 — Spinner timer guarded by disposed flag to prevent stale callbacks.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { OrchestratorTree } from "../orchestrator-tree.js";
import { fmtTokenMeter } from "../viewport/renderer.js";

// ── Braille spinner ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

// ── Focus indicator colour: derives the theme colour from the root's
// aggregate status. The shape (○/●) carries focus; the colour carries
// status. Both dimensions on the same circle glyph.
//
//   ○ green  = not focused, completed    ● green  = focused, completed
//   ○ red    = not focused, failed       ● red    = focused, failed
//   ○ dim    = not focused, terminal     ● dim    = focused, terminal
//   ○ accent = not focused, running      ● accent = focused, running

function focusIndicatorColour(roots: import("../orchestrator-tree.js").OrchestratorNode[], theme: Theme): import("@earendil-works/pi-coding-agent").ThemeColor {
	// Derive the aggregate status from all visible roots.
	// Running/cancelling wins over terminal; failed wins over completed.
	const hasRunning = roots.some((r) => r.status === "running" || r.status === "cancelling");
	if (hasRunning) return "accent";

	const hasFailed = roots.some((r) => r.status === "failed" || r.status === "escalated");
	if (hasFailed) return "error";

	const hasCompleted = roots.some((r) => r.status === "completed");
	if (hasCompleted) return "success";

	// Terminal but not failed/completed (cancelled, pending, etc.).
	return "muted";
}

// ── OrchestratorStatusBar ──────────────────────────────────────────────────

export class OrchestratorStatusBar implements Component {
	private tree: OrchestratorTree;
	private theme: Theme;
	private active = false;
	private disposed = false; // IL7: guards interval callbacks after dispose
	private invalidationCb?: () => void;
	private spinnerTimer?: NodeJS.Timeout;
	private spinnerIdx = 0;
	private onAction?: () => void; // callback to open dashboard
	private disposeFns: Array<() => void> = [];

	constructor(tree: OrchestratorTree, theme: Theme) {
		this.tree = tree;
		this.theme = theme;

		const onChange = () => {
			if (!this.disposed) {
				this.ensureSpinnerTimer(); // restart spinner if roots became active
				this.invalidationCb?.();
			}
		};
		this.tree.on("change", onChange);
		this.tree.on("tree", onChange);
		this.tree.on("tail", onChange);
		this.tree.on("preview", onChange);
		this.disposeFns.push(
			() => { this.tree.off("change", onChange); this.tree.off("tree", onChange); this.tree.off("tail", onChange); this.tree.off("preview", onChange); },
		);
	}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
		this.ensureSpinnerTimer();
	}

	setOnAction(cb: () => void): void {
		this.onAction = cb;
	}

	setActive(active: boolean): void {
		this.active = active;
		if (!this.disposed) {
			this.ensureSpinnerTimer(); // restart spinner if needed
			this.invalidationCb?.();
		}
	}

	isActive(): boolean {
		return this.active;
	}

	private ensureSpinnerTimer(): void {
		if (this.spinnerTimer) return;
		// Only start the timer when there are running/cancelling roots to animate.
		const anyActive = this.tree.getActiveRoots().some(
			(r) => r.status === "running" || r.status === "cancelling",
		);
		if (!anyActive) return; // no spinner needed yet
		this.spinnerTimer = setInterval(() => {
			// IL7: guard against firing after dispose.
			if (this.disposed) {
				this.stopSpinnerTimer();
				return;
			}
			const anyActive = this.tree.getActiveRoots().some(
				(r) => r.status === "running" || r.status === "cancelling",
			);
			if (!anyActive) {
				// One last render to settle spinner, then stop.
				this.invalidationCb?.();
				this.stopSpinnerTimer();
				return;
			}
			this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
			this.invalidationCb?.();
		}, SPINNER_INTERVAL_MS);
	}

	private stopSpinnerTimer(): void {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
	}

	render(width: number): string[] {
		const roots = this.tree.getActiveRoots();
		if (roots.length === 0) return []; // Hidden when nothing is running.

		const dim = (s: string) => this.theme.fg("dim", s);
		const bold = (s: string) => this.theme.bold(this.theme.fg("accent", s));

		// Build a segment for each active root.
		const segments: string[] = [];
		for (const root of roots) {
			// Find the deepest running leaf or the root itself.
			const leaf = this.findDeepestRunningLeaf(root.id);
			const displayNode = leaf ?? root;

			// Label: root label, with current phase as suffix if different.
			let label = root.label;
			if (leaf && leaf.id !== root.id) {
				const shortRole = leaf.id.includes(":") ? leaf.id.split(":").slice(1).join(":") : leaf.label;
				label = `${root.label} · ${shortRole}`;
			}

			// Usage footer (right-aligned within segment).
			const usage = this.tree.getSubtreeUsage(root.id);
			const meter = fmtTokenMeter(usage);
			const meterPart = meter ? dim(` ${meter}`) : "";

			// IL1: spinner (worm) shows activity — only for running/cancelling.
			// Not shown for terminal states (completed, failed, etc.).
			const spin = (displayNode.status === "running" || displayNode.status === "cancelling")
				? ` ${this.theme.fg("accent", SPINNER_FRAMES[this.spinnerIdx])}`
				: "";

			// Turn preview (truncated).
			const preview = displayNode.lastTurnPreview
				? dim(` "${truncateToWidth(displayNode.lastTurnPreview, 60)}"`)
				: "";

			const segment = `${bold(`[${label}]`)}${spin}${preview}${meterPart}`;
			segments.push(segment);
		}

		// Right-side hint depends on active state.
		const hint = this.active
			? dim(" ⏎ open · esc back")
			: dim(" ↓ dashboard");

		// Focus indicator: ○/● coloured by aggregate status.
		// Shape: ○ when inactive ("↓ here"), ● when active ("you're here").
		// Colour: accent=running, success=completed, error=failed, muted=terminal.
		const indicatorColour = focusIndicatorColour(roots, this.theme);
		const indicatorGlyph = this.active ? "●" : "○";
		const prefix = this.theme.fg(indicatorColour, indicatorGlyph) + " ";
		const joined = segments.join(dim(" │ "));
		const line = `${prefix}${joined}${hint}`;

		return [truncateToWidth(line, width)];
	}

	invalidate(): void {
		// Re-render driven by external invalidationCb → tui.requestRender().
	}

	// Note: handleInput is dead code for setWidget("belowEditor") components —
	// pi-tui routes input to the prompt editor, not to belowEditor widgets.
	// All key handling (↓ focus, ↑/Esc unfocus, Enter open dashboard) is in
	// the ForgeInputRouter listener in thread-switcher.ts.
	// Keeping the method for Component interface conformance; it does nothing.

	dispose(): void {
		this.disposed = true; // IL7: set before clearing timer so callback sees it
		this.stopSpinnerTimer();
		for (const fn of this.disposeFns) fn();
		this.disposeFns = [];
	}

	/** Walk depth-first to find the deepest running/cancelling leaf. */
	private findDeepestRunningLeaf(id: string): import("../orchestrator-tree.js").OrchestratorNode | undefined {
		const node = this.tree.getNode(id);
		if (!node) return undefined;
		if (node.kind === "leaf" && (node.status === "running" || node.status === "cancelling")) {
			return node;
		}
		for (const childId of node.children) {
			const found = this.findDeepestRunningLeaf(childId);
			if (found) return found;
		}
		// If no running leaf, return the root if it's running.
		if (node.status === "running" || node.status === "cancelling") return node;
		return undefined;
	}
}