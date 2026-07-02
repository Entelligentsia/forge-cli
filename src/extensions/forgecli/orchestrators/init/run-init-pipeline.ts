// run-init-pipeline.ts — top-level FSM for the /forge:init orchestrated pipeline.
// FORGE-S33-T03.
//
// Provides `runInitPipeline(opts)` which drives the step machine (Slice 1):
//   - builds the flat INIT_STEPS table, topo-sorts it into waves
//   - startPhase routing (resume from any coarse phase 1–4 via PHASE_TO_WAVE)
//   - runs each wave concurrently (runWave/Promise.all); per step:
//     check precondition → run (deterministic thunk OR subagent) → check
//     requiredOutput → advance / rerun (retryPolicy) / halt
//   - deterministic Phase 3/4 execution via existing helpers (now steps)
//   - checkpoint writes via writeInitProgress
//   - orchestrator transcript + OrchestratorTree nodes
//   - IL10-compliant phase event emission (orchestrator-only; subagents never emit)
//   - returns the InitReport result shape
//
// Iron Laws:
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through dispatchSingleAgent → runForgeSubagent (NO sendKickoff)
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
	deriveProjectPrefix,
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

import { INIT_SESSION_ID } from "./init-phases.js";
import {
	dispatchSingleAgent,
	readInitPhasePrompt,
	readInitSharedProcedure,
	readInitPhase2Fragment,
	type InitDispatchParams,
} from "./init-phase-dispatch.js";
import {
	runStep,
	runWave,
	topoSortWaves,
	type Step,
	type StepRuntimeCtx,
	type SubagentRun,
} from "./init-steps.js";
import type { RunInitOptions, InitReport } from "./run-init-types.js";
import { DISCOVERY_SCHEMA, DOMAINS, KB_DOC_IDS, KB_DOC_SCHEMA } from "./run-init-types.js";
import { getSessionRegistry } from "../../session-registry.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";

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
 * The orchestrator calls this after each successful subagent STEP completes.
 *
 * `stepId` is folded into `eventId` (and per-step start/end timestamps are used)
 * so every step in a concurrent fan-out wave produces a DISTINCT event file.
 * Deriving the id from phaseName + waveStartMs alone collided every step in a
 * wave onto one <eventId>.json (store.writeEvent is a plain overwrite), silently
 * discarding all but the last step's token accounting.
 */
