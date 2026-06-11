// recovery-menu.ts — FEAT-009 (halt-recovery UX): interactive recovery menu
// offered at a pipeline halt, on top of the deterministic remediation + the
// `4ge reset` hint. Lets the operator rewind the pipeline with two keystrokes
// (pick "reset", pick a phase) instead of recalling the command.
//
// Best-effort and non-blocking: in non-interactive mode it is a no-op (the
// printed remediation + 4ge reset hint stand on their own); any error is
// swallowed so it can never mask the primary halt.

import { isNonInteractive } from "./orchestrator-misc.js";
import {
	type ResetEntityKind,
	type ResetPipelineParams,
	type ResetPipelineResult,
	resetPipelineState,
} from "./reset-pipeline.js";
import { BUG_PHASES } from "../bug/bug-phases.js";
import { PHASES } from "../task/task-phases.js";

// Minimal UI surface this helper needs (subset of ExtensionCommandContext.ui).
export interface RecoveryUi {
	select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
	notify(message: string, level?: string): void;
}

export interface RecoveryMenuParams {
	ui: RecoveryUi;
	kind: ResetEntityKind;
	id: string;
	cwd: string;
	storeCli: string;
	/** Override interactivity detection (tests). */
	interactive?: boolean;
	/** Override the reset implementation (tests). */
	reset?: (p: ResetPipelineParams) => ResetPipelineResult;
}

const RESET_LABEL = "Reset to a phase and resume later";
const ABORT_LABEL = "Leave it halted";

/** Ordered phase roles for the entity's pipeline. */
export function phaseRolesFor(kind: ResetEntityKind): string[] {
	return (kind === "bug" ? BUG_PHASES : PHASES).map((p) => p.role);
}

/**
 * Offer an interactive recovery menu at a halt. Returns the reset result if the
 * operator chose to reset, otherwise undefined (declined / aborted / non-
 * interactive). Never throws.
 */
export async function offerRecoveryMenu(
	p: RecoveryMenuParams,
): Promise<ResetPipelineResult | undefined> {
	const interactive = p.interactive ?? !isNonInteractive();
	if (!interactive) return undefined;

	try {
		const choice = await p.ui.select(`Halt recovery — ${p.id}`, [RESET_LABEL, ABORT_LABEL]);
		if (choice !== RESET_LABEL) return undefined;

		const phase = await p.ui.select(`Reset ${p.id} to which phase?`, phaseRolesFor(p.kind));
		if (!phase) return undefined;

		const reset = p.reset ?? resetPipelineState;
		const result = reset({
			kind: p.kind,
			cwd: p.cwd,
			id: p.id,
			toPhase: phase,
			storeCli: p.storeCli,
		});

		if (result.ok) {
			const resumeCmd = p.kind === "bug" ? `/forge:fix-bug ${p.id}` : `/forge:run-task ${p.id}`;
			p.ui.notify(
				`〇 reset ${p.id} → '${result.role}' (status → ${result.preStatus}). Resume with: ${resumeCmd}`,
				"info",
			);
		} else {
			p.ui.notify(`⚠ reset ${p.id} failed: ${result.detail ?? "unknown"}`, "warning");
		}
		return result;
	} catch (err: unknown) {
		const e = err as { message?: string };
		p.ui.notify(`⚠ recovery menu unavailable (non-fatal): ${e.message ?? "unknown"}`, "warning");
		return undefined;
	}
}
