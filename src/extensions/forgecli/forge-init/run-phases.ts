// forge-init/run-phases.ts — per-phase standalone functions (FORGE-S26-T17)
//
// FORGE-S33-T04: runPhase1 and runPhase2 have been removed.
//   - runPhase1's LLM dispatch now lives in orchestrators/init/init-phase-dispatch.ts
//   - runPhase1's KB-folder prompt and marketplace advisory moved to forge-init.ts handler
//   - runPhase2's LLM dispatch now lives in orchestrators/init/init-phase-dispatch.ts
//   - runPhase2's post-verify hooks (project-context.json, calibration baseline) duplicated
//     in orchestrators/init/run-init-pipeline.ts:runPhase2PostVerifyHooks
//
// This file now only exports runPhase3 (the deterministic materialize phase),
// which is called by run-init-pipeline.ts:runInitPipelineInner for the skip branch.
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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { writeInitProgress } from "./init-progress.js";
import { execFileAsync, runToolAdvisory } from "../lib/exec-helpers.js";
import { verifyPhase3 } from "./verifiers.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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
