// run-init-pipeline.ts — top-level FSM for the /forge:init orchestrated pipeline.
// FORGE-S33-T03.
//
// Provides `runInitPipeline(opts)` which drives the four-phase loop:
//   - startPhase routing (resume from any phase 1–4)
//   - per-phase dispatch via dispatchInitPhase (T02) for LLM phases
//   - deterministic Phase 3/4 execution via existing helpers
//   - checkpoint writes via writeInitProgress
//   - orchestrator transcript + OrchestratorTree nodes
//   - IL10-compliant phase event emission (orchestrator-only; subagents never emit)
//   - returns the InitReport result shape
//
// Iron Laws:
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through dispatchInitPhase → runForgeSubagent (NO sendKickoff)
//          Orchestrator is the sole emitter of phase events; subagents NEVER call store-cli emit.
//
// Layering: may import from orchestrators/init/ siblings, orchestrators/common/,
// orchestrators/task/ (task-events.ts), forge-init/ (upward), config/, lib/, node:*.
// MUST NOT import from forge-init/forge-init.ts (circular init-chain).

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { MergedConfig } from "../../config/config-layer.js";
import { runToolAdvisory } from "../../lib/exec-helpers.js";
import type { OrchestratorResult } from "../../lib/orchestrator-types.js";
import {
	buildProjectContext,
	computeCalibrationBaseline,
	validateProjectContext,
	writeProjectContext,
} from "../../forge-init/init-context.js";
import { writeInitProgress } from "../../forge-init/init-progress.js";
import { runPhase3 } from "../../forge-init/run-phases.js";
import { runPhase4, type Phase4Context } from "../../forge-init/phase4-register.js";
import { verifyPhase2 } from "../../forge-init/verifiers.js";
import { createOrchestratorNotifier } from "../common/orchestrator-notify.js";
import { runPipelinePreflight } from "../common/orchestrator-entry.js";
import {
	type OrchestratorTranscriptSession,
	withOrchestratorTranscript,
} from "../common/orchestrator-transcript-session.js";
import { emitEvent } from "../task/task-events.js";
import type { SubagentResult } from "../../forge-subagent.js";
import type { ForgeToolDefs } from "../../forge-tools.js";

// ── Internal pipeline result (satisfies OrchestratorResult for transcript) ───

interface InitPipelineInternalResult extends OrchestratorResult {
	initReport: InitReport;
}

import { INIT_PHASES } from "./init-phases.js";
import {
	dispatchInitPhase,
} from "./init-phase-dispatch.js";
import type { RunInitOptions, InitReport } from "./run-init-types.js";

// ── Status / message keys ─────────────────────────────────────────────────────

const STATUS_KEY = "forge:init";
const MESSAGE_KEY = "forge:init:message";

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * Extended options for the orchestrator pipeline. Parallel to RunTaskPipelineOptions
 * in orchestrators/task/run-task-types.ts.
 */
export interface RunInitPipelineOptions extends RunInitOptions {
	ctx: ExtensionCommandContext;
	cwd: string;
	bundleRoot: string;
	toolsRoot: string;
	projectName: string;
	/** Absolute path to store-cli.cjs (for IL10 phase event emission). */
	storeCli: string;
	/** Sprint ID for IL10 phase event emission. Optional; emit skipped if absent. */
	sprintId?: string;
	/** Optional forge tool definitions (carries forge_ask_user). */
	forgeToolDefs?: ForgeToolDefs;
	/** Pre-resolved model routing config. If absent, resolved by preflight. */
	modelRoutingConfig?: MergedConfig;
	/** Whether the runtime is the pi agent runtime (for Phase 4). */
	isPiRuntime?: () => boolean;
	/** Get the bundled tools root (for Phase 4). */
	getBundledToolsRoot?: () => string;
}

// ── buildInitPhaseEvent ───────────────────────────────────────────────────────

/**
 * Build an init-specific phase event object for IL10 emission.
 * The orchestrator calls this after each LLM phase completes.
 */
