// forge config — routing config inspector (Plan 16, Slice 3).
//
// Subcommands:
//   forge config show                  Print persona-models and pipeline overrides
//   forge config show --resolved       Same, with per-entry cascade source annotation
//   forge config show --json           Machine-readable JSON output
//   forge config show --resolved --json Both
//
// This command reads from:
//   ~/.pi/agent/forge-cli/config.json        (L1 global)
//   <cwd>/.pi/forge-cli/config.json          (L2/L3/L4 project)
//   <cwd>/.forge/config.json                 (pipeline catalogue — optional)
// And checks availability against the pi ModelRegistry (same as `forge doctor`).
//
// The persona catalogue is read from the bundled base-pack personas dir.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadLayeredConfig } from "../extensions/forgecli/config-layer.js";
import { lookupPersonaModel } from "../extensions/forgecli/model-resolver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Arg parser ───────────────────────────────────────────────────────────────

export interface ConfigArgs {
  subcommand: "show" | "usage";
  resolved: boolean;
  json: boolean;
}

export interface ConfigArgsError {
  error: string;
}

export type ParseConfigResult = ConfigArgs | ConfigArgsError;

export function parseConfigArgs(args: string[]): ParseConfigResult {
  if (args.length === 0) {
    return { subcommand: "usage", resolved: false, json: false };
  }

  const [sub, ...rest] = args;

  if (sub !== "show") {
    return { error: `forge config: unknown subcommand "${sub}". Try: forge config show [--resolved] [--json]` };
  }

  let resolved = false;
  let json = false;
  for (const flag of rest) {
    if (flag === "--resolved") { resolved = true; continue; }
    if (flag === "--json") { json = true; continue; }
    return { error: `forge config show: unknown flag "${flag}"` };
  }

  return { subcommand: "show", resolved, json };
}

// ── Persona catalogue ────────────────────────────────────────────────────────

