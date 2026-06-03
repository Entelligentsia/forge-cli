// halt-advisor.ts — Halt-recovery advisor helper (FORGE-S26-T18).
//
// When preflight-gate.cjs exits 1 and emits a structured failure JSON,
// the CLI route (run-task / fix-bug) calls runHaltAdvisor to spawn a
// read-only one-shot subagent that explains the failure and guides recovery.
//
// Design constraints:
//   - Advisor is READ-ONLY: no store writes, no artifact mutations.
//   - Model selected by resolveAdvisorModel: advisorModel config slot (L1/L2)
//     first; falls back to ctx.modelRegistry.getAvailable()[0]; if neither,
//     skips the advisor silently (non-fatal).
//   - runHaltAdvisor is best-effort: failures must not mask the primary halt.

import { runForgeSubagent, loadForgePersona, type ForgePersona } from "../forge-subagent.js";
import type { PersonaModel } from "../config-layer.js";

// Minimal subset of the ModelRegistry interface needed here.
export interface ModelRegistryLike {
	getAvailable(): Array<{ provider: string; model: string }>;
}

// Minimal subset of the ExtensionCommandContext.ui interface needed here.
export interface UiLike {
	notify(message: string, level?: string): void;
}

export interface CtxLike {
	ui: UiLike;
	modelRegistry?: ModelRegistryLike;
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
 *   2. `modelRegistry.getAvailable()[0]` — the first available model.
 *   3. undefined — caller should skip the advisor.
 *
 * Note: model-registry.ts does NOT expose a capability rank, so the config
 * slot is the canonical way to point at a "strongest" model. getAvailable()[0]
 * is the safe no-config fallback. (Sub-decision resolved in PLAN.md.)
 */
export function resolveAdvisorModel(
	configSlot: PersonaModel | undefined,
	modelRegistry: ModelRegistryLike | undefined,
): PersonaModel | undefined {
	if (configSlot) return configSlot;
	const available = modelRegistry?.getAvailable?.() ?? [];
	return available[0] as PersonaModel | undefined;
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
