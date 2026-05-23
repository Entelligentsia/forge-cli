// forge config — routing config inspector (Plan 16, Slice 3).
//
// Subcommands:
//   forge config show                  Print persona-models and pipeline overrides
//   forge config show --resolved       Same, with per-entry cascade source annotation
//   forge config show --json           Machine-readable JSON output
//   forge config show --resolved --json Both
//   forge config dispatch              Per-phase dispatch trace (no LLM call)
//   forge config dispatch --json       Machine-readable JSON output
//
// This command reads from:
//   ~/.pi/forge-cli/config.json              (L1 global — post-v0.10.0 layout)
//   <cwd>/.pi/forge-cli/config.json          (L2/L3/L4 project)
//   <cwd>/.forge/config.json                 (pipeline catalogue — optional)
// All paths resolve through `../extensions/forgecli/paths/paths.ts`.
// And checks availability against the pi ModelRegistry (same as `forge doctor`).
//
// The persona catalogue is read from the bundled base-pack personas dir.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { loadLayeredConfig } from "../extensions/forgecli/config-layer.js";
import {
  ensureForgeCliPathsReady,
  getGlobalConfigPath,
  getProjectConfigPath,
  shortenPath,
} from "../extensions/forgecli/paths/paths.js";
import { lookupPersonaModel, resolveModelForPhase } from "../extensions/forgecli/model-resolver.js";
import { PHASES } from "../extensions/forgecli/run-task.js";
import { BUG_PHASES } from "../extensions/forgecli/fix-bug.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Arg parser ───────────────────────────────────────────────────────────────

export interface ConfigArgs {
  subcommand: "show" | "dispatch" | "usage";
  resolved: boolean;
  json: boolean;
  /** dispatch-only: pipeline name override (defaults to "default" for task, "fix-bug" for bug). */
  pipeline?: string;
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

  if (sub === "show") {
    let resolved = false;
    let json = false;
    for (const flag of rest) {
      if (flag === "--resolved") { resolved = true; continue; }
      if (flag === "--json") { json = true; continue; }
      return { error: `forge config show: unknown flag "${flag}"` };
    }
    return { subcommand: "show", resolved, json };
  }

  if (sub === "dispatch") {
    let json = false;
    let pipeline: string | undefined;
    for (const flag of rest) {
      if (flag === "--json") { json = true; continue; }
      if (flag.startsWith("--pipeline=")) { pipeline = flag.slice("--pipeline=".length); continue; }
      return { error: `forge config dispatch: unknown flag "${flag}"` };
    }
    return { subcommand: "dispatch", resolved: false, json, pipeline };
  }

  return { error: `forge config: unknown subcommand "${sub}". Try: forge config show [--resolved] [--json] | dispatch [--pipeline=<name>] [--json]` };
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
  phases: Array<{ role: string; override: string | null; available: boolean; source: string }>;
}

// ── Main show implementation ─────────────────────────────────────────────────

type WriteFn = (line: string) => void;

export async function runConfigShow(
  opts: ConfigArgs,
  cwd: string,
  write: WriteFn,
): Promise<number> {
  const { resolved: showResolved, json } = opts;

  // N-B-E: surface schema errors informally; exit 0 (CLI inspector stays useful even with a broken config).
  // See doc/decisions/layered-config-error-policy.md.
  const layeredShow = loadLayeredConfig(cwd);
  if (layeredShow.errors.length > 0) {
    for (const e of layeredShow.errors) {
      write(`⚠ forge config: schema error — ${e}`);
    }
  }
  const { merged } = layeredShow;
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
      write(`Create ${shortenPath(getGlobalConfigPath())} or ${getProjectConfigPath(cwd)}`);
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

    const phasesOutput = Object.entries(pipelineCfg.phases ?? {}).map(([role, phase]) => {
      const override = phase["model-override"];
      if (!override) return { role, override: null, available: true, source: "inherit" };
      if (typeof override === "string") {
        return { role, override, available: true, source: "L4-name" };
      }
      const isAvail = available.some(
        (m) => m.provider === override.provider && m.id === override.model,
      );
      return {
        role,
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
          write(`    phase[${phase.role}]  →  ${phase.override}  ${badge}  ${phase.source}`);
        }
      }
    }
    write("");
  }

  return 0;
}

// ── dispatch — per-phase trace, no LLM call ─────────────────────────────────

export interface DispatchPhaseRow {
  pipeline: "default" | "fix-bug";
  phaseRole: string;
  persona: string;
  requested: { provider: string; model: string } | null;
  source: string;
  /** True if pi.modelRegistry.find(provider, model) returns a Model — i.e. setModel
   *  will actually take effect at dispatch time. False = will silently fall through
   *  to pi's current model.
   */
  registered: boolean | null;
  /** When registered === true, the exact id the registry returned. May differ from
   *  `requested.model` if pi aliases (e.g. "claude-haiku-4-5" → "claude-haiku-4-5-20251001").
   */
  registryId: string | null;
}

