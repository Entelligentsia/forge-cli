// forge-init/run-phases.ts — per-phase standalone functions (FORGE-S26-T17)
//
// Linear pi-example style: each runPhaseN() is a standalone async function
// that handles its own banner → dispatch → verify → retry → post-phase hooks.
// No descriptor-driven generic loop — each phase carries its own explicit logic.
//
// Iron Laws (forge-cli-engineer skill):
//   - IL6: execFileAsync with argv arrays — no shell-string interpolation
//   - IL7: silent continuation past failures is never acceptable
//
// Design decisions:
//   - Verifiers.ts is now a facade over verify-phase.cjs (async wrappers).
//     VerifyResult interface is defined there.
//   - prompts.ts is deleted — phase prompts read from bundleRoot/init/phases/*.md
//   - Phase 3 is deterministic (no sendToAgent) — pure tool calls.
//   - postVerify hooks for Phase 1 (KB folder, marketplace) and Phase 2
//     (project-context.json, calibration baseline) are inlined here.

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildProjectContext,
	computeCalibrationBaseline,
	validateProjectContext,
	writeProjectContext,
} from "./init-context.js";
import { writeInitProgress } from "./init-progress.js";
import { execFileAsync, runToolAdvisory } from "../lib/exec-helpers.js";
import { verifyPhase1, verifyPhase2, verifyPhase3 } from "./verifiers.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read a phase prompt file from bundleRoot/init/phases/. Throws if missing. */
function readPhasePrompt(bundleRoot: string, phaseNum: 1 | 2): string {
	const phasesDir = path.join(bundleRoot, "init", "phases");
	const pattern = `phase-${phaseNum}-`;
	let filename: string | undefined;
	try {
		const files = fs.readdirSync(phasesDir);
		filename = files.find((f) => f.startsWith(pattern) && f.endsWith(".md"));
	} catch {
		// directory missing — fall through to throw
	}
	if (!filename) {
		throw new Error(
			`Phase ${phaseNum} prompt file not found in ${phasesDir} (expected: ${pattern}*.md). ` +
				"Run the forge plugin bundler to populate dist/forge-payload/init/phases/.",
		);
	}
	return fs.readFileSync(path.join(phasesDir, filename), "utf8");
}

/** Run banners.cjs for a phase header (non-fatal). */
async function renderPhaseBanner(
	toolsRoot: string,
	cwd: string,
	phaseNum: number,
	phaseName: string,
	bannerKey: string,
): Promise<void> {
	const bannersTool = path.join(toolsRoot, "banners.cjs");
	if (!fs.existsSync(bannersTool)) return;
	await execFileAsync(
		"node",
		[bannersTool, "--phase", String(phaseNum), "4", phaseName, bannerKey],
		{ cwd, timeout: 5000 },
	).catch(() => {
		/* non-fatal */
	});
}

// ── Phase 1 — Collect ─────────────────────────────────────────────────────────

export async function runPhase1(
	cwd: string,
	bundleRoot: string,
	toolsRoot: string,
	configCache: Record<string, unknown>,
	ctx: ExtensionCommandContext,
	sendToAgent: (text: string) => Promise<void>,
	waitForIdle: () => Promise<void>,
	isNonInteractive: () => boolean,
): Promise<"ok" | "abort"> {
	ctx.ui.setStatus?.("forge:init", "Phase 1/4: Collect");

	await renderPhaseBanner(toolsRoot, cwd, 1, "Collect", "north");

	ctx.ui.notify("Running codebase discovery...", "info");

	// Read phase prompt from bundled file
	let prompt: string;
	try {
		prompt = readPhasePrompt(bundleRoot, 1);
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(`× Phase 1: cannot read phase prompt: ${e.message ?? "unknown"}`, "error");
		return "abort";
	}

	// Dispatch to agent
	await sendToAgent(prompt);
	await waitForIdle();

	// Verify
	let result = await verifyPhase1(cwd);

	// Retry once on failure (silent — first failure is expected when waitForIdle
	// resolves before the agent finishes; no warning to avoid confusing the user)
	if (!result.ok) {
		const retrySteer =
			`Phase 1 verification failed. Missing: ${result.missing.join(", ")}.\n\n` +
			`Please fix .forge/config.json so it contains all required fields: ` +
			`version, project.name, project.prefix, stack, commands, ` +
			`paths.engineering, paths.store, paths.workflows.`;
		await sendToAgent(retrySteer);
		await waitForIdle();
		result = await verifyPhase1(cwd);
	}

	// Handle persistent failure
	if (!result.ok) {
		if (isNonInteractive()) {
			ctx.ui.notify(`× Phase 1 failed: ${result.missing.join(", ")}`, "error");
			return "abort";
		}
		const proceed = await ctx.ui.confirm(
			"Phase 1 — continue?",
			`Phase 1 verify failed: ${result.missing.join(", ")}. Continue to next phase?`,
		);
		if (!proceed) {
			ctx.ui.notify("× /forge:init aborted at Phase 1.", "error");
			return "abort";
		}
		ctx.ui.notify("△ Continuing with partial Phase 1.", "warning");
	}

	// Post-verify hooks: KB folder prompt + marketplace advisory
	// G3: skipped in non-interactive mode (default: "engineering")
	if (!isNonInteractive()) {
		const kbDescription =
			`Forge will create a folder for architecture docs, sprints, bugs, and features.\n\n` +
			`Use "engineering" as the folder name?  (Pick No only if your project already has an "engineering/" folder you don't want Forge to touch.)`;
		const useDefault = await ctx.ui.confirm("Engineering folder name?", kbDescription);
		if (!useDefault) {
			const customName = await ctx.ui.input(
				"Engineering folder name? Enter preferred folder name",
				"e.g. ai-docs, .forge-kb, docs/ai",
			);
			if (customName && customName.trim()) {
				const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
				if (fs.existsSync(manageConfigTool)) {
					await runToolAdvisory(
						manageConfigTool,
						["set", "paths.engineering", customName.trim()],
						cwd,
						ctx,
						"manage-config paths.engineering",
					);
				}
			}
		}
	}

	// Marketplace skills advisory (pi-only: no auto-install)
	ctx.ui.notify(
		"〇 Marketplace skills auto-recommendation is Claude-Code-only. " +
			"Pi users install extensions manually. Writing installedSkills: []",
		"info",
	);
	const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
	if (fs.existsSync(manageConfigTool)) {
		await runToolAdvisory(
			manageConfigTool,
			["set", "installedSkills", "[]"],
			cwd,
			ctx,
			"manage-config installedSkills",
		);
		await runToolAdvisory(manageConfigTool, ["set", "mode", "full"], cwd, ctx, "manage-config mode");
	}
	void configCache; // populated by caller after this function returns

	writeInitProgress(cwd, 1);
	ctx.ui.notify("〇 Phase 1 complete.", "info");
	return "ok";
}

