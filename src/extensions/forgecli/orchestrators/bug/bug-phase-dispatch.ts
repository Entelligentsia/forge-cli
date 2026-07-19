// bug-phase-dispatch.ts — per-phase subagent dispatch for the fix-bug pipeline:
// persona load → bug-body compose → debug-log setup → viewport observer attach
// → model resolution → runForgeSubagent (IL10) → post-subagent abort /
// halt-on-failure detection. Extracted VERBATIM from fix-bug.ts's phase loop
// (FORGE-S31 file-size refactor) with no logic changes — the inline
// `return {...}` paths now return `{ kind: "return"; result }`, and the success
// path returns `{ kind: "ok"; ... }` carrying the live locals the loop needs
// (subagent result, finishPhaseNode closure, observer, phaseStart, writeDebug,
// the captured tool_execution_end events, and the debug-log handle/flags so the
// post-triage bugId-capture block can re-initialize the log under the real ID).
//
// IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff here).

import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { AskBroker } from "../../ask-broker.js";
import { CallerContextStore } from "../../audience-gate.js";
import type { MergedConfig } from "../../config/config-layer.js";
import { resolveModelForPhase } from "../../config/model-resolver.js";
import { loadForgePersona, runForgeSubagent, type SubagentResult } from "../../forge-subagent.js";
import { getSubagentTools } from "../../forge-tools.js";
import { getOrchestratorTree } from "../../orchestrator-tree.js";
import type { PhaseRole } from "../../subagent/caller-context.js";
import { attachViewportObserver } from "../../viewport/events.js";

import { buildSummariesBlock, emitIncompletePhaseEvent, type PhaseDescriptor } from "../run-task.js";
import { composeBugBody } from "./bug-body.js";
import type { BugRecord } from "./bug-id.js";
import { writeBugState } from "./bug-state.js";
import type { RunBugPipelineOptions, RunBugPipelineResult } from "./run-bug-types.js";

const STATUS_KEY = "forge:fix-bug";

export interface BugPhaseDispatchParams {
	opts: RunBugPipelineOptions;
	phase: PhaseDescriptor;
	bugId: string;
	cwd: string;
	ctx: ExtensionCommandContext;
	storeCli: string;
	currentPhaseIndex: number;
	iterationCounts: Record<string, number>;
	dispatchCounts: Record<string, number>;
	modelRoutingConfig: MergedConfig;
	registry: RunBugPipelineOptions["registry"];
	/** Whether this is a new bug — only used to decide the triage-prefix body. */
	isNewBug: boolean | undefined;
	originalArg: string | undefined;
	/** Raw sub-workflow markdown already loaded + marker/audience-checked by the caller. */
	subWorkflowMd: string;
	/** Bug record read before this phase (status used for compose + cache key). */
	bugRecordBefore: BugRecord | null;
	bugStatusBeforePhase: string | undefined;
	/** True when bugId is still a PENDING- placeholder (triage of a new bug). */
	pendingBugId: boolean;
}

export type BugPhaseDispatchOutcome =
	| { kind: "return"; result: RunBugPipelineResult }
	| {
			kind: "ok";
			result: SubagentResult;
			finishPhaseNode: (status: "completed" | "failed" | "escalated") => void;
			observer: ReturnType<typeof attachViewportObserver>;
			phaseStart: number;
			writeDebug: (rec: Record<string, unknown>) => void;
			toolExecutionEvents: Array<{ toolName?: string; result?: unknown }>;
			debugLogPath: string | null;
			debugLogDisabled: boolean;
	  };

/**
 * Run a single bug phase's subagent dispatch and classify the immediate outcome
 * (persona-load failure, subagent throw, cancellation, or non-zero exit) into a
 * discriminated result. On success returns `kind: "ok"` with the live locals the
 * caller's loop needs for bugId capture / verdict / advance handling.
 */
