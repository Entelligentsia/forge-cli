// forge-init.ts — /forge:init command handler — FORGE-S17-T02
//
// Full 4-phase init flow:
//   Phase 1 — Collect: multi-step discovery + config.json synthesis → .forge/config.json
//   Phase 2 — Discover: phase gate + KB doc generation + index files → engineering/
//   Phase 3 — Materialize: substitute-placeholders → .forge/{personas,skills,workflows,templates}
//   Phase 4 — Register: 11 deterministic steps → versioning, packs, store, Tomoshibi
//
// Per INIT_PARITY_SPEC.md and PLAN.md (rev 2) phases A–G.
//
// ── Phase model (FORGE-S26-T17) ──────────────────────────────────────────
//
// Phases 1–3 are standalone async functions in forge-init/run-phases.ts.
// Each reads its phase prompt from the bundled init/phases/phase-N-*.md file,
// dispatches via sendToAgent + waitForIdle (phases 1-2) or runs tools directly
// (phase 3), then verifies deliverables via verify-phase.cjs.
//
// Phase 4 is in forge-init/phase4-register.ts → runPhase4().
//
// This file is the orchestrator: flag parsing, resume detection, configCache population
// (between Phase 1 and Phase 2), phase loop, post-init report.
//
// Iron Laws:
//   - Iron Law 1: no edits to forge/ or pi-mono/
//   - Iron Law 6: execFile with argv arrays — no shell-string interpolation
//   - Iron Law 7: silent continuation past failures is never acceptable
//
// Sub-decision bindings (from PLAN.md):
//   #1: Marketplace skills — advisory only; write installedSkills: []
//   #3: Parallel dispatch — vendored subagent via ctx.sendUserMessage instruction
//   #4: /forge:enhance — sentinel + advisory only; no sendUserMessage dispatch
//   #5: Tomoshibi — runRefreshKbLinks() native TS port; no shell-out
//   #9: Health check — runHealthCheck() direct call; NOT via sendUserMessage
//
// ── Async/sync contract (N-B-C, revised 2026-05-26) ──────────────────────────
//
// `await sendToAgent(text)` sends a prompt to the agent and resolves when the agent
// has finished processing it. It wraps `pi.sendUserMessage(text, { deliverAs: "steer" })`.
//
// When the agent is IDLE (the common case at init start): sendUserMessage calls
// session.prompt(), which starts a full agent turn via agent.prompt(). Awaiting it
// blocks until that turn completes, including all tool calls and follow-ups.
//
// When the agent is STREAMING (mid-turn): sendUserMessage enqueues a steer message
// and resolves quickly — the steer is picked up by the running turn's steering poll.
// In this case `await ctx.waitForIdle()` IS needed afterwards to wait for the turn
// (including the steer) to finish.
//
// Both awaits are always issued: `await sendToAgent` covers the idle-agent path;
// `await waitForIdle` covers the streaming-agent path and is a harmless no-op when
// the agent already completed its turn via sendToAgent.
//
// Pattern for every phase:
//   await sendToAgent(promptText);  // dispatch + wait for completion when idle
//   await waitForIdle();           // wait for current turn when streaming; no-op when idle
//   const result = verifyPhaseN();  // read deliverable — agent is done
//
// ── Config cache boundary (B-4, N-B-A) ──────────────────────────────────────
//
// `.forge/config.json` is WRITTEN by the Phase-1 agent. Any read before Phase 1's
// `waitForIdle` returns stale or absent data. `configCache` is populated once,
// immediately after Phase 1 completes, and reused throughout Phase 2, Phase 4,
// the post-init hook, and the report section — reducing 8 fs.readFileSync calls to 1.
//
// `verifyPhase1` inside `forge-init/verifiers.ts` intentionally reads config.json
// directly rather than using `configCache` — it validates the Phase-1 deliverable
// and must see the freshly written file.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runPhase4 } from "../forge-init/phase4-register.js";
import { runPhase1, runPhase2, runPhase3 } from "../forge-init/run-phases.js";
import { verifyPhase1, verifyPhase3 } from "../forge-init/verifiers.js";
import { runHealthCheck } from "../health-check.js";
import { emitSyntheticEvent } from "../hook-dispatcher.js";
import { discoverProjectName } from "./init-context.js";
import { deleteInitProgress, readInitProgress } from "./init-progress.js";
import { execFileAsync } from "../lib/exec-helpers.js";
import { clearForgeConfigCache } from "../lib/forge-config.js";
// FORGE-S26-T11: registerMigrate imported to power `forge:init --migrate`
import { registerMigrate } from "../migrate.js";

