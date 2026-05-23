// forge-init/phase-descriptors.ts — LlmPhaseDescriptor interface + runLlmPhase() runner
// + per-phase descriptor objects (FORGE-S25-T24, B-5)
//
// Centralises the repeated "banner → [LLM dispatch → waitForIdle →] verify → [retry →]
// [user confirm →] writeInitProgress → completeNotify" skeleton that was duplicated
// across the Phase 1, 2, and 3 blocks in forge-init.ts.
//
// Design rules:
//   - If `buildPrompt` returns a non-null string, the runner performs LLM dispatch via
//     `sendToAgent` + `waitForIdle`. Phase 1 and 2 use this path.
//   - If `buildPrompt` returns null, the runner skips LLM dispatch and invokes
//     `runDeterministic` instead (Phase 3 path — pure tool calls, no agent).
//   - `postVerify` is an optional async hook invoked after the failure-handling decision
//     completes (i.e. after verify succeeds OR after user chooses partial-continue).
//     Used by Phase 1 for KB folder prompt + marketplace advisory, by Phase 2 for
//     project-context.json write and calibration baseline.
//   - `hardFailOnVerifyError` (default false): when true, a failed verify causes an
//     immediate `"abort"` return with no retry and no user confirm. Phase 3 uses this.
//   - `preDispatchNotify` (optional): fired before LLM dispatch — used by Phase 1 to
//     emit the "Running 5 discovery scans in parallel..." info notice.

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileAsync, runToolAdvisory } from "../lib/exec-helpers.js";
import { writeInitProgress } from "../init-progress.js";
import {
	buildProjectContext,
	computeCalibrationBaseline,
	validateProjectContext,
	writeProjectContext,
} from "../init-context.js";
import { verifyPhase1, verifyPhase2, verifyPhase3 } from "./verifiers.js";
import { buildPhase1PromptText, buildPhase2PromptText } from "./prompts.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface VerifyResult {
	ok: boolean;
	missing: string[];
	reason?: string;
}

/** Context passed to the `postVerify` hook. */
export interface PostVerifyContext {
	cwd: string;
	bundleRoot: string;
	toolsRoot: string;
	projectName: string;
	configCache: Record<string, unknown>;
	ctx: ExtensionCommandContext;
	sendToAgent: (text: string) => void;
	isNonInteractive: () => boolean;
}

/**
 * Descriptor for a single init phase.
 *
 * LLM phases (1, 2): `buildPrompt` returns a string; `runLlmPhase` dispatches via
 * `sendToAgent` + `waitForIdle` then verifies.
 *
 * Deterministic phases (3): `buildPrompt` returns `null`; `runDeterministic` runs
 * tool calls directly without LLM dispatch.
 */
export interface LlmPhaseDescriptor {
	phaseNum: 1 | 2 | 3;
	label: string; // e.g. "1/4: Collect"
	bannerName: string; // e.g. "Collect"
	bannerKey: string; // e.g. "north"
	/**
	 * Build the prompt to send to the agent. Return `null` for deterministic phases
	 * that run tool calls directly (Phase 3).
	 */
	buildPrompt: (
		bundleRoot: string,
		cwd: string,
		projectName: string,
		configCache: Record<string, unknown>,
	) => string | null;
	/** Direct tool execution for deterministic phases (called when buildPrompt returns null). */
	runDeterministic?: (
		cwd: string,
		bundleRoot: string,
		toolsRoot: string,
		configCache: Record<string, unknown>,
		ctx: ExtensionCommandContext,
	) => Promise<void>;
	/** Optional notification emitted before LLM dispatch (e.g. Phase 1 parallel-scan notice). */
	preDispatchNotify?: string;
	verify: (cwd: string, configCache: Record<string, unknown>) => VerifyResult;
	buildRetrySteer: (result: VerifyResult, bundleRoot: string, cwd: string) => string | null;
	nonInteractiveAbortMsg: (result: VerifyResult) => string;
	interactiveAbortPrompt: (result: VerifyResult) => { title: string; body: string };
	abortNotify: string;
	partialContinueNotify: string;
	completeNotify: string;
	/** When true, a failed verify aborts immediately with no retry or user confirm. Default: false. */
	hardFailOnVerifyError?: boolean;
	/**
	 * Optional async hook invoked after the failure-handling decision completes (both on
	 * success and on partial-continue). NOT called when the phase returns "abort".
	 */
	postVerify?: (ctx: PostVerifyContext) => Promise<void> | void;
}

