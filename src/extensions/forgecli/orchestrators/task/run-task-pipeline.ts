// run-task-pipeline.ts — the per-task orchestrator pipeline (runTaskPipeline
// thin wrapper + runTaskPipelineInner phase loop). Extracted VERBATIM from
// run-task.ts (FORGE-S31 file-size refactor); the only logic-neutral change is
// that the review-phase verdict block is delegated to handleReviewVerdict in
// task-verdict-loop.ts and the loop switches on its discriminated result.
//
// Iron Laws enforced here:
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff calls here)
//
// sendKickoff is NEVER called from this file.

import * as fs from "node:fs";
import * as path from "node:path";

import { assertAudience, CallerContextStore } from "../../audience-gate.js";
import type { MergedConfig } from "../../config/config-layer.js";
import { checkMaterialization } from "../../lib/manifest-checker.js";
import { type AudienceValue, loadWorkflow } from "../../parsers/workflow-loader.js";
import { runRefreshKbLinks } from "../../refresh-kb-links.js";
import type { PhaseRole } from "../../subagent/caller-context.js";
import { fmtPhaseSummary } from "../../viewport/renderer.js";
import { runPipelinePreflight } from "../common/orchestrator-entry.js";
import { createOrchestratorNotifier } from "../common/orchestrator-notify.js";
import {
	type OrchestratorTranscriptSession,
	withOrchestratorTranscript,
} from "../common/orchestrator-transcript-session.js";
import { recoverPhaseSummary } from "../common/summary-recovery.js";
import { resolveAdvisorModel, runHaltAdvisor } from "../halt-advisor.js";
import type { RunTaskPipelineOptions, RunTaskPipelineResult } from "./run-task-types.js";
import {
	buildPhaseEvent,
	drainFrictionFile,
	emitEvent,
	judgementFromSummary,
	type OrchestratorEmitContext,
} from "./task-events.js";
import { runPostflightGate, runPreflightGateWithData } from "./task-gates.js";
import { dispatchPhase } from "./task-phase-dispatch.js";
import { PHASES, SUMMARY_KEY_BY_ROLE } from "./task-phases.js";
import { readTaskRecord } from "./task-record.js";
import { deleteState, writeState } from "./task-state.js";
import { handleReviewVerdict } from "./task-verdict-loop.js";

const STATUS_KEY = "forge:run-task";
const MESSAGE_KEY = "forge:run-task:message";

// ── runTaskPipeline ──────────────────────────────────────────────────────

export async function runTaskPipeline(opts: RunTaskPipelineOptions): Promise<RunTaskPipelineResult> {
	// Entry preflight (layered-config schema + model-config validation) runs
	// BEFORE the transcript writer is created, so a failed preflight never
	// leaves a transcript file behind.
	const notify = createOrchestratorNotifier(opts.ctx, {
		label: "forge:run-task",
		statusKey: STATUS_KEY,
		messageKey: MESSAGE_KEY,
	});
	const pre = runPipelinePreflight({ cwd: opts.cwd, ctx: opts.ctx, notify });
	if (!pre.proceed) {
		return { status: "failed", lastPhaseIndex: 0, iterationCounts: {}, lastError: pre.lastError };
	}

	// The transcript session owns ctx.ui.notify interception and the guaranteed
	// pipeline-end close on every outcome (see orchestrator-transcript-session).
	return withOrchestratorTranscript(
		{ cwd: opts.cwd, entityKind: "task", entityId: opts.taskId, ctx: opts.ctx },
		(session) => runTaskPipelineInner(opts, pre.modelRoutingConfig, session),
	);
}

