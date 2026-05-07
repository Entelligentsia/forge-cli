// forgecli pi extension — Stage 1 (FORGE-S15-T03).
//
// Behaviour:
//   - When loaded outside a Forge-initialized project (no `.forge/config.json`
//     reachable via walk-up from cwd, or the config is malformed/missing
//     `paths.forgeRoot`), this extension is a silent no-op: zero handler
//     registrations, no log output.
//   - When loaded inside a Forge-initialized project, registers exactly one
//     `session_start` handler that emits `forgecli active` via
//     `ctx.ui.notify(...)` once per process.
//
// Tools/commands/hooks land in T04+; this file is intentionally minimal.
//
// Spike R1 (FORGE-S15-T04): when FORGE_SPIKE_R1=1, registers the /forge-poc:r1
// command via registerPocRunTask. Gated behind env flag; does not alter
// production behaviour when flag is absent.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverForgeRoot } from "./forge-root.js";

let notified = false;

export default async function forgecli(pi: ExtensionAPI): Promise<void> {
	const forgeRoot = discoverForgeRoot();
	if (!forgeRoot) return;

	pi.on("session_start", async (_event, ctx) => {
		if (notified) return;
		notified = true;
		ctx.ui.notify("forgecli active", "info");
	});

	// Spike R1 — env-gated; dynamic import awaited before factory returns
	// so the command is registered before the spike runner activates.
	// PLAN_REVIEW iter2 advisory: top-level await import ensures the command
	// is registered in time.
	// The session reference is injected via setSession() in session-harness.ts
	// (closure setter — not globalThis). This is a spike-only pattern.
	if (process.env.FORGE_SPIKE_R1 === "1") {
		const { registerPocRunTask } = await import(
			"../../../test/poc/spike-r1/spike.js"
		);
		registerPocRunTask(pi);
	}
}
