// lib/orchestrator-preflight.ts — FORGE-S25-T17 (H-13, N-H-D)
//
// Single shared preflight helper for orchestrator pipelines. Replaces the
// duplicate pre-flight validation blocks in run-task.ts and fix-bug.ts.
//
// Design: a `mode` parameter selects behaviour:
//
//   mode="task"     — full model-config validation via validateModelConfig.
//                     Used by runTaskPipeline and runBugPipeline.
//   mode="ceremony" — skips validateModelConfig entirely.
//                     Aligns with dispatchSprintCeremony which uses
//                     lookupPersonaModel (not the full validator). The
//                     run-sprint.ts ceremony call does NOT use this helper
//                     directly; it was already skip-validation by design
//                     (N-H-D). This mode is available for future callers
//                     that need a ceremony-style preflight.
//
// Why run-sprint.ts is NOT migrated to this helper:
//   run-sprint.ts contains a separate sprint-entry validation block
//   (lines 470–498) that validates sprint-level config, not task/phase-level.
//   That block is architecturally distinct and is explicitly out of scope
//   per the plan-review finding (N-H-D resolved, reviewer-approved).

import { validateModelConfig } from "../model-validator.js";
import type { MergedConfig } from "../config-layer.js";
import type { OrchestratorResult } from "./orchestrator-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal context interface — only the bits preflight needs. */
export interface PreflightContext {
	ui: {
		notify(message: string, type?: "error" | "info" | "warning"): void;
	};
}

export interface RunOrchestratorPreflightOptions {
	/** "task" runs validateModelConfig; "ceremony" skips it. */
	mode: "task" | "ceremony";
	/** Minimal context for notifications. */
	ctx: PreflightContext;
	/** Prefix for notify messages, e.g. "forge:run-task" or "forge:fix-bug". */
	notifyPrefix: string;
	/** Persona name catalogue from readPersonaDir. */
	personaCatalogue: string[];
	/** Pipeline name catalogue from readPipelineNames; null if no config found. */
	pipelineCatalogue: string[] | null;
	/** Merged model-routing config from loadLayeredConfig. */
	modelRoutingConfig: MergedConfig;
	/** Available models from ctx.modelRegistry.getAvailable(). */
	availableModels: Array<{ provider: string; id: string }>;
}

/** Discriminated union: proceed=true → continue; proceed=false → return result early. */
export type OrchestratorPreflightResult =
	| { proceed: true }
	| { proceed: false; result: OrchestratorResult };

// ---------------------------------------------------------------------------
// runOrchestratorPreflight
// ---------------------------------------------------------------------------

/**
 * Run the orchestrator pre-flight check.
 *
 * In mode="task": calls validateModelConfig and surfaces warnings/errors via
 * ctx.ui.notify. Returns `{ proceed: false, result }` with status="failed" if
 * there are errors; returns `{ proceed: true }` otherwise.
 *
 * In mode="ceremony": returns `{ proceed: true }` immediately without calling
 * validateModelConfig. This matches the existing behaviour of ceremony dispatch
 * which uses lookupPersonaModel rather than the full validator.
 */
export function runOrchestratorPreflight(
	opts: RunOrchestratorPreflightOptions,
): OrchestratorPreflightResult {
	if (opts.mode === "ceremony") {
		return { proceed: true };
	}

	// mode="task" — full validation
	const strict = process.env.FORGE_STRICT_MODELS === "1";
	const { errors, warnings } = validateModelConfig(
		opts.personaCatalogue,
		opts.pipelineCatalogue,
		opts.modelRoutingConfig,
		opts.availableModels,
		strict,
	);

	for (const w of warnings) {
		opts.ctx.ui.notify(`⚠ ${opts.notifyPrefix} — model routing: ${w.message}`, "warning");
	}

	if (errors.length > 0) {
		for (const e of errors) {
			opts.ctx.ui.notify(`× ${opts.notifyPrefix} — model routing: ${e.message}`, "error");
		}
		return {
			proceed: false,
			result: {
				status: "failed",
				lastPhaseIndex: 0,
				iterationCounts: {},
				lastError: `model config validation failed: ${errors.map((e) => e.code).join(", ")}`,
			},
		};
	}

	return { proceed: true };
}
