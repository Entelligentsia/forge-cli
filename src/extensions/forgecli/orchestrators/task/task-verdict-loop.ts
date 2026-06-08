// task-verdict-loop.ts — review-phase verdict + revision/loopback handling
// for the run-task pipeline. Extracted VERBATIM from run-task.ts's phase loop
// (FORGE-S31 file-size refactor) as a pure decision function: it performs the
// same store reads, ctx.ui notifications, state writes, transcript records,
// tree-node finalization, and halt-advisor dispatch the inline block did, and
// returns a small discriminated result the caller's loop switches on.
//
// Behavior-preserving: no logic changes. The only structural change is that the
// inline `return {...}` paths now return `{ kind: "return"; result }`, the
// `continue` path returns `{ kind: "loopback"; toIndex }`, and the fall-through
// (approved) path returns `{ kind: "advance" }`.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { MergedConfig } from "../../config/config-layer.js";
import { resolveAdvisorModel, runHaltAdvisor } from "../halt-advisor.js";
import type { OrchestratorTranscriptWriter } from "../../subagent/orchestrator-transcript.js";
import { findPredecessorIndex } from "./task-body.js";
import type { GateFailureData } from "./task-gates.js";
import { type PhaseDescriptor, PHASES } from "./task-phases.js";
import { readVerdict } from "./task-record.js";
import { type RunTaskState, writeState } from "./task-state.js";
import type { RunTaskPipelineResult } from "./run-task-types.js";

export type VerdictLoopOutcome =
	| { kind: "advance" }
	| { kind: "loopback"; toIndex: number }
	| { kind: "return"; result: RunTaskPipelineResult };

export interface VerdictLoopParams {
	phase: PhaseDescriptor;
	taskId: string;
	storeCli: string;
	cwd: string;
	forgeRoot: string;
	iterationCounts: Record<string, number>;
	currentPhaseIndex: number;
	modelRoutingConfig: MergedConfig;
	ctx: ExtensionCommandContext;
	orchTranscript: OrchestratorTranscriptWriter;
	/** Closure that finalizes this dispatch's OrchestratorTree node. */
	finishPhaseNode: (status: "completed" | "failed" | "escalated") => void;
}

/**
 * Evaluate the review-phase verdict and decide the loop's next move.
 * Mirrors the inline block that previously lived in runTaskPipelineInner.
 */
export function handleReviewVerdict(p: VerdictLoopParams): VerdictLoopOutcome {
	const { phase, taskId, storeCli, cwd, forgeRoot, iterationCounts, currentPhaseIndex, modelRoutingConfig, ctx } = p;
	const { orchTranscript, finishPhaseNode } = p;

	const verdict = readVerdict(taskId, phase.role, storeCli, cwd);

	if (verdict === "missing") {
		ctx.ui.notify(
			`× forge:run-task — verdict missing for phase ${phase.role} after subagent completed. ` +
				"Subagent may have crashed or failed to write summaries. Halting for advisory.",
			"error",
		);
		finishPhaseNode("failed");
		writeState(cwd, {
			taskId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: true,
			lastError: `verdict missing for ${phase.role}`,
			savedAt: new Date().toISOString(),
		} satisfies RunTaskState);
		// A missing verdict IS a postflight-outputs failure: the canonical
		// phase summary the subagent must write (e.g. summaries.code_review)
		// was never recorded, so there is no verdict to route on. review-phase
		// workflows declare no `outputs` block, so runPostflightGate is a
		// pass-through here — this readVerdict check is the effective gate.
		// Route it through the halt-recovery advisor (FORGE-S26-T18), the same
		// hand-off the postflight-gate-unsatisfied branch uses, instead of a
		// bare escalation — so the strongest configured model can diagnose the
		// missing-summary cause. Best-effort, non-fatal (FORGE-S26-T19 parity).
		const gateFailure: GateFailureData = {
			phase: phase.role,
			reasonCode: "verdict-missing",
			detail:
				`Phase '${phase.role}' completed but no verdict was found in the store. ` +
				"The canonical phase summary was not written, so the orchestrator has no verdict to route on.",
			remediation:
				"Re-run the phase and ensure the subagent's forge_store set-summary call " +
				'uses args:["<recordId>", "<phaseKey>"] with the literal phase key as args[1] ' +
				"(e.g. code_review), and that the call exits zero before the subagent returns.",
		};
		const advisorModel = resolveAdvisorModel(modelRoutingConfig, ctx.model as any);
		void runHaltAdvisor({
			gateFailure,
			advisorModel,
			taskId,
			cwd,
			ctx: { ui: ctx.ui as any },
			forgeRoot,
		});
		return {
			kind: "return",
			result: {
				status: "halted",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `verdict missing for ${phase.role}`,
			},
		};
	}

	if (verdict === "revision") {
		// Increment iteration count for this review phase
		iterationCounts[phase.role] = (iterationCounts[phase.role] ?? 0) + 1;

		if (iterationCounts[phase.role] >= phase.maxIterations) {
			ctx.ui.notify(
				`× forge:run-task — revision cap reached for phase ${phase.role} ` +
					`(${iterationCounts[phase.role]}/${phase.maxIterations} iterations). Escalating.`,
				"error",
			);
			finishPhaseNode("escalated");
			writeState(cwd, {
				taskId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `revision cap reached for ${phase.role}`,
				savedAt: new Date().toISOString(),
			} satisfies RunTaskState);
			return {
				kind: "return",
				result: {
					status: "escalated",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `revision cap reached for ${phase.role}`,
				},
			};
		}

		// Loop back to predecessor non-review phase. The review
		// subagent itself finished cleanly — `revision` is its verdict,
		// not a failure — so its node closes as completed before the
		// predecessor re-dispatches under a fresh node ID.
		finishPhaseNode("completed");
		const predIndex = findPredecessorIndex(PHASES, currentPhaseIndex);
		ctx.ui.notify(
			`⟳ forge:run-task — ${phase.role} returned revision; looping to ${PHASES[predIndex]?.role ?? predIndex} ` +
				`(attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
			"info",
		);
		orchTranscript.record({
			kind: "phase-loopback",
			ts: new Date().toISOString(),
			fromPhase: phase.role,
			toPhase: PHASES[predIndex]?.role ?? String(predIndex),
			fromPhaseIndex: currentPhaseIndex,
			toPhaseIndex: predIndex,
			reason: `${phase.role} returned revision (attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
		});
		// Write intermediate state (not halted — still running)
		writeState(cwd, {
			taskId,
			phaseIndex: predIndex,
			iterationCounts,
			halted: false,
			savedAt: new Date().toISOString(),
		} satisfies RunTaskState);
		return { kind: "loopback", toIndex: predIndex };
	}

	// verdict === "approved": advance
	return { kind: "advance" };
}
