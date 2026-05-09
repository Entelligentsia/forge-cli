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

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "./ask-user-tool.js";
import { readProjectMeta } from "./banner.js";
import { registerAllForgeCommands, registerForgeCommands } from "./forge-commands.js";
import { registerForgeInit } from "./forge-init.js";
import { registerSprintIntake } from "./sprint-intake.js";
import { discoverForgeConfig } from "./forge-root.js";
import { registerForgeTools } from "./forge-tools.js";
import { checkBundledForgeDrift, registerForgeUpdateCommand } from "./forge-update-command.js";
import { detectFoundryCollision, markCollisionSeen, wasCollisionSeen } from "./foundry-collision.js";
import { registerHookDispatcher } from "./hook-dispatcher.js";
import { detectMissingCredentials, loadRegistry, seedEnabledModels } from "./model-registry.js";
import { registerUsageHook } from "./usage-hook.js";
import { triggerUpdateCheck } from "./update-check.js";

// Resolve the vendored prompts directory at module load. After build, this
// file lives at <pkg>/dist/extensions/forgecli/index.js — go up three levels
// to <pkg>/, then into prompts/. In the source tree (vitest runs raw .ts), the
// equivalent climb resolves to forge-cli/prompts/.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPTS_ROOT = path.join(PKG_ROOT, "prompts");

// Read package.json once at module load. Failures here are non-fatal — the
// update-check module short-circuits if the version strings are empty.
function readPkgVersions(): { cliVersion: string; bundledForgeVersion: string } {
	try {
		const raw = readFileSync(path.join(PKG_ROOT, "package.json"), "utf8");
		const pkg = JSON.parse(raw) as { version?: unknown; forge?: { bundledVersion?: unknown } };
		return {
			cliVersion: typeof pkg.version === "string" ? pkg.version : "",
			bundledForgeVersion: typeof pkg.forge?.bundledVersion === "string" ? pkg.forge.bundledVersion : "",
		};
	} catch {
		return { cliVersion: "", bundledForgeVersion: "" };
	}
}

const PKG_VERSIONS = readPkgVersions();

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
	// Full 4-phase implementation — FORGE-S17-T02.
	// Banner suppression: outside-Forge banner below only fires when
	// .forge/config.json is absent. Once /forge:init writes config.json,
	// the banner is suppressed automatically (no extra guard needed here).
	registerForgeInit(pi);

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

		// 4. Update-check probe + banner (FORGE-S16-T14, issue #18 part 1).
		// Fire-and-forget — never blocks startup; fail-silent on the user surface.
		if (PKG_VERSIONS.cliVersion && PKG_VERSIONS.bundledForgeVersion) {
			void triggerUpdateCheck({
				notify: (msg, level) => ctx.ui.notify(msg, level),
				currentCliVersion: PKG_VERSIONS.cliVersion,
				currentBundledForgeVersion: PKG_VERSIONS.bundledForgeVersion,
			}).catch(() => {
				/* AC#5: network failures are fail-silent */
			});
		}

		// 5. Bundled-forge drift prompt (FORGE-S16-T15, issue #18 part 2 / Q7).
		// Detect+prompt only — never auto-applies migrations.
		if (PKG_VERSIONS.bundledForgeVersion) {
			try {
				await checkBundledForgeDrift({
					currentBundledForgeVersion: PKG_VERSIONS.bundledForgeVersion,
					notify: (msg, level) => ctx.ui.notify(msg, level),
				});
			} catch (err) {
				if (process.env.FORGE_DEBUG_UPDATE_CHECK === "1") {
					console.error("[forge-cli drift-check]", err);
				}
			}
		}

		// 6. Model registry seed + missing-credentials banner (FORGE-S16-T16, issue #17).
		// Project-scope only; never reads or writes ~/.pi/agent/settings.json.
		if (forgeRoot && forgeConfig) {
			try {
				const projectRoot = path.dirname(path.dirname(forgeConfig.configPath));
				const registry = loadRegistry();
				await seedEnabledModels({ projectRoot, registry });
				const credBanner = detectMissingCredentials(registry);
				if (credBanner) ctx.ui.notify(credBanner, "warning");
			} catch (err) {
				if (process.env.FORGE_DEBUG_MODEL_REGISTRY === "1") {
					console.error("[forge-cli model-registry]", err);
				}
			}
		}
	});

	// ── Conditional full forge:* set (AC#5) ──────────────────────────────────
	if (forgeRoot) {
		// T03: forge tools — wired (FORGE-S16-T03)
		// AC4 note: .cjs tools use findProjectRoot() not --forge-root. Equivalent
		// guarantee: forgeRoot captured at init; projectRoot passed as cwd to execFile.
		const projectRoot = path.dirname(path.dirname(forgeConfig!.configPath));
		registerForgeTools(pi, forgeRoot, projectRoot);
		// T05 → T02 (FORGE-S18-T02): hook dispatcher wired — audit-only, no blocking.
		registerHookDispatcher(pi, forgeRoot);
		// T04 (FORGE-S18-T04): forge:ask_user interactive prompt tool.
		registerAskUserTool(pi);
		// T03 (FORGE-S19-T03): pi-runtime token telemetry hook.
		// Accumulates per-turn usage from message_end events. Phase key is read
		// from FORGE_PHASE_KEY env (set by the sprint runner before each phase).
		registerUsageHook(pi);
	}

	// ── /forge:sprint-intake native handler (FORGE-S19-T01) ──────────────────
	// Registered before registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub generated from the command markdown file.
	registerSprintIntake(pi);

	// ── /forge:* command set (FORGE-S16-T04) ─────────────────────────────────
	// Registered unconditionally so /forge:ask works outside a Forge project.
	// Per-command handlers enforce the Q14 outside-project no-op contract.
	registerForgeCommands(pi, { forgeRoot, promptsRoot: PROMPTS_ROOT });

	// ── Phase G: all bundled commands (FORGE-S17-T02) ─────────────────────────
	// Enumerate every *.md under dist/forge-payload/.base-pack/commands/ and
	// register each as a pi command. Real handlers (init/health/ask/config/
	// status/refresh-kb-links) were registered above; stubs for the rest.
	// Banner-suppression guard: outside-Forge banner is gated on forgeRoot
	// being null — once /forge:init writes .forge/config.json, forgeRoot is
	// non-null and the outside-Forge banner no longer fires (F3 AC#8).
	const payloadRoot = path.join(PKG_ROOT, "dist", "forge-payload");
	const configExists = existsSync(path.join(process.cwd(), ".forge", "config.json"));
	registerAllForgeCommands(pi, {
		bundlePayloadRoot: payloadRoot,
		cwd: process.cwd(),
		bundleRoot: configExists ? payloadRoot : undefined,
	});

	// ── /forge:update guided upgrade (FORGE-S16-T15) ─────────────────────────
	// Registered unconditionally — useful even outside a Forge project (the
	// command upgrades the globally-installed forgecli, not the project).
	if (PKG_VERSIONS.cliVersion) {
		registerForgeUpdateCommand(pi, {
			pkgRoot: PKG_ROOT,
			currentCliVersion: PKG_VERSIONS.cliVersion,
		});
	}

	// ── Spike R1 (env-gated) ──────────────────────────────────────────────────
	if (process.env.FORGE_SPIKE_R1 === "1") {
		const spikePath = "../../../test/poc/spike-r1/spike.js";
		const mod = (await import(spikePath)) as {
			registerPocRunTask: (pi: ExtensionAPI) => void;
		};
		mod.registerPocRunTask(pi);
	}
}
