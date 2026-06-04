import type { MergedConfig, PersonaModel } from "./config-layer.js";
import { lookupPersonaModel } from "./model-resolver.js";

export type ValidationCode = "UNKNOWN_PERSONA" | "MODEL_UNAVAILABLE" | "UNKNOWN_PIPELINE" | "UNRESOLVABLE_OVERRIDE";

export interface ValidationIssue {
	code: ValidationCode;
	message: string;
	/** JSON-pointer-style path to the offending config value */
	path?: string;
}

export interface ValidationReport {
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
}

type AvailableModel = { provider: string; id: string };

function isAvailable(pair: PersonaModel, available: AvailableModel[]): boolean {
	return available.some((m) => m.provider === pair.provider && m.id === pair.model);
}

function modelKey(pair: PersonaModel): string {
	return `${pair.provider}:${pair.model}`;
}

/**
 * Validate the merged forge-cli model config against runtime catalogues.
 *
 * - strict=false: unavailability and unknown persona names are warnings.
 * - strict=true: those warnings become errors.
 * - Unknown pipeline names are always errors when pipelineCatalogue is non-null;
 *   warnings when pipelineCatalogue is null (no .forge/config.json found).
 * - Unresolvable model-override strings are always errors.
 *
 * The function is pure — no I/O. Callers pass in the pre-built catalogues.
 */
export function validateModelConfig(
	personaCatalogue: string[],
	pipelineCatalogue: string[] | null,
	merged: MergedConfig,
	availableModels: AvailableModel[],
	strict: boolean,
): ValidationReport {
	const errors: ValidationIssue[] = [];
	const warnings: ValidationIssue[] = [];

	function issue(isError: boolean, code: ValidationCode, message: string, path?: string): void {
		(isError ? errors : warnings).push({ code, message, path });
	}

	// ── 1. Validate top-level and per-layer persona-models entries ────────────

	const allPersonaEntries = collectPersonaEntries(merged);
	for (const { key, value, path } of allPersonaEntries) {
		if (key !== "default" && !personaCatalogue.includes(key)) {
			issue(strict, "UNKNOWN_PERSONA", `Unknown persona name "${key}" — not in persona catalogue`, path);
		}
		if (!isAvailable(value, availableModels)) {
			issue(
				strict,
				"MODEL_UNAVAILABLE",
				`${modelKey(value)} (persona "${key}") is not available in ModelRegistry`,
				path,
			);
		}
	}

	// ── 2. Validate pipeline names + per-pipeline phases ─────────────────────

	const pipelines = merged.pipelines ?? {};
	for (const [pipelineName, pipelineConfig] of Object.entries(pipelines)) {
		const pipelinePath = `pipelines.${pipelineName}`;

		// Unknown pipeline name
		if (pipelineCatalogue !== null && !pipelineCatalogue.includes(pipelineName)) {
			issue(
				true,
				"UNKNOWN_PIPELINE",
				`Unknown pipeline name "${pipelineName}" — not in .forge/config.json`,
				pipelinePath,
			);
		} else if (pipelineCatalogue === null) {
			issue(
				false,
				"UNKNOWN_PIPELINE",
				`Pipeline name "${pipelineName}" could not be verified — no .forge/config.json found`,
				pipelinePath,
			);
		}

		// Per-pipeline persona-models entries
		const pipelinePersonaModels = pipelineConfig["persona-models"] ?? {};
		for (const [key, value] of Object.entries(pipelinePersonaModels)) {
			const entryPath = `${pipelinePath}.persona-models.${key}`;
			if (key !== "default" && !personaCatalogue.includes(key)) {
				issue(strict, "UNKNOWN_PERSONA", `Unknown persona name "${key}" in pipeline "${pipelineName}"`, entryPath);
			}
			if (!isAvailable(value, availableModels)) {
				issue(
					strict,
					"MODEL_UNAVAILABLE",
					`${modelKey(value)} (pipeline "${pipelineName}", persona "${key}") is not available`,
					entryPath,
				);
			}
		}

		// Per-phase model-override validation
		const phases = pipelineConfig.phases ?? {};
		for (const [role, phase] of Object.entries(phases)) {
			const override = phase["model-override"];
			if (override === undefined) continue;

			const phasePath = `${pipelinePath}.phases.${role}.model-override`;

			if (typeof override === "string") {
				// Named persona-model key — must resolve via the cascade
				const resolved = lookupPersonaModel(override, pipelineName, merged);
				if (resolved.source === "missing") {
					issue(
						true,
						"UNRESOLVABLE_OVERRIDE",
						`phases.${role}.model-override "${override}" in pipeline "${pipelineName}" does not resolve to any persona-model`,
						phasePath,
					);
				} else if (resolved.model && !isAvailable(resolved.model as PersonaModel, availableModels)) {
					issue(
						strict,
						"MODEL_UNAVAILABLE",
						`${modelKey(resolved.model as PersonaModel)} (override "${override}" in pipeline "${pipelineName}", phase "${role}") is not available`,
						phasePath,
					);
				}
			} else {
				// Inline {provider, model} object — check availability only
				if (!isAvailable(override, availableModels)) {
					issue(
						strict,
						"MODEL_UNAVAILABLE",
						`${modelKey(override)} (inline override in pipeline "${pipelineName}", phase "${role}") is not available`,
						phasePath,
					);
				}
			}
		}
	}

	return { errors, warnings };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

interface PersonaEntry {
	key: string;
	value: PersonaModel;
	path: string;
}

/**
 * Collect all persona-model entries across global and project layers,
 * deduplicating by key (project wins, same as the merge in config-layer.ts).
 * Returns one entry per unique key, with the winning layer's path annotation.
 */
function collectPersonaEntries(merged: MergedConfig): PersonaEntry[] {
	const seen = new Map<string, PersonaEntry>();

	function add(key: string, value: PersonaModel, layer: string): void {
		// project layer overwrites global layer (project wins)
		if (!seen.has(key) || layer.startsWith("project")) {
			seen.set(key, { key, value, path: `${layer}.persona-models.${key}` });
		}
	}

	const global = merged._global?.["persona-models"] ?? {};
	for (const [key, value] of Object.entries(global)) {
		add(key, value, "global");
	}

	const project = merged._project?.["persona-models"] ?? {};
	for (const [key, value] of Object.entries(project)) {
		add(key, value, "project");
	}

	return Array.from(seen.values());
}
