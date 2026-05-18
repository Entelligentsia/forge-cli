// Read-only loader for the Forge plugin's `.forge/config.json`.
//
// Plan 16 Slice 4a: the config TUI needs to render a read-only summary of the
// installed Forge plugin (version, paths, installed skills) alongside the
// forge-cli routing config it edits. This module never mutates `.forge/`.
//
// The legacy `mode` field (fast/full) is retired (see memory
// project_fast_full_mode_retired). When present, we surface it as
// modeLegacy=true so the TUI can render it as "(legacy)" without offering to
// change it.

import * as fs from "node:fs";
import * as path from "node:path";

export interface PluginConfigPaths {
  engineering?: string;
  store?: string;
  workflows?: string;
  commands?: string;
  templates?: string;
  customCommands?: string;
  forgeRoot?: string;
  forgeRef?: string;
}

export interface PluginConfigSummary {
  version: string | null;
  projectName: string | null;
  projectPrefix: string | null;
  paths: PluginConfigPaths;
  installedSkills: string[];
  forgeRef: string | null;
  /** Legacy 'mode' field if present in config.json; otherwise null. */
  mode: string | null;
  /** True iff `mode` is present (retired field; rendered as "(legacy)"). */
  modeLegacy: boolean;
}

export function readPluginConfig(cwd: string): PluginConfigSummary | null {
  const configPath = path.join(cwd, ".forge", "config.json");

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  const project = (obj.project ?? null) as Record<string, unknown> | null;
  const paths = (obj.paths ?? {}) as Record<string, unknown>;
  const installedSkills = Array.isArray(obj.installedSkills)
    ? obj.installedSkills.filter((s): s is string => typeof s === "string")
    : [];

  const mode = typeof obj.mode === "string" ? obj.mode : null;

  return {
    version: typeof obj.version === "string" ? obj.version : null,
    projectName: typeof project?.name === "string" ? (project.name as string) : null,
    projectPrefix: typeof project?.prefix === "string" ? (project.prefix as string) : null,
    paths: {
      engineering: typeof paths.engineering === "string" ? (paths.engineering as string) : undefined,
      store: typeof paths.store === "string" ? (paths.store as string) : undefined,
      workflows: typeof paths.workflows === "string" ? (paths.workflows as string) : undefined,
      commands: typeof paths.commands === "string" ? (paths.commands as string) : undefined,
      templates: typeof paths.templates === "string" ? (paths.templates as string) : undefined,
      customCommands:
        typeof paths.customCommands === "string" ? (paths.customCommands as string) : undefined,
      forgeRoot: typeof paths.forgeRoot === "string" ? (paths.forgeRoot as string) : undefined,
      forgeRef: typeof paths.forgeRef === "string" ? (paths.forgeRef as string) : undefined,
    },
    installedSkills,
    forgeRef: typeof paths.forgeRef === "string" ? (paths.forgeRef as string) : null,
    mode,
    modeLegacy: mode !== null,
  };
}