async function runTaskPipelineInner(
	opts: RunTaskPipelineOptions,
	modelRoutingConfig: MergedConfig,
	session: OrchestratorTranscriptSession,
): Promise<RunTaskPipelineResult> {
	const { taskId, cwd, ctx, forgeRoot, storeCli, preflightGate, registry, resumeFromState, onPhaseEvent } = opts;

	// modelRoutingConfig is loaded and validated by runPipelinePreflight (in
	// runTaskPipeline) before the transcript writer exists, then passed in.

	// Determine starting phase from resumeFromState (if provided) or phase 0.
	let currentPhaseIndex = resumeFromState?.phaseIndex ?? 0;
	const iterationCounts: Record<string, number> = resumeFromState?.iterationCounts ?? {};

	// Per-phase completion-recovery guard (forge-engineering#41): each role gets
	// at most one deterministic set-summary recovery attempt before a
	// missing-summary hard-fail. Prevents recovery loops.
	const recoveredPhases = new Set<string>();

	// Per-role dispatch counter for OrchestratorTree node identity. Distinct
	// from iterationCounts (which only tracks review-verdict revisions): every
	// dispatch of a role — including a plan re-run after a review loopback —
	// gets its own `<taskId>:<role>:<attempt>` node, so the dashboard renders
	// one leaf per run in dispatch order instead of merging attempts into one
	// node (CART-BUG-003 dashboard regression). Seeded from resume state so
	// resumed runs continue numbering past prior attempts.
	const dispatchCounts: Record<string, number> = { ...(resumeFromState?.iterationCounts ?? {}) };

	// Track model/provider from last successful subagent result (REVIEW FIX #1).
	let lastModel: string | undefined;
	let lastProvider: string | undefined;

	// Resolve the task's sprintId once for prompt-cache session affinity. All
	// phases in this task share the cache key `forge:${sprintId}` so the
	// system-prompt + project orientation prefix (which is identical across
	// personas) stays warm on Anthropic and shares a stable prompt_cache_key
	// on OpenAI. Falls back to a task-scoped key if the task is unattached.
	const taskRecordAtStart = readTaskRecord(taskId, storeCli, cwd);
	const cacheSessionId = taskRecordAtStart?.sprintId ? `forge:${taskRecordAtStart.sprintId}` : `forge:task:${taskId}`;

	// Orchestrator transcript writer — created and notify-intercepted by
	// withOrchestratorTranscript; the loop records structured phase-boundary
	// events through it (FORGE-BUG-040 follow-up: one JSONL file per run).
	const orchTranscript = session.writer;
	const pipelineStartMs = Date.now();

	while (currentPhaseIndex < PHASES.length) {
		// ── Between-phase cancellation gate ────────────────────────────
		if (opts.signal?.aborted) {
			ctx.ui.notify(`⊘ forge:run-task — ${taskId} cancelled by user.`, "info");
			registry.completePhase(taskId, PHASES[currentPhaseIndex]?.role ?? "unknown", "cancelled");
			registry.confirmCancelled(taskId);
			// ADR-S21-01: preserve state file so cancelled runs are resumable
			// from the beginning of the cancelled phase (not deleted).
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: false,
				status: "cancelled",
				lastError: undefined,
				savedAt: new Date().toISOString(),
			});
			return { status: "cancelled", lastPhaseIndex: currentPhaseIndex, iterationCounts };
		}

		const phase = PHASES[currentPhaseIndex];
		if (!phase) {
			ctx.ui.notify(`× forge:run-task — invalid phase index ${currentPhaseIndex}`, "error");
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `invalid phase index ${currentPhaseIndex}`,
			};
		}

		ctx.ui.setStatus?.(
			STATUS_KEY,
			`run-task ${taskId}: phase ${currentPhaseIndex + 1}/${PHASES.length} (${phase.role})`,
		);
		ctx.ui.notify(`→ ${taskId}: ${phase.role} (phase ${currentPhaseIndex + 1}/${PHASES.length})`, "info");
		orchTranscript.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: phase.role,
			phaseIndex: currentPhaseIndex,
			phaseCount: PHASES.length,
			attempt: (iterationCounts[phase.role] ?? 0) + 1,
			workflowFile: phase.workflowFile,
			persona: phase.personaNoun,
		});

		const subWorkflowPath = path.join(cwd, ".forge", "workflows", `${phase.workflowFile}.md`);

		// ── Read sub-workflow ─────────────────────────────────────────
		let subWorkflowMd: string;
		let subWorkflowAudience: AudienceValue = "any";
		try {
			const loaded = loadWorkflow(subWorkflowPath);
			subWorkflowMd = loaded.rawMarkdown;
			subWorkflowAudience = loaded.audience;
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× forge:run-task — failed to read sub-workflow for ${phase.role}: ${e.message ?? "unknown"}`,
				"error",
			);
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `sub-workflow read failed: ${e.message ?? "unknown"}`,
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `sub-workflow read failed: ${e.message ?? "unknown"}`,
			};
		}

		// ── 6a. Preflight gate ────────────────────────────────────────
		if (fs.existsSync(preflightGate)) {
			const preflightOutcome = runPreflightGateWithData(preflightGate, phase.role, taskId, cwd);
			if (preflightOutcome.result === "halt") {
				// Render structured failure reason if available.
				if (preflightOutcome.gateFailure) {
					ctx.ui.notify(
						`× forge:run-task — preflight gate failed for phase ${phase.role} ` +
							`[${preflightOutcome.gateFailure.reasonCode}]: ${preflightOutcome.gateFailure.detail}`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:run-task — preflight gate failed for phase ${phase.role} (exit 1); halting.`,
						"error",
					);
				}
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 1 for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				// Spawn halt-recovery advisor (Tier 1, best-effort — non-fatal).
				if (preflightOutcome.gateFailure) {
					const advisorModel = resolveAdvisorModel(modelRoutingConfig, ctx.model as any);
					await runHaltAdvisor({
						gateFailure: preflightOutcome.gateFailure,
						advisorModel,
						taskId,
						cwd,
						ctx: { ui: ctx.ui as any },
						forgeRoot,
					});
				}
				return {
					status: "halted",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `preflight gate exit 1 for ${phase.role}`,
				};
			}
			if (preflightOutcome.result === "escalate") {
				ctx.ui.notify(
					`× forge:run-task — preflight gate escalated for phase ${phase.role} (exit 2); manual intervention required.`,
					"error",
				);
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 2 (escalate) for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				return {
					status: "escalated",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `preflight gate exit 2 (escalate) for ${phase.role}`,
				};
			}
			// Preflight passed — notify (mirrored to the root node's dashboard log).
			ctx.ui.notify(`〇 preflight: ${phase.role} — ok`, "info");
		}

		// ── 6. Materialization-marker check ───────────────────────────
		const markerCheck = checkMaterialization(subWorkflowPath, subWorkflowMd);
		if (!markerCheck.ok) {
			for (const marker of markerCheck.missing) {
				ctx.ui.notify(`× workflow regression: ${marker} not found in ${subWorkflowPath}`, "error");
			}
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `materialization markers missing: ${markerCheck.missing.join(", ")}`,
			};
		}

		// ── 5. Audience check ─────────────────────────────────────────
		// Wrap with CallerContextStore.asSubagent so assertAudience treats
		// this as a subagent context (IL10: we ARE dispatching from subagent chain).
		const audienceOk = CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
			assertAudience({ workflowName: phase.workflowFile, audience: subWorkflowAudience }, ctx),
		);
		if (!audienceOk) {
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `audience check failed for ${phase.workflowFile}`,
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `audience check failed for ${phase.workflowFile}`,
			};
		}

		// ── Dispatch (persona load + runForgeSubagent + observer + abort/halt) ──
		// Extracted to task-phase-dispatch.ts (FORGE-S31). Returns either a
		// terminal result (persona-load failure / throw / cancel / non-zero exit)
		// or the live locals the rest of the loop needs.
		const dispatch = await dispatchPhase({
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
			subWorkflowMd,
		});
		if (dispatch.kind === "return") return dispatch.result;
		const { result, finishPhaseNode, observer, phaseStart, writeDebug } = dispatch;

		// Capture model/provider from subagent result (REVIEW FIX #1).
		if (result.model) lastModel = result.model;
		if (result.provider) lastProvider = result.provider;

		// Phase-complete liveliness ping (counts + duration).
		{
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			const { turn, toolCount, errCount, cumUsage } = observer.state;
			ctx.ui.notify(
				`✓ ${phase.role}: ${turn} turn${turn === 1 ? "" : "s"} · ${toolCount} tool call${toolCount === 1 ? "" : "s"}${errCount ? ` · ${errCount} err` : ""} · ${elapsed}s`,
				"info",
			);
			orchTranscript.record({
				kind: "phase-end",
				ts: new Date().toISOString(),
				phase: phase.role,
				phaseIndex: currentPhaseIndex,
				attempt: (iterationCounts[phase.role] ?? 0) + 1,
				verdict: "n/a",
				elapsedMs: Date.now() - phaseStart,
				turns: turn,
				toolCount,
				errCount,
				subagentTranscriptPath: result.subagentTranscriptPath,
			});
			const { cumCompression } = observer.state;
			registry.appendTail(
				taskId,
				phase.role,
				fmtPhaseSummary({
					role: phase.role,
					turns: turn,
					tools: toolCount,
					errors: errCount,
					wallSeconds: elapsed,
					usage: cumUsage,
					model: result.model,
					provider: result.provider,
					compression: cumCompression.tokensSaved > 0 ? cumCompression : undefined,
				}),
			);
		}

		// ── Plan 11 / Slice 2: orchestrator emits phase event ─────────
		const phaseEndMs = Date.now();
		const taskRecord = readTaskRecord(taskId, storeCli, cwd);
		const sprintId = taskRecord?.sprintId;
		if (!sprintId) {
			ctx.ui.notify(
				`⚠ forge:run-task — could not resolve sprintId for ${taskId}; ` +
					`skipping orchestrator emit for phase ${phase.role}`,
				"warning",
			);
			writeDebug({ kind: "emit_skipped", reason: "no-sprintId" });
		} else {
			const phaseIteration = (iterationCounts[phase.role] ?? 0) + 1;
			const emitCtx: OrchestratorEmitContext = {
				entityType: "task",
				taskId,
				sprintId,
				phase,
				iteration: phaseIteration,
				startMs: phaseStart,
				endMs: phaseEndMs,
				model: result.model ?? "unknown",
				provider: result.provider ?? "unknown",
				usage: {
					input: result.usage.input,
					output: result.usage.output,
					cacheRead: result.usage.cacheRead,
					cacheWrite: result.usage.cacheWrite,
				},
				judgement: judgementFromSummary(taskRecord, phase.role),
				storeCli,
				cwd,
			};
			const phaseEvent = buildPhaseEvent(emitCtx);
			const emitResult = emitEvent(storeCli, cwd, sprintId, phaseEvent);
			if (!emitResult.ok) {
				ctx.ui.notify(
					`⚠ forge:run-task — phase event emit failed for ${phase.role}: ${emitResult.stderr.trim()}`,
					"warning",
				);
				writeDebug({ kind: "emit_failed", stderr: emitResult.stderr });
			} else {
				writeDebug({ kind: "emit_ok", eventId: phaseEvent.eventId });
			}

			// Notify sprint-level observer (FORGE-S21-T03).
			if (onPhaseEvent) onPhaseEvent(phaseEvent);

			// Drain friction file for this phase, if any.
			const frictionPath = path.join(cwd, ".forge", "cache", `FRICTION-${phase.role}.jsonl`);
			const drain = drainFrictionFile(frictionPath, emitCtx);
			if (drain.emitted + drain.failed > 0) {
				writeDebug({ kind: "friction_drain", ...drain });
				if (drain.failed > 0) {
					ctx.ui.notify(
						`⚠ forge:run-task — friction drain for ${phase.role}: ${drain.emitted} ok, ${drain.failed} failed`,
						"warning",
					);
				}
			}
		}

		// ── 6b. Verdict check (review phases only) ────────────────────
		if (phase.isReview) {
			const outcome = await handleReviewVerdict({
				phase,
				taskId,
				storeCli,
				cwd,
				forgeRoot,
				iterationCounts,
				currentPhaseIndex,
				modelRoutingConfig,
				ctx,
				orchTranscript,
				finishPhaseNode,
				recoveredPhases,
				phaseStartMs: phaseStart,
			});
			if (outcome.kind === "return") return outcome.result;
			if (outcome.kind === "loopback") {
				currentPhaseIndex = outcome.toIndex;
				continue;
			}
			// outcome.kind === "advance": fall through to postflight + advance
		}

		// Postflight gate: evaluate `outputs` block after subagent returns,
		// before FSM status advance (FORGE-S26-T19). Hard enforcement in forge-cli;
		// plugin LLM route treats postflight as advisory. On UNSATISFIED: do not
		// advance currentPhaseIndex, halt, hand off to existing runHaltAdvisor.
		{
			const postflightGatePath = preflightGate.replace("preflight-gate.cjs", "postflight-gate.cjs");
			let postflightOutcome = runPostflightGate(postflightGatePath, phase.role, taskId, cwd);

			// Completion recovery (forge-engineering#41): a clean stop with an
			// unsatisfied postflight is most often the subagent writing the
			// {PHASE}-SUMMARY.json sidecar but eliding the set-summary that
			// registers it. Register the sidecar ourselves (once per phase), then
			// re-run the gate. Only the existing hard-fail remains if it's still
			// unsatisfied (sidecar genuinely absent → set-summary exits non-zero).
			if (postflightOutcome.result === "unsatisfied") {
				const summaryKey = SUMMARY_KEY_BY_ROLE[phase.role];
				if (summaryKey && !recoveredPhases.has(phase.role)) {
					recoveredPhases.add(phase.role);
					const rec = recoverPhaseSummary({ storeCli, entityId: taskId, summaryKey, cwd });
					writeDebug({ kind: "summary_recovery", phase: phase.role, gate: "postflight", ok: rec.ok });
					if (rec.ok) {
						const recheck = runPostflightGate(postflightGatePath, phase.role, taskId, cwd);
						if (recheck.result !== "unsatisfied") {
							ctx.ui.notify(
								`⟳ forge:run-task — ${phase.role}: subagent skipped set-summary; orchestrator registered ` +
									`the '${summaryKey}' sidecar and postflight now passes.`,
								"info",
							);
						}
						postflightOutcome = recheck;
					}
				}
			}

			if (postflightOutcome.result === "unsatisfied") {
				finishPhaseNode("failed");
				if (postflightOutcome.gateFailure) {
					ctx.ui.notify(
						`× forge:run-task — postflight gate failed for phase ${phase.role} ` +
							`[${postflightOutcome.gateFailure.reasonCode}]: ${postflightOutcome.gateFailure.detail}`,
						"error",
					);
				} else {
					ctx.ui.notify(`× forge:run-task — postflight gate failed for phase ${phase.role}; halting.`, "error");
				}
				// Do NOT advance FSM — write state at current phaseIndex (halted)
				writeState(cwd, {
					taskId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `postflight gate exit 1 for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				// Spawn halt-recovery advisor (Tier 1, best-effort — non-fatal).
				if (postflightOutcome.gateFailure) {
					const advisorModel = resolveAdvisorModel(modelRoutingConfig, ctx.model as any);
					await runHaltAdvisor({
						gateFailure: postflightOutcome.gateFailure,
						advisorModel,
						taskId,
						cwd,
						ctx: { ui: ctx.ui as any },
						forgeRoot,
					});
				}
				return {
					status: "halted",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `postflight gate exit 1 for ${phase.role}`,
				};
			}
			// "ok" or "error" — proceed to advance
			if (postflightOutcome.result === "ok") {
				ctx.ui.notify(`〇 postflight: ${phase.role} — ok`, "info");
			}
		}

		// ── Advance to next phase ─────────────────────────────────────
		registry.completePhase(taskId, phase.role, "completed");
		finishPhaseNode("completed");
		// KB link refresh is orchestrator-owned in forge-cli (subagents run via Pi
		// runtime and have no Skill tool). Mirrors the init phase-4 pattern.
		if (phase.role === "writeback") {
			try {
				const kbResult = await runRefreshKbLinks(cwd);
				ctx.ui.notify(
					kbResult.filesUpdated > 0
						? `〇 KB links refreshed (${kbResult.filesUpdated} file${kbResult.filesUpdated === 1 ? "" : "s"} updated)`
						: `  KB links — already up to date`,
					"info",
				);
			} catch (e: unknown) {
				ctx.ui.notify(
					`△ KB links refresh failed (best-effort): ${(e as { message?: string }).message ?? "unknown"}`,
					"warning",
				);
			}
		}
		writeState(cwd, {
			taskId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: false,
			savedAt: new Date().toISOString(),
		});
		currentPhaseIndex++;
	}

	// ── All phases complete ───────────────────────────────────────────
	deleteState(cwd, taskId);
	orchTranscript.record({
		kind: "pipeline-end",
		ts: new Date().toISOString(),
		outcome: "complete",
		elapsedMs: Date.now() - pipelineStartMs,
	});
	return {
		status: "completed",
		lastPhaseIndex: PHASES.length - 1,
		iterationCounts,
		model: lastModel,
		provider: lastProvider,
	};
}
