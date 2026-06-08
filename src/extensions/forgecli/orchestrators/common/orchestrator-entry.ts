// orchestrator-entry.ts — shared "common concerns" for orchestrator entry.
//
// Three helpers used by all three orchestrator handlers:
//   - gatherModelValidationInputs: the byte-identical persona/pipeline/model
//     catalogue snippet (run-task, fix-bug, run-sprint).
//   - resolveOrchestratorEntry: discover the Forge config, fail-and-clear-status
//     when absent, sweep orphaned transcripts, return resolved tool paths.
//   - runPipelinePreflight: layered-config schema check + full model-config
//     validation (used by run-task and fix-bug; run-sprint keeps its own inline
//     sprint-entry validation per the N-H-D boundary).

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadLayeredConfig, type MergedConfig } from "../../config/config-layer.js";
import { readPersonaDir, readPipelineNames } from "../../lib/catalog-helpers.js";
import { discoverForgeConfigCached } from "../../lib/forge-config.js";
import { sweepProjectTranscripts } from "../../transcript-archive.js";
import { runOrchestratorPreflight } from "../orchestrator-preflight.js";
import type { OrchestratorNotifier } from "./orchestrator-notify.js";

export interface ModelValidationInputs {
	personaCatalogue: string[];
	pipelineCatalogue: string[] | null;
	availableModels: Array<{ provider: string; id: string }>;
}

/** Gather the model-validation inputs shared by every orchestrator entry: the
 *  bundled persona catalogue, the project pipeline names, and the session model
 *  registry. The persona dir is resolved relative to this module's dist
 *  location (orchestrators/common → four levels up to dist/forge-payload). */
export function gatherModelValidationInputs(
	cwd: string,
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): ModelValidationInputs {
	const personasDir = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		"..",
		"..",
		"forge-payload",
		".base-pack",
		"personas",
	);
	const personaCatalogue = readPersonaDir(personasDir);
	const forgeCfgPath = path.join(cwd, ".forge", "config.json");
	const pipelineCatalogue = readPipelineNames(forgeCfgPath);
	const availableModels = (ctx.modelRegistry?.getAvailable?.() ?? []).map((m) => ({ provider: m.provider, id: m.id }));
	return { personaCatalogue, pipelineCatalogue, availableModels };
}

export interface OrchestratorEntry {
	forgeRoot: string;
	storeCli: string;
	preflightGate: string;
}

/** Discover the Forge config at cwd. On success, sweep orphaned project
 *  transcripts and return the resolved tool paths. On failure, notify and clear
 *  the status line, then return null (caller returns immediately). */
export function resolveOrchestratorEntry(opts: {
	cwd: string;
	notify: OrchestratorNotifier;
}): OrchestratorEntry | null {
	const { cwd, notify } = opts;
	const forgeConfig = discoverForgeConfigCached(cwd);
	if (!forgeConfig) {
		notify.error("no Forge project found at cwd. Run /forge:init first.");
		notify.clearStatus();
		return null;
	}
	const forgeRoot = forgeConfig.forgeRoot;

	// Best-effort transcript-archive sweep: adopt any project-local runs not yet
	// in the central index (crash recovery + pre-existing history). Runs BEFORE
	// any pipeline creates its own transcript writer, so in-flight runs are
	// never swept half-written.
	sweepProjectTranscripts(cwd);

	return {
		forgeRoot,
		storeCli: path.join(forgeRoot, "tools", "store-cli.cjs"),
		preflightGate: path.join(forgeRoot, "tools", "preflight-gate.cjs"),
	};
}

export type PipelinePreflightOutcome =
	| { proceed: true; modelRoutingConfig: MergedConfig }
	| { proceed: false; lastError: string };

/** Layered-config schema check followed by full model-config validation.
 *  Surfaces schema/validation errors via the notifier (matching the legacy
 *  inline strings) and returns the merged routing config on success. */
export function runPipelinePreflight(opts: {
	cwd: string;
	ctx: ExtensionCommandContext;
	notify: OrchestratorNotifier;
}): PipelinePreflightOutcome {
	const { cwd, ctx, notify } = opts;

	// N-B-E: surface schema errors to caller (Decision 9 — orchestrators
	// fail-fast). See doc/decisions/layered-config-error-policy.md.
	const { merged: modelRoutingConfig, errors: layeredConfigErrors } = loadLayeredConfig(cwd);
	if (layeredConfigErrors.length > 0) {
		for (const e of layeredConfigErrors) {
			notify.error(`forge-cli config schema error: ${e}`);
		}
		return { proceed: false, lastError: `forge-cli config schema errors: ${layeredConfigErrors.join("; ")}` };
	}

	const inputs = gatherModelValidationInputs(cwd, ctx);
	const preflightResult = runOrchestratorPreflight({
		mode: "task",
		ctx,
		notifyPrefix: notify.label,
		personaCatalogue: inputs.personaCatalogue,
		pipelineCatalogue: inputs.pipelineCatalogue,
		modelRoutingConfig,
		availableModels: inputs.availableModels,
	});
	if (!preflightResult.proceed) {
		return {
			proceed: false,
			lastError: preflightResult.result.lastError ?? "model config validation failed",
		};
	}

	return { proceed: true, modelRoutingConfig };
}