function readPersonaCatalogue(): string[] {
  const personasDir = path.resolve(__dirname, "..", "forge-payload", ".base-pack", "personas");
  try {
    return fs.readdirSync(personasDir)
      .filter((f) => f.endsWith(".md") && !f.endsWith("-skills.md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

// ── Pipeline catalogue from .forge/config.json ───────────────────────────────

function readPipelineCatalogue(cwd: string): string[] | null {
  const forgeCfgPath = path.join(cwd, ".forge", "config.json");
  try {
    const raw = fs.readFileSync(forgeCfgPath, "utf-8");
    const cfg = JSON.parse(raw) as unknown;
    if (cfg && typeof cfg === "object" && "pipelines" in cfg) {
      const pipelines = (cfg as { pipelines?: unknown }).pipelines;
      if (pipelines && typeof pipelines === "object") {
        return Object.keys(pipelines);
      }
      return [];
    }
    return null;
  } catch {
    return null;
  }
}

// ── Output types ─────────────────────────────────────────────────────────────

export interface PersonaModelEntry {
  persona: string;
  provider: string;
  model: string;
  available: boolean;
  source: string;
}

export interface ConfigShowOutput {
  personaModels: Record<string, PersonaModelEntry>;
  pipelines: Record<string, PipelineShowOutput>;
}

export interface PipelineShowOutput {
  personaModels: Record<string, PersonaModelEntry>;
  phases: Array<{ index: number; override: string | null; available: boolean; source: string }>;
}

// ── Main show implementation ─────────────────────────────────────────────────

type WriteFn = (line: string) => void;

export async function runConfigShow(
  opts: ConfigArgs,
  cwd: string,
  write: WriteFn,
): Promise<number> {
  const { resolved: showResolved, json } = opts;

  const { merged } = loadLayeredConfig(cwd);
  const personaCatalogue = readPersonaCatalogue();
  const pipelineCatalogue = readPipelineCatalogue(cwd);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const available = modelRegistry.getAvailable();

  const hasPersonaModels =
    merged._global?.["persona-models"] !== undefined ||
    merged._project?.["persona-models"] !== undefined;
  const hasPipelines =
    merged.pipelines !== undefined && Object.keys(merged.pipelines).length > 0;

  if (!hasPersonaModels && !hasPipelines) {
    if (json) {
      write(JSON.stringify({ personaModels: {}, pipelines: {} }, null, 2));
    } else {
      write("No forge-cli model routing config found.");
      write("");
      write("Create ~/.pi/agent/forge-cli/config.json or <project>/.pi/forge-cli/config.json");
      write("to configure persona → model routing.");
    }
    return 0;
  }

  // Build the persona entries map
  const personaModels: Record<string, PersonaModelEntry> = {};

  // Collect all persona names defined across both layers
  const allPersonaNames = new Set<string>([
    ...Object.keys(merged._global?.["persona-models"] ?? {}),
    ...Object.keys(merged._project?.["persona-models"] ?? {}),
  ]);

  for (const personaName of Array.from(allPersonaNames).sort()) {
    const lookup = lookupPersonaModel(personaName, "default", merged);
    if (!lookup.model) continue;
    const isAvail = available.some(
      (m) => m.provider === lookup.model!.provider && m.id === lookup.model!.model,
    );
    personaModels[personaName] = {
      persona: personaName,
      provider: lookup.model.provider,
      model: lookup.model.model,
      available: isAvail,
      source: lookup.source,
    };
  }

  // Build pipeline output
  const pipelinesOutput: Record<string, PipelineShowOutput> = {};
  for (const [pipelineName, pipelineCfg] of Object.entries(merged.pipelines ?? {})) {
    const pipelinePersonaModels: Record<string, PersonaModelEntry> = {};
    for (const [key, value] of Object.entries(pipelineCfg["persona-models"] ?? {})) {
      const isAvail = available.some(
        (m) => m.provider === value.provider && m.id === value.model,
      );
      pipelinePersonaModels[key] = {
        persona: key,
        provider: value.provider,
        model: value.model,
        available: isAvail,
        source: "L3",
      };
    }

    const phasesOutput = (pipelineCfg.phases ?? []).map((phase, i) => {
      const override = phase["model-override"];
      if (!override) return { index: i, override: null, available: true, source: "inherit" };
      if (typeof override === "string") {
        return { index: i, override, available: true, source: "L4-name" };
      }
      const isAvail = available.some(
        (m) => m.provider === override.provider && m.id === override.model,
      );
      return {
        index: i,
        override: `${override.provider}:${override.model}`,
        available: isAvail,
        source: "L4-inline",
      };
    });

    pipelinesOutput[pipelineName] = { personaModels: pipelinePersonaModels, phases: phasesOutput };
  }

  if (json) {
    write(JSON.stringify({ personaModels, pipelines: pipelinesOutput }, null, 2));
    return 0;
  }

  // Human-readable output
  write("forge config — model routing" + (showResolved ? " (resolved)" : ""));
  write("");

  if (Object.keys(personaModels).length > 0) {
    write("persona-models:");
    const colWidths = {
      persona: Math.max(8, ...Object.keys(personaModels).map((k) => k.length)),
      model: Math.max(5, ...Object.values(personaModels).map((e) => `${e.provider}:${e.model}`.length)),
    };

    for (const entry of Object.values(personaModels)) {
      const availBadge = entry.available ? "✓" : "✗ unavailable";
      const modelStr = `${entry.provider}:${entry.model}`;
      const personaPad = entry.persona.padEnd(colWidths.persona);
      const modelPad = modelStr.padEnd(colWidths.model);
      if (showResolved) {
        write(`  ${personaPad}  →  ${modelPad}  ${availBadge}  ${entry.source}`);
      } else {
        write(`  ${personaPad}  →  ${modelPad}  ${availBadge}`);
      }
    }
    write("");
  }

  if (pipelineCatalogue !== null && hasPipelines) {
    write("pipeline overrides:");
    for (const [pName, pOut] of Object.entries(pipelinesOutput)) {
      const inCatalogue = pipelineCatalogue.includes(pName);
      const marker = inCatalogue ? "" : " ⚠ (not in .forge/config.json)";
      write(`  [${pName}]${marker}`);
      for (const [key, entry] of Object.entries(pOut.personaModels)) {
        const badge = entry.available ? "✓" : "✗ unavailable";
        write(`    ${key}  →  ${entry.provider}:${entry.model}  ${badge}`);
      }
      for (const phase of pOut.phases) {
        if (phase.override) {
          const badge = phase.available ? "✓" : "✗ unavailable";
          write(`    phase[${phase.index}]  →  ${phase.override}  ${badge}  ${phase.source}`);
        }
      }
    }
    write("");
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runConfig(args: string[], cwd: string = process.cwd()): Promise<number> {
  // Plan 16 Slice 4b: delegate to runConfigTui so the bin and pi-extension
  // surfaces share the same argv parser + routing. The bin has no ctx, so
  // interactive subcommands print a "use /forge:config from pi" fallback.
  // Lazy import to avoid a circular dependency at module load.
  const { runConfigTui } = await import("../extensions/forgecli/config-tui/handler.js");
  return runConfigTui(args, cwd, {
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  });
}
