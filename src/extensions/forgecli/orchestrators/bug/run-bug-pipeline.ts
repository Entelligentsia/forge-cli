// run-bug-pipeline.ts — the per-bug orchestrator pipeline (runBugPipeline thin
// wrapper + runBugPipelineInner phase loop). Extracted VERBATIM from fix-bug.ts
// (FORGE-S31 file-size refactor); the only logic-neutral changes are that the
// per-phase dispatch, the post-triage bugId capture, the review-phase verdict
// handling, and the post-triage Path A/B routing are delegated to helpers in
// bug-phase-dispatch.ts / bug-triage-routing.ts / bug-verdict-loop.ts and the
// loop switches on their discriminated results.
//
// Iron Laws enforced here:
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff calls here)
//
// sendKickoff is NEVER called from this file.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { assertAudience, CallerContextStore } from "../../audience-gate.js";
import type { MergedConfig } from "../../config/config-layer.js";
import { checkMaterialization } from "../../lib/manifest-checker.js";
import { type AudienceValue, loadWorkflow } from "../../parsers/workflow-loader.js";
import type { PhaseRole } from "../../subagent/caller-context.js";
import { BUG_SUMMARY_KEY_BY_ROLE } from "../../subagent/phase-summary-map.js";
import { fmtPhaseSummary } from "../../viewport/renderer.js";
import { resolveAdvisorModel, runHaltAdvisor } from "../halt-advisor.js";
import { createOrchestratorNotifier } from "../common/orchestrator-notify.js";
import { runPipelinePreflight } from "../common/orchestrator-entry.js";
import {
	type OrchestratorTranscriptSession,
	withOrchestratorTranscript,
} from "../common/orchestrator-transcript-session.js";
import {
	buildPhaseEvent,
	drainFrictionFile,
	emitEvent,
	judgementFromSummary,
	type OrchestratorEmitContext,
	runPreflightGateWithData,
} from "../run-task.js";

import { dispatchBugPhase } from "./bug-phase-dispatch.js";
import { BUG_PHASES, BUG_TYPE_TOKENS } from "./bug-phases.js";
import { readBugRecord } from "./bug-id.js";
import { deleteBugState, writeBugState } from "./bug-state.js";
import { captureTriageBugId, maybeSkipPhase, routeAfterTriage } from "./bug-triage-routing.js";
import { handleBugReviewVerdict } from "./bug-verdict-loop.js";
import type { RunBugPipelineOptions, RunBugPipelineResult } from "./run-bug-types.js";

const STATUS_KEY = "forge:fix-bug";
const MESSAGE_KEY = "forge:fix-bug:message";

export async function runBugPipeline(opts: RunBugPipelineOptions): Promise<RunBugPipelineResult> {
	// Entry preflight (layered-config schema + model-config validation) runs
	// BEFORE the transcript writer is created, so a failed preflight never
	// leaves a transcript file behind.
	const notify = createOrchestratorNotifier(opts.ctx, {
		label: "forge:fix-bug",
		statusKey: STATUS_KEY,
		messageKey: MESSAGE_KEY,
	});
	const pre = runPipelinePreflight({ cwd: opts.cwd, ctx: opts.ctx, notify });
	if (!pre.proceed) {
		return {
			status: "failed",
			lastPhaseIndex: opts.resumeFromState?.phaseIndex ?? 0,
			iterationCounts: opts.resumeFromState?.iterationCounts ?? {},
			lastError: pre.lastError,
		};
	}

	// The transcript session owns ctx.ui.notify interception and the guaranteed
	// pipeline-end close on every outcome (see orchestrator-transcript-session).
	return withOrchestratorTranscript(
		{ cwd: opts.cwd, entityKind: "bug", entityId: opts.bugId, ctx: opts.ctx },
		(session) => runBugPipelineInner(opts, pre.modelRoutingConfig, session),
	);
}

