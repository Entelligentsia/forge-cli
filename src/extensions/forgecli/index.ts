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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverForgeRoot } from "./forge-root.js";

let notified = false;

export default function forgecli(pi: ExtensionAPI): void {
	const forgeRoot = discoverForgeRoot();
	if (!forgeRoot) return;

	pi.on("session_start", async (_event, ctx) => {
		if (notified) return;
		notified = true;
		ctx.ui.notify("forgecli active", "info");
	});
}
