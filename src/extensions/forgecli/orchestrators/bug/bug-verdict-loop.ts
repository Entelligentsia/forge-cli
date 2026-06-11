// bug-verdict-loop.ts — review-phase verdict + revision/loopback handling for
// the fix-bug pipeline. Extracted VERBATIM from fix-bug.ts's phase loop
// (FORGE-S31 file-size refactor) as a pure decision function: it performs the
// same store reads, ctx.ui notifications, state writes, transcript records,
// tree-node finalization, status-reset transition, and halt-advisor dispatch the
// inline block did, and returns a small discriminated result the caller's loop
// switches on.
//
// Behavior-preserving: no logic changes. The only structural change is that the
// inline `return {...}` paths now return `{ kind: "return"; result }`, the
// `continue` path returns `{ kind: "loopback"; toIndex }`, and the fall-through
// (approved) path returns `{ kind: "advance" }`.

import { spawnSync } from "node:child_process";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { MergedConfig } from "../../config/config-layer.js";
import type { OrchestratorTranscriptWriter } from "../../subagent/orchestrator-transcript.js";
import { resolveAdvisorModel, runHaltAdvisor } from "../halt-advisor.js";
import { offerRecoveryMenu } from "../common/recovery-menu.js";
import { recoverPhaseSummary } from "../common/summary-recovery.js";
import { findPredecessorIndex, type PhaseDescriptor } from "../run-task.js";
import { BUG_PHASES } from "./bug-phases.js";
import { readBugRecord } from "./bug-id.js";
import { writeBugState } from "./bug-state.js";
import { readBugVerdict } from "./bug-verdict.js";
import type { RunBugPipelineResult } from "./run-bug-types.js";

export type BugVerdictLoopOutcome =
	| { kind: "advance" }
	| { kind: "loopback"; toIndex: number }
	| { kind: "return"; result: RunBugPipelineResult };

export interface BugVerdictLoopParams {
	phase: PhaseDescriptor;
	bugId: string;
	storeCli: string;
	cwd: string;
	forgeRoot: string;
	iterationCounts: Record<string, number>;
	currentPhaseIndex: number;
	modelRoutingConfig: MergedConfig;
	ctx: ExtensionCommandContext;
	orchTranscript: OrchestratorTranscriptWriter;
	/** Per-role phase-summary key map (BUG_SUMMARY_KEY_BY_ROLE). */
	summaryKeyByRole: Record<string, string | null>;
	/** Closure that finalizes this dispatch's OrchestratorTree node. */
	finishPhaseNode: (status: "completed" | "failed" | "escalated") => void;
	/** Per-phase completion-recovery guard (forge-engineering#41) — roles that
	 *  already consumed their one set-bug-summary recovery attempt this run. */
	recoveredPhases: Set<string>;
}

/**
 * Evaluate the review-phase verdict and decide the loop's next move.
 * Mirrors the inline block that previously lived in runBugPipelineInner.
 */
