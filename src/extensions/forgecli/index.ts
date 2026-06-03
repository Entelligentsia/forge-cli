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

import * as fs from "node:fs";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type LoadSkillsResult, loadSkillsFromDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { registerAddPipeline } from "./add-pipeline.js";
import { registerAddTask } from "./add-task.js";
import { registerApprove } from "./approve.js";
import { registerAskUserTool } from "./ask-user-tool.js";
import { readProjectMeta } from "./banner.js";
// calibrate.ts — registerCalibrate removed from index.ts in v1.0 (FORGE-S26-T10); deprecation stub in registerForgeCommands
import { registerCollate } from "./collate.js";
import { registerCommit } from "./commit.js";
import { registerConfigCommand } from "./config-command.js";
// enhance.ts — registerEnhance removed from index.ts in v1.0 (FORGE-S26-T10); deprecation stub in registerForgeCommands
import { registerFixBug } from "./fix-bug.js";
import { registerAllForgeCommands, registerForgeCommands } from "./forge-commands.js";
import { createForgeHeader, type ForgeHeader } from "./forge-header.js";
import { registerForgeInit } from "./forge-init.js";
import { type ForgeToolDefs, registerForgeTools } from "./forge-tools.js";
import { checkBundledForgeDrift, registerForgeUpdateCommand } from "./forge-update-command.js";
import { detectFoundryCollision, markCollisionSeen, wasCollisionSeen } from "./foundry-collision.js";
import { registerHookDispatcher } from "./hook-dispatcher.js";
import {
	createGovernor,
	createNoOpGovernor,
	loadDefaultPolicyTable,
} from "./context-governor.js";
import {
	buildForgeAwarenessMsg,
	buildMultiPluginMsg,
	buildPendingMigrationMsg,
	buildVersionDriftMsg,
	syncForgeRootAndRef,
} from "./hooks/check-update.js";
import { registerPostInitHook } from "./hooks/post-init-hook.js";
import { registerPostSprintHook } from "./hooks/post-sprint-hook.js";
import { registerImplement } from "./implement.js";
import { getInputRouter } from "./input-router.js";
import { discoverForgeConfigCached } from "./lib/forge-config.js";
import { readPkgVersionsSync } from "./lib/versions.js";
// materialize.ts — registerMaterialize removed from index.ts in v1.0 (FORGE-S26-T10); deprecation stub in registerForgeCommands
// migrate.ts — registerMigrate removed from index.ts in v1.0 (FORGE-S26-T10); deprecation stub in registerForgeCommands
import { detectMissingCredentials, loadRegistry, seedEnabledModels } from "./model-registry.js";
import { ensureForgeCliPathsReady, getPiAgentThemesDir } from "./paths/paths.js";
import { registerPlan } from "./plan.js";
import { buildProjectOrientation } from "./project-orientation.js";
import { registerQuizAgent } from "./quiz-agent.js";
import { registerReadCommand } from "./read-command.js";
import { registerRegenerate } from "./regenerate.js";
import { registerRemoveCommand } from "./remove-command.js";
import { registerReportBug } from "./report-bug.js";
import { registerRetrospective } from "./retrospective.js";
import { registerReviewCode } from "./review-code.js";
import { registerReviewPlan } from "./review-plan.js";
import { registerRunSprint } from "./run-sprint.js";
import { registerRunTask } from "./run-task.js";
import { registerSprintIntake } from "./sprint-intake.js";
import { registerSprintPlan } from "./sprint-plan.js";
import { registerStatusCommand } from "./status-command.js";
import { registerStoreQuery } from "./store-query.js";
import { registerStoreRepair } from "./store-repair.js";
import { registerTestOrchestrate } from "./test-orchestrate.js";
import { registerThreadSwitcher } from "./thread-switcher.js";
import { registerDashboardCommand } from "./dashboard/register.js";
import { triggerUpdateCheck } from "./update-check.js";
// update-tools.ts — registerUpdateTools removed from index.ts in v1.0 (FORGE-S26-T10); deprecation stub in registerForgeCommands
import { registerUsageHook } from "./usage-hook.js";
import { registerValidate } from "./validate.js";
import { registerRunWorkflow } from "./wf-engine/register.js";
import { mountWhatsNewWidgetOnStartup, registerChangelogCommand } from "./whats-new-widget.js";

// Resolve the vendored prompts directory at module load. After build, this
// file lives at <pkg>/dist/extensions/forgecli/index.js — go up three levels
// to <pkg>/, then into prompts/. In the source tree (vitest runs raw .ts), the
// equivalent climb resolves to forge-cli/prompts/.
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PROMPTS_ROOT = path.join(PKG_ROOT, "prompts");