function buildInitPhaseEvent(
	phaseName: string,
	sprintId: string,
	startMs: number,
	endMs: number,
	model: string,
	provider: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Record<string, unknown> {
	const durationMs = Math.max(0, endMs - startMs);
	const startIso = new Date(startMs).toISOString();
	const compactTs = startIso.replace(/[-:.Z]/g, "");
	return {
		eventId: `forge-init_${phaseName}_${compactTs}`,
		sprintId,
		role: `init-${phaseName}`,
		action: `forge:init:${phaseName}`,
		phase: phaseName,
		iteration: 1,
		startTimestamp: startIso,
		endTimestamp: new Date(endMs).toISOString(),
		durationMinutes: Math.round((durationMs / 60000) * 100) / 100,
		model,
		provider,
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		tokenSource: "reported",
	};
}

// ── runPhase2PostVerifyHooks ──────────────────────────────────────────────────

/**
 * Post-Phase-2 hooks: project-context.json + calibration baseline.
 * Extracted inline from run-phases.ts:runPhase2 lines 278–332.
 * T04 will delete the dead code from run-phases.ts after the handler swap.
 */
async function runPhase2PostVerifyHooks(
	cwd: string,
	bundleRoot: string,
	toolsRoot: string,
	projectName: string,
	configCache: Record<string, unknown>,
	ctx: ExtensionCommandContext,
): Promise<void> {
	let kbPathResolved = "engineering";
	let prefix = "";
	try {
		const cachePaths = configCache.paths as Record<string, unknown> | undefined;
		if (cachePaths && typeof cachePaths.engineering === "string") {
			kbPathResolved = cachePaths.engineering;
		}
		const cacheProj = configCache.project as Record<string, unknown> | undefined;
		if (cacheProj && typeof cacheProj.prefix === "string") prefix = cacheProj.prefix;
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
		ctx.ui.notify(
			`△ project-context.json validation failed: ${e.message ?? "unknown"} — proceeding.`,
			"warning",
		);
	}

	// Calibration baseline.
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
}

// ── runInitPipeline ───────────────────────────────────────────────────────────

/**
 * Top-level entry point for the /forge:init orchestrated pipeline.
 * Runs preflight, then wraps in withOrchestratorTranscript, delegates to FSM.
 */
export async function runInitPipeline(opts: RunInitPipelineOptions): Promise<InitReport> {
	const notify = createOrchestratorNotifier(opts.ctx, {
		label: "forge:init",
		statusKey: STATUS_KEY,
		messageKey: MESSAGE_KEY,
	});

	const pre = runPipelinePreflight({ cwd: opts.cwd, ctx: opts.ctx, notify });
	if (!pre.proceed) {
		return {
			ok: false,
			lastPhase: 0,
			failure: pre.lastError,
		};
	}

	const modelRoutingConfig = opts.modelRoutingConfig ?? pre.modelRoutingConfig;

	// Use a synthetic entityId since /forge:init is not a store task.
	const initEntityId = "forge-init";

	const internal = await withOrchestratorTranscript(
		{ cwd: opts.cwd, entityKind: "task", entityId: initEntityId, ctx: opts.ctx },
		(session) => runInitPipelineInner(opts, modelRoutingConfig, session),
	);
	return internal.initReport;
}

// ── runInitPipelineInner ──────────────────────────────────────────────────────

async function runInitPipelineInner(
	opts: RunInitPipelineOptions,
	modelRoutingConfig: MergedConfig,
	session: OrchestratorTranscriptSession,
): Promise<InitPipelineInternalResult> {
	const { cwd, bundleRoot, toolsRoot, projectName, ctx, storeCli } = opts;
	const orchTranscript = session.writer;

	/** Build the internal failure result (satisfies OrchestratorResult for transcript). */
	function makeFailResult(report: InitReport): InitPipelineInternalResult {
		return {
			status: "failed",
			lastPhaseIndex: report.lastPhase,
			iterationCounts: {},
			lastError: report.failure,
			initReport: report,
		};
	}

	// Resolve kbFolder from opts or configCache (default: "engineering").
	const kbFolder = opts.kbFolder ?? "engineering";
	// kbPathFinal is resolved by Phase 4 or from configCache after Phase 1.
	let kbPathFinal: string | undefined;

	// Build initial configCache from .forge/config.json (fallback: {}).
	let configCache: Record<string, unknown> = {};
	try {
		configCache = JSON.parse(
			fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8"),
		) as Record<string, unknown>;
	} catch {
		// File not yet present — Phase 1 will create it
	}

	// Resolve start phase index (0-based).
	const startPhaseIndex = Math.max(0, (opts.startPhase ?? 1) - 1);
	let currentPhaseIndex = startPhaseIndex;
	let lastPhase = startPhaseIndex;

	while (currentPhaseIndex < INIT_PHASES.length) {
		const phase = INIT_PHASES[currentPhaseIndex];
		if (!phase) {
			ctx.ui.notify(
				`× forge:init — invalid phase index ${currentPhaseIndex}`,
				"error",
			);
			return makeFailResult({ ok: false, lastPhase, failure: `invalid phase index ${currentPhaseIndex}` });
		}

		const phaseNum = currentPhaseIndex + 1;
		ctx.ui.setStatus?.(STATUS_KEY, `forge:init: phase ${phaseNum}/${INIT_PHASES.length} (${phase.name})`);
		ctx.ui.notify(`→ init: phase ${phase.name} (${phaseNum}/${INIT_PHASES.length})`, "info");

		orchTranscript.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: phase.name,
			phaseIndex: currentPhaseIndex,
			phaseCount: INIT_PHASES.length,
			attempt: 1,
			workflowFile: `init-${phase.name}`,
			persona: phase.persona ?? "engineer",
		});

		const phaseStartMs = Date.now();

		// Dispatch the phase.
		const outcome = await dispatchInitPhase({
			opts,
			phase,
			phaseIndex: currentPhaseIndex,
			cwd,
			ctx,
			bundleRoot,
			kbFolder,
			isoTimestamp: opts.isoTimestamp,
			modelRoutingConfig,
			forgeToolDefs: opts.forgeToolDefs,
		});

		if (outcome.kind === "return") {
			// Early failure / cancel.
			const failure = outcome.result.failure ?? `Phase ${phaseNum} (${phase.name}) failed`;
			ctx.ui.notify(`× forge:init — phase ${phase.name} failed: ${failure}`, "error");
			orchTranscript.record({
				kind: "phase-end",
				ts: new Date().toISOString(),
				phase: phase.name,
				phaseIndex: currentPhaseIndex,
				attempt: 1,
				verdict: "error",
				elapsedMs: Date.now() - phaseStartMs,
			});
			return makeFailResult({ ok: false, lastPhase: phaseNum, failure });
		}

		if (outcome.kind === "skip") {
			// Deterministic phase — run Phase 3 or Phase 4 directly.
			if (phase.name === "materialize") {
				// Phase 3: runPhase3 internally calls verifyPhase3 and hard-halts on failure.
				const phase3Result = await runPhase3(cwd, bundleRoot, toolsRoot, ctx);
				if (phase3Result === "abort") {
					const failure = "Phase 3 abort (verify failed or tools missing)";
					ctx.ui.notify(`× forge:init — ${failure}`, "error");
					orchTranscript.record({
						kind: "phase-end",
						ts: new Date().toISOString(),
						phase: phase.name,
						phaseIndex: currentPhaseIndex,
						attempt: 1,
						verdict: "error",
						elapsedMs: Date.now() - phaseStartMs,
					});
					return makeFailResult({ ok: false, lastPhase: phaseNum, failure });
				}
				// Phase 3 succeeded — write checkpoint.
				writeInitProgress(cwd, 3);
			} else if (phase.name === "register") {
				// Phase 4: runPhase4 is deterministic + internally deletes init-progress.
				const isPiRuntime = opts.isPiRuntime ?? (() => false);
				const getBundledToolsRoot = opts.getBundledToolsRoot ?? (() => toolsRoot);
				const phase4Ctx: Phase4Context = {
					cwd,
					bundleRoot,
					toolsRoot,
					projectName,
					configCache,
					ctx,
					isPiRuntime,
					getBundledToolsRoot,
				};
				const phase4Result = await runPhase4(phase4Ctx);
				if (phase4Result === "abort") {
					const failure = "Phase 4 abort";
					ctx.ui.notify(`× forge:init — ${failure}`, "error");
					orchTranscript.record({
						kind: "phase-end",
						ts: new Date().toISOString(),
						phase: phase.name,
						phaseIndex: currentPhaseIndex,
						attempt: 1,
						verdict: "error",
						elapsedMs: Date.now() - phaseStartMs,
					});
					return makeFailResult({ ok: false, lastPhase: phaseNum, failure });
				}
				// Capture kbPathFinal from Phase 4 result for InitReport.
				kbPathFinal = phase4Result.kbPathFinal;
				// Phase 4 internally calls deleteInitProgress — no checkpoint write needed.
			}
		} else {
			// outcome.kind === "ok" — LLM phase succeeded.
			const result: SubagentResult = outcome.result;

			// Phase 1 post-success: re-read configCache.
			if (phase.name === "collect") {
				try {
					configCache = JSON.parse(
						fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8"),
					) as Record<string, unknown>;
				} catch {
					// Fall back to existing cache
				}
			}

			// Phase 2 post-success: run verifyPhase2 + post-verify hooks.
			if (phase.name === "discover") {
				// Resolve kbPath from configCache (matches run-phases.ts:runPhase2 logic).
				let kbPath = kbFolder;
				try {
					const cachePaths = configCache.paths as Record<string, unknown> | undefined;
					if (cachePaths && typeof cachePaths.engineering === "string") {
						kbPath = cachePaths.engineering;
					}
				} catch {
					// use kbFolder default
				}

				const verifyResult = await verifyPhase2(cwd, kbPath);
				if (!verifyResult.ok) {
					// T02 already did retry-once inside dispatchInitPhase; this is the
					// orchestrator-side confirm. On failure, halt (non-interactive path).
					const failure = `Phase 2 verify failed: ${verifyResult.missing.join(", ")}`;
					ctx.ui.notify(`× forge:init — ${failure}`, "error");
					orchTranscript.record({
						kind: "phase-end",
						ts: new Date().toISOString(),
						phase: phase.name,
						phaseIndex: currentPhaseIndex,
						attempt: 1,
						verdict: "error",
						elapsedMs: Date.now() - phaseStartMs,
					});
					return makeFailResult({ ok: false, lastPhase: phaseNum, failure });
				}

				// Run post-verify hooks (project-context.json + calibration baseline).
				await runPhase2PostVerifyHooks(
					cwd,
					bundleRoot,
					toolsRoot,
					projectName,
					configCache,
					ctx,
				);
			}

			// IL10: orchestrator emits phase event from result.{model,provider,usage}.
			// Subagents NEVER call store-cli emit for phase events.
			const phaseEndMs = Date.now();
			const { sprintId } = opts;
			if (!sprintId) {
				ctx.ui.notify(
					`⚠ forge:init — sprintId not provided; skipping phase event emit for ${phase.name}`,
					"warning",
				);
			} else {
				const phaseEvent = buildInitPhaseEvent(
					phase.name,
					sprintId,
					phaseStartMs,
					phaseEndMs,
					result.model ?? "unknown",
					result.provider ?? "unknown",
					{
						input: result.usage.input,
						output: result.usage.output,
						cacheRead: result.usage.cacheRead,
						cacheWrite: result.usage.cacheWrite,
					},
				);
				const emitResult = emitEvent(storeCli, cwd, sprintId, phaseEvent);
				if (!emitResult.ok) {
					ctx.ui.notify(
						`⚠ forge:init — phase event emit failed for ${phase.name}: ${emitResult.stderr.trim()}`,
						"warning",
					);
				}
			}

			// Write checkpoint after LLM phase (phases 1 and 2).
			if (phase.name === "collect") {
				writeInitProgress(cwd, 1);
			} else if (phase.name === "discover") {
				writeInitProgress(cwd, 2);
			}
		}

		// Record phase-end to orchestrator transcript.
		orchTranscript.record({
			kind: "phase-end",
			ts: new Date().toISOString(),
			phase: phase.name,
			phaseIndex: currentPhaseIndex,
			attempt: 1,
			verdict: "n/a",
			elapsedMs: Date.now() - phaseStartMs,
		});

		const elapsed = Math.floor((Date.now() - phaseStartMs) / 1000);
		ctx.ui.notify(`✓ init: ${phase.name} complete (${elapsed}s)`, "info");

		lastPhase = phaseNum;
		currentPhaseIndex++;
	}

	// ── All phases complete — assemble InitReport ──────────────────────────────

	const pipelineEndMs = Date.now();
	orchTranscript.record({
		kind: "pipeline-end",
		ts: new Date().toISOString(),
		outcome: "complete",
		elapsedMs: pipelineEndMs,
	});

	const stack = typeof (configCache.project as Record<string, unknown> | undefined)?.stack === "string"
		? ((configCache.project as Record<string, unknown>).stack as string)
		: undefined;

	const skillMatches = Array.isArray(configCache.installedSkills)
		? (configCache.installedSkills as string[])
		: undefined;

	// If Phase 4 didn't run (resume at Phase 1–3), derive kbPathFinal from configCache.
	if (!kbPathFinal) {
		const p = configCache.paths as Record<string, unknown> | undefined;
		if (p && typeof p.engineering === "string" && p.engineering) {
			kbPathFinal = p.engineering;
		}
	}

	const report: InitReport = {
		ok: true,
		lastPhase,
		stack,
		skillMatches,
		kbPathFinal,
	};

	return {
		status: "completed",
		lastPhaseIndex: lastPhase,
		iterationCounts: {},
		initReport: report,
	};
}
