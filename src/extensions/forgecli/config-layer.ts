import * as fs from "node:fs";
import { Ajv } from "ajv";
import { getGlobalConfigPath, getProjectConfigPath } from "./paths/paths.js";
import schema from "./forge-cli-schema.json" with { type: "json" };

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

export interface GlobalConfig {
  "persona-models"?: PersonaModelsMap;
}

export interface ProjectConfig {
  "persona-models"?: PersonaModelsMap;
  pipelines?: Record<string, PipelineConfig>;
}

// MergedConfig carries both the merged view and per-layer provenance for the resolver.
export interface MergedConfig {
  /** Shallow-merged persona-models (project wins on key collision). */
  "persona-models"?: PersonaModelsMap;
  /** Project-only pipelines (L3/L4 config lives here). */
  pipelines?: Record<string, PipelineConfig>;
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
      validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") ?? "unknown";
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

  return { global: globalConfig, project: projectConfig, merged, errors };
}
