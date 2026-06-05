// thread-switcher.ts — orchestrator status bar + dashboard overlay for forge.
//
// Two elements:
//   1. OrchestratorStatusBar (belowEditor widget): a one-line summary of
//      running orchestrations — label, current phase, status glyph, spinner,
//      turn preview, token meter. Press ↓ to open the dashboard overlay.
//      Hidden when no orchestration is running.
//
//   2. Dashboard overlay (/forge:dashboard command or ↓ from status bar):
//      full-screen two-panel tree browser + detail view. See dashboard/.
//
// The chip strip and TailViewComponent have been retired — the dashboard
// replaces them for all orchestration visualization. The main viewport
// stays clean for user prompts and new tasks.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";

import { getInputRouter } from "./input-router.js";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { getOrchestratorTree, type OrchestratorTree } from "../orchestrator-tree.js";
import { DashboardComponent, DashboardController } from "../dashboard/component.js";
import { OrchestratorStatusBar } from "./orchestrator-status-bar.js";
import {
	getSessionRegistry,
	type SessionRegistry,
} from "../session-registry.js";
import { fmtModelLabel, fmtTokenFooter } from "../viewport/renderer.js";
import { paintFooterLine } from "../viewport/theme.js";

const STATUS_BAR_WIDGET_KEY = "forge:orchestrator-status-bar";
const FOOTER_WIDGET_KEY = "forge:viewport-footer";

// ── Aggregate token footer ──────────────────────────────────────────────────
// Mirrors the per-phase footer rendered inside TailView when a subagent chip
// was focused. Now shown at the bottom of the main viewport whenever an
// orchestration is active.

class ViewportFooterComponent implements Component {
	private invalidationCb?: () => void;

	constructor(
		private readonly registry: SessionRegistry,
		private readonly theme: Theme,
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

	invalidate(): void {}

	setInvalidationCallback(cb: () => void): void {
		this.invalidationCb = cb;
	}

	dispose: () => void;
}

// ── Registration ─────────────────────────────────────────────────────────────

function isDownArrow(data: string): boolean {
	return data === "\x1b[B" || data === "\x1bOB";
}

let statusBarRef: OrchestratorStatusBar | undefined;
let statusBarTui: import("@earendil-works/pi-tui").TUI | undefined;

// Module-level tree reference so openDashboardTui can access the singleton
// without being nested inside registerThreadSwitcher.
let treeRef: OrchestratorTree | undefined;

export interface OpenDashboardOptions {
	/**
	 * Inject a detached tree (transcript replay). Defaults to the live
	 * singleton. Injected trees are NEVER memoized into the module-level
	 * treeRef — a replay must not pollute the live dashboard entry points.
	 */
	tree?: OrchestratorTree;
	/** Read-only mode: cancel (`x`) disabled; footer marks the replay. */
	readOnly?: boolean;
}

/** Open the dashboard overlay. Shared by /forge:threads, /forge:dashboard,
 *  the status bar Enter action, and transcript replay (injected tree).
 *  Returns the overlay's lifetime promise so callers (replay re-entry loop)
 *  can await close; existing fire-and-forget call sites ignore it. */
export function openDashboardTui(ctx: ExtensionContext, opts: OpenDashboardOptions = {}): Promise<void> {
	const tree = opts.tree ?? treeRef ?? getOrchestratorTree();
	if (!opts.tree && !treeRef) treeRef = tree;

	const controller = new DashboardController(tree, undefined, { readOnly: opts.readOnly ?? false });
	const router = getInputRouter();
	router.pushOverlay();
	return ctx.ui
		.custom<null>(
			(tui, theme, _kb, done) => {
				const component = new DashboardComponent(controller, tui, theme, done);
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					width: "100%",
					anchor: "center",
					margin: 0,
				},
			},
		)
		.then(() => undefined)
		.finally(() => {
			router.popOverlay();
		});
}

export function registerThreadSwitcher(pi: ExtensionAPI): void {
	const registry = getSessionRegistry();
	const tree = getOrchestratorTree();
	treeRef = tree;
	let mounted = false;
	let currentCtx: ExtensionContext | undefined;

	function mount(ctx: ExtensionContext): void {
		currentCtx = ctx;
		if (mounted) return;

		// ── Orchestrator status bar (belowEditor) ────────────────────────
		ctx.ui.setWidget(
			STATUS_BAR_WIDGET_KEY,
			(tui, theme) => {
				statusBarTui = tui;
				const bar = new OrchestratorStatusBar(tree, theme);
				bar.setInvalidationCallback(() => tui.requestRender());
				bar.setOnAction(() => {
					// Enter on focused status bar → open dashboard.
					const live = currentCtx;
					if (live) openDashboardTui(live);
				});
				statusBarRef = bar;
				return bar;
			},
			{ placement: "belowEditor" },
		);

		// ── Aggregate token footer (aboveEditor) ─────────────────────────
		ctx.ui.setWidget(
			FOOTER_WIDGET_KEY,
			(tui, theme) => {
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

		// ── Input routing: ↓ focuses status bar; Enter opens dashboard ────────
		getInputRouter().register(
			(data) => {
				if (!statusBarRef || !statusBarTui) return undefined;

				// Allow ↓ navigation whenever orchestration roots are visible —
				// this includes completed/failed/escalated roots so the user
				// can review results even after execution ends.
				const activeRoots = tree.getActiveRoots();
				if (activeRoots.length === 0) return undefined;

				// ↓ focuses the status bar (makes it active).
				if (isDownArrow(data)) {
					statusBarRef.setActive(true);
					return { consume: true };
				}

				// When the status bar is focused, ↑ / Esc return focus to the prompt.
				if (statusBarRef.isActive() && (matchesKey(data, Key.up) || matchesKey(data, Key.escape))) {
					statusBarRef.setActive(false);
					return { consume: true };
				}

				// When the status bar is focused, Enter opens the dashboard.
				if (statusBarRef.isActive() && matchesKey(data, Key.enter)) {
					statusBarRef.setActive(false);
					const live = currentCtx;
					if (live) openDashboardTui(live);
					return { consume: true };
				}

				return undefined;
			},
			{ name: "orchestrator-status-bar", skipWhenOverlayActive: true },
		);

		mounted = true;
	}

	pi.registerCommand("forge:threads", {
		description:
			"Open the Forge orchestrator dashboard. " +
			"Shows a two-panel view of sprint/task/phase tree with status, " +
			"metrics, and live activity. You can also press ↓ from the prompt " +
			"when an orchestration is running.",
		async handler(_args, ctx) {
			mount(ctx);
			openDashboardTui(ctx);
		},
	});

	// Mount at session_start so the status bar + ↓ listener are live from
	// the first keystroke. mount() is idempotent.
	pi.on("session_start", async (_event, ctx) => {
		mount(ctx);
	});
}