// ── Generic runner ─────────────────────────────────────────────────────────

/**
 * Run a single init phase using its descriptor.
 *
 * Returns `"ok"` when the phase completes successfully (verify passed, or the
 * user chose to continue with partial results).
 *
 * Returns `"abort"` when the phase should halt the entire init (verify failed
 * in hard-fail mode, verify failed twice in non-interactive mode, or the user
 * declined to continue).
 */
export async function runLlmPhase(
	desc: LlmPhaseDescriptor,
	ctx: ExtensionCommandContext,
	cwd: string,
	bundleRoot: string,
	toolsRoot: string,
	projectName: string,
	configCache: Record<string, unknown>,
	sendToAgent: (text: string) => void,
	waitForIdle: () => Promise<void>,
	isNonInteractive: () => boolean,
): Promise<"ok" | "abort"> {
	// 1. setStatus
	ctx.ui.setStatus?.("forge:init", `Phase ${desc.label}`);

	// 2. Banner
	const bannersTool = path.join(toolsRoot, "banners.cjs");
	if (fs.existsSync(bannersTool)) {
		await execFileAsync(
			"node",
			[bannersTool, "--phase", String(desc.phaseNum), "4", desc.bannerName, desc.bannerKey],
			{ cwd, timeout: 5000 },
		).catch(() => {
			/* non-fatal */
		});
	}

	// 3. Optional pre-dispatch notification
	if (desc.preDispatchNotify) {
		ctx.ui.notify(desc.preDispatchNotify, "info");
	}

	// 4. LLM dispatch OR deterministic execution
	const prompt = desc.buildPrompt(bundleRoot, cwd, projectName, configCache);
	if (prompt !== null) {
		// LLM path: send prompt + wait for agent
		sendToAgent(prompt);
		await waitForIdle();
	} else if (desc.runDeterministic) {
		// Deterministic path: run tool calls directly
		await desc.runDeterministic(cwd, bundleRoot, toolsRoot, configCache, ctx);
	}

	// 5. Verify
	let result = desc.verify(cwd, configCache);

	if (!result.ok && desc.hardFailOnVerifyError) {
		// Hard-fail: no retry, no user confirm (Phase 3)
		ctx.ui.notify(desc.nonInteractiveAbortMsg(result), "error");
		return "abort";
	}

	// 6. Retry steer (LLM phases only)
	if (!result.ok && prompt !== null) {
		const retrySteer = desc.buildRetrySteer(result, bundleRoot, cwd);
		if (retrySteer) {
			ctx.ui.notify(
				`△ Phase ${desc.phaseNum} deliverable missing: ${result.missing.join(", ")} — retrying with corrective steer.`,
				"warning",
			);
			sendToAgent(retrySteer);
			await waitForIdle();
			result = desc.verify(cwd, configCache);
		}
	}

	// 7. Handle persistent failure
	if (!result.ok) {
		if (isNonInteractive()) {
			ctx.ui.notify(desc.nonInteractiveAbortMsg(result), "error");
			return "abort";
		}

		const { title, body } = desc.interactiveAbortPrompt(result);
		const proceed = await ctx.ui.confirm(title, body);
		if (!proceed) {
			ctx.ui.notify(desc.abortNotify, "error");
			return "abort";
		}
		ctx.ui.notify(desc.partialContinueNotify, "warning");
	}

	// 8. Post-verify hook (called on success AND on partial-continue)
	if (desc.postVerify) {
		await desc.postVerify({ cwd, bundleRoot, toolsRoot, projectName, configCache, ctx, sendToAgent, isNonInteractive });
	}

	// 9. Write progress marker + completion notify
	writeInitProgress(cwd, desc.phaseNum);
	ctx.ui.notify(desc.completeNotify, "info");

	return "ok";
}

// ── Phase descriptors ──────────────────────────────────────────────────────

