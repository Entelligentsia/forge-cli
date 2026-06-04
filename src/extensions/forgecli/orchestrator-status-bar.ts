// orchestrator-status-bar.ts — One-line status bar for running orchestrations.
//
// Two render modes, distinguished by focus indicator:
//
//   INACTIVE (outline ○ prefix — navigation hint):
//     ○ [HELLO-S01-T01 ● plan ⠋] "preview…"  ↓ dashboard
//
//     Press ↓ to focus the status bar. ○ signals "you can navigate here".
//
//   ACTIVE (accent ▸ prefix — focus confirmation):
//     ▸ [HELLO-S01-T01 ● plan ⠋] "preview…"  ⏎ open · esc back
//
//     ↑ / Esc returns focus to the prompt. Enter opens the dashboard.
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
import type { OrchestratorTree, NodeStatus } from "./orchestrator-tree.js";
import { fmtTokenMeter } from "./viewport-renderer.js";

// ── Braille spinner ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

// ── Status glyph for a node ────────────────────────────────────────────────

// ── Status glyph for a node (status bar) ───────────────────────────────────
//
// Uses filled ● for active states (running, cancelling) and outline ○ for
// terminal/idle states so the bar is scannable at a glance: filled = still
// going, outline = done. Per-status colouring conveys the outcome.

function nodeGlyph(status: NodeStatus, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("accent", "●");   // filled — active
		case "cancelling":
			return theme.fg("warning", "●");  // filled — winding down
		case "completed":
			return theme.fg("success", "○");  // outline — done
		case "failed":
			return theme.fg("error", "○");     // outline — error
		case "escalated":
			return theme.fg("error", "○");     // outline — escalated
		case "cancelled":
			return theme.fg("muted", "○");    // outline — stopped
		case "pending":
		default:
			return theme.fg("dim", "○");       // outline — waiting
	}
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
			const glyph = nodeGlyph(displayNode.status, this.theme);

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

			// IL1: spinner characters themed with accent colour.
			const spin = (displayNode.status === "running" || displayNode.status === "cancelling")
				? ` ${this.theme.fg("accent", SPINNER_FRAMES[this.spinnerIdx])}`
				: "";

			// Turn preview (truncated).
			const preview = displayNode.lastTurnPreview
				? dim(` "${truncateToWidth(displayNode.lastTurnPreview, 60)}"`)
				: "";

			const segment = `${glyph} ${bold(`[${label}]`)}${spin}${preview}${meterPart}`;
			segments.push(segment);
		}

		// Right-side hint depends on active state.
		const hint = this.active
			? dim(" ⏎ open · esc back")
			: dim(" ↓ dashboard");

		// Focus indicator: outline ○ when inactive (navigation hint),
		// accent ▸ when active (focus confirmation).
		const prefix = this.active ? accent("▸") + " " : dim("○") + " ";
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