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
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerAskUserTool } from "./ask-user-tool.js";
import { createForgeHeader, type ForgeHeader } from "./forge-header.js";
import { readProjectMeta } from "./banner.js";
import { registerEnhance } from "./enhance.js";
import { registerAllForgeCommands, registerForgeCommands } from "./forge-commands.js";
import { registerForgeInit } from "./forge-init.js";
import { discoverForgeConfig } from "./forge-root.js";
import { registerForgeTools } from "./forge-tools.js";
import { loadSkillsFromDir, type LoadSkillsResult } from "@earendil-works/pi-coding-agent";
import { checkBundledForgeDrift, registerForgeUpdateCommand } from "./forge-update-command.js";
import { detectFoundryCollision, markCollisionSeen, wasCollisionSeen } from "./foundry-collision.js";
import { registerHookDispatcher } from "./hook-dispatcher.js";
import { registerImplement } from "./implement.js";
import { detectMissingCredentials, loadRegistry, seedEnabledModels } from "./model-registry.js";
import { registerPlan } from "./plan.js";
import { buildProjectOrientation } from "./project-orientation.js";
import { registerRegenerate } from "./regenerate.js";
import { registerSprintIntake } from "./sprint-intake.js";
import { registerSprintPlan } from "./sprint-plan.js";
import { triggerUpdateCheck } from "./update-check.js";
import { mountWhatsNewWidgetOnStartup, registerWhatsNewWidgetCommand } from "./whats-new-widget.js";
import { registerUsageHook } from "./usage-hook.js";
import { registerReadCommand } from "./read-command.js";
import { registerRunTask } from "./run-task.js";
import { registerRunSprint } from "./run-sprint.js";
import { registerFixBug } from "./fix-bug.js";
import { registerReviewPlan } from "./review-plan.js";
import { registerReviewCode } from "./review-code.js";
import { registerApprove } from "./approve.js";
import { registerCommit } from "./commit.js";
import { registerValidate } from "./validate.js";
import { registerCollate } from "./collate.js";
import { registerTestOrchestrate } from "./test-orchestrate.js";
import { registerThreadSwitcher } from "./thread-switcher.js";
import { registerRunWorkflow } from "./wf-engine/register.js";
import { registerPostInitHook } from "./hooks/post-init-hook.js";
import { registerPostSprintHook } from "./hooks/post-sprint-hook.js";

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

	// ── Project Orientation — main-thread system prompt context ─────────────
	// Prepends a project-orientation block to every main-thread turn when
	// inside a Forge project. Symmetric to the subagent path in
	// runForgeSubagent. Single source of truth: project-orientation.ts.
	// Philosophy: context, not enforcement. See forge-cli#6.
	if (forgeConfig && typeof pi.on === "function") {
		const projectRoot = path.dirname(path.dirname(forgeConfig.configPath));
		const orientation = buildProjectOrientation(projectRoot);
		pi.on("before_agent_start", async (event) => {
			const existing = event.systemPrompt ?? "";
			return { systemPrompt: `${orientation}\n${existing}` };
		});
	}

	// ── post-init hook (FORGE-S21-T04) ───────────────────────────────────────
	// Registered BEFORE registerForgeInit to prevent emit-before-consumer race.
	// The hook fires after Phase 4 closure via the `init-complete` synthetic
	// event and triggers /forge:enhance --phase 1 --auto with idempotency.
	registerPostInitHook(pi);

	// ── post-sprint hook (FORGE-S21-T05) ─────────────────────────────────────
	// Registered BEFORE registerRunSprint to prevent emit-before-consumer race.
	// The hook fires after sprint collate phase via the `sprint-collate-complete`
	// synthetic event and triggers /forge:enhance --phase 2 with idempotency.
	// Sprint-ID regex gate ^[A-Z]+-S\d+$ prevents bug-fix collate runs from
	// triggering sprint-level enhancement.
	registerPostSprintHook(pi);

	// ── Unconditional /forge:init (AC#4) ─────────────────────────────────────
	// Full 4-phase implementation — FORGE-S17-T02.
	// Banner suppression: outside-Forge banner below only fires when
	// .forge/config.json is absent. Once /forge:init writes config.json,
	// the banner is suppressed automatically (no extra guard needed here).
	registerForgeInit(pi);

	// ── /forge:regenerate — re-materialize .forge/ from bundled payload ────
	// Deterministic subset of plugin's /forge:regenerate: runs
	// substitute-placeholders.cjs against bundled .base-pack/. Useful when a
	// new forge-cli build ships an updated payload and the project's
	// .forge/workflows/ etc. need to be refreshed. Registered AFTER
	// registerForgeInit and BEFORE registerAllForgeCommands so the real
	// handler beats the auto-stub.
	registerRegenerate(pi);

	// ── /test-orchestrate (subagent harness e2e probe) ──────────────────────
	// Registered unconditionally — useful inside or outside a Forge project.
	// Spawns an in-process pi AgentSession via runForgeSubagent and delegates
	// the user-supplied prompt. Multi-turn allowed. Status updates streamed.
	registerTestOrchestrate(pi);

	// ── Install bundled themes into ~/.pi/agent/themes/ ──────────────────────
	// Themes in that directory are loaded by pi BEFORE initTheme() runs, so
	// pi's /settings > theme picker lists them and setTheme(name) finds them
	// by name in session_start. We ship one or more JSON themes under
	// forge-cli/themes/ and copy each one into the global theme directory.
	const bundledThemesDir = path.join(PKG_ROOT, "themes");
	const globalThemesDir = path.join(getAgentDir(), "themes");
	try {
		fs.mkdirSync(globalThemesDir, { recursive: true });
		const themeFiles = fs.readdirSync(bundledThemesDir).filter((f) => f.endsWith(".json"));
		for (const file of themeFiles) {
			fs.copyFileSync(
				path.join(bundledThemesDir, file),
				path.join(globalThemesDir, file),
			);
		}
	} catch {
		// Non-fatal — theme install skipped, fall back to default
	}

	// ── Session start — banners + collision detection ─────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return; // headless mode — no banners

		// Apply forge-dark as default. The theme is in ~/.pi/agent/themes/ so
		// loadThemeJson finds it by name. Only apply if user hasn't saved a
		// custom preference (setTheme also persists via settingsManager).
		const currentTheme = ctx.ui.theme.name;
		if (currentTheme === "dark" || currentTheme === "light") {
			ctx.ui.setTheme("forge-dark");
		}

		// 0. Inject custom Forge CLI branding header
		let forgeHeaderRef: ForgeHeader | null = null;
		const headerFactory = createForgeHeader({
			cliVersion: PKG_VERSIONS.cliVersion || "unknown",
			bundledForgeVersion: PKG_VERSIONS.bundledForgeVersion || "unknown",
			piVersion: PI_VERSION || "unknown",
		});
		ctx.ui.setHeader((tui, theme) => {
			const h = headerFactory(tui, theme);
			forgeHeaderRef = h;
			return h;
		});
		const doneStartup = () => forgeHeaderRef?.setStartupDone();

		if (notified) {
			doneStartup();
			return;
		}
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
			doneStartup();
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

		// 4b. What's-New strip — single-row widget below the editor, arrow-key
		// navigable across pi / forge-plugin / forge-cli changelog summaries.
		// Mirrors the thread-switcher pattern (setWidget + onTerminalInput +
		// setOutputSource for the per-component detail view). Marks versions
		// as seen so subsequent sessions don't re-mount.
		if (PKG_VERSIONS.cliVersion && PKG_VERSIONS.bundledForgeVersion && PI_VERSION) {
			void mountWhatsNewWidgetOnStartup(pi, ctx, {
				pkgRoot: PKG_ROOT,
				current: {
					pi: PI_VERSION,
					forgePlugin: PKG_VERSIONS.bundledForgeVersion,
					forgeCli: PKG_VERSIONS.cliVersion,
				},
			}).catch((err) => {
				if (process.env.FORGE_DEBUG_WHATS_NEW === "1") {
					console.error("[forge-cli whats-new]", err);
				}
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

		// Startup tasks complete — transition header from loader to full logo.
		doneStartup();
	});

	// ── Conditional full forge:* set (AC#5) ──────────────────────────────────
	if (forgeRoot) {
		// T03: forge tools — wired (FORGE-S16-T03)
		// AC4 note: .cjs tools use findProjectRoot() not --forge-root. Equivalent
		// guarantee: forgeRoot captured at init; projectRoot passed as cwd to execFile.
		const projectRoot = path.dirname(path.dirname(forgeConfig!.configPath));
		registerForgeTools(pi, forgeRoot, projectRoot);

		// T04: Load bundled skills from dist/forge-payload/skills/ and validate.
		// In dev mode (vitest), the payload isn't built yet, so the directory
		// won't exist — fail-soft with a warning, don't crash.
		const EXPECTED_SKILL_COUNT = 4;
		const payloadSkillsDir = path.join(PKG_ROOT, "dist", "forge-payload", "skills");
		if (existsSync(payloadSkillsDir)) {
			try {
				const result: LoadSkillsResult = loadSkillsFromDir({
					dir: payloadSkillsDir,
					source: "forge-payload",
				});
				if (result.diagnostics.length > 0) {
					for (const diag of result.diagnostics) {
						console.warn(
							`[forge-cli] skill diagnostic: ${diag.type} ${diag.path ?? "(unknown)"}: ${diag.message}`,
						);
					}
				}
				if (result.skills.length !== EXPECTED_SKILL_COUNT) {
					console.warn(
						`[forge-cli] expected ${EXPECTED_SKILL_COUNT} bundled skills, loaded ${result.skills.length}`,
					);
				}
			} catch (err) {
				console.warn("[forge-cli] failed to load bundled skills:", err);
			}
		} else {
			console.warn("[forge-cli] bundled skills directory not found — skipping skill load (dev mode?)");
		}
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

	// ── /forge:sprint-plan native handler (FORGE-S19-T02) ────────────────────
	// Registered before registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub generated from the command markdown file.
	registerSprintPlan(pi);

	// ── /forge:enhance native kickoff handler (FORGE-S20-T04) ────────────────
	// Replaces the post-S17 sentinel-writing stub. Registered unconditionally
	// here so it takes precedence over the auto-stub registered by
	// registerAllForgeCommands; the handler itself notifies and returns when
	// `.forge/workflows/enhance.md` is absent (graceful no-op outside Forge
	// project).
	registerEnhance(pi);

	// ── /forge:plan native kickoff handler (FORGE-S20-T05) ───────────────────
	// Replaces the auto-generated stub. Same Kickoff Shim archetype as
	// sprint-intake / enhance. Handler notifies and returns when
	// `.forge/workflows/plan_task.md` is absent (graceful no-op outside Forge
	// project). Prompt-injection fallback DELETED per T05 AC#4.
	registerPlan(pi);

	// ── /forge:implement native kickoff handler (FORGE-S20-T06) ──────────────
	// Replaces the auto-generated stub. Same Kickoff Shim archetype as plan.
	// Handler notifies and returns when `.forge/workflows/implement_plan.md`
	// is absent (graceful no-op outside Forge project). Prompt-injection
	// fallback DELETED per T06 AC#4.
	registerImplement(pi);

	// ── /forge:run-task native Orchestrator handler (FORGE-S21-T02) ──────────
	// Full TS-driven Orchestrator-archetype handler. Chains 8 phases via
	// runForgeSubagent (IL10). Registered BEFORE registerAllForgeCommands so
	// the real handler takes precedence over the auto-stub from the command .md.
	registerRunTask(pi);

	// ── /forge:run-sprint native Orchestrator handler (FORGE-S21-T03) ────────
	// Sprint-level orchestrator: iterates sprint tasks via runTaskPipeline.
	// Registered BEFORE registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub from the command .md.
	registerRunSprint(pi);

	// ── /forge:fix-bug native Orchestrator handler (FORGE-S21-T07) ────
	// Bug-level orchestrator: chains triage → plan-fix → review-plan →
	// implement → review-code → approve → commit via runForgeSubagent (IL10).
	// Registered BEFORE registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub from the command .md.
	registerFixBug(pi);

	// ── Chain sub-workflow Kickoff Shims (FORGE-S21-T10) ─────────────────────
	// Six native kickoff handlers replacing auto-generated stubs. Each is a
	// Kickoff Shim (Pack-04 + Pack-06): reads the materialized workflow, runs
	// marker checks, assertAudience, then sendKickoff. Standalone invocations
	// of subagent-only workflows (review-plan, review-code, approve, commit,
	// validate) receive audience refusal — this IS the contract.
	// Orchestrator chains (run-task, run-sprint, fix-bug) MUST NOT route
	// through these handlers — they dispatch via runForgeSubagent directly (IL10).
	// Registered BEFORE registerAllForgeCommands so real handlers take precedence.
	registerReviewPlan(pi);
	registerReviewCode(pi);
	registerApprove(pi);
	registerCommit(pi);
	registerValidate(pi);
	registerCollate(pi);

	// ── /forge:run-workflow generic workflow engine (Plan 14) ────────────────
	// Resolution order: CWD/workflows/<id> first (user-authored workflows),
	// then bundled PKG_ROOT/workflows/<id> (shipped examples). Registered unconditionally.
	registerRunWorkflow(pi, { cwd: process.cwd(), bundledWorkflowsDir: path.join(PKG_ROOT, "workflows") });

	// ── /forge:threads native handler ────────────────────────────────────────
	// Single-viewport thread switcher: one-row chip strip below the editor.
	// ↓ from the editor activates it; ←→ navigate, Enter focuses a chip into
	// the main chat viewport (via ctx.ui.setOutputSource added in pi-mono
	// 0.75.0), Esc snaps back to main.
	registerThreadSwitcher(pi);

	// ── /forge:read native handler ───────────────────────────────────────────
	registerReadCommand(pi, forgeRoot);

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

	// /whats-new — replay summary as text (widget itself auto-mounts on session_start).
	if (PKG_VERSIONS.cliVersion && PKG_VERSIONS.bundledForgeVersion && PI_VERSION) {
		registerWhatsNewWidgetCommand(pi, {
			pkgRoot: PKG_ROOT,
			current: {
				pi: PI_VERSION,
				forgePlugin: PKG_VERSIONS.bundledForgeVersion,
				forgeCli: PKG_VERSIONS.cliVersion,
			},
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
