// halt-advisor.ts — Halt-recovery advisor helper (FORGE-S26-T18).
//
// When preflight-gate.cjs exits 1 and emits a structured failure JSON,
// the CLI route (run-task / fix-bug) calls runHaltAdvisor to spawn a
// read-only one-shot subagent that explains the failure and guides recovery.
//
// Design constraints:
//   - Advisor is READ-ONLY: no store writes, no artifact mutations.
//   - Model: the HEAVY model the runtime resolves point-in-time — the
//     approve/architect slot through the existing routing cascade
//     (project > user > pi default). NO dedicated advisorModel config entry.
//     If nothing is routed and no current model exists, the advisor is
//     skipped silently (non-fatal).
//   - runHaltAdvisor is best-effort: failures must not mask the primary halt.

import type { MergedConfig, PersonaModel } from "../config/config-layer.js";
import { runForgeSubagent, loadForgePersona, type ForgePersona } from "../forge-subagent.js";
import { resolveModelForPhase } from "../config/model-resolver.js";

// Minimal subset of the ExtensionCommandContext.ui interface needed here.
export interface UiLike {
	notify(message: string, level?: string): void;
}

export interface CtxLike {
	ui: UiLike;
}

// Structured gate failure shape emitted by preflight-gate.cjs on stdout.
export interface GateFailure {
	phase: string;
	reasonCode: string;
	detail: string;
	remediation: string;
}

export interface RunHaltAdvisorOptions {
	/** Structured failure parsed from preflight-gate.cjs stdout. */
	gateFailure: GateFailure;
	/** Resolved advisor model (from resolveAdvisorModel). If undefined, advisor is skipped. */
	advisorModel: PersonaModel | undefined;
	/** Task or bug id for context. */
	taskId: string;
	/** Working directory. */
	cwd: string;
	/** Extension command context (ui + modelRegistry). */
	ctx: CtxLike;
	/** Optional forge root path — forwarded to runForgeSubagent. */
	forgeRoot?: string;
}

/**
 * Resolve the advisor model for halt-recovery.
 *
 * Priority:
 *   1. Explicit `advisorModel` config slot from forge-cli layered config.
 * Contract (rev. 2026-06-04): the advisor model is the HEAVY model the runtime
 * resolves point-in-time. There is NO dedicated advisorModel config entry —
 * "heavy" is the approve/architect slot resolved through the existing routing
 * cascade (L4 phase override → L3/L2 project → L1 user/global → default),
 * exactly as the approve phase itself would resolve. When the cascade bottoms
 * out at inherit, the session's current model (pi default) is used. In the
 * Claude Code plugin route the equivalent is the opus-class session model.
 *
 * Returns undefined (advisor skipped, non-fatal) only when nothing is routed
 * AND no current model is available.
 *
 * (History: the original FORGE-S26-T18 implementation used a dedicated
 * advisorModel config slot with a blind registry fallback that produced
 * "anthropic/undefined" on the CART-S03-T01 halt — both retired.)
 */
export function resolveAdvisorModel(
	merged: MergedConfig,
	currentModel?: { provider?: string; model?: string; id?: string },
	pipelineName = "default",
): PersonaModel | undefined {
	// Heavy slot: the approve phase / architect persona routing resolution.
	try {
		const heavy = resolveModelForPhase(pipelineName, "approve", "architect", merged ?? {});
		if (heavy.model) return heavy.model;
	} catch {
		// resolution errors are non-fatal — fall through to the current model
	}
	// Inherit → pi's current model (provider-neutral, known-good).
	if (currentModel?.provider) {
		const model = currentModel.model ?? currentModel.id;
		if (model) return { provider: currentModel.provider, model };
	}
	return undefined;
}

/**
 * Spawn a read-only advisor subagent to explain the gate failure and guide recovery.
 *
 * Best-effort: errors are notified via ctx.ui but do NOT propagate. The
 * primary halt status is the caller's responsibility to surface separately.
 */
export async function runHaltAdvisor(opts: RunHaltAdvisorOptions): Promise<void> {
	const { gateFailure, advisorModel, taskId, cwd, ctx, forgeRoot } = opts;

	if (!advisorModel) {
		// No model available — skip advisor silently.
		return;
	}

	ctx.ui.notify(
		`ℹ forge: halt advisor running on ${advisorModel.provider}/${advisorModel.model} for ${taskId}`,
		"info",
	);

	const advisoryPrompt = [
		`# Halt-Recovery Advisory for ${taskId}`,
		``,
		`A preflight gate halted the pipeline for phase **${gateFailure.phase}**.`,
		``,
		`## Failure Details`,
		`- **Reason code:** \`${gateFailure.reasonCode}\``,
		`- **Detail:** ${gateFailure.detail}`,
		``,
		`## Recommended Remediation`,
		gateFailure.remediation,
		``,
		`## Your Role`,
		`You are a read-only advisor. Explain the failure in plain language, confirm the`,
		`remediation step, and provide any additional context the user needs to unblock.`,
		`Do NOT modify any files, run any commands, or write to the store.`,
		`Output your advisory as a brief structured summary (2–4 sentences).`,
	].join("\n");

	try {
		let persona: ForgePersona;
		try {
			persona = loadForgePersona("engineer", cwd);
		} catch {
			// Persona unavailable — use a minimal fallback rather than crashing.
			persona = {
				name: "advisor",
				description: "Halt-recovery advisor",
				systemPrompt: "You are a Forge engineering advisor. Be concise and helpful.",
				filePath: "",
			};
		}

		await runForgeSubagent({
			persona,
			task: advisoryPrompt,
			cwd,
			forgeRoot,
			requestedModel: advisorModel,
		});
	} catch (err: unknown) {
		const e = err as { message?: string };
		ctx.ui.notify(
			`⚠ forge: halt advisor failed (non-fatal): ${e.message ?? "unknown"}`,
			"warning",
		);
	}
}