// ── Phase 2 — Discover ────────────────────────────────────────────────────────

export async function runPhase2(
	cwd: string,
	bundleRoot: string,
	toolsRoot: string,
	projectName: string,
	configCache: Record<string, unknown>,
	ctx: ExtensionCommandContext,
	sendToAgent: (text: string) => Promise<void>,
	waitForIdle: () => Promise<void>,
	isNonInteractive: () => boolean,
): Promise<"ok" | "abort"> {
	ctx.ui.setStatus?.("forge:init", "Phase 2/4: Discover");

	await renderPhaseBanner(toolsRoot, cwd, 2, "Discover", "oracle");

	// Resolve kbPath from configCache
	let kbPath = "engineering";
	const cachePaths = configCache.paths as Record<string, unknown> | undefined;
	if (cachePaths && typeof cachePaths.engineering === "string" && cachePaths.engineering) {
		kbPath = cachePaths.engineering;
	}

	// Scaffold dirs before dispatching
	const dirs = [
		path.join(cwd, kbPath),
		path.join(cwd, kbPath, "architecture"),
		path.join(cwd, kbPath, "business-domain"),
		path.join(cwd, kbPath, "sprints"),
		path.join(cwd, ".forge", "store"),
		path.join(cwd, ".forge", "cache"),
	];
	for (const dir of dirs) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			const keepPath = path.join(dir, ".gitkeep");
			if (!fs.existsSync(keepPath)) {
				fs.writeFileSync(keepPath, "", "utf8");
			}
		} catch {
			// non-fatal
		}
	}

	// Read phase prompt from bundled file
	let prompt: string;
	try {
		prompt = readPhasePrompt(bundleRoot, 2);
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(`× Phase 2: cannot read phase prompt: ${e.message ?? "unknown"}`, "error");
		return "abort";
	}

	// Dispatch to agent
	await sendToAgent(prompt);
	await waitForIdle();

	// Verify
	let result = await verifyPhase2(cwd, kbPath);

	// Retry once on failure (silent — first failure is expected when waitForIdle
	// resolves before the agent finishes; no warning to avoid confusing the user)
	if (!result.ok) {
		const retrySteer =
			`Phase 2 verification failed. Missing KB docs: ${result.missing.join(", ")}.\n\n` +
			`Please generate the missing knowledge-base documents under ${kbPath}/architecture/.`;
		await sendToAgent(retrySteer);
		await waitForIdle();
		result = await verifyPhase2(cwd, kbPath);
	}

	// Handle persistent failure
	if (!result.ok) {
		if (isNonInteractive()) {
			ctx.ui.notify(`× Phase 2 failed: ${result.missing.join(", ")}`, "error");
			return "abort";
		}
		const proceed = await ctx.ui.confirm(
			"Phase 2 — continue?",
			`Phase 2 verify failed: ${result.missing.join(", ")}. Continue to next phase?`,
		);
		if (!proceed) {
			ctx.ui.notify("× /forge:init aborted at Phase 2.", "error");
			return "abort";
		}
		ctx.ui.notify("△ Continuing with partial Phase 2.", "warning");
	}

	// Post-verify hooks: project-context.json + calibration baseline
	let kbPathResolved = kbPath;
	let prefix = "";
	try {
		const cacheProj = configCache.project as Record<string, unknown> | undefined;
		if (cacheProj && typeof cacheProj.prefix === "string") prefix = cacheProj.prefix;
		const cachePaths2 = configCache.paths as Record<string, unknown> | undefined;
		if (cachePaths2 && typeof cachePaths2.engineering === "string") kbPathResolved = cachePaths2.engineering;
	} catch {
		// use defaults
	}

	try {
		const projectCtx = buildProjectContext(
			{
				projectName: ((configCache.project as Record<string, unknown>)?.name as string) ?? projectName,
				prefix,
				kbPath: kbPathResolved,
			},
			configCache as {
				project?: { name?: string; prefix?: string };
				paths?: { engineering?: string; forgeRoot?: string };
			},
		);
		validateProjectContext(projectCtx);
		writeProjectContext(cwd, projectCtx);
		ctx.ui.notify("〇 project-context.json written.", "info");
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(`△ project-context.json validation failed: ${e.message ?? "unknown"} — proceeding.`, "warning");
	}

	// Calibration baseline
	let bundledPluginVersion = "";
	try {
		const pluginPath = path.join(bundleRoot, ".claude-plugin", "plugin.json");
		const plugin = JSON.parse(fs.readFileSync(pluginPath, "utf8")) as { version?: string };
		bundledPluginVersion = plugin.version ?? "";
	} catch {
		// non-fatal — version field stays ""
	}
	const baseline = computeCalibrationBaseline(cwd, kbPathResolved, bundledPluginVersion);
	const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
	if (fs.existsSync(manageConfigTool)) {
		await runToolAdvisory(
			manageConfigTool,
			["set", "calibrationBaseline", JSON.stringify(baseline)],
			cwd,
			ctx,
			"manage-config calibrationBaseline",
		);
	}

	writeInitProgress(cwd, 2);
	ctx.ui.notify("〇 Phase 2 complete.", "info");
	return "ok";
}

