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
//
// Spike R2 (FORGE-S15-T05): when FORGE_SPIKE_R2=1, loads and registers the
// vendored subagent default export via dynamic default import. This validates
// that the vendored subagent module (dist/extensions/forgecli/subagent/index.js)
// imports correctly when forgecli is consumed as an npm pack tarball.
// The import path uses a variable (not a string literal) per SPIKE-LESSONS §5
// to avoid rootDir violations. Does not alter production behaviour when absent.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverForgeRoot } from "./forge-root.js";

let notified = false;

export default async function forgecli(pi: ExtensionAPI): Promise<void> {
	// Spike R2 — env-gated; runs BEFORE the forgeRoot early-return so it works
	// even when no .forge/config.json is present (e.g. in an isolated tmp dir).
	// This is intentional: AC4 tests that the vendored subagent module resolves
	// cleanly from the installed tarball path, independent of Forge project state.
	// Import path is a variable (not a string literal) per SPIKE-LESSONS §5
	// to avoid TS rootDir violations. The default export is an anonymous
	// function matching: (pi: ExtensionAPI) => void (subagent/index.ts:442).
	// FORGE_SPIKE_R2_DEBUG=1 enables diagnostic logging.
	if (process.env.FORGE_SPIKE_R2 === "1") {
		const subagentPath = "./subagent/index.js";
		if (process.env.FORGE_SPIKE_R2_DEBUG === "1") {
			console.error("[forge-cli R2] loading vendored subagent from:", subagentPath);
		}
		const mod = (await import(subagentPath)) as {
			default: (pi: ExtensionAPI) => void;
		};
		mod.default(pi);
		if (process.env.FORGE_SPIKE_R2_DEBUG === "1") {
			console.error("[forge-cli R2] vendored subagent registered");
		}
	}

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
		const spikePath = "../../../test/poc/spike-r1/spike.js";
		const mod = (await import(spikePath)) as {
			registerPocRunTask: (pi: ExtensionAPI) => void;
		};
		mod.registerPocRunTask(pi);
	}
}
