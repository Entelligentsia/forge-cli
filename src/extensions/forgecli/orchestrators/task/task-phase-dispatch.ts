// task-phase-dispatch.ts — per-phase subagent dispatch for the run-task
// pipeline: persona load → task-body compose → model resolution → viewport
// observer attach → context-governor injection → runForgeSubagent (IL10) →
// post-subagent abort / halt-on-failure detection. Extracted VERBATIM from
// run-task.ts's phase loop (FORGE-S31 file-size refactor) with no logic
// changes — the inline `return {...}` paths now return `{ kind: "return";
// result }`, and the success path returns `{ kind: "ok"; ... }` carrying the
// live locals the loop needs (subagent result, finishPhaseNode closure,
// observer, phaseStart, writeDebug).
//
// IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff here).

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionCommandContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { AskBroker } from "../../ask-broker.js";
import { CallerContextStore } from "../../audience-gate.js";
import type { PhaseRole } from "../../subagent/caller-context.js";
import type { MergedConfig } from "../../config/config-layer.js";
import { buildGovernorFactory } from "../../context-governor.js";
import { buildForgeCompactionFactory } from "../../context-governor-compaction.js";
import { loadForgePersona, runForgeSubagent, type SubagentResult } from "../../forge-subagent.js";
import { getSubagentTools } from "../../forge-tools.js";
import { resolveModelForPhase } from "../../config/model-resolver.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";
import { attachViewportObserver } from "../../viewport/events.js";

import { composeTaskBody, buildSummariesBlock } from "./task-body.js";
import { emitIncompletePhaseEvent } from "./task-events.js";
import { PHASES, type PhaseDescriptor } from "./task-phases.js";
import { readTaskRecord, type TaskRecord } from "./task-record.js";
import { writeState } from "./task-state.js";
import type { RunTaskPipelineOptions, RunTaskPipelineResult } from "./run-task-types.js";

const STATUS_KEY = "forge:run-task";
const MESSAGE_KEY = "forge:run-task:message";

export interface PhaseDispatchParams {
	opts: RunTaskPipelineOptions;
	phase: PhaseDescriptor;
	taskId: string;
	cwd: string;
	ctx: ExtensionCommandContext;
	storeCli: string;
	currentPhaseIndex: number;
	iterationCounts: Record<string, number>;
	dispatchCounts: Record<string, number>;
	modelRoutingConfig: MergedConfig;
	registry: RunTaskPipelineOptions["registry"];
	cacheSessionId: string;
	taskRecordAtStart: TaskRecord | null;
	/** Raw sub-workflow markdown already loaded + marker-checked by the caller. */
	subWorkflowMd: string;
}

export type PhaseDispatchOutcome =
	| { kind: "return"; result: RunTaskPipelineResult }
	| {
			kind: "ok";
			result: SubagentResult;
			finishPhaseNode: (status: "completed" | "failed" | "escalated") => void;
			observer: ReturnType<typeof attachViewportObserver>;
			phaseStart: number;
			writeDebug: (rec: Record<string, unknown>) => void;
	  };

/**
 * Run a single phase's subagent dispatch and classify the immediate outcome
 * (persona-load failure, subagent throw, cancellation, or non-zero exit) into
 * a discriminated result. On success returns `kind: "ok"` with the live locals
 * the caller's loop needs for verdict/postflight handling and advance.
 */
