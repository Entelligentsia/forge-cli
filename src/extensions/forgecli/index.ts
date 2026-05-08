// forgecli pi extension — production factory (FORGE-S16-T02).
//
// Behaviour:
//   - Registers `/forge:init` unconditionally (even outside a Forge project).
//   - On `session_start` (UI only):
//       1. Foundry-collision detection + one-time notify (AC#7, Q17).
//       2. Outside-Forge banner when no `.forge/config.json` found (AC#4, Q14).
//       3. Inside-Forge project-name/prefix banner when inside a Forge project (AC#5).
//   - Registers full `/forge:*` command/tool set only when inside a Forge project.
//
// Spike R1/R2 env-gated blocks are preserved for backward-compat — no-op in
// production when env flags are absent.

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readProjectMeta } from "./banner.js";
import { registerForgeCommands } from "./forge-commands.js";
import { discoverForgeConfig } from "./forge-root.js";
import { registerForgeTools } from "./forge-tools.js";
import { detectFoundryCollision, markCollisionSeen, wasCollisionSeen } from "./foundry-collision.js";

// Resolve the vendored prompts directory at module load. After build, this
// file lives at <pkg>/dist/extensions/forgecli/index.js — go up three levels
// to <pkg>/, then into prompts/. In the source tree (vitest runs raw .ts), the
// equivalent climb resolves to forge-cli/prompts/.
const PROMPTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "prompts");

let notified = false;

export default async function forgecli(pi: ExtensionAPI): Promise<void> {
	// ── Spike R2 (env-gated) ──────────────────────────────────────────────────
	// Validates that the vendored subagent module resolves cleanly from the
	// installed tarball path. No-op in production.
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

	// ── Forge project discovery ───────────────────────────────────────────────
	const forgeConfig = discoverForgeConfig();
	const forgeRoot = forgeConfig?.forgeRoot ?? null;

	// ── Unconditional /forge:init (AC#4) ─────────────────────────────────────
	// Stub — full implementation lands in FORGE-S16-T04.
	pi.registerCommand("forge:init", {
		description: "Bootstrap a new Forge SDLC project at the current working directory",
		async handler(_args, ctx) {
			ctx.ui.notify("forge:init — coming in FORGE-S16-T04", "info");
		},
	});

	// ── Session start — banners + collision detection ─────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return; // headless mode — no banners
		if (notified) return;
		notified = true;

		// 1. Foundry-collision detection (AC#7)
		const collision = detectFoundryCollision();
		if (collision.collides && collision.colliderPath !== null && !wasCollisionSeen(collision.colliderPath)) {
			markCollisionSeen(collision.colliderPath);
			ctx.ui.notify(
				`forge: collision detected — another 'forge' binary found at ${collision.colliderPath}. ` +
					"Use 'forgecli' or '4ge' to disambiguate.",
				"warning",
			);
		}

		if (!forgeRoot) {
			// 2. Outside-Forge banner (AC#4, Q14)
			ctx.ui.notify("forge — no .forge/ at cwd; run /forge:init to bootstrap", "info");
			return;
		}

		// 3. Inside-Forge banner with project.name [prefix] (AC#5)
		const meta = forgeConfig ? readProjectMeta(forgeConfig.configPath) : null;
		if (meta) {
			ctx.ui.notify(`${meta.name} [${meta.prefix}]`, "info");
		}
	});

	// ── Conditional full forge:* set (AC#5) ──────────────────────────────────
	if (forgeRoot) {
		// T03: forge tools — wired (FORGE-S16-T03)
		// AC4 note: .cjs tools use findProjectRoot() not --forge-root. Equivalent
		// guarantee: forgeRoot captured at init; projectRoot passed as cwd to execFile.
		const projectRoot = path.dirname(path.dirname(forgeConfig!.configPath));
		registerForgeTools(pi, forgeRoot, projectRoot);
		// T05 stub — hook dispatcher registration
		// registerHookDispatcher(pi, forgeRoot);  — FORGE-S16-T05
	}

	// ── /forge:* command set (FORGE-S16-T04) ─────────────────────────────────
	// Registered unconditionally so /forge:ask works outside a Forge project.
	// Per-command handlers enforce the Q14 outside-project no-op contract.
	registerForgeCommands(pi, { forgeRoot, promptsRoot: PROMPTS_ROOT });

	// ── Spike R1 (env-gated) ──────────────────────────────────────────────────
	if (process.env.FORGE_SPIKE_R1 === "1") {
		const spikePath = "../../../test/poc/spike-r1/spike.js";
		const mod = (await import(spikePath)) as {
			registerPocRunTask: (pi: ExtensionAPI) => void;
		};
		mod.registerPocRunTask(pi);
	}
}