async function runBugPipelineInner(
	opts: RunBugPipelineOptions,
	modelRoutingConfig: MergedConfig,
	session: OrchestratorTranscriptSession,
): Promise<RunBugPipelineResult> {
	const {
		bugId: initialBugId,
		originalArg,
		isNewBug,
		cwd,
		ctx,
		forgeRoot,
		storeCli,
		preflightGate,
		registry,
		resumeFromState,
	} = opts;

	// Mutable bugId — for new bugs, pre-assign a real FORGE-BUG-NNN ID
	// before triage so the subagent never needs to create or discover one.
	// This replaces the fragile PENDING→capture pattern where the subagent was
	// expected to create the bug record and we'd fish the ID from events.
	let bugId = initialBugId;
	let currentPhaseIndex = resumeFromState?.phaseIndex ?? 0;
	const iterationCounts: Record<string, number> = resumeFromState?.iterationCounts ?? {};

	// Per-phase completion-recovery guard (forge-engineering#41): each role gets
	// at most one deterministic set-bug-summary recovery attempt before a
	// missing-summary hard-fail. Prevents recovery loops.
	const recoveredPhases = new Set<string>();

	// Per-role dispatch counter for OrchestratorTree node identity. Distinct
	// from iterationCounts (which only tracks review-verdict revisions): every
	// dispatch of a role — including a plan-fix re-run after a review
	// loopback — gets its own `<bugId>:<role>:<attempt>` node, so the
	// dashboard renders one leaf per run in dispatch order instead of merging
	// attempts into one node (CART-BUG-003 dashboard regression). Seeded from
	// resume state so resumed runs continue numbering past prior attempts.
	const dispatchCounts: Record<string, number> = { ...(resumeFromState?.iterationCounts ?? {}) };
	let lastModel: string | undefined;
	let lastProvider: string | undefined;

	// modelRoutingConfig is loaded and validated by runPipelinePreflight (in
	// runBugPipeline) before the transcript writer exists, then passed in.
	// Pipeline name "fix-bug" lets users configure per-phase overrides under
	// pipelines["fix-bug"] in their routing config.

	// Orchestrator transcript writer — created and notify-intercepted by
	// withOrchestratorTranscript; the loop records structured phase-boundary
	// events through it (one JSONL file per run).
	const orchTranscript = session.writer;
	const pipelineStartMs = Date.now();

	while (currentPhaseIndex < BUG_PHASES.length) {
		// ── Between-phase cancellation gate ────────────────────────────
		if (opts.signal?.aborted) {
			ctx.ui.notify(`⊘ forge:fix-bug — ${bugId} cancelled by user.`, "info");
			registry.completePhase(bugId, BUG_PHASES[currentPhaseIndex]?.role ?? "unknown", "cancelled");
			registry.confirmCancelled(bugId);
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
			return { status: "cancelled", lastPhaseIndex: currentPhaseIndex, iterationCounts };
		}

		const phase = BUG_PHASES[currentPhaseIndex];
		if (!phase) {
			ctx.ui.notify(`× forge:fix-bug — invalid phase index ${currentPhaseIndex}`, "error");
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `invalid phase index ${currentPhaseIndex}`,
			};
		}

		ctx.ui.setStatus?.(
			STATUS_KEY,
			`fix-bug ${bugId}: phase ${currentPhaseIndex + 1}/${BUG_PHASES.length} (${phase.role})`,
		);
		ctx.ui.notify(`→ ${bugId}: ${phase.role} (phase ${currentPhaseIndex + 1}/${BUG_PHASES.length})`, "info");
		orchTranscript.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: phase.role,
			phaseIndex: currentPhaseIndex,
			phaseCount: BUG_PHASES.length,
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
				`× forge:fix-bug — failed to read sub-workflow for ${phase.role}: ${e.message ?? "unknown"}`,
				"error",
			);
			writeBugState(cwd, {
				bugId,
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

		// ── 6a. Phase skip (state-aware, defense-in-depth) ─────────────
		const bugNow = readBugRecord(bugId, storeCli, cwd);
		if (maybeSkipPhase({ phase, bugId, cwd, ctx, storeCli, bugNow, summaryKeyByRole: BUG_SUMMARY_KEY_BY_ROLE })) {
			currentPhaseIndex++;
			continue;
		}

		// ── 6b. Preflight gate ────────────────────────────────────────
		// Skip preflight gate for triage phase of new bugs (PENDING- placeholder)
		// because the bug record doesn't exist yet — gates referencing bug fields
		// would always fail.
		//
		// Also skip for review phases when the bug is already in a terminal
		// state ("fixed"). Path A bugs get fixed during triage, then the
		// preflight gate's `forbid bug.status == fixed` and `after implement
		// = n/a` checks block review-code/review-plan even though we
		// deliberately want to run those reviews. The review subagent handles
		// the already-fixed scenario internally.
		const pendingBugId = bugId.startsWith("PENDING-");
		const bugAlreadyFixed = bugNow?.status === "fixed" && phase.isReview;
		if (!pendingBugId && !bugAlreadyFixed && fs.existsSync(preflightGate)) {
			const preflightOutcome = runPreflightGateWithData(preflightGate, phase.role, bugId, cwd, "bug");
			if (preflightOutcome.result === "halt") {
				// Render structured failure reason if available.
				if (preflightOutcome.gateFailure) {
					ctx.ui.notify(
						`× forge:fix-bug — preflight gate failed for phase ${phase.role} ` +
							`[${preflightOutcome.gateFailure.reasonCode}]: ${preflightOutcome.gateFailure.detail}`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:fix-bug — preflight gate failed for phase ${phase.role} (exit 1); halting.`,
						"error",
					);
				}
				writeBugState(cwd, {
					bugId,
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
						taskId: bugId,
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
					`× forge:fix-bug — preflight gate escalated for phase ${phase.role} (exit 2); manual intervention required.`,
					"error",
				);
				writeBugState(cwd, {
					bugId,
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
		}

		// ── 6. Materialization-marker check ───────────────────────────
		// FORGE-BUG-040: every BUG phase is now a true `audience: subagent`
		// sub-workflow — triage / plan-fix / implement no longer alias to
		// fix_bug.md. The marker check is therefore unconditional; a missing
		// marker is a hard failure on the first dispatch.
		{
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
		}

		// ── 5. Audience check ─────────────────────────────────────────
		// FORGE-BUG-040: every BUG phase is a true `audience: subagent`
		// workflow now; the previous `fix_bug.md` audience-bypass is gone.
		const audienceOk = CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
			assertAudience({ workflowName: phase.workflowFile, audience: subWorkflowAudience }, ctx),
		);
		if (!audienceOk) {
			writeBugState(cwd, {
				bugId,
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

		// ── Read bug record for current status ────────────────────────
		// Skip for PENDING bugIds (bug doesn't exist yet).
		const bugRecordBefore = pendingBugId ? null : readBugRecord(bugId, storeCli, cwd);
		const bugStatusBeforePhase = bugRecordBefore?.status;

		// ── Dispatch (persona load + runForgeSubagent + observer + abort/halt) ──
		// Extracted to bug-phase-dispatch.ts (FORGE-S31). Returns either a
		// terminal result or the live locals the rest of the loop needs.
		const dispatch = await dispatchBugPhase({
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
		});
		if (dispatch.kind === "return") return dispatch.result;
		const { result, finishPhaseNode, observer, phaseStart, toolExecutionEvents, debugLogDisabled } = dispatch;
		let { writeDebug, debugLogPath } = dispatch;

		// Capture model/provider from subagent result.
		if (result.model) lastModel = result.model;
		if (result.provider) lastProvider = result.provider;

		// ── BugId capture after triage phase (Finding #1, #2) ──────────
		// For new bugs, the triage subagent creates the bug record via store-cli.
		// We capture the bugId by scanning tool_execution_end events.
		if (phase.role === "triage" && isNewBug && bugId.startsWith("PENDING-")) {
			const capture = captureTriageBugId(
				{
					bugId,
					cwd,
					ctx,
					storeCli,
					currentPhaseIndex,
					iterationCounts,
					debugLogDisabled,
					toolExecutionEvents,
				},
				writeDebug,
				debugLogPath,
			);
			if (capture.kind === "return") return capture.result;
			bugId = capture.bugId;
			debugLogPath = capture.debugLogPath;
			writeDebug = capture.writeDebug;
		}

		{
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			const { turn, toolCount, errCount, cumUsage, cumCompression } = observer.state;
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
			registry.appendTail(
				bugId,
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

		// ── Slice-2: orchestrator emits phase event ──────────────────
		// sprintId for bug event emission is the literal "bugs" (routing key),
		// matching the convention in .forge/workflows/fix_bug.md.
		const phaseEndMs = Date.now();
		const bugRecord = readBugRecord(bugId, storeCli, cwd);
		const sprintId = "bugs"; // routing key for bug events — not a sprint reference
		const phaseIteration = (iterationCounts[phase.role] ?? 0) + 1;

		// Read summary judgement for review phases (using bug summary key map)
		const judgement = phase.isReview
			? judgementFromSummary(bugRecord ?? null, phase.role, BUG_SUMMARY_KEY_BY_ROLE)
			: undefined;

		const emitCtx: OrchestratorEmitContext = {
			entityType: "bug",
			bugId,
			sprintId, // routing key "bugs" — not a sprint reference
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
			judgement,
			storeCli,
			cwd,
		};
		const phaseEvent = buildPhaseEvent(emitCtx);

		// Set bug event type based on BUG_TYPE_TOKENS mapping.
		const typeTokenEntry = BUG_TYPE_TOKENS[phase.role];
		if (typeTokenEntry) {
			if (phase.isReview && judgement?.verdict === "revision") {
				phaseEvent.type = typeTokenEntry.fail;
			} else {
				phaseEvent.type = typeTokenEntry.pass;
			}
		}

		const emitResult = emitEvent(storeCli, cwd, sprintId, phaseEvent);
		if (!emitResult.ok) {
			ctx.ui.notify(
				`⚠ forge:fix-bug — phase event emit failed for ${phase.role}: ${emitResult.stderr.trim()}`,
				"warning",
			);
			writeDebug({ kind: "emit_failed", stderr: emitResult.stderr });
		} else {
			writeDebug({ kind: "emit_ok", eventId: phaseEvent.eventId });
		}

		// Drain friction file for this phase.
		const frictionPath = path.join(cwd, ".forge", "cache", `FRICTION-${phase.role}.jsonl`);
		const drain = drainFrictionFile(frictionPath, emitCtx);
		if (drain.emitted + drain.failed > 0) {
			writeDebug({ kind: "friction_drain", ...drain });
			if (drain.failed > 0) {
				ctx.ui.notify(
					`⚠ forge:fix-bug — friction drain for ${phase.role}: ${drain.emitted} ok, ${drain.failed} failed`,
					"warning",
				);
			}
		}

		// ── AC §C.16: Bug FSM canonical-enum assertion ────────────────
		// After each phase that could transition bug status, validate the new
		// status via store-cli (single source of truth). Surface a warning (not halt) if invalid.
		const currentBugRecordForAssert = readBugRecord(bugId, storeCli, cwd);
		if (currentBugRecordForAssert && currentBugRecordForAssert.status) {
			// Defer to store-cli's isLegalTransition as authoritative guard.
			// Only warn on statuses store-cli itself would reject.
			const validateResult = spawnSync(
				"node",
				[storeCli, "validate", "bug", JSON.stringify(currentBugRecordForAssert)],
				{ cwd, encoding: "utf8" },
			);
			if (validateResult.status !== 0) {
				const detail = typeof validateResult.stderr === "string" ? validateResult.stderr.trim() : "unknown";
				ctx.ui.notify(`⚠ forge:fix-bug — bug ${bugId} validation warning: ${detail}`, "warning");
				writeDebug({ kind: "fsm_assertion_warning", bugId, status: currentBugRecordForAssert.status, detail });
			}
		}

		// ── 6b. Verdict check (review phases only) ────────────────────
		if (phase.isReview) {
			const outcome = await handleBugReviewVerdict({
				phase,
				bugId,
				storeCli,
				cwd,
				forgeRoot,
				iterationCounts,
				currentPhaseIndex,
				modelRoutingConfig,
				ctx,
				orchTranscript,
				summaryKeyByRole: BUG_SUMMARY_KEY_BY_ROLE,
				recoveredPhases,
				finishPhaseNode,
			});
			if (outcome.kind === "return") return outcome.result;
			if (outcome.kind === "loopback") {
				currentPhaseIndex = outcome.toIndex;
				continue;
			}
			// outcome.kind === "advance": fall through to advance
		}

		// ── Advance to next phase ─────────────────────────────────────
		registry.completePhase(bugId, phase.role, "completed");
		finishPhaseNode("completed");
		writeBugState(cwd, {
			bugId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: false,
			savedAt: new Date().toISOString(),
		});

		// ── 6c. Path A / Path B branch (post-triage) ──────────────────
		// Per meta-fix-bug.md § Triage Judgement (forge v0.44.0+), the
		// triage subagent records the route decision in
		// bug.summaries.triage.route. The orchestrator reads it after
		// triage returns and selects the downstream phase list:
		//   Path A (short-circuit): skip plan-fix + review-plan
		//   Path B (default, full loop): run all phases
		//
		// If route is missing or malformed, default to Path B (the safe
		// choice — running extra phases never produces an unsafe outcome).
		// The PHASE_SKIP_STATES heuristic at section 6a remains as
		// defense-in-depth for cases where the field is missing but the
		// bug status proves the work happened.
		if (phase.role === "triage") {
			const routing = routeAfterTriage({ bugId, cwd, ctx, storeCli, currentPhaseIndex });
			if (routing.kind === "jump") {
				currentPhaseIndex = routing.toIndex;
				continue;
			}
		}

		currentPhaseIndex++;
	}

	// ── All phases complete ───────────────────────────────────────────
	deleteBugState(cwd, bugId);
	orchTranscript.record({
		kind: "pipeline-end",
		ts: new Date().toISOString(),
		outcome: "complete",
		elapsedMs: Date.now() - pipelineStartMs,
	});
	return {
		status: "completed",
		lastPhaseIndex: BUG_PHASES.length - 1,
		iterationCounts,
		model: lastModel,
		provider: lastProvider,
	};
}