// ── Bundle path resolution ─────────────────────────────────────────────────

const _EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
// dist/extensions/forgecli/forge-init/ → dist/extensions/forgecli/ → dist/ → <pkg-root>/
const _DIST_DIR = path.resolve(_EXTENSION_DIR, "..", "..", "..");
const _PKG_ROOT = path.resolve(_DIST_DIR, "..");

/** Get the bundled forge-payload root (dist/forge-payload/) */
export function getBundledPayloadRoot(): string {
	return path.join(_PKG_ROOT, "dist", "forge-payload");
}

/** Get the bundled tools directory (dist/forge-payload/tools/) */
export function getBundledToolsRoot(): string {
	return path.join(getBundledPayloadRoot(), "tools");
}

/**
 * Resolve the absolute path to dist/forge-payload/tools and validate it
 * contains store-cli.cjs. Throws if the directory is missing or incomplete.
 * Exported for test access and for Phase-4 pi-aware forgeRoot stamp.
 */
export function resolveBundleToolsRoot(): string {
	const toolsRoot = getBundledToolsRoot();
	const storeCli = path.join(toolsRoot, "store-cli.cjs");
	if (!fs.existsSync(storeCli)) {
		throw new Error(
			`resolveBundleToolsRoot: bundled tools dir missing store-cli.cjs — expected at ${storeCli}. ` +
				"Run 'npm run build' to populate dist/forge-payload/tools/.",
		);
	}
	return toolsRoot;
}

/**
 * Detect pi runtime. forge-init.ts is only ever called from the forgecli pi
 * extension (registerForgeInit is invoked during extension load by pi). There
 * is no Claude Code execution path. Therefore this always returns true.
 *
 * We keep the guard explicit rather than hardcoding `true` so that if a future
 * Claude Code path is added it is obvious where to insert the condition.
 *
 * Heuristic: PI_CODING_AGENT_DIR env set → definitely pi. Otherwise assume pi
 * (our only caller). Only false if explicitly opted-out via env flag in a
 * hypothetical future Claude Code integration.
 * Exported for test access.
 */
export function isPiRuntime(): boolean {
	// If the caller explicitly overrides via env, respect it (test escape hatch only).
	if (process.env.FORGE_INIT_CLAUDE_CODE_MODE === "1") return false;
	return true;
}

