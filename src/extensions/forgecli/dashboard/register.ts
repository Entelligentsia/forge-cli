// dashboard/register.ts — Registers /forge:dashboard as a pi command.
//
// The dashboard is a full-terminal overlay (ctx.ui.custom with overlay: true)
// that renders the OrchestratorTree as a two-panel tree browser + detail view.
// Parallel to the chip strip — both read from their respective models; the
// dashboard does not replace or modify the chip strip.
//
// Entry point consolidation: thread-switcher.ts owns openDashboardTui() and
// the /forge:threads command. This file re-exports openDashboardTui so both
// /forge:dashboard and /forge:threads (↓ from status bar) share the same
// wiring — single place to maintain overlay creation.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getOrchestratorTree } from "../orchestrator-tree.js";
import { openDashboardTui } from "../tui/thread-switcher.js";

export function registerDashboardCommand(pi: ExtensionAPI): void {
	pi.registerCommand("forge:dashboard", {
		description:
			"Show the orchestrator tree dashboard. " +
			"Two-panel view of sprint/task/phase tree with status, metrics, " +
			"and live activity. ↑↓ navigate · → expand · ← collapse · ⏎ focus · " +
			"x cancel · esc close.",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			const tree = getOrchestratorTree();

			// Nothing to show if no sessions in the tree.
			if (tree.getActiveRoots().length === 0) {
				ctx.ui.notify("No orchestrator sessions running. Start a /forge:run-task or /forge:run-sprint first.", "info");
				return;
			}

			openDashboardTui(ctx);
		},
	});
}