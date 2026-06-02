// orchestrator-status-bar.ts — One-line status bar for running orchestrations.
//
// Two render modes:
//
//   INACTIVE (default):
//     [HELLO-S01-T01 ● plan ⠋] "preview…"  ↓ dashboard
//
//     Shows a compact summary with status, spinner, and a ↓ hint.
//     Press ↓ to focus the status bar.
//
//   ACTIVE (user pressed ↓):
//     ▸ [HELLO-S01-T01 ● plan ⠋] "preview…"  ⏎ open · esc back
//
//     Cursor glyph highlights the bar. Enter opens the dashboard overlay.
//     Esc returns focus to the editor.
//
// The dashboard overlay (/forge:dashboard) remains the detailed view.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { OrchestratorTree, NodeStatus } from "./orchestrator-tree.js";
import { fmtTokenMeter } from "./viewport-renderer.js";

// ── Braille spinner ────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

// ── Status glyph for a node ────────────────────────────────────────────────

function nodeGlyph(status: NodeStatus, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "running":
			return theme.fg("accent", "●");
		case "cancelling":
			return theme.fg("warning", "⏳");
		case "cancelled":
			return theme.fg("muted", "⊘");
		case "failed":
			return theme.fg("error", "✗");
		case "escalated":
			return theme.fg("error", "▲");
		case "pending":
		default:
			return theme.fg("dim", "○");
	}
}

// ── OrchestratorStatusBar ──────────────────────────────────────────────────

export class OrchestratorStatusBar implements Component {
	private tree: OrchestratorTree;
	private theme: Theme;
	private active = false;
	private invalidationCb?: () => void;
	private spinnerTimer?: NodeJS.Timeout;
	private spinnerIdx = 0;
	private onAction?: () => void; // callback to open dashboard
	private disposeFns: Array<() => void> = [];

	constructor(tree: OrchestratorTree, theme: Theme) {
		this.tree = tree;
		this.theme = theme;

		const onChange = () => this.invalidationCb?.();
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
		this.invalidationCb?.();
	}

	isActive(): boolean {
		return this.active;
	}

	private ensureSpinnerTimer(): void {
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			const anyActive = this.tree.getActiveRoots().some(
				(r) => r.status === "running" || r.status === "cancelling",
			);
			if (!anyActive) {
				// One last render to settle spinner, then stop.
				this.invalidationCb?.();
				if (this.spinnerTimer) clearInterval(this.spinnerTimer);
				this.spinnerTimer = undefined;
				return;
			}
			this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
			this.invalidationCb?.();
		}, SPINNER_INTERVAL_MS);
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

			// Spinner for running nodes.
			const spin = (displayNode.status === "running" || displayNode.status === "cancelling")
				? ` ${SPINNER_FRAMES[this.spinnerIdx]}`
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

		// Compose: join segments with separator, append hint.
		const prefix = this.active ? accent("▸") + " " : "";
		const joined = segments.join(dim(" │ "));
		const line = `${prefix}${joined}${hint}`;

		return [truncateToWidth(line, width)];
	}

	invalidate(): void {
		// Re-render driven by external invalidationCb → tui.requestRender().
	}

	handleInput(data: string): void {
		if (!this.active) return;
		if (matchesKey(data, Key.enter)) {
			this.active = false;
			this.onAction?.(); // open dashboard
		} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.up)) {
			this.active = false; // deactivate, return to editor
		}
		this.invalidationCb?.();
	}

	dispose: () => void = () => {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
		for (const fn of this.disposeFns) fn();
		this.disposeFns = [];
	};

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