/** Get the bundled forge version from .claude-plugin/plugin.json */
function getBundledForgeVersion(): string {
	try {
		const pluginPath = path.join(getBundledPayloadRoot(), ".claude-plugin", "plugin.json");
		const raw = fs.readFileSync(pluginPath, "utf8");
		const plugin = JSON.parse(raw) as { version?: string };
		return typeof plugin.version === "string" ? plugin.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

// ── Session-scoped banner state ────────────────────────────────────────────

// Prevents re-rendering the hero banner on resume within the same session.
let heroBannerShown = false;

// ── Non-interactive mode ───────────────────────────────────────────────────

/**
 * Returns true when running in non-interactive / CI mode.
 *
 * Activated by either:
 *   - `FORGE_YES=1`          — ergonomic shell shorthand (FORGE-S18-T01)
 *   - `FORGE_NON_INTERACTIVE=1` — set by `forge --non-interactive` flag
 *
 * When active, every Y/N gate resolves to its documented default without
 * emitting a model-text prompt.
 */
function isNonInteractive(): boolean {
	return process.env.FORGE_YES === "1" || process.env.FORGE_NON_INTERACTIVE === "1";
}

// ── Flag parsing ───────────────────────────────────────────────────────────

interface ParsedFlags {
	fast: boolean;
	full: boolean;
	/** FORGE-S26-T11: --migrate flag triggers store migration instead of full init. */
	migrate: boolean;
	startPhase: number | null; // 1-4 if specified, null otherwise
	conflict: boolean;
	invalidPhase: boolean;
}

function parseInitFlags(args: string): ParsedFlags {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const hasFast = parts.includes("--fast");
	const hasFull = parts.includes("--full");
	const hasMigrate = parts.includes("--migrate");

	// Find trailing numeric phase arg
	let startPhase: number | null = null;
	let invalidPhase = false;

	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--fast" || p === "--full" || p === "--migrate") continue;
		const n = parseInt(p, 10);
		if (!Number.isNaN(n)) {
			if (n >= 1 && n <= 4) {
				startPhase = n;
			} else {
				invalidPhase = true;
			}
		}
	}

	return {
		fast: hasFast,
		full: hasFull,
		migrate: hasMigrate,
		startPhase,
		conflict: hasFast && hasFull,
		invalidPhase,
	};
}

// ── Main command registration ──────────────────────────────────────────────

export function registerForgeInit(pi: ExtensionAPI): void {
	// Capture pi.sendUserMessage in closure — ExtensionCommandContext does not
	// have sendUserMessage; it is on ExtensionAPI per pi types.ts:1187.
	//
	// sendToAgent MUST be awaited. When the agent is idle (the typical case for
	// /forge:init), sendUserMessage starts a full agent turn and resolves when it
	// completes. When the agent is streaming, sendUserMessage enqueues a steer and
	// resolves quickly — waitForIdle is then needed to wait for the turn to finish.
	//
	// Previous bug (BUG-017/BUG-023 workaround was incomplete): sendToAgent was
	// fire-and-forget (no await), and waitForIdle was the sole sync primitive.
	// But waitForIdle() returns Promise.resolve() when agent.activeRun is null
	// (no active turn), which is the state at init start — the steer hadn't been
	// picked up yet, so everything after waitForIdle fired instantly.
	const sendToAgent = async (text: string) => {
		await pi.sendUserMessage(text, { deliverAs: "steer" });
	};

	pi.registerCommand("forge:init", {
		description: "Bootstrap a new Forge SDLC project at the current working directory",
		async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
			const cwd = process.cwd();
			const bundleRoot = getBundledPayloadRoot();
			const toolsRoot = getBundledToolsRoot();
			const bundledVersion = getBundledForgeVersion();

			// kbPathFinal is resolved in Phase 4 but used in post-phase report.
			// Declare at handler scope so post-phase code can read it.
			let kbPathFinal = "engineering";

			// ── 1. Flag parsing ────────────────────────────────────────────────
			const flags = parseInitFlags(args);

			// FORGE-S26-T11: --migrate flag dispatches to store migration instead of init.
			if (flags.migrate) {
				// Strip --migrate, pass remaining args to migrate handler.
				const migrateParts = (args ?? "").trim().split(/\s+/).filter((p) => p !== "--migrate");
				const migrateArgs = migrateParts.join(" ");
				let migrateHandler:
					| ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void)
					| undefined;
				const syntheticPi = {
					...pi,
					registerCommand: (name: string, def: { handler: typeof migrateHandler }) => {
						if (name === "forge:migrate") migrateHandler = def.handler;
					},
				} as unknown as ExtensionAPI;
				registerMigrate(syntheticPi);
				if (migrateHandler) {
					await migrateHandler(migrateArgs, ctx);
				} else {
					ctx.ui.notify("× forge:init --migrate — migrate handler unavailable", "error");
				}
				return;
			}

			if (flags.conflict) {
				ctx.ui.notify("× Conflicting flags: --fast and --full cannot be combined.", "error");
				return;
			}

			// ── 2. Resume detection ────────────────────────────────────────────
			const progressResult = readInitProgress(cwd);
			let startPhase = flags.startPhase ?? 1;

			if (progressResult.kind === "malformed") {
				ctx.ui.notify("△ init-progress.json is malformed — deleting and starting fresh.", "warning");
				deleteInitProgress(cwd);
			} else if (progressResult.kind === "stale") {
				// Silently delete stale checkpoint and proceed fresh
				deleteInitProgress(cwd);
			} else if (progressResult.kind === "valid") {
				const lastPhase = progressResult.progress.lastPhase;
				const nextPhase = Math.min(lastPhase + 1, 4);
				const resumeBanner =
					`〇 Previous init detected — last completed phase: ${lastPhase} of 4\n` +
					`Resume from Phase ${nextPhase}?`;

				// G1: in non-interactive mode, default to not resuming (start fresh)
				const shouldResume = isNonInteractive() ? false : await ctx.ui.confirm("Resume /forge:init?", resumeBanner);
				if (shouldResume) {
					startPhase = nextPhase;
					// Skip hero banner on resume (session-scoped gate)
					heroBannerShown = true;
				} else {
					deleteInitProgress(cwd);
					startPhase = 1;
				}
			}

			// Override startPhase from flags if --fast/--full N or direct phase arg
			if (flags.startPhase !== null) {
				startPhase = flags.startPhase;
			}
			if (flags.invalidPhase) {
				// Invalid phase specified — re-prompt via pre-flight (fall through to pre-flight)
				startPhase = 1;
			}

			// ── 3. Hero banner (once per session) ────────────────────────────
			if (!heroBannerShown) {
				heroBannerShown = true;
				const bannersTool = path.join(toolsRoot, "banners.cjs");
				if (fs.existsSync(bannersTool)) {
					await execFileAsync("node", [bannersTool, "forge"], {
						cwd,
						timeout: 5000,
					}).catch(() => {
						/* non-fatal */
					});
					await execFileAsync(
						"node",
						[bannersTool, "--subtitle", `AI SDLC bootstrapper · forge:init v${bundledVersion}`],
						{ cwd, timeout: 5000 },
					).catch(() => {
						/* non-fatal */
					});
				}
			}

			// ── 4. Flag acknowledgement (--fast or --full, no phase jump) ────
			if ((flags.fast || flags.full) && flags.startPhase === null) {
				const mode = flags.fast ? "--fast" : "--full";
				ctx.ui.notify(`〇 ${mode} — running all 4 phases sequentially (functionally equivalent).`, "info");
			}

			// ── 5. Pre-flight plan (unless jumping to a specific phase) ───────
			const projectName = discoverProjectName(cwd);
			if (flags.startPhase === null || flags.invalidPhase) {
				const preflightSummary =
					`Forge Init — ${projectName}\n\n` +
					`4 phases will run in this session (~45 seconds non-interactive):\n\n` +
					`  1   Collect      — codebase discovery → config.json\n` +
					`                     KB folder prompt (interactive)\n` +
					`  2   Discover     — KB doc generation + project-context.json\n` +
					`  3   Materialize  — substitute-placeholders.cjs → fully functional workflows\n` +
					`  4   Register     — versioning, manifest, cache, store entries, Tomoshibi\n\n` +
					`Phase 1 is interactive (KB folder name prompt). Phases 2–4 are non-interactive.`;

				// G2: skip pre-flight confirm in non-interactive mode (proceed directly to Phase 1)
				if (!isNonInteractive()) {
					const proceed = await ctx.ui.confirm("Start /forge:init?", preflightSummary);
					if (!proceed) {
						ctx.ui.notify("〇 /forge:init cancelled.", "info");
						return;
					}
				}
			}

			// ── Config cache (B-4, N-B-A) ─────────────────────────────────────
			// Populated unconditionally before the loop so that resume paths
			// (startPhase > 1) read the config.json that Phase 1 wrote in a prior
			// session. Falls back to {} when config.json does not exist yet (first-run
			// Phase 1 will create it). Refreshed after Phase 1 completes in the loop
			// to pick up values the Phase-1 agent just wrote. See file-header comment
			// §Config cache boundary for the full rationale.
			let configCache: Record<string, unknown> = {};
			try {
				configCache = JSON.parse(fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8")) as Record<
					string,
					unknown
				>;
			} catch {
				// File not yet present — Phase 1 will create it
			}

			// ── Phases 1–3: linear phase calls ──────────────────────────────────
			// Each phase is a standalone async function in forge-init/run-phases.ts.
			// (FORGE-S26-T17: replaced descriptor-driven loop with explicit calls.)

			// Phase 1 — Collect
			if (startPhase <= 1) {
				const phase1Result = await runPhase1(
					cwd,
					bundleRoot,
					toolsRoot,
					configCache,
					ctx,
					sendToAgent,
					() => ctx.waitForIdle(),
					isNonInteractive,
				);
				if (phase1Result === "abort") return;

				// Inter-phase gate: let user review before Phase 2
				if (!isNonInteractive()) {
					const proceed = await ctx.ui.confirm(
						"Phase 1 complete — proceed?",
						"Phase 1 deliverables verified. Continue to Phase 2: Discover (KB generation)?",
					);
					if (!proceed) {
						ctx.ui.notify("〇 /forge:init paused after Phase 1. Re-run /forge:init to resume.", "info");
						return;
					}
				}

				// Refresh configCache after Phase 1 writes .forge/config.json
				try {
					configCache = JSON.parse(
						fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8"),
					) as Record<string, unknown>;
				} catch {
					// Fall back to existing cache — all downstream reads have their own defaults
				}
			}

			// Phase 2 — Discover
			if (startPhase <= 2) {
				const phase2Result = await runPhase2(
					cwd,
					bundleRoot,
					toolsRoot,
					projectName,
					configCache,
					ctx,
					sendToAgent,
					() => ctx.waitForIdle(),
					isNonInteractive,
				);
				if (phase2Result === "abort") return;

				// Inter-phase gate: let user review before Phase 3
				if (!isNonInteractive()) {
					const proceed = await ctx.ui.confirm(
						"Phase 2 complete — proceed?",
						"Phase 2 deliverables verified. Continue to Phase 3: Materialize (workflow generation)?",
					);
					if (!proceed) {
						ctx.ui.notify("〇 /forge:init paused after Phase 2. Re-run /forge:init to resume.", "info");
						return;
					}
				}
			}

			// Phase 3 — Materialize
			if (startPhase <= 3) {
				const phase3Result = await runPhase3(cwd, bundleRoot, toolsRoot, ctx);
				if (phase3Result === "abort") return;
			}

			// ── Phase 4 — Register (runPhase4) ────────────────────────────────
			if (startPhase <= 4) {
				const phase4Result = await runPhase4({
					cwd,
					bundleRoot,
					toolsRoot,
					projectName,
					configCache,
					ctx,
					isPiRuntime,
					getBundledToolsRoot,
				});

				if (phase4Result === "abort") {
					return;
				}

				// phase4Result.kbPathFinal is used in the post-init report below
				kbPathFinal = phase4Result.kbPathFinal;
			}

			// ── Invalidate forge-config cache so same-session commands find the new project
			clearForgeConfigCache();

			// ── Post-Phase-4: health check ────────────────────────────────────
			ctx.ui.setStatus?.("forge:init", "Post-init: health check");
			const healthResult = await runHealthCheck(cwd, bundleRoot);
			if (healthResult.clean) {
				ctx.ui.notify("〇 /forge:health: clean.", "info");
			} else {
				ctx.ui.notify(
					`△ /forge:health: ${healthResult.gaps.length} gap(s) detected — see console output.`,
					"warning",
				);
				for (const gap of healthResult.gaps) {
					ctx.ui.notify(`  · ${gap.check}: ${gap.message}`, "info");
				}
			}

			// ── Report ────────────────────────────────────────────────────────
			// FIX BUG-020: use configCache here (populated from config.json after Phase 1
			// or from pre-existing config.json for resumed inits starting at Phase 2+).
			// kbPathFinal is updated inside the Phase-4 block; for Phase-1-3 resumes
			// configCache captures the correct value that Phase 4 would have stamped.
			{
				const p = configCache.paths as Record<string, unknown> | undefined;
				if (p && typeof p.engineering === "string" && p.engineering) {
					kbPathFinal = p.engineering;
				}
			}

			ctx.ui.setStatus?.("forge:init", undefined);
			const kbPath_ = kbPathFinal;

			// FIX BUG-022 (product call): surface gap details in Report.
			// Conservative path: always include gap list in the Report.
			// Exit non-zero (via notify "error") only for blocking (severity: "error") gaps.
			// Warning-severity gaps are advisory; init is considered successful.
			//
			// Rationale: exiting non-zero for any gap would break common fresh-init
			// flows where KB docs haven't been generated yet (kb-freshness warning).
			// Error gaps (e.g. config missing) indicate structural failure and must
			// surface clearly.
			const criticalGaps = healthResult.gaps.filter((g) => g.severity === "error");
			const warningGaps = healthResult.gaps.filter((g) => g.severity === "warning");

			let healthSection = `Health: ${healthResult.summary}`;
			if (healthResult.gaps.length > 0) {
				const gapLines = healthResult.gaps
					.map((g) => `  [${g.severity.toUpperCase()}] ${g.check}: ${g.message}`)
					.join("\n");
				healthSection += `\n\nGap detail:\n${gapLines}`;
			}
			if (warningGaps.length > 0) {
				healthSection += `\n\nWarning gaps are advisory. Run /forge:health anytime to recheck.`;
			}
			if (criticalGaps.length > 0) {
				healthSection += `\n\n× CRITICAL: ${criticalGaps.length} blocking gap(s) — review the detail above and re-run /forge:init.`;
				ctx.ui.notify(
					`× /forge:init: ${criticalGaps.length} critical gap(s) require attention — see Report.`,
					"error",
				);
			}

			// Final cross-phase verification — banner reflects real disk state.
			const finalP1 = await verifyPhase1(cwd);
			const finalP3 = await verifyPhase3(cwd);
			const fullyComplete = finalP1.ok && finalP3.ok;
			const bannerLabel = fullyComplete
				? `║  /forge:init complete                                        ║`
				: `║  /forge:init incomplete — see gaps below                     ║`;
			const incompleteDetail: string[] = [];
			if (!finalP1.ok) {
				incompleteDetail.push(`× Phase 1: ${finalP1.missing.join(", ")} (config incomplete)`);
			}
			if (!finalP3.ok) {
				incompleteDetail.push(`× Phase 3: ${finalP3.missing.join(", ")} (materialization missing)`);
				incompleteDetail.push(
					`  → Recover: \`/forge:rebuild\` (re-runs substitute-placeholders against current config), or delete .forge/init-progress.json and re-run /forge:init.`,
				);
			}

			const report = [
				``,
				`╔══════════════════════════════════════════════════════════════╗`,
				bannerLabel,
				`╚══════════════════════════════════════════════════════════════╝`,
				``,
				`Project: ${projectName}`,
				`Bundle:  forge v${bundledVersion}`,
				``,
				`Knowledge base: ${kbPath_}/`,
				`Personas: .forge/personas/`,
				`Skills:   .forge/skills/`,
				`Workflows: .forge/workflows/`,
				`Templates: .forge/templates/`,
				``,
				...(incompleteDetail.length > 0 ? [`Phase verification gaps:`, ...incompleteDetail, ``] : []),
				healthSection,
				``,
				`Next steps:`,
				`  1. Run /forge:new-sprint to start your first sprint`,
				`  2. Run /forge:status to see sprint and task summary`,
				`  3. Run /forge:health anytime to check project health`,
				``,
				`Note: Marketplace skills auto-recommendation is Claude-Code-only.`,
				`Pi users install extensions manually.`,
				``,
				// BUG-025: explain slash command registration under pi runtime
				...(isPiRuntime()
					? [
							`Note: Slash commands registered programmatically (pi runtime); skipping .claude/commands/ Claude-Code-only artifact.`,
							``,
						]
					: []),
			].join("\n");

			await sendToAgent(report);

			// ── post-init: emit synthetic event for registered hooks (FORGE-S21-T04) ──
			// Fires AFTER the report so the user sees the summary before enhancement
			// or other hook-triggered workflows begin.
			// Errors inside hooks are caught by emitSyntheticEvent — fail-open.
			{
				let projectPrefixForHook = "";
				const projForHook = configCache.project as Record<string, unknown> | undefined;
				if (projForHook && typeof projForHook.prefix === "string") {
					projectPrefixForHook = projForHook.prefix;
				}
				await emitSyntheticEvent({ type: "init-complete", projectPrefix: projectPrefixForHook, cwd }, ctx);
			}
		},
	});
}