export async function handleBugReviewVerdict(p: BugVerdictLoopParams): Promise<BugVerdictLoopOutcome> {
	const { phase, bugId, storeCli, cwd, forgeRoot, iterationCounts, currentPhaseIndex, modelRoutingConfig, ctx } = p;
	const { orchTranscript, finishPhaseNode, summaryKeyByRole, recoveredPhases } = p;

	// Re-read bug record for latest status after subagent ran
	const updatedBugRecord = readBugRecord(bugId, storeCli, cwd);
	let verdict = readBugVerdict(updatedBugRecord, phase.role, summaryKeyByRole);

	// Completion recovery (forge-engineering#41): a clean stop with no verdict in
	// the store is most often the subagent writing the {PHASE}-SUMMARY.json
	// sidecar but eliding the set-bug-summary that registers it. Register the
	// sidecar ourselves (once per phase), then re-read. Phases whose verdict comes
	// from bug.status (e.g. commit → summaryKey null) are not recoverable this way.
	if (verdict === "missing") {
		const summaryKey = summaryKeyByRole[phase.role];
		if (summaryKey && !recoveredPhases.has(phase.role)) {
			recoveredPhases.add(phase.role);
			const rec = recoverPhaseSummary({
				storeCli,
				entityId: bugId,
				summaryKey,
				cwd,
				summaryVerb: "set-bug-summary",
			});
			if (rec.ok) {
				const recheck = readBugVerdict(readBugRecord(bugId, storeCli, cwd), phase.role, summaryKeyByRole);
				if (recheck !== "missing") {
					ctx.ui.notify(
						`⟳ forge:fix-bug — ${phase.role}: subagent skipped set-bug-summary; orchestrator registered ` +
							`the '${summaryKey}' sidecar and the verdict is now present.`,
						"info",
					);
					verdict = recheck;
				}
			}
		}
	}

	if (verdict === "missing") {
		ctx.ui.notify(
			`× forge:fix-bug — verdict missing for phase ${phase.role} after subagent completed. Halting for advisory.`,
			"error",
		);
		finishPhaseNode("failed");
		writeBugState(cwd, {
			bugId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: true,
			lastError: `verdict missing for ${phase.role}`,
			savedAt: new Date().toISOString(),
		});
		// A missing verdict IS a postflight-outputs failure: the canonical
		// phase summary the subagent must write (e.g. summaries.code_review,
		// linked via set-bug-summary) was never recorded, so there is no
		// verdict to route on. Route it through the halt-recovery advisor
		// (FORGE-S26-T18) — the same hand-off the preflight/postflight gate
		// failures use — instead of a bare escalation. Best-effort, non-fatal.
		const advisorModel = resolveAdvisorModel(modelRoutingConfig, ctx.model as any);
		// FORGE-BUG-046: await the advisor so its diagnosis surfaces BEFORE the
		// pipeline tears down (was `void` — fire-and-forget before pipeline-end).
		await runHaltAdvisor({
			gateFailure: {
				phase: phase.role,
				reasonCode: "verdict-missing",
				detail:
					`Phase '${phase.role}' completed but no verdict was found in the store. ` +
					"The canonical phase summary was not written, so the orchestrator has no verdict to route on.",
				remediation:
					"Re-run the phase and ensure the subagent's forge_store set-bug-summary call " +
					'uses args:["<bugId>", "<phaseKey>"] with the literal phase key as args[1] ' +
					"(e.g. code_review), and that the call exits zero before the subagent returns.",
			},
			advisorModel,
			taskId: bugId,
			cwd,
			ctx: { ui: ctx.ui as any },
			forgeRoot,
		});
		// FEAT-009: offer an interactive recovery menu (reset → resume). No-op in
		// non-interactive mode; best-effort, never masks the halt.
		await offerRecoveryMenu({ ui: ctx.ui, kind: "bug", id: bugId, cwd, storeCli });
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
		iterationCounts[phase.role] = (iterationCounts[phase.role] ?? 0) + 1;

		if (iterationCounts[phase.role] >= phase.maxIterations) {
			ctx.ui.notify(
				`× forge:fix-bug — revision cap reached for phase ${phase.role} ` +
					`(${iterationCounts[phase.role]}/${phase.maxIterations} iterations). Escalating.`,
				"error",
			);
			finishPhaseNode("escalated");
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `revision cap reached for ${phase.role}`,
				savedAt: new Date().toISOString(),
			});
			// FEAT-009: a revision-cap escalation is a halt like any other — route it
			// through the halt-recovery advisor + recovery menu instead of leaving the
			// bare error notify above as the only signal (matches the verdict-missing
			// hand-off above and the run-task twin). Best-effort, non-fatal.
			const gateFailure = {
				phase: phase.role,
				reasonCode: "revision-cap-reached",
				detail:
					`Phase '${phase.role}' returned 'revision' ${iterationCounts[phase.role]} time(s), ` +
					`reaching its cap of ${phase.maxIterations}. The reviewer kept requesting changes ` +
					"and the predecessor phase could not satisfy them within the allowed iterations, " +
					"so the pipeline halted rather than loop indefinitely.",
				remediation:
					"Inspect the latest review feedback for this phase, address it manually, then " +
					`reset the pipeline to the predecessor phase and resume — e.g. \`4ge reset ${bugId} ` +
					`--to ${BUG_PHASES[findPredecessorIndex(BUG_PHASES, currentPhaseIndex)]?.role ?? phase.role}\` ` +
					"— or re-run the bug once the underlying disagreement is resolved.",
			};
			const advisorModel = resolveAdvisorModel(modelRoutingConfig, ctx.model as any);
			await runHaltAdvisor({
				gateFailure,
				advisorModel,
				taskId: bugId,
				cwd,
				ctx: { ui: ctx.ui as any },
				forgeRoot,
			});
			await offerRecoveryMenu({ ui: ctx.ui, kind: "bug", id: bugId, cwd, storeCli });
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

		// Transition bug back to in-progress before re-dispatching implement.
		// This is required for review-code → implement and approve → implement loops.
		const currentBugStatus = updatedBugRecord?.status;
		if (currentBugStatus === "fixed" || currentBugStatus === "approved") {
			const transitionResult = spawnSync(
				"node",
				[storeCli, "update-status", "bug", bugId, "status", "in-progress"],
				{ cwd, encoding: "utf8" },
			);
			if (transitionResult.status !== 0) {
				ctx.ui.notify(
					`⚠ forge:fix-bug — failed to transition bug ${bugId} from ${currentBugStatus} to in-progress: ${transitionResult.stderr ?? "unknown"}`,
					"warning",
				);
			} else {
				ctx.ui.notify(`⟳ forge:fix-bug — transitioned bug ${bugId}: ${currentBugStatus} → in-progress`, "info");
			}
		}

		// The review subagent itself finished cleanly — `revision`
		// is its verdict, not a failure — so its node closes as
		// completed before the predecessor re-dispatches under a
		// fresh node ID.
		finishPhaseNode("completed");
		const predIndex = findPredecessorIndex(BUG_PHASES, currentPhaseIndex);
		ctx.ui.notify(
			`⟳ forge:fix-bug — ${phase.role} returned revision; looping to ${BUG_PHASES[predIndex]?.role ?? predIndex} ` +
				`(attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
			"info",
		);
		orchTranscript.record({
			kind: "phase-loopback",
			ts: new Date().toISOString(),
			fromPhase: phase.role,
			toPhase: BUG_PHASES[predIndex]?.role ?? String(predIndex),
			fromPhaseIndex: currentPhaseIndex,
			toPhaseIndex: predIndex,
			reason: `${phase.role} returned revision (attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
		});
		writeBugState(cwd, {
			bugId,
			phaseIndex: predIndex,
			iterationCounts,
			halted: false,
			savedAt: new Date().toISOString(),
		});
		return { kind: "loopback", toIndex: predIndex };
	}

	// verdict === "approved": fall through to advance
	return { kind: "advance" };
}
