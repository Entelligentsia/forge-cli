// dashboard/register.ts — Registers /forge:dashboard as a pi command.
//
// The dashboard is a full-terminal overlay (ctx.ui.custom with overlay: true)
// that renders the OrchestratorTree as a two-panel tree browser + detail view.
// Parallel to the chip strip — both read from their respective models; the
// dashboard does not replace or modify the chip strip.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getOrchestratorTree } from "../orchestrator-tree.js";
import { DashboardComponent, DashboardController } from "./component.js";
import { getInputRouter } from "../input-router.js";

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

			const controller = new DashboardController(tree);
			const router = getInputRouter();
			router.pushOverlay();
			try {
				await ctx.ui.custom<null>((tui, theme, _kb, done) => {
					const component = new DashboardComponent(controller, tui, theme, done);
					return component;
				}, {
					overlay: true,
					overlayOptions: {
						width: "100%",
						anchor: "center",
						margin: 0,
					},
				});
			} finally {
				router.popOverlay();
			}
		},
	});
}