export async function dispatchBugPhase(p: BugPhaseDispatchParams): Promise<BugPhaseDispatchOutcome> {
	const {
		opts,
		phase,
		bugId,
		cwd,
		ctx,
		storeCli,
		currentPhaseIndex,
		iterationCounts,
		dispatchCounts,
		modelRoutingConfig,
		registry,
		isNewBug,
		originalArg,
		subWorkflowMd,
		bugRecordBefore,
		bugStatusBeforePhase,
		pendingBugId,
	} = p;

	const tree = getOrchestratorTree();

	// ── Persona load ──────────────────────────────────────────────
	let persona;
	try {
		persona = loadForgePersona(phase.personaNoun, cwd);
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(
			`× forge:fix-bug — persona '${phase.personaNoun}' not found for phase ${phase.role}: ${e.message ?? "unknown"}. ` +
				"Run /forge:regenerate to materialize persona files.",
			"error",
		);
		writeBugState(cwd, {
			bugId,
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
	// NEVER sendKickoff here — that would reproduce issue #30.
	// Carry forward prior phase summaries (forge-cli#19).
	const bugSummariesBlock =
		currentPhaseIndex > 0 ? buildSummariesBlock(bugRecordBefore?.summaries) || undefined : undefined;
	let bugBody = composeBugBody(subWorkflowMd, bugId, phase.role, bugStatusBeforePhase, bugSummariesBlock);

	// For new bugs in triage, prepend the original free-form text so the
	// subagent knows the user-provided bug description to triage.
	// The bug record already exists (pre-created with status "reported"),
	// so the subagent should update it, not create a new one.
	if (phase.role === "triage" && isNewBug && originalArg) {
		bugBody = `Bug description: ${originalArg}\n\n---\n\n${bugBody}`;
	}

	// Phase-scoped progress counters
	const phaseStart = Date.now();

	// Track tool_execution_end events for bugId capture (Findings #1, #2).
	const toolExecutionEvents: Array<{ toolName?: string; result?: unknown }> = [];

	// Stabilization debug log
	// Skip for PENDING bugIds — create after real bugId is captured.
	// Disable entirely with FORGE_DEBUG_LOG=0.
	const debugLogDisabled = process.env.FORGE_DEBUG_LOG === "0";
	let debugLogPath: string | null = null;
	let writeDebug: (rec: Record<string, unknown>) => void = () => {};
	if (!pendingBugId && !debugLogDisabled) {
		debugLogPath = path.join(cwd, ".forge", "cache", `fix-bug-debug-${bugId}.jsonl`);
		writeDebug = (rec: Record<string, unknown>) => {
			try {
				fs.mkdirSync(path.dirname(debugLogPath!), { recursive: true });
				// Cap at 10 MB: truncate head when size exceeds the cap.
				try {
					const st = fs.statSync(debugLogPath!);
					if (st.size > 10 * 1024 * 1024) {
						const all = fs.readFileSync(debugLogPath!, "utf8");
						const lines = all.split("\n");
						// Keep last 80% of lines
						const keep = Math.floor(lines.length * 0.8);
						fs.writeFileSync(debugLogPath!, lines.slice(-keep).join("\n"), "utf8");
					}
				} catch {
					/* file may not exist yet */
				}
				fs.appendFileSync(
					debugLogPath!,
					`${JSON.stringify({ ts: new Date().toISOString(), phase: phase.role, ...rec })}\n`,
					"utf8",
				);
			} catch {
				// non-fatal; debug log is best-effort
			}
		};
	}
	writeDebug({ kind: "phase_start", phaseIndex: currentPhaseIndex });
	registry.startPhase(bugId, phase.role, currentPhaseIndex);

	// Bridge: register phase in OrchestratorTree. Node identity is
	// per-dispatch (see dispatchCounts above) — never reuse an ID for
	// a re-dispatched role.
	const iteration = (dispatchCounts[phase.role] = (dispatchCounts[phase.role] ?? 0) + 1);
	const phaseNodeId = `${bugId}:${phase.role}:${iteration}`;
	tree.startNode(phaseNodeId, {
		parentId: bugId,
		label: `${phase.role}:${iteration}`,
		kind: "leaf",
		// Full body — display clamping/expansion is the view's decision
		// (the tree applies only a storage cap).
		promptPreview: bugBody,
	});

	const refreshStatus = () => {
		if (process.env.FORGE_VERBOSE !== "1") return;
		const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
		const tail = observer.state.lastTool ? ` · ${observer.state.lastTool}` : "";
		ctx.ui.setStatus?.(
			STATUS_KEY,
			`fix-bug ${bugId}: ${phase.role} · t${observer.state.turn} · tools ${observer.state.toolCount}${observer.state.errCount ? ` · err ${observer.state.errCount}` : ""} · ${elapsed}s${tail}`,
		);
	};

	const observer = attachViewportObserver({
		registry,
		sessionId: bugId,
		phaseRole: phase.role,
		nodeId: phaseNodeId,
		beginHeader: `─── phase ${phase.role} begin ───`,
		writeDebug,
		notify: (msg, level) => ctx.ui.notify(msg, level),
		setStatusVerbose: process.env.FORGE_VERBOSE === "1" ? (k, v) => ctx.ui.setStatus?.(k, v) : undefined,
		verboseKeys: { messageKey: `${STATUS_KEY}:message` },
		afterEach: refreshStatus,
	});

	// Wrap the observer's onEvent to also capture tool_execution_end events
	// for bugId capture downstream (findings #1, #2), plus the first turn_end
	// per phase (IL10 visibility — stream-observed model id).
	let modelObservedLogged = false;
	const onSubagentEvent = (event: any) => {
		if (event?.type === "tool_execution_end") {
			toolExecutionEvents.push({ toolName: event.toolName, result: event.result });
		}
		if (!modelObservedLogged && event?.type === "turn_end" && event.message?.model) {
			modelObservedLogged = true;
			writeDebug({
				kind: "model_observed",
				provider: event.message.provider ?? null,
				model: event.message.model,
			});
		}
		observer.onEvent(event);
	};

	// Per-phase model resolution. When config is absent or cascade bottoms
	// out, resolves to inherit (model: undefined) — setModel is skipped and
	// pi's current model is used. IL10 still holds: result.model below is
	// the stream-observed runtime model, not whatever we requested here.
	const modelResolution = resolveModelForPhase("fix-bug", phase.role, phase.personaNoun, modelRoutingConfig);
	writeDebug({
		kind: "requested_model",
		requested: modelResolution.model ?? null,
		source: modelResolution.source,
		persona: phase.personaNoun,
	});

	let result;
	try {
		// FORGE-BUG-040: wrap the runForgeSubagent dispatch in the phase
		// caller context so downstream tool calls (forge_preflight,
		// forge_store update-status / set-bug-summary / set-summary / emit)
		// can verify the caller's phase matches the phase named in the
		// tool's arguments. This is the single setter of phase context
		// for the bug pipeline; the audience-test wrap above is a
		// short-lived test, not the canonical dispatch context.
		result = await CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
			// Bind the orchestrator's TUI so a forge_ask_user call from the
			// (headless) subagent is marshalled back here and rendered. Required:
			// getSubagentTools injects forge_ask_user, so an unbound dispatch would
			// make a subagent ask throw. Refcounted + serialised in AskBroker.
			AskBroker.withUI(ctx.ui, () =>
				runForgeSubagent({
					persona,
					task: bugBody,
					cwd,
					exportTag: `${bugId}__${phase.role}`,
					tailLog: observer.state.tailLog,
					// Sprint-scoped if the bug is attached to one, else bug-scoped.
					// Keeps every phase of this bug-fix pipeline in a single cache
					// namespace so the system-prompt + persona prefix stays warm
					// across the ~10-minute phases.
					cacheSessionId:
						typeof bugRecordBefore?.sprintId === "string"
							? `forge:${bugRecordBefore.sprintId}`
							: `forge:bug:${bugId}`,
					onEvent: onSubagentEvent,
					requestedModel: modelResolution.model,
					modelRegistry: ctx.modelRegistry,
					signal: opts.signal,
					customTools: opts.forgeToolDefs ? getSubagentTools(opts.forgeToolDefs, persona.name) : undefined,
				}),
			),
		);
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(
			`× forge:fix-bug — runForgeSubagent threw for phase ${phase.role}: ${e.message ?? "unknown"}`,
			"error",
		);
		tree.completeNode(phaseNodeId, "failed");
		writeBugState(cwd, {
			bugId,
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
	// loopback, advance). A node left `running` keeps a live spinner
	// in the dashboard forever AND absorbs the next same-role
	// dispatch's telemetry via the observer's legacy role-prefix scan.
	const finishPhaseNode = (status: "completed" | "failed" | "escalated"): void => {
		tree.setNodeUsage(phaseNodeId, {
			input: result.usage.input,
			output: result.usage.output,
			cacheRead: result.usage.cacheRead,
			context: result.usage.contextTokens,
		});
		if (result.model) tree.setNodeModel(phaseNodeId, result.model, result.provider ?? "");
		tree.completeNode(phaseNodeId, status);
	};

	// ── Post-subagent abort detection ─────────────────────────────────
	if (result.stopReason === "aborted" || opts.signal?.aborted) {
		ctx.ui.notify(`⊘ forge:fix-bug — ${bugId} phase ${phase.role} cancelled.`, "info");
		registry.completePhase(bugId, phase.role, "cancelled");
		tree.completeNode(phaseNodeId, "cancelled");
		registry.confirmCancelled(bugId);
		// Bug B parity with run-task: account billed tokens of the aborted attempt.
		// sprintId "bugs" = routing key for bug events (matches success path).
		// The optional `type` token is omitted — verdict carries the outcome.
		emitIncompletePhaseEvent({
			emitCtx: {
				entityType: "bug",
				bugId,
				sprintId: "bugs",
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
		// ADR-S21-01: preserve state file so cancelled runs are resumable
		writeBugState(cwd, {
			bugId,
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
			`× forge:fix-bug — phase ${phase.role} failed (exit ${result.exitCode})` +
				(result.errorMessage ? `: ${result.errorMessage}` : "") +
				(result.stopReason ? ` [${result.stopReason}]` : ""),
			"error",
		);
		finishPhaseNode("failed");
		// Bug B parity with run-task: account billed tokens of the failed attempt.
		emitIncompletePhaseEvent({
			emitCtx: {
				entityType: "bug",
				bugId,
				sprintId: "bugs",
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
		writeBugState(cwd, {
			bugId,
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

	return {
		kind: "ok",
		result,
		finishPhaseNode,
		observer,
		phaseStart,
		writeDebug,
		toolExecutionEvents,
		debugLogPath,
		debugLogDisabled,
	};
}