export async function dispatchPhase(p: PhaseDispatchParams): Promise<PhaseDispatchOutcome> {
	const {
		opts,
		phase,
		taskId,
		cwd,
		ctx,
		storeCli,
		currentPhaseIndex,
		iterationCounts,
		dispatchCounts,
		modelRoutingConfig,
		registry,
		cacheSessionId,
		taskRecordAtStart,
	} = p;

	const tree = getOrchestratorTree();

	// ── Persona load ──────────────────────────────────────────────
	let persona;
	try {
		persona = loadForgePersona(phase.personaNoun, cwd);
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(
			`× forge:run-task — persona '${phase.personaNoun}' not found for phase ${phase.role}: ${e.message ?? "unknown"}. ` +
				"Run /forge:regenerate to materialize persona files.",
			"error",
		);
		writeState(cwd, {
			taskId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: true,
			lastError: `persona load failed: ${e.message ?? "unknown"}`,
			savedAt: new Date().toISOString(),
		});
		return {
			kind: "return",
			result: {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `persona load failed: ${e.message ?? "unknown"}`,
			},
		};
	}

	// ── 4. Dispatch via runForgeSubagent (IL10) ───────────────────
	// NEVER sendKickoff here — that would reproduce issue #30 (same-context inline = no fork).
	// Read fresh task record to carry forward prior phase summaries (forge-cli#19).
	const taskRecordForSummaries = currentPhaseIndex > 0 ? readTaskRecord(taskId, storeCli, cwd) : null;
	const summariesBlock = buildSummariesBlock(taskRecordForSummaries?.summaries);
	const taskBody = composeTaskBody(p.subWorkflowMd, taskId, summariesBlock || undefined);

	// Log whether carry-forward summaries were injected (forge-cli#19).
	if (summariesBlock) {
		const debugCarryPath = path.join(cwd, ".forge", "cache", `run-task-debug-${taskId}.jsonl`);
		try {
			fs.mkdirSync(path.dirname(debugCarryPath), { recursive: true });
			fs.appendFileSync(
				debugCarryPath,
				`${JSON.stringify({ ts: new Date().toISOString(), phase: phase.role, kind: "carry_forward_injected", summariesLength: summariesBlock.length, summariesBlock })}\n`,
				"utf8",
			);
		} catch {
			/* best-effort debug log */
		}
	}

	// Resolve per-phase model from layered config (Plan 16 Slice 2).
	// Pipeline name "default" matches the Forge plugin's shipped pipeline.
	// When config is absent or cascade bottoms out, resolves to inherit
	// (model: undefined) — setModel is skipped and pi's current model is used.
	const modelResolution = resolveModelForPhase("default", phase.role, phase.personaNoun, modelRoutingConfig);
	const dispatchModelLabel = modelResolution.model
		? `${modelResolution.model.provider}:${modelResolution.model.model}`
		: "inherit";
	ctx.ui.notify(
		`  dispatch: persona=${phase.personaNoun} · model=${dispatchModelLabel} [${modelResolution.source}]`,
		"info",
	);

	const phaseStart = Date.now();

	// Stabilization debug log — every subagent event appended as JSONL.
	const debugLogPath = path.join(cwd, ".forge", "cache", `run-task-debug-${taskId}.jsonl`);
	const writeDebug = (rec: Record<string, unknown>) => {
		try {
			fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
			fs.appendFileSync(
				debugLogPath,
				`${JSON.stringify({ ts: new Date().toISOString(), phase: phase.role, ...rec })}\n`,
				"utf8",
			);
		} catch {
			// non-fatal; debug log is best-effort
		}
	};
	writeDebug({ kind: "phase_start", phaseIndex: currentPhaseIndex });
	writeDebug({
		kind: "requested_model",
		requested: modelResolution.model ?? null,
		source: modelResolution.source,
		persona: phase.personaNoun,
	});
	registry.startPhase(taskId, phase.role, currentPhaseIndex);

	// Bridge: register phase in OrchestratorTree. Node identity is
	// per-dispatch (see dispatchCounts above) — never reuse an ID for a
	// re-dispatched role.
	const iteration = (dispatchCounts[phase.role] = (dispatchCounts[phase.role] ?? 0) + 1);
	const phaseNodeId = `${taskId}:${phase.role}:${iteration}`;
	tree.startNode(phaseNodeId, {
		parentId: taskId,
		label: `${phase.role}:${iteration}`,
		kind: "leaf",
		// Full body — display clamping/expansion is the view's decision
		// (the tree applies only a storage cap).
		promptPreview: taskBody,
	});

	// Capture the first stream-observed model on turn_end (IL10 visibility).
	// If pi auto-substitutes or setModel silently no-ops, this line will diverge
	// from requested_model — exactly the diagnostic signal we want.
	let modelObservedLogged = false;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const wrappedOnEvent = (event: any) => {
		if (!modelObservedLogged && event?.type === "turn_end" && typeof event?.message?.model === "string") {
			modelObservedLogged = true;
			writeDebug({
				kind: "model_observed",
				provider: event.message.provider ?? null,
				model: event.message.model,
			});
		}
		observer.onEvent(event);
	};

	const refreshStatus = () => {
		if (process.env.FORGE_VERBOSE !== "1") return;
		const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
		const tail = observer.state.lastTool ? ` · ${observer.state.lastTool}` : "";
		ctx.ui.setStatus?.(
			STATUS_KEY,
			`run-task ${taskId}: ${phase.role} · t${observer.state.turn} · tools ${observer.state.toolCount}${observer.state.errCount ? ` · err ${observer.state.errCount}` : ""} · ${elapsed}s${tail}`,
		);
	};

	const observer = attachViewportObserver({
		registry,
		sessionId: taskId,
		phaseRole: phase.role,
		nodeId: phaseNodeId,
		beginHeader: `─── phase ${currentPhaseIndex + 1}/${PHASES.length} ${phase.role} begin · ${taskId} ───`,
		writeDebug,
		notify: (msg, level) => ctx.ui.notify(msg, level),
		setStatusVerbose: process.env.FORGE_VERBOSE === "1" ? (k, v) => ctx.ui.setStatus?.(k, v) : undefined,
		verboseKeys: { messageKey: MESSAGE_KEY },
		afterEach: refreshStatus,
	});

	// ── Context governor injection (completes FORGE-S30-T07) ──────
	// Per-phase factories built HERE because only the pipeline knows the
	// `${personaNoun}/${role}` phase key — pi never sets persona/phase on
	// ExtensionContext, and the parent session's registerHookDispatcher
	// governor never sees subagent tool traffic (dormant-governor defect,
	// CART-S02-T03 benchmark). Flag-gated: FORGE_CTX_GOVERNOR=1.
	//   buildGovernorFactory        — Mechanisms A/B/C/D in the subagent
	//   buildForgeCompactionFactory — Mechanism E with warm-tier path opts
	//     (previously injected from index.ts with NO opts → warm-tier dead)
	const phaseKey = `${phase.personaNoun}/${phase.role}`;
	// Sprint ID from the task record's sprint FK (the store owns that
	// relationship); the taskId-shape regex is only a fallback for records
	// missing the FK (FORGE-BUG-043 PR 2).
	const sprintIdForSummaries = taskRecordAtStart?.sprintId ?? /^(.*)-T\d+$/.exec(taskId)?.[1];
	const governorFactories: ExtensionFactory[] =
		process.env.FORGE_CTX_GOVERNOR === "1"
			? [
					buildGovernorFactory({ phaseKey, cwd }),
					buildForgeCompactionFactory({
						cwd,
						phaseKey,
						entityId: taskId,
						sprintId: sprintIdForSummaries,
					}),
				]
			: [];
	const phaseExtensionFactories = [...(opts.extensionFactories ?? []), ...governorFactories];

	let result;
	try {
		// FORGE-BUG-040: wrap the runForgeSubagent dispatch in the phase
		// caller context (parity with fix-bug.ts) so the phase-ownership
		// guard can verify tool calls from the subagent. Single setter
		// of phase context for the task pipeline.
		result = await CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
			// Bind the orchestrator's live TUI so a forge_ask_user call from inside
			// the (headless) subagent session is marshalled back to this UI and
			// rendered for the human, instead of silently defaulting. Refcounted +
			// serialised in AskBroker, so it is safe even under parallel dispatch.
			AskBroker.withUI(ctx.ui, () =>
				runForgeSubagent({
					persona,
					task: taskBody,
					cwd,
					exportTag: `${taskId}__${phase.role}`,
					tailLog: observer.state.tailLog,
					cacheSessionId,
					streamFn: opts.streamFnFactory?.({
						kind: "task-phase",
						persona: persona.name,
						phase: phase.role,
						taskId,
					}),
					onEvent: wrappedOnEvent,
					requestedModel: modelResolution.model,
					modelRegistry: ctx.modelRegistry,
					signal: opts.signal,
					customTools: opts.forgeToolDefs ? getSubagentTools(opts.forgeToolDefs, persona.name) : undefined,
					extensionFactories: phaseExtensionFactories.length > 0 ? phaseExtensionFactories : undefined,
				}),
			),
		);
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(
			`× forge:run-task — runForgeSubagent threw for phase ${phase.role}: ${e.message ?? "unknown"}`,
			"error",
		);
		tree.completeNode(phaseNodeId, "failed");
		writeState(cwd, {
			taskId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: true,
			lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}`,
			savedAt: new Date().toISOString(),
		});
		return {
			kind: "return",
			result: {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}`,
			},
		};
	}

	// Close this dispatch's tree node with final usage/model — MUST be
	// called on every exit path below (failure, halt, escalation,
	// loopback, advance). A node left `running` keeps a live spinner in
	// the dashboard forever AND absorbs the next same-role dispatch's
	// telemetry via the observer's legacy role-prefix scan.
	const finishPhaseNode = (status: "completed" | "failed" | "escalated"): void => {
		tree.setNodeUsage(phaseNodeId, {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead,
		});
		if (result.model) tree.setNodeModel(phaseNodeId, result.model, result.provider ?? "");
		tree.completeNode(phaseNodeId, status);
	};

	// ── Post-subagent abort detection ─────────────────────────────────
	// If the abort signal fired during the subagent run, treat it as
	// cancellation regardless of the exit code (subagent may have been
	// mid-turn when aborted — exitCode could be 0 or 1).
	// This check MUST come before halt-on-failure so that
	// stopReason="aborted" + exitCode=1 is classified as cancellation,
	// not a phase failure.
	if (result.stopReason === "aborted" || opts.signal?.aborted) {
		ctx.ui.notify(`⊘ forge:run-task — ${taskId} phase ${phase.role} cancelled.`, "info");
		registry.completePhase(taskId, phase.role, "cancelled");
		tree.completeNode(phaseNodeId, "cancelled");
		registry.confirmCancelled(taskId);
		// Bug B: account the billed tokens of this aborted attempt before returning.
		{
			const abortSprintId = readTaskRecord(taskId, storeCli, cwd)?.sprintId;
			if (abortSprintId) {
				emitIncompletePhaseEvent({
					emitCtx: {
						entityType: "task",
						taskId,
						sprintId: abortSprintId,
						phase,
						iteration: (iterationCounts[phase.role] ?? 0) + 1,
						startMs: phaseStart,
						endMs: Date.now(),
						model: result.model ?? "unknown",
						provider: result.provider ?? "unknown",
						usage: {
							input: result.usage.input,
							output: result.usage.output,
							cacheRead: result.usage.cacheRead,
							cacheWrite: result.usage.cacheWrite,
						},
						judgement: undefined,
						storeCli,
						cwd,
					},
					outcome: "aborted",
					notes: result.errorMessage ?? result.stopReason ?? undefined,
					onDebug: writeDebug,
				});
			} else {
				writeDebug({ kind: "incomplete_emit_skipped", reason: "no-sprintId", outcome: "aborted" });
			}
		}
		// ADR-S21-01: preserve state file so cancelled runs are resumable
		writeState(cwd, {
			taskId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: false,
			status: "cancelled",
			lastError: undefined,
			savedAt: new Date().toISOString(),
		});
		return {
			kind: "return",
			result: { status: "cancelled", lastPhaseIndex: currentPhaseIndex, iterationCounts },
		};
	}

	// ── Halt-on-failure ───────────────────────────────────────────
	if (result.exitCode !== 0) {
		ctx.ui.notify(
			`× forge:run-task — phase ${phase.role} failed (exit ${result.exitCode})` +
				(result.errorMessage ? `: ${result.errorMessage}` : "") +
				(result.stopReason ? ` [${result.stopReason}]` : ""),
			"error",
		);
		finishPhaseNode("failed");
		// Bug B: account the billed tokens of this failed attempt before returning.
		{
			const failSprintId = readTaskRecord(taskId, storeCli, cwd)?.sprintId;
			if (failSprintId) {
				emitIncompletePhaseEvent({
					emitCtx: {
						entityType: "task",
						taskId,
						sprintId: failSprintId,
						phase,
						iteration: (iterationCounts[phase.role] ?? 0) + 1,
						startMs: phaseStart,
						endMs: Date.now(),
						model: result.model ?? "unknown",
						provider: result.provider ?? "unknown",
						usage: {
							input: result.usage.input,
							output: result.usage.output,
							cacheRead: result.usage.cacheRead,
							cacheWrite: result.usage.cacheWrite,
						},
						judgement: undefined,
						storeCli,
						cwd,
					},
					outcome: "failed",
					notes: result.errorMessage ?? result.stopReason ?? undefined,
					onDebug: writeDebug,
				});
			} else {
				writeDebug({ kind: "incomplete_emit_skipped", reason: "no-sprintId", outcome: "failed" });
			}
		}
		writeState(cwd, {
			taskId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: true,
			lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
			savedAt: new Date().toISOString(),
		});
		return {
			kind: "return",
			result: {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
			},
		};
	}

	return { kind: "ok", result, finishPhaseNode, observer, phaseStart, writeDebug };
}