// Read package.json and bundled plugin version once at module load. Failures
// are non-fatal — the update-check module short-circuits when version strings
// are empty. Delegated to lib/versions.ts (B-1 consolidation).
const PKG_VERSIONS = readPkgVersionsSync(PKG_ROOT);

let notified = false;

export default async function forgecli(pi: ExtensionAPI): Promise<void> {
	// ── Lazy one-shot user-data layout migration (FORGE-S20-T11) ─────────────
	// Runs at most once per process. Moves pre-v0.10.0 user data from
	// ~/.pi/agent/forge-cli/ + ~/.cache/forgecli/ into ~/.pi/forge-cli/.
	// Idempotent and fail-silent — every downstream path read goes through
	// the resolver in ./paths/paths.ts so post-migration paths "just work".
	ensureForgeCliPathsReady();

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
	const forgeConfig = discoverForgeConfigCached();
	const forgeRoot = forgeConfig?.forgeRoot ?? null;

	// ── Project Orientation — main-thread system prompt context ─────────────
	// Prepends a project-orientation block to every main-thread turn when
	// inside a Forge project. Symmetric to the subagent path in
	// runForgeSubagent. Single source of truth: project-orientation.ts.
	// Philosophy: context, not enforcement. See forge-cli#6.
	//
	// Also exports FORGE_ROOT into process.env so kickoff handlers' bash
	// invocations (e.g. `node "$FORGE_ROOT/tools/manage-versions.cjs"`) resolve.
	// Subagent dispatch via runForgeSubagent already sets this (forge-subagent.ts);
	// kickoff handlers don't go through that path, so without this line the
	// shell substitutes `$FORGE_ROOT` to empty string. See forge-cli#28.
	if (forgeConfig && typeof pi.on === "function") {
		const projectRoot = path.dirname(path.dirname(forgeConfig.configPath));
		const orientation = buildProjectOrientation(projectRoot);
		if (forgeRoot) {
			process.env.FORGE_ROOT = forgeRoot;
		}
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

	// ── /forge:rebuild — re-materialize .forge/ from bundled payload ────────
	// Renamed from /forge:regenerate in v1.0 (FORGE-S26-T10). Deterministic
	// subset of plugin's /forge:rebuild: runs substitute-placeholders.cjs
	// against bundled .base-pack/. Useful when a new forge-cli build ships an
	// updated payload and the project's .forge/workflows/ etc. need to be
	// refreshed. Registered AFTER registerForgeInit and BEFORE
	// registerAllForgeCommands so the real handler beats the auto-stub.
	registerRegenerate(pi);

	// ── /test-orchestrate (subagent harness e2e probe) ──────────────────────
	// Registered unconditionally — useful inside or outside a Forge project.
	// Spawns an in-process pi AgentSession via runForgeSubagent and delegates
	// the user-supplied prompt. Multi-turn allowed. Status updates streamed.
	registerTestOrchestrate(pi);

	// ── Install bundled themes into pi's theme namespace ─────────────────────
	// Themes live under pi's getAgentDir()/themes/ (NOT forge-cli's user root)
	// because pi loads them before initTheme() runs — its /settings > theme
	// picker reads from that exact path. The resolver re-exports the path so
	// call sites stay funneled through paths.ts.
	const bundledThemesDir = path.join(PKG_ROOT, "themes");
	const globalThemesDir = getPiAgentThemesDir();
	try {
		fs.mkdirSync(globalThemesDir, { recursive: true });
		const themeFiles = fs.readdirSync(bundledThemesDir).filter((f) => f.endsWith(".json"));
		for (const file of themeFiles) {
			fs.copyFileSync(path.join(bundledThemesDir, file), path.join(globalThemesDir, file));
		}
	} catch {
		// Non-fatal — theme install skipped, fall back to default
	}

	// ── Session start — banners + collision detection ─────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return; // headless mode — no banners

		// Plan 16 Slice 4c: single pi listener for forge-cli; dispatch through
		// the overlay-aware router. Per-feature listeners register via
		// getInputRouter().register(...) instead of ctx.ui.onTerminalInput
		// directly, so overlays (e.g. /forge:config) can suppress arrow
		// activators while mounted.
		const router = getInputRouter();
		ctx.ui.onTerminalInput((data) => router.dispatch(data));

		// Apply forge-dark as default. The theme is in pi's themes namespace so
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
			ctx.ui.notify("forge — no .forge/ at cwd; run /forge:init to bootstrap", "warning");
			doneStartup();
			return;
		}

		// 3. Inside-Forge banner with project.name [prefix] (AC#5)
		const meta = forgeConfig ? readProjectMeta(forgeConfig.configPath) : null;
		if (meta) {
			ctx.ui.notify(`${meta.name} [${meta.prefix}]`, "info");
		}

		// 3a. Forge-awareness context + project-state sync (FORGE-S23-T05).
		// Port of check-update.js functions (1), (3), (4), (5).
		// All wrapped in try/catch — session_start must never throw.
		if (forgeConfig) {
			// (1) Forge-awareness context injection (AC#1)
			try {
				const awarenessMsg = buildForgeAwarenessMsg(forgeConfig.configPath);
				if (awarenessMsg) ctx.ui.notify(awarenessMsg, "info");
			} catch {
				/* non-fatal */
			}

			// (4) Multi-plugin scan — notify if multiple Forge installations found (AC#3)
			try {
				const multiPluginMsg = buildMultiPluginMsg({ forgeRoot: forgeRoot!, configPath: forgeConfig.configPath });
				if (multiPluginMsg) ctx.ui.notify(multiPluginMsg, "info");
			} catch {
				/* non-fatal */
			}

			// (6) Binary-project version drift detection (must run BEFORE forgeRef sync)
			try {
				const driftMsg = buildVersionDriftMsg(
					forgeConfig.configPath,
					PKG_VERSIONS.bundledForgeVersion ?? "",
				);
				if (driftMsg) ctx.ui.notify(driftMsg, "warning");
			} catch {
				/* non-fatal */
			}

			// (3) Distribution-switch detection + forgeRoot/forgeRef sync (AC#2, AC#6)
			try {
				const switchMsg = syncForgeRootAndRef({ forgeRoot: forgeRoot!, configPath: forgeConfig.configPath });
				if (switchMsg) ctx.ui.notify(switchMsg, "warning");
			} catch {
				/* non-fatal */
			}

			// (5) Pending-migration state surfacing (AC#4)
			try {
				const pendingMsg = buildPendingMigrationMsg(forgeConfig.configPath);
				if (pendingMsg) ctx.ui.notify(pendingMsg, "warning");
			} catch {
				/* non-fatal */
			}
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
		// Project-scope only; never reads or writes pi's global settings.json.
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
	let forgeToolDefs: ForgeToolDefs | undefined;
	if (forgeRoot) {
		// T03: forge tools — wired (FORGE-S16-T03)
		// AC4 note: .cjs tools use findProjectRoot() not --forge-root. Equivalent
		// guarantee: forgeRoot captured at init; projectRoot passed as cwd to execFile.
		const projectRoot = path.dirname(path.dirname(forgeConfig!.configPath));
		forgeToolDefs = registerForgeTools(pi, forgeRoot, projectRoot);

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
		// FORGE-S30-T07: governor wired under FORGE_CTX_GOVERNOR=1 (flag-gated rollout).
		// When the flag is absent, falls back to no-op governor — no behaviour change.
		// IL7: try/catch wraps governor construction; any factory error falls back
		// to no-op silently so the hook dispatcher never throws at registration time.
		// Pack 07: governor reads store but never writes; all paths are read-only.
		let governor;
		try {
			if (process.env.FORGE_CTX_GOVERNOR === "1") {
				const table = loadDefaultPolicyTable();
				// The _modelRegistry parameter is a contextWindow fallback only;
				// the live registry is accessed from ctx.modelRegistry inside the
				// governor's handler chain. Pass a no-op stub here — sufficient for
				// registration time. The actual per-turn model lookup uses ctx.modelRegistry.
				const stubRegistry = { find: () => undefined } as unknown as ModelRegistry;
				governor = createGovernor(table, stubRegistry);
			} else {
				governor = createNoOpGovernor();
			}
		} catch {
			governor = createNoOpGovernor();
		}
		registerHookDispatcher(pi, forgeRoot, governor);
		// T04 (FORGE-S18-T04): forge:ask_user interactive prompt tool.
		registerAskUserTool(pi);
		// T03 (FORGE-S19-T03): pi-runtime token telemetry hook.
		// Accumulates per-turn usage from message_end events. Phase key is read
		// from FORGE_PHASE_KEY env (set by the sprint runner before each phase).
		registerUsageHook(pi);
	}

	// ── /forge:new-sprint native handler (FORGE-S19-T01, renamed FORGE-S26-T10) ──
	// Registered before registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub generated from the command markdown file.
	// Now registers as forge:new-sprint (renamed from forge:sprint-intake in v1.0).
	registerSprintIntake(pi);

	// ── /forge:plan-sprint native handler (FORGE-S19-T02, renamed FORGE-S26-T10) ──
	// Registered before registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub generated from the command markdown file.
	// Now registers as forge:plan-sprint (renamed from forge:sprint-plan in v1.0).
	registerSprintPlan(pi);

	// /forge:enhance — REMOVED in v1.0 (FORGE-S26-T10).
	// Deprecation stub is registered by registerForgeCommands below.
	// registerEnhance(pi) — no longer called here.

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

	// FORGE-S30-T07 (revised): governor + compaction factories are now built
	// PER-PHASE inside run-task.ts under FORGE_CTX_GOVERNOR=1 — only the
	// pipeline knows the `${personaNoun}/${role}` phase key, and the previous
	// global buildForgeCompactionFactory() threading from here carried no
	// path opts (warm-tier dead) while Mechanisms A–D never reached subagent
	// sessions at all (dormant-governor defect, CART-S02-T03 benchmark).
	// The extensionFactories option on registerRunTask/registerRunSprint
	// remains as a test seam.

	// ── /forge:run-task native Orchestrator handler (FORGE-S21-T02) ──────────
	// Full TS-driven Orchestrator-archetype handler. Chains 8 phases via
	// runForgeSubagent (IL10). Registered BEFORE registerAllForgeCommands so
	// the real handler takes precedence over the auto-stub from the command .md.
	registerRunTask(pi, { forgeToolDefs });

	// ── /forge:run-sprint native Orchestrator handler (FORGE-S21-T03) ────────
	// Sprint-level orchestrator: iterates sprint tasks via runTaskPipeline.
	// Registered BEFORE registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub from the command .md.
	registerRunSprint(pi, { forgeToolDefs });

	// ── /forge:fix-bug native Orchestrator handler (FORGE-S21-T07) ────
	// Bug-level orchestrator: chains triage → plan-fix → review-plan →
	// implement → review-code → approve → commit via runForgeSubagent (IL10).
	// Registered BEFORE registerAllForgeCommands so the real handler takes
	// precedence over the auto-stub from the command .md.
	registerFixBug(pi, { forgeToolDefs });

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
	registerCollate(pi); // internal — used by orchestrators; not user-facing in v1.0
	registerRetrospective(pi); // FORGE-S26-T10: now registers forge:retro
	// forge:calibrate — REMOVED in v1.0. Deprecation stub registered by registerForgeCommands below.
	// forge:materialize — REMOVED in v1.0. Deprecation stub registered by registerForgeCommands below.
	// forge:migrate — REMOVED in v1.0. Deprecation stub registered by registerForgeCommands below.
	// forge:update-tools — REMOVED in v1.0. Deprecation stub registered by registerForgeCommands below.
	registerStoreQuery(pi, { forgeRoot }); // FORGE-S26-T10: now registers forge:search
	registerStatusCommand(pi, { forgeRoot }); // FORGE-S23-T10: v0 sprint/task summary widget
	registerAddTask(pi, { forgeRoot }); // FORGE-S23-T11: Kickoff shim — add a task mid-sprint
	registerAddPipeline(pi, { forgeRoot }); // FORGE-S23-T11: Kickoff shim — pipeline manager
	registerQuizAgent(pi, { forgeRoot }); // FORGE-S26-T10: now registers forge:check-agent
	registerRemoveCommand(pi, { forgeRoot }); // FORGE-S23-T11: Kickoff shim — remove Forge artifacts
	registerReportBug(pi, { forgeRoot }); // FORGE-S23-T11: Kickoff shim — file bug against Forge
	registerStoreRepair(pi, { forgeRoot }); // FORGE-S26-T10: now registers forge:repair

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

	// ── /forge:dashboard overlay (parallel to chip strip) ───────────────────────
	// Reads from OrchestratorTree; the chip strip reads from SessionRegistry.
	// Both are written to by the same orchestrator call-sites.
	registerDashboardCommand(pi);

	// ── /forge:read native handler ───────────────────────────────────────────
	registerReadCommand(pi, forgeRoot);

	// ── /forge:config native handler (Plan 16 Slice 4a) ──────────────────────
	// Replaces the LLM-backed delegateMarkdownCommand stub that previously
	// lived in forge-commands.ts. Registered BEFORE registerForgeCommands so
	// the real handler wins. The stub block in forge-commands.ts has been
	// removed; forge:config stays in EXPLICITLY_REGISTERED_NAMES so the
	// auto-stub loop never registers a fallback.
	registerConfigCommand(pi, { forgeRoot });

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
	if (PKG_VERSIONS.cliVersion && PKG_VERSIONS.bundledForgeVersion) {
		registerForgeUpdateCommand(pi, {
			pkgRoot: PKG_ROOT,
			currentCliVersion: PKG_VERSIONS.cliVersion,
			currentBundledForgeVersion: PKG_VERSIONS.bundledForgeVersion,
		});
	}

	// /changelog — forge-comprehensive override of pi's built-in (auto-mounts on session_start).
	if (PKG_VERSIONS.cliVersion && PKG_VERSIONS.bundledForgeVersion && PI_VERSION) {
		registerChangelogCommand(pi, {
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
		const spikePath = "../../../test/.archive/spikes/spike-r1/spike.js";
		const mod = (await import(spikePath)) as {
			registerPocRunTask: (pi: ExtensionAPI) => void;
		};
		mod.registerPocRunTask(pi);
	}
}