export const PHASE_1: LlmPhaseDescriptor = {
	phaseNum: 1,
	label: "1/4: Collect",
	bannerName: "Collect",
	bannerKey: "north",

	preDispatchNotify: "Running 5 discovery scans in parallel...",

	buildPrompt(bundleRoot, _cwd, projectName, _configCache) {
		return buildPhase1PromptText(bundleRoot, projectName);
	},

	verify(cwd, _configCache) {
		return verifyPhase1(cwd);
	},

	buildRetrySteer(result, _bundleRoot, _cwd) {
		return (
			`Phase 1 verification failed. .forge/config.json is missing the following required fields: ${result.missing.join(", ")}.\n\n` +
			`Write a complete .forge/config.json now using the \`write\` tool. Do NOT call subagents — analyze the project codebase yourself if needed. ` +
			`Use the schema from the original Phase 1 prompt: version, project.{name,prefix}, stack, commands, and paths.{engineering,store,workflows,commands,templates} are all required.`
		);
	},

	nonInteractiveAbortMsg(result) {
		return `× Phase 1 failed: ${result.missing.join(", ")}. Aborting init in non-interactive mode.`;
	},

	interactiveAbortPrompt(result) {
		return {
			title: "Phase 1 failed twice — continue with partial init?",
			body:
				`.forge/config.json is still missing: ${result.missing.join(", ")}.\n\n` +
				`Yes = continue (you'll need to /forge:regenerate later).\n` +
				`No  = abort. Inspect the file manually and re-run /forge:init.`,
		};
	},

	abortNotify: "× /forge:init aborted at Phase 1 verify.",
	partialContinueNotify: "△ Continuing with partial Phase 1 — downstream phases may fail.",
	completeNotify: "〇 Phase 1 complete.",

	async postVerify({ cwd, toolsRoot, configCache, ctx, isNonInteractive }) {
		// KB folder prompt (spec §7, F2) — G3: skipped in non-interactive mode (default: "engineering")
		// Phrasing chosen so the default-Yes affirmative ("use engineering/") is the
		// safe path. Pi's ctx.ui.confirm has no defaultValue option, so the question
		// has to align with the highlighted default — earlier "does this conflict?"
		// phrasing made the unsafe answer the default.
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
					const manageConfigToolEarly = path.join(toolsRoot, "manage-config.cjs");
					if (fs.existsSync(manageConfigToolEarly)) {
						await runToolAdvisory(
							manageConfigToolEarly,
							["set", "paths.engineering", customName.trim()],
							cwd,
							ctx,
							"manage-config paths.engineering",
						);
					}
				}
			}
		}

		// Marketplace skills advisory (sub-decision #1)
		ctx.ui.notify(
			"〇 Marketplace skills auto-recommendation is Claude-Code-only. " +
				"Pi users install extensions manually. Writing installedSkills: []",
			"info",
		);

		// Write installedSkills: []
		const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
		if (fs.existsSync(manageConfigTool)) {
			await runToolAdvisory(
				manageConfigTool,
				["set", "installedSkills", "[]"],
				cwd,
				ctx,
				"manage-config installedSkills",
			);
			// Write mode = "full"
			await runToolAdvisory(manageConfigTool, ["set", "mode", "full"], cwd, ctx, "manage-config mode");
		}

		void configCache; // used by descriptor runner; accessed here only to satisfy type
	},
};