export interface DispatchOutput {
  cwd: string;
  taskPipeline: string;
  taskPhases: DispatchPhaseRow[];
  bugPhases: DispatchPhaseRow[];
}

/**
 * Walk run-task's PHASES and fix-bug's BUG_PHASES; for each, compute the requested
 * model via the same resolveModelForPhase the orchestrator uses, and verify that
 * pi's ModelRegistry can resolve the requested id. Prints a table or JSON.
 *
 * No LLM call. No pi session. Pure inspection.
 */
export function runConfigDispatch(
  args: ConfigArgs,
  cwd: string,
  write: (line: string) => void,
): number {
  const taskPipeline = args.pipeline ?? "default";
  const bugPipeline = "fix-bug";

  // N-B-E: surface schema errors informally; exit 0 (CLI inspector stays useful even with a broken config).
  // See doc/decisions/layered-config-error-policy.md.
  const layeredDispatch = loadLayeredConfig(cwd);
  if (layeredDispatch.errors.length > 0) {
    for (const e of layeredDispatch.errors) {
      write(`⚠ forge config: schema error — ${e}`);
    }
  }
  const { merged } = layeredDispatch;
  const registry = ModelRegistry.create(AuthStorage.create());

  const traceOne = (
    pipelineName: "default" | "fix-bug",
    phaseRole: string,
    personaNoun: string,
  ): DispatchPhaseRow => {
    const res = resolveModelForPhase(pipelineName, phaseRole, personaNoun, merged);
    if (!res.model) {
      return {
        pipeline: pipelineName,
        phaseRole,
        persona: personaNoun,
        requested: null,
        source: res.source,
        registered: null,
        registryId: null,
      };
    }
    const found = registry.find?.(res.model.provider, res.model.model);
    return {
      pipeline: pipelineName,
      phaseRole,
      persona: personaNoun,
      requested: { provider: res.model.provider, model: res.model.model },
      source: res.source,
      registered: !!found,
      registryId: found?.id ?? null,
    };
  };

  const taskPhases: DispatchPhaseRow[] = PHASES.map((p) =>
    traceOne(taskPipeline as "default" | "fix-bug", p.role, p.personaNoun),
  );
  const bugPhases: DispatchPhaseRow[] = BUG_PHASES.map((p) =>
    traceOne(bugPipeline, p.role, p.personaNoun),
  );

  if (args.json) {
    const out: DispatchOutput = { cwd, taskPipeline, taskPhases, bugPhases };
    write(JSON.stringify(out, null, 2));
    return 0;
  }

  // Human-readable table.
  const fmt = (row: DispatchPhaseRow): string => {
    const req = row.requested
      ? `${row.requested.provider}:${row.requested.model}`
      : "(inherit pi current)";
    let find: string;
    if (row.registered === null) {
      find = "(skipped — setModel not called)";
    } else if (row.registered) {
      find = `✓ ${row.registryId}`;
    } else {
      find = `✗ MISS — setModel will silently inherit pi current`;
    }
    return `${row.phaseRole.padEnd(13)} ${row.persona.padEnd(16)} ${req.padEnd(36)} ${find}`;
  };

  write(`forge config dispatch — cwd=${cwd}`);
  write("");
  write("Note: this trace uses the baseline ModelRegistry built from AuthStorage");
  write("only — it does NOT see providers that get registered by extensions at");
  write("session start (ollama-cloud, openrouter, …). Inside a live forge session");
  write("runForgeSubagent now uses ctx.modelRegistry, which does see them. A MISS");
  write("here means the model is extension-registered, not that dispatch will fail.");
  write("");
  write(`── run-task PHASES (pipeline: ${taskPipeline}) ─────────────────────────────`);
  write("phase         persona          requested                            registry.find");
  write("─────         ───────          ─────────                            ─────────────");
  for (const row of taskPhases) write(fmt(row));
  write("");
  write(`── fix-bug BUG_PHASES (pipeline: ${bugPipeline}) ───────────────────────────`);
  write("phase         persona          requested                            registry.find");
  write("─────         ───────          ─────────                            ─────────────");
  for (const row of bugPhases) write(fmt(row));
  write("");
  write("source map (raw resolver):");
  for (const row of taskPhases) {
    write(`  task[${row.phaseRole.padEnd(13)}] ${row.source}`);
  }
  for (const row of bugPhases) {
    write(`  bug [${row.phaseRole.padEnd(13)}] ${row.source}`);
  }

  return 0;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function runConfig(args: string[], cwd: string = process.cwd()): Promise<number> {
  // Trigger one-shot user-data layout migration so subsequent path reads
  // resolve to the post-v0.10.0 layout (FORGE-S20-T11).
  ensureForgeCliPathsReady();
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
