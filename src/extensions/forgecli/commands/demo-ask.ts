// commands/demo-ask.ts — dev-only live demo of the ask_user dashboard overlay.
//
// Registered ONLY under FORGE_DEMO=1 (off in production). It seeds a small
// orchestrator tree, opens the dashboard overlay, and fires one real
// AskBroker.ask into it — so you can arrow-key the HARD-gate modal in your own
// terminal and see forge#114 Slice 3 end to end, without a model or API key.
//
// This doubles as a manual smoke test for the overlay-ask path.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getOrchestratorTree } from "../orchestrator-tree.js";
import { openDashboardTui } from "../tui/thread-switcher.js";
import { AskBroker } from "../ask-broker.js";

/** True when the dev demo command should be registered. */
export function isDemoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.FORGE_DEMO === "1";
}

export function registerDemoAsk(pi: ExtensionAPI): void {
	if (!isDemoEnabled()) return; // dev-gated — production never registers it

	pi.registerCommand("forge:demo-ask", {
		description:
			"Dev demo (FORGE_DEMO=1): open the dashboard and fire a live ask_user prompt into it — " +
			"arrow-key the HARD-gate modal to see forge#114 Slice 3.",
		async handler(_args: string, ctx: ExtensionCommandContext) {
			// Seed a small, realistic run tree so the dashboard has content.
			const tree = getOrchestratorTree();
			tree.startNode("DEMO-S01", { label: "wfl:run-sprint · DEMO", kind: "orchestrator" });
			tree.startNode("DEMO-S01-T01", { parentId: "DEMO-S01", label: "▸ wfl:run-task · demo", kind: "orchestrator" });
			tree.startNode("DEMO-S01-T01:plan", { parentId: "DEMO-S01-T01", label: "plan · architect", kind: "leaf" });
			tree.appendTail("DEMO-S01-T01:plan", "HARD GATE — asking user to ratify the token map");

			// Fire the ask once the overlay has mounted and registered its renderer.
			// AskBroker.ask throws when neither a bound UI nor an overlay renderer is
			// present, so wait for the dashboard to register (it does so on mount).
			const askPromise = (async () => {
				for (let i = 0; i < 40 && !AskBroker.hasOverlayRenderer(); i++) {
					await new Promise((r) => setTimeout(r, 25));
				}
				if (!AskBroker.hasOverlayRenderer()) return; // dashboard never opened
				const r = await AskBroker.ask({
					question: "Ratify the design-token mapping table before implementation?",
					type: "choice",
					options: ["Ratify as-is", "Revise mapping", "Abort task"],
					default: "Ratify as-is",
				});
				// Surface the outcome live in the dashboard log, and notify on close.
				tree.appendTail("DEMO-S01-T01:plan", r.ok ? `✓ user chose: ${r.value}` : `✗ dismissed: ${r.message}`);
				ctx.ui.notify(
					r.ok ? `[forge:demo-ask] user answered: ${r.value}` : `[forge:demo-ask] dismissed — ${r.message}`,
					r.ok ? "info" : "warning",
				);
			})();

			// Open the dashboard (blocks until the user closes it with Esc). The ask
			// fires into it; answering resolves askPromise, closing cancels it.
			await openDashboardTui(ctx);
			await askPromise;
		},
	});
}
