// orchestrator-status-bar.ts — One-line status bar for running orchestrations.
//
// Two render modes, distinguished by focus indicator:
//
//   INACTIVE (outline ○ prefix — navigation hint):
//     ○ [HELLO-S01-T01 · plan:1 ⠋] "preview…"  ↓ dashboard
//
//     ○ signals "you can ↓ here". Spinner (⠋) separately shows activity.
//
//   ACTIVE (filled ● prefix — focus confirmation):
//     ● [HELLO-S01-T01 · plan:1 ⠋] "preview…"  ⏎ open · esc back
//
//     ● signals "you're here". ↑/Esc returns focus to the prompt.
//
// Visual semantics:
//   ○/● — bar focus state (outline = not focused, filled = focused)
//   ⠋  — activity spinner (only shown for running/cancelling nodes)
//   No worm when done — completed/failed etc. have no spinner.
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
import type { OrchestratorTree } from "./orchestrator-tree.js";
import { fmtTokenMeter } from "./viewport-renderer.js";

// ── Braille spinner ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

// ── Status glyph for a node ────────────────────────────────────────────────

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
			if (!this.disposed) this.invalidationCb?.();
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
		if (!this.disposed) this.invalidationCb?.();
	}

	isActive(): boolean {
		return this.active;
	}

	private ensureSpinnerTimer(): void {
		if (this.spinnerTimer) return;
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
		const accent = (s: string) => this.theme.fg("accent", s);
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

		// Focus indicator: outline ○ when inactive (navigation hint),
		// filled ● when active (focus confirmation). ○ says "↓ here",
		// ● says "you're here". The spinner (⠋) separately shows activity.
		const prefix = this.active ? accent("●") + " " : dim("○") + " ";
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
	private findDeepestRunningLeaf(id: string): import("./orchestrator-tree.js").OrchestratorNode | undefined {
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