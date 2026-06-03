import * as fs from "node:fs";
import AjvModule from "ajv";
import schema from "./forge-cli-schema.json" with { type: "json" };
import { getGlobalConfigPath, getProjectConfigPath } from "./paths/paths.js";

// Ajv v8 ESM interop: default export is a namespace holder;
// the actual constructor lives at .Ajv or .default.Ajv.
const Ajv = (AjvModule as any).default?.Ajv ?? (AjvModule as any).Ajv ?? AjvModule;

export interface PersonaModel {
	provider: string;
	model: string;
	description?: string;
}

export type PersonaModelsMap = Record<string, PersonaModel>;

export interface PhaseConfig {
	"model-override"?: string | PersonaModel;
}

export interface PipelineConfig {
	"persona-models"?: PersonaModelsMap;
	/** Phase overrides keyed by role string. */
	phases?: Record<string, PhaseConfig>;
}

export interface SkillCurationConfig {
	/**
	 * FORGE-S24 SKILL-CURATION pipeline rollout flag. Default false.
	 * When false, the four T08–T11 modules (skill-retriever, skill-usage-tracker,
	 * skill-curator-subagent, friction-emit) no-op at entry. Wired into the
	 * orchestrator handlers (run-task / fix-bug) so a flag-off run is
	 * byte-identical to pre-FORGE-S24 behaviour.
	 */
	enabled?: boolean;
}

export interface ForgeCliFeatureFlags {
	skillCuration?: SkillCurationConfig;
}

export interface GlobalConfig {
	"persona-models"?: PersonaModelsMap;
	forgeCli?: ForgeCliFeatureFlags;
	/**
	 * FORGE-S26-T18: optional advisor model for halt-recovery advisory.
	 * When present, the halt advisor spawns on this model instead of
	 * falling back to modelRegistry.getAvailable()[0].
	 */
	advisorModel?: PersonaModel;
}

export interface ProjectConfig {
	"persona-models"?: PersonaModelsMap;
	forgeCli?: ForgeCliFeatureFlags;
	pipelines?: Record<string, PipelineConfig>;
	/**
	 * FORGE-S26-T18: optional per-project advisor model override.
	 * Project config (L2) wins over global config (L1).
	 */
	advisorModel?: PersonaModel;
}

// MergedConfig carries both the merged view and per-layer provenance for the resolver.
export interface MergedConfig {
	/** Shallow-merged persona-models (project wins on key collision). */
	"persona-models"?: PersonaModelsMap;
	/** Project-only pipelines (L3/L4 config lives here). */
	pipelines?: Record<string, PipelineConfig>;
	/**
	 * Resolved advisor model (project wins over global; same L2>L1 precedence).
	 * Used by halt-recovery advisor (FORGE-S26-T18).
	 */
	advisorModel?: PersonaModel;
	/** The raw global config for L1 lookups — null if absent or invalid. */
	_global: GlobalConfig | null;
	/** The raw project config for L2 lookups — null if absent or invalid. */
	_project: ProjectConfig | null;
}

export interface LayeredConfig {
	global: GlobalConfig | null;
	project: ProjectConfig | null;
	merged: MergedConfig;
	errors: string[];
}

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

function validateConfig(
	raw: unknown,
	label: string,
): { valid: true; data: GlobalConfig & ProjectConfig } | { valid: false; error: string } {
	const ok = validate(raw);
	if (!ok) {
		const messages =
			validate.errors
				?.map((e: { instancePath?: string; message?: string }) => `${e.instancePath || "/"} ${e.message}`)
				.join("; ") ?? "unknown";
		return { valid: false, error: `forge-cli ${label} config schema error: ${messages}` };
	}
	return { valid: true, data: raw as GlobalConfig & ProjectConfig };
}

function readJsonFile(filePath: string): unknown | null {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch (_err: unknown) {
		return null;
	}
}

export function loadLayeredConfig(cwd: string): LayeredConfig {
	const errors: string[] = [];

	const globalPath = getGlobalConfigPath();
	const projectPath = getProjectConfigPath(cwd);

	let globalConfig: GlobalConfig | null = null;
	let projectConfig: ProjectConfig | null = null;

	const rawGlobal = readJsonFile(globalPath);
	if (rawGlobal !== null) {
		const result = validateConfig(rawGlobal, "global");
		if (result.valid) {
			globalConfig = result.data;
		} else {
			errors.push(result.error);
		}
	}

	const rawProject = readJsonFile(projectPath);
	if (rawProject !== null) {
		const result = validateConfig(rawProject, "project");
		if (result.valid) {
			projectConfig = result.data;
		} else {
			errors.push(result.error);
		}
	}

	// Shallow-merge persona-models: global first, project overwrites per key
	const mergedPersonaModels: PersonaModelsMap = {
		...(globalConfig?.["persona-models"] ?? {}),
		...(projectConfig?.["persona-models"] ?? {}),
	};

	const merged: MergedConfig = {
		_global: globalConfig,
		_project: projectConfig,
	};

	if (Object.keys(mergedPersonaModels).length > 0) {
		merged["persona-models"] = mergedPersonaModels;
	}

	// Pipelines are project-only (global config is project-agnostic)
	if (projectConfig?.pipelines) {
		merged.pipelines = projectConfig.pipelines;
	}

	// advisorModel: project (L2) wins over global (L1)
	const advisorModel = projectConfig?.advisorModel ?? globalConfig?.advisorModel;
	if (advisorModel) {
		merged.advisorModel = advisorModel;
	}

	return { global: globalConfig, project: projectConfig, merged, errors };
}