export const PHASE_2: LlmPhaseDescriptor = {
	phaseNum: 2,
	label: "2/4: Discover",
	bannerName: "Discover",
	bannerKey: "oracle",

	buildPrompt(bundleRoot, cwd, projectName, configCache) {
		let kbPath = "engineering";
		const cachePaths = configCache.paths as Record<string, unknown> | undefined;
		if (cachePaths && typeof cachePaths.engineering === "string" && cachePaths.engineering) {
			kbPath = cachePaths.engineering;
		}

		// Scaffold dirs before dispatching to ensure they exist
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

		return buildPhase2PromptText(bundleRoot, kbPath, projectName);
	},

	verify(cwd, configCache) {
		let kbPath = "engineering";
		const cachePaths = configCache.paths as Record<string, unknown> | undefined;
		if (cachePaths && typeof cachePaths.engineering === "string" && cachePaths.engineering) {
			kbPath = cachePaths.engineering;
		}
		return verifyPhase2(cwd, kbPath);
	},

	buildRetrySteer(result, bundleRoot, _cwd) {
		return (
			`Phase 2 verification failed. The following architecture docs are missing:\n${result.missing.map((m) => `  - ${m}`).join("\n")}\n\n` +
			`Write the missing files now using the \`write\` tool. Do NOT call subagents — analyze the project codebase yourself. ` +
			`Use the rulebook at ${path.join(bundleRoot, ".init", "generation", "generate-kb-doc.md")} for the per-doc shape and confidence-header format.`
		);
	},

	nonInteractiveAbortMsg(result) {
		return `× Phase 2 failed: ${result.missing.length} doc(s) still missing. Aborting init in non-interactive mode.`;
	},

	interactiveAbortPrompt(result) {
		return {
			title: "Phase 2 failed twice — continue with partial init?",
			body:
				`Missing docs:\n${result.missing.map((m) => `  - ${m}`).join("\n")}\n\n` +
				`Yes = continue (you'll need to fill these manually).\n` +
				`No  = abort. Inspect the project and re-run /forge:init.`,
		};
	},

	abortNotify: "× /forge:init aborted at Phase 2 verify.",
	partialContinueNotify: "△ Continuing with partial Phase 2.",
	completeNotify: "〇 Phase 2 complete.",

	async postVerify({ cwd, bundleRoot, toolsRoot, projectName, configCache, ctx }) {
		// Construct project-context.json — use configCache (written by Phase 1)
		let kbPathResolved = "engineering";
		let prefix = "";
		{
			const cacheProj = configCache.project as Record<string, unknown> | undefined;
			if (cacheProj && typeof cacheProj.prefix === "string") prefix = cacheProj.prefix;
			const cachePaths2 = configCache.paths as Record<string, unknown> | undefined;
			if (cachePaths2 && typeof cachePaths2.engineering === "string") kbPathResolved = cachePaths2.engineering;
		}

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

		try {
			validateProjectContext(projectCtx);
			writeProjectContext(cwd, projectCtx);
			ctx.ui.notify("〇 project-context.json written.", "info");
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`△ project-context.json validation failed: ${e.message ?? "unknown"} — proceeding.`,
				"warning",
			);
		}

		// Calibration baseline — read bundled version from plugin.json (same pattern as phase4-register.ts step 4-8)
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
	},
};

export const PHASE_3: LlmPhaseDescriptor = {
	phaseNum: 3,
	label: "3/4: Materialize",
	bannerName: "Materialize",
	bannerKey: "supervisor",

	// Phase 3 is deterministic — no LLM dispatch.
	buildPrompt(_bundleRoot, _cwd, _projectName, _configCache) {
		return null;
	},

	async runDeterministic(cwd, bundleRoot, toolsRoot, _configCache, ctx) {
		const buildInitContextTool = path.join(toolsRoot, "build-init-context.cjs");
		const substituteTool = path.join(toolsRoot, "substitute-placeholders.cjs");
		const buildOverlayTool = path.join(toolsRoot, "build-overlay.cjs");
		const basePackDir = path.join(bundleRoot, ".base-pack");

		// 3a: build-init-context.cjs first build
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
					cwd,
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

		// 3b: substitute-placeholders.cjs — base-pack materialisation
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
					path.join(cwd, ".forge", "init-context.json"),
					"--out",
					cwd,
				],
				cwd,
				ctx,
				"substitute-placeholders",
				60000,
			);
		}

		// 3c: build-overlay.cjs smoke test (exit 1 is advisory)
		if (fs.existsSync(buildOverlayTool)) {
			await runToolAdvisory(
				buildOverlayTool,
				["--task", "INIT-SMOKE-TEST", "--format", "json"],
				cwd,
				ctx,
				"build-overlay smoke (advisory)",
				15000,
			);
		}
	},

	verify(cwd, _configCache) {
		return verifyPhase3(cwd);
	},

	buildRetrySteer(_result, _bundleRoot, _cwd) {
		// Phase 3 hard-fails — retry steer is not used.
		return null;
	},

	nonInteractiveAbortMsg(result) {
		return (
			`× Phase 3 failed: ${result.missing.join(", ")}. ` +
			`This usually means substitute-placeholders.cjs ran against an incomplete config. ` +
			`Fix .forge/config.json and run /forge:regenerate, or restart /forge:init from scratch (delete .forge/init-progress.json).`
		);
	},

	interactiveAbortPrompt(result) {
		return {
			title: "Phase 3 failed — abort init?",
			body:
				`Phase 3 materialization failed: ${result.missing.join(", ")}.\n\n` +
				`This usually means substitute-placeholders.cjs ran against an incomplete config.\n` +
				`Fix .forge/config.json and run /forge:regenerate.`,
		};
	},

	abortNotify: "× /forge:init aborted at Phase 3 verify.",
	partialContinueNotify: "△ Continuing with partial Phase 3.",
	completeNotify: "〇 Phase 3 complete.",

	// Phase 3 hard-fails on verify error — no retry, no user confirm.
	hardFailOnVerifyError: true,
};