function buildInitPhaseEvent(
	phaseName: string,
	stepId: string,
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
	// Sanitize the step id for use inside a filesystem-safe eventId (step ids
	// carry ':' e.g. "discovery:routing", "kb-doc:stack").
	const safeStepId = stepId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return {
		eventId: `forge-init_${phaseName}_${safeStepId}_${compactTs}`,
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
	const initEntityId = INIT_SESSION_ID;

	// Open the orchestrator session + root tree node so the always-mounted chip
	// strip and /forge:dashboard render /forge:init's live progress exactly like
	// run-task/run-sprint/fix-bug. Per-phase leaf nodes + telemetry are attached
	// inside dispatchSingleAgent (init-phase-dispatch.ts). try/finally guarantees
	// the session never leaks in a "running" state on a thrown failure path —
	// otherwise the chip strip would show a stuck spinner forever.
	const registry = getSessionRegistry();
	const tree = getOrchestratorTree();
	registry.startSession(initEntityId);
	tree.startNode(initEntityId, { label: "forge:init", kind: "orchestrator" });

	let internal: InitPipelineInternalResult;
	try {
		internal = await withOrchestratorTranscript(
			{ cwd: opts.cwd, entityKind: "task", entityId: initEntityId, ctx: opts.ctx },
			(session) => runInitPipelineInner(opts, modelRoutingConfig, session),
		);
	} catch (err) {
		registry.completeSession(initEntityId, "failed");
		tree.completeNode(initEntityId, "failed");
		throw err;
	}

	const finalStatus = internal.initReport.ok ? "completed" : "failed";
	registry.completeSession(initEntityId, finalStatus);
	tree.completeNode(initEntityId, finalStatus);
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
	// Build initial configCache from .forge/config.json (fallback: {}).
	let configCache: Record<string, unknown> = {};
	try {
		configCache = JSON.parse(
			fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8"),
		) as Record<string, unknown>;
	} catch {
		// File not yet present — Phase 1 will create it
	}

	// ── Coarse-phase ↔ wave bridge ────────────────────────────────────────────
	// The step machine groups steps into topo waves, but the on-disk
	// `.forge/cache/init-progress` checkpoint + resume tests speak the coarse
	// phase number (1–4). These tables bridge the two with NO checkpoint-format
	// change (PLAN design #8). Wave layout (from topoSortWaves on INIT_STEPS):
	//   0 discovery×5 · 1 config-writer · 2 enforce-config      → phase 1 (collect)
	//   3 kb-doc×10 · 4 index · 5 context · 6 verify-discover    → phase 2 (discover)
	//   7 materialize                                            → phase 3
	//   8 register                                               → phase 4
	const WAVE_PHASE_NUM = [1, 1, 1, 2, 2, 2, 2, 3, 4] as const;
	const WAVE_PHASE_NAME = [
		"collect", "collect", "collect",
		"discover", "discover", "discover", "discover",
		"materialize", "register",
	] as const;
	// Resume: coarse startPhase (1–4) → first wave of that phase.
	const PHASE_TO_WAVE: Record<number, number> = { 1: 0, 2: 3, 3: 7, 4: 8 };
	const startWave = PHASE_TO_WAVE[opts.startPhase ?? 1] ?? 0;

	// ── Mutable pipeline state (threaded to steps as the runtime ctx) ─────────
	// Only single-step waves mutate these fields, so reads/writes are race-free
	// even though fan-out waves share this one object.
	interface InitStepState extends StepRuntimeCtx {
		configCache: Record<string, unknown>;
		kbPathFinal?: string;
		verifyOk: boolean;
		verifyReason?: string;
		phase3Ok: boolean;
		phase4Ok: boolean;
	}
	const state: InitStepState = {
		configCache,
		verifyOk: true,
		phase3Ok: true,
		phase4Ok: true,
	};

	// Pre-read the bundled phase prompts needed for the resume range. A prompt
	// read failure is a graceful pipeline failure (IL7), not a thrown crash.
	//
	// Slice 2 (FORGE-S35-T03): the Phase-2 base prompt is NO LONGER the whole
	// phase-2-discover.md rulebook. It is the shared procedure (generate-kb-doc.md);
	// each Phase-2 step appends its OWN substance fragment + AGENT PARAMS in its
	// buildPrompt, so a subagent sees only its own docId's work. Fragments are
	// keyed by KB_DOC_ID basename plus "index" / "context".
	const promptCache: Partial<Record<1 | 2, string>> = {};
	const phase2Fragments: Record<string, string> = {};
	try {
		if (startWave <= 1) promptCache[1] = readInitPhasePrompt(bundleRoot, 1);
		if (startWave <= 5) {
			promptCache[2] = readInitSharedProcedure(bundleRoot);
			const fragmentNames = [
				...KB_DOC_IDS.map((id) => id.slice(id.lastIndexOf("/") + 1)),
				"index",
				"context",
			];
			for (const name of fragmentNames) {
				phase2Fragments[name] = readInitPhase2Fragment(bundleRoot, name);
			}
		}
	} catch (err: unknown) {
		const e = err as { message?: string };
		const failure = `phase prompt read failed: ${e.message ?? "unknown"}`;
		ctx.ui.notify(`× forge:init — ${failure}`, "error");
		return makeFailResult({ ok: false, lastPhase: WAVE_PHASE_NUM[startWave], failure });
	}

	// ── Subagent step runner (IL10: dispatch via dispatchSingleAgent) ─────────
	const dispatchCounts: Record<string, number> = {};
	let currentWaveIndex = startWave;
	const dispatchSubagent = async (run: SubagentRun): Promise<SubagentResult> => {
		const base = promptCache[run.promptPhase];
		if (base === undefined) {
			throw new Error(`init: phase-${run.promptPhase} prompt not loaded for step ${run.subLabel}`);
		}
		const prompt = run.buildPrompt(base, state);
		const dispatchParams: InitDispatchParams = {
			opts,
			cwd,
			ctx,
			bundleRoot,
			modelRoutingConfig,
			forgeToolDefs: opts.forgeToolDefs,
			dispatchCounts,
			orderHint: currentWaveIndex,
		};
		return dispatchSingleAgent(
			run.subLabel,
			run.subRole,
			run.modelRole,
			prompt,
			run.schema,
			run.persona,
			dispatchParams,
		);
	};

	// ── INIT_STEPS: the flat step table that supersedes coarse INIT_PHASES ─────
	function buildInitSteps(): Step[] {
		const iso = opts.isoTimestamp;
		// Deterministic postcondition for a subagent step: its own dispatch exited 0.
		const exitOk = async (
			_c: StepRuntimeCtx,
			lastResult?: SubagentResult,
		): Promise<{ ok: boolean; reason?: string }> => ({
			ok: lastResult?.exitCode === 0,
			reason: lastResult && lastResult.exitCode !== 0 ? `subagent exited ${lastResult.exitCode}` : undefined,
		});
		// Deterministic precondition replacing the DELETED Phase-2 gate subagent:
		// verify phase-1 config is ready before kb-doc generation fans out.
		const kbReady = async (c: StepRuntimeCtx): Promise<{ ok: boolean; reason?: string }> => {
			const cc = (c as InitStepState).configCache;
			const ok = !!cc && typeof cc === "object";
			return { ok, reason: ok ? undefined : "phase-1 config not ready (gate)" };
		};

		const steps: Step[] = [];

		// Wave 0 — 5 domain discovery agents (independent fan-out).
		for (const domain of DOMAINS) {
			steps.push({
				id: `discovery:${domain}`,
				dependsOn: [],
				retryPolicy: { maxReruns: 0 },
				requiredOutput: exitOk,
				run: {
					kind: "subagent",
					promptPhase: 1,
					subLabel: `discovery:${domain}`,
					subRole: "plan" as const,
					modelRole: "discovery",
					persona: "engineer",
					phaseGroup: "collect",
					schema: DISCOVERY_SCHEMA,
					buildPrompt: (b) =>
						`${b}\n\n<!-- AGENT PARAMS -->\ndomain: ${domain}\nkbFolder: ${kbFolder}\nisoTimestamp: ${iso}\n`,
				},
			});
		}

		// Wave 1 — config-writer (depends on all domains; retries once).
		steps.push({
			id: "config-writer",
			dependsOn: DOMAINS.map((d) => `discovery:${d}`),
			retryPolicy: { maxReruns: 1 },
			requiredOutput: exitOk,
			run: {
				kind: "subagent",
				promptPhase: 1,
				subLabel: "config-writer",
				subRole: "plan" as const,
				modelRole: "config",
				persona: "engineer",
				phaseGroup: "collect",
				buildPrompt: (b) =>
					`${b}\n\n<!-- AGENT PARAMS -->\nrole: config-writer\nkbFolder: ${kbFolder}\nisoTimestamp: ${iso}\n`,
			},
		});

		// Wave 2 — deterministic: orchestrator-owned KB-folder + prefix enforcement,
		// configCache refresh, coarse phase-1 checkpoint. (Migrated verbatim from the
		// old inlined post-collect hook — the KB folder + prefix are NOT LLM-routed.)
		steps.push({
			id: "enforce-config",
			dependsOn: ["config-writer"],
			retryPolicy: { maxReruns: 0 },
			run: {
				kind: "deterministic",
				thunk: async () => {
					const manageConfigTool = path.join(toolsRoot, "manage-config.cjs");
					if (fs.existsSync(manageConfigTool)) {
						await runToolAdvisory(
							manageConfigTool,
							["set", "paths.engineering", kbFolder],
							cwd,
							ctx,
							"manage-config paths.engineering",
						);
						const projectPrefix = opts.projectPrefix ?? deriveProjectPrefix(projectName);
						await runToolAdvisory(
							manageConfigTool,
							["set", "project.prefix", projectPrefix],
							cwd,
							ctx,
							"manage-config project.prefix",
						);
					}
					try {
						state.configCache = JSON.parse(
							fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8"),
						) as Record<string, unknown>;
					} catch {
						// keep existing cache
					}
					writeInitProgress(cwd, 1);
				},
			},
		});

		// Wave 3 — 10 kb-doc agents (independent fan-out; gate is now a precondition).
		for (const docId of KB_DOC_IDS) {
			steps.push({
				id: `kb-doc:${docId}`,
				dependsOn: ["enforce-config"],
				precondition: kbReady,
				retryPolicy: { maxReruns: 1 },
				requiredOutput: exitOk,
				run: {
					kind: "subagent",
					promptPhase: 2,
					subLabel: `kb-doc:${docId}`,
					subRole: "plan" as const,
					modelRole: "kb-doc",
					persona: "engineer",
					phaseGroup: "discover",
					schema: KB_DOC_SCHEMA,
					buildPrompt: (b) => {
						const fragment = phase2Fragments[docId.slice(docId.lastIndexOf("/") + 1)] ?? "";
						return `${b}\n\n${fragment}\n\n<!-- AGENT PARAMS -->\nrole: kb-doc\ndocId: ${docId}\nkbFolder: ${kbFolder}\nisoTimestamp: ${iso}\n`;
					},
				},
			});
		}

		// Wave 4 — index (depends on all kb-docs).
		steps.push({
			id: "index",
			dependsOn: KB_DOC_IDS.map((d) => `kb-doc:${d}`),
			retryPolicy: { maxReruns: 0 },
			requiredOutput: exitOk,
			run: {
				kind: "subagent",
				promptPhase: 2,
				subLabel: "index",
				subRole: "plan" as const,
				modelRole: "index",
				persona: "engineer",
				phaseGroup: "discover",
				buildPrompt: (b) =>
					`${b}\n\n${phase2Fragments["index"] ?? ""}\n\n<!-- AGENT PARAMS -->\nrole: index\nkbFolder: ${kbFolder}\nisoTimestamp: ${iso}\n`,
			},
		});

		// Wave 5 — context (depends on index; retries once).
		steps.push({
			id: "context",
			dependsOn: ["index"],
			retryPolicy: { maxReruns: 1 },
			requiredOutput: exitOk,
			run: {
				kind: "subagent",
				promptPhase: 2,
				subLabel: "context",
				subRole: "plan" as const,
				modelRole: "context",
				persona: "engineer",
				phaseGroup: "discover",
				buildPrompt: (b) =>
					`${b}\n\n${phase2Fragments["context"] ?? ""}\n\n<!-- AGENT PARAMS -->\nrole: context\nkbFolder: ${kbFolder}\nisoTimestamp: ${iso}\n`,
			},
		});

		// Wave 6 — deterministic: verifyPhase2 + post-verify hooks + coarse phase-2
		// checkpoint. requiredOutput gates on the verify result.
		steps.push({
			id: "verify-discover",
			dependsOn: ["context"],
			retryPolicy: { maxReruns: 0 },
			requiredOutput: async (c) => {
				const s = c as InitStepState;
				return { ok: s.verifyOk, reason: s.verifyReason };
			},
			run: {
				kind: "deterministic",
				thunk: async () => {
					let kbPath = kbFolder;
					try {
						const cachePaths = state.configCache.paths as Record<string, unknown> | undefined;
						if (cachePaths && typeof cachePaths.engineering === "string") {
							kbPath = cachePaths.engineering;
						}
					} catch {
						// use kbFolder default
					}
					const verifyResult = await verifyPhase2(cwd, kbPath);
					if (!verifyResult.ok) {
						state.verifyOk = false;
						state.verifyReason = `Phase 2 verify failed: ${verifyResult.missing.join(", ")}`;
						return;
					}
					state.verifyOk = true;
					await runPhase2PostVerifyHooks(cwd, bundleRoot, toolsRoot, projectName, state.configCache, ctx);
					writeInitProgress(cwd, 2);
				},
			},
		});

		// Wave 7 — deterministic: Phase 3 materialize (scaffold + verify) + checkpoint.
		steps.push({
			id: "materialize",
			dependsOn: ["verify-discover"],
			retryPolicy: { maxReruns: 0 },
			requiredOutput: async (c) => {
				const s = c as InitStepState;
				return {
					ok: s.phase3Ok,
					reason: s.phase3Ok ? undefined : "Phase 3 abort (verify failed or tools missing)",
				};
			},
			run: {
				kind: "deterministic",
				thunk: async () => {
					const phase3Result = await runPhase3(cwd, bundleRoot, toolsRoot, ctx);
					if (phase3Result === "abort") {
						state.phase3Ok = false;
						return;
					}
					state.phase3Ok = true;
					writeInitProgress(cwd, 3);
				},
			},
		});

		// Wave 8 — deterministic: Phase 4 register (internally deletes init-progress).
		steps.push({
			id: "register",
			dependsOn: ["materialize"],
			retryPolicy: { maxReruns: 0 },
			requiredOutput: async (c) => {
				const s = c as InitStepState;
				return { ok: s.phase4Ok, reason: s.phase4Ok ? undefined : "Phase 4 abort" };
			},
			run: {
				kind: "deterministic",
				thunk: async () => {
					const isPiRuntime = opts.isPiRuntime ?? (() => false);
					const getBundledToolsRoot = opts.getBundledToolsRoot ?? (() => toolsRoot);
					const phase4Ctx: Phase4Context = {
						cwd,
						bundleRoot,
						toolsRoot,
						projectName,
						configCache: state.configCache,
						ctx,
						isPiRuntime,
						getBundledToolsRoot,
					};
					const phase4Result = await runPhase4(phase4Ctx);
					if (phase4Result === "abort") {
						state.phase4Ok = false;
						return;
					}
					state.phase4Ok = true;
					state.kbPathFinal = phase4Result.kbPathFinal;
				},
			},
		});

		return steps;
	}

	// ── Drive the waves ────────────────────────────────────────────────────────
	const steps = buildInitSteps();
	const waves = topoSortWaves(steps);
	let lastPhase = startWave === 0 ? 0 : WAVE_PHASE_NUM[startWave - 1] ?? 0;
	const pipelineStartMs = Date.now();

	for (let w = startWave; w < waves.length; w++) {
		currentWaveIndex = w;
		const wave = waves[w];
		const phaseName = WAVE_PHASE_NAME[w];
		const phaseNum = WAVE_PHASE_NUM[w];

		ctx.ui.setStatus?.(STATUS_KEY, `forge:init: wave ${w + 1}/${waves.length} (${phaseName})`);
		ctx.ui.notify(
			`→ init: ${phaseName} · wave ${w + 1}/${waves.length} [${wave.map((s) => s.id).join(", ")}]`,
			"info",
		);

		orchTranscript.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: phaseName,
			phaseIndex: w,
			phaseCount: waves.length,
			attempt: 1,
			workflowFile: `init-${phaseName}`,
			persona: "engineer",
		});

		const waveStartMs = Date.now();

		const outcomes = await runWave(wave, (step) =>
			runStep(step, { ctx: state, dispatchSubagent }),
		);

		// IL10: orchestrator emits ONE phase event per successful subagent step,
		// composed from captured result.{model,provider,usage} + the step's OWN
		// start/end bracket (outcome.startMs/endMs) so each event is distinct and
		// duration is attributed per step, not per wave. Deterministic steps emit
		// nothing (no subagent telemetry to attribute). Subagents never emit.
		const { sprintId } = opts;
		for (let i = 0; i < wave.length; i++) {
			const step = wave[i];
			const outcome = outcomes[i];
			if (step.run.kind !== "subagent" || !outcome.ok || !outcome.result) continue;
			if (!sprintId) {
				ctx.ui.notify(
					`⚠ forge:init — sprintId not provided; skipping phase event emit for ${step.id}`,
					"warning",
				);
				continue;
			}
			const r = outcome.result;
			const phaseEvent = buildInitPhaseEvent(
				step.run.phaseGroup,
				step.id,
				sprintId,
				outcome.startMs,
				outcome.endMs,
				r.model ?? "unknown",
				r.provider ?? "unknown",
				{
					input: r.usage.input,
					output: r.usage.output,
					cacheRead: r.usage.cacheRead,
					cacheWrite: r.usage.cacheWrite,
				},
			);
			const emitResult = emitEvent(storeCli, cwd, sprintId, phaseEvent);
			if (!emitResult.ok) {
				ctx.ui.notify(
					`⚠ forge:init — phase event emit failed for ${step.id}: ${emitResult.stderr.trim()}`,
					"warning",
				);
			}
		}

		// Halt on the first failed step in this wave (declaration order).
		const failedIdx = outcomes.findIndex((o) => !o.ok);
		if (failedIdx >= 0) {
			const failedStep = wave[failedIdx];
			const failure = outcomes[failedIdx].reason ?? `step "${failedStep.id}" failed`;
			ctx.ui.notify(`× forge:init — ${phaseName} step "${failedStep.id}" failed: ${failure}`, "error");
			orchTranscript.record({
				kind: "phase-end",
				ts: new Date().toISOString(),
				phase: phaseName,
				phaseIndex: w,
				attempt: 1,
				verdict: "error",
				elapsedMs: Date.now() - waveStartMs,
			});
			return makeFailResult({ ok: false, lastPhase: phaseNum, failure });
		}

		orchTranscript.record({
			kind: "phase-end",
			ts: new Date().toISOString(),
			phase: phaseName,
			phaseIndex: w,
			attempt: 1,
			verdict: "n/a",
			elapsedMs: Date.now() - waveStartMs,
		});
		const elapsed = Math.floor((Date.now() - waveStartMs) / 1000);
		ctx.ui.notify(`✓ init: ${phaseName} wave ${w + 1}/${waves.length} complete (${elapsed}s)`, "info");

		lastPhase = phaseNum;
	}

	// ── All waves complete — assemble InitReport ───────────────────────────────

	orchTranscript.record({
		kind: "pipeline-end",
		ts: new Date().toISOString(),
		outcome: "complete",
		elapsedMs: Date.now() - pipelineStartMs,
	});

	const finalCache = state.configCache;
	const stack = typeof (finalCache.project as Record<string, unknown> | undefined)?.stack === "string"
		? ((finalCache.project as Record<string, unknown>).stack as string)
		: undefined;

	const skillMatches = Array.isArray(finalCache.installedSkills)
		? (finalCache.installedSkills as string[])
		: undefined;

	// If Phase 4 didn't run (resume at phase 1–3), derive kbPathFinal from configCache.
	let kbPathFinal = state.kbPathFinal;
	if (!kbPathFinal) {
		const p = finalCache.paths as Record<string, unknown> | undefined;
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