// ── Phase 3 — Materialize (deterministic) ─────────────────────────────────────

export async function runPhase3(
	cwd: string,
	bundleRoot: string,
	toolsRoot: string,
	ctx: ExtensionCommandContext,
): Promise<"ok" | "abort"> {
	ctx.ui.setStatus?.("forge:init", "Phase 3/4: Materialize");

	await renderPhaseBanner(toolsRoot, cwd, 3, "Materialize", "ember");

	const buildInitContextTool = path.join(toolsRoot, "build-init-context.cjs");
	const substituteTool = path.join(toolsRoot, "substitute-placeholders.cjs");
	const buildOverlayTool = path.join(toolsRoot, "build-overlay.cjs");
	const basePackDir = path.join(bundleRoot, ".base-pack");

	// Resolve KB path from config (Phase 1 wrote it)
	let kbPath = "engineering";
	try {
		const cfg = JSON.parse(fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8"));
		if (cfg?.paths?.engineering) kbPath = cfg.paths.engineering;
	} catch {
		// fall back to default
	}

	// 3a: substitute-placeholders.cjs — base-pack materialisation
	// Runs first: creates .forge/personas/, .forge/skills/, .forge/workflows/,
	// .forge/templates/ from the base-pack. Subsequent tools depend on these.
	if (fs.existsSync(substituteTool) && fs.existsSync(basePackDir)) {
		await runToolAdvisory(
			substituteTool,
			[
				"--forge-root",
				bundleRoot,
				"--base-pack",
				basePackDir,
				"--config",
				path.join(cwd, ".forge", "config.json"),
				"--context",
				path.join(cwd, ".forge", "project-context.json"),
				"--out",
				cwd,
			],
			cwd,
			ctx,
			"substitute-placeholders",
			60000,
		);
	}

	// 3b: build-init-context.cjs — needs personas/ and templates/ from 3a
	if (fs.existsSync(buildInitContextTool)) {
		await runToolAdvisory(
			buildInitContextTool,
			[
				"--config",
				path.join(cwd, ".forge", "config.json"),
				"--personas",
				path.join(cwd, ".forge", "personas"),
				"--templates",
				path.join(cwd, ".forge", "templates"),
				"--kb",
				path.join(cwd, kbPath),
				"--out",
				path.join(cwd, ".forge", "init-context.md"),
				"--json-out",
				path.join(cwd, ".forge", "init-context.json"),
			],
			cwd,
			ctx,
			"build-init-context",
			30000,
		);
	}

	// Verify Phase 3 (hard-fail — no retry, no user confirm)
	const result = await verifyPhase3(cwd);
	if (!result.ok) {
		ctx.ui.notify(
			`× Phase 3 failed: ${result.missing.join(", ")}. ` +
				`This usually means substitute-placeholders.cjs ran against an incomplete config. ` +
				`Fix .forge/config.json and run /forge:rebuild, or restart /forge:init from scratch (delete .forge/init-progress.json).`,
			"error",
		);
		return "abort";
	}

	writeInitProgress(cwd, 3);
	ctx.ui.notify("〇 Phase 3 complete.", "info");
	return "ok";
}
