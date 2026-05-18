// Shared entrypoint for the forge config TUI / show routes.
//
// Plan 16 Slice 4a+4b. Both surfaces — `forge config` (bin) and `/forge:config`
// (in-session pi command) — call into this module.
//
// Slice 4a wired: arg parsing, show-route delegation, stub responses for
// interactive routes.
// Slice 4b wires: top-menu and edit-persona routes mount the TUI via
// cb.ctx.mountConfigTui (supplied by the pi-extension wrapper). The bin path
// stays non-interactive (no ctx) and prints a friendly fallback.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigArgs, runConfigShow } from "../../../bin/config.js";
import { loadLayeredConfig } from "../config-layer.js";
import type { AvailableModel, InitOptions } from "./state.js";

export type ConfigTuiRoute =
  | { kind: "top-menu" }
  | { kind: "show"; resolved: boolean; json: boolean }
  | { kind: "edit-persona"; persona: string }
  | { kind: "edit-override"; pipeline: string; phaseIndex: number };

export interface ConfigTuiArgsError {
  error: string;
}

export type ParseConfigTuiResult = ConfigTuiRoute | ConfigTuiArgsError;

export function parseConfigTuiArgs(args: string[]): ParseConfigTuiResult {
  if (args.length === 0) {
    return { kind: "top-menu" };
  }

  const [head, ...rest] = args;

  if (head === "show") {
    let resolved = false;
    let json = false;
    for (const flag of rest) {
      if (flag === "--resolved") { resolved = true; continue; }
      if (flag === "--json") { json = true; continue; }
      return { error: `forge config show: unknown flag "${flag}"` };
    }
    return { kind: "show", resolved, json };
  }

  if (head === "edit") {
    const [target, ...editRest] = rest;
    if (target === "persona") {
      const persona = editRest[0];
      if (!persona) {
        return { error: `forge config edit persona: missing persona name` };
      }
      return { kind: "edit-persona", persona };
    }
    if (target === "override") {
      const pipeline = editRest[0];
      const phaseStr = editRest[1];
      if (!pipeline || !phaseStr) {
        return {
          error: `forge config edit override: usage "edit override <pipeline> <phaseIndex>"`,
        };
      }
      const phaseIndex = Number.parseInt(phaseStr, 10);
      if (!Number.isInteger(phaseIndex) || phaseIndex < 0) {
        return { error: `forge config edit override: phaseIndex must be a non-negative integer` };
      }
      return { kind: "edit-override", pipeline, phaseIndex };
    }
    return { error: `forge config edit: unknown target "${target ?? ""}" (try "persona" or "override")` };
  }

  return {
    error:
      `forge config: unknown subcommand "${head}". Try: forge config [show [--resolved] [--json] | edit persona <name> | edit override <pipeline> <phaseIndex>]`,
  };
}

/**
 * Caller-provided interaction surface. The pi-extension wrapper supplies
 * `ctx.mountConfigTui` to give us TUI access; the bin surface omits it (and
 * gets a non-interactive fallback message).
 */
export interface ConfigTuiCallbacks {
  write: (line: string) => void;
  writeErr?: (line: string) => void;
  /** Present only when invoked inside a pi session (TUI mount available). */
  ctx?: {
    notify: (msg: string, level?: string) => void;
    mountConfigTui?: (init: InitOptions) => Promise<number>;
  };
}

const USAGE_LINES = [
  "Usage:",
  "  forge config                              Open interactive config TUI",
  "  forge config show [--resolved] [--json]   Print routing config",
  "  forge config edit persona <name>          Edit a persona-model assignment",
  "  forge config edit override <pipeline> <phaseIndex>",
  "                                            Edit a per-phase model override",
];

// ── Helpers: read catalogues + available models ─────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPersonaCatalogue(): string[] {
  // The compiled handler lives at dist/extensions/forgecli/config-tui/handler.js;
  // the bundled personas dir is at dist/forge-payload/.base-pack/personas/. In
  // source mode (vitest), the source tree's payload may be absent — return [].
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "forge-payload", ".base-pack", "personas"),
    path.resolve(__dirname, "..", "..", "forge-payload", ".base-pack", "personas"),
  ];
  for (const dir of candidates) {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md") && !f.endsWith("-skills.md"))
        .map((f) => f.replace(/\.md$/, ""));
    } catch {
      continue;
    }
  }
  return [];
}

export function readPipelineCatalogue(cwd: string): string[] | null {
  // Forge plugin's .forge/config.json doesn't carry `pipelines` in user
  // projects — pipeline definitions live in the plugin install (forgeRoot).
  // So presence of .forge/config.json alone is the "is this a Forge project?"
  // signal. When the file exists but no pipelines key is present, fall back
  // to ["default"] (the canonical 8-phase chain consumed by run-task).
  const forgeCfgPath = path.join(cwd, ".forge", "config.json");
  if (!fs.existsSync(forgeCfgPath)) return null;
  try {
    const raw = fs.readFileSync(forgeCfgPath, "utf-8");
    const cfg = JSON.parse(raw) as unknown;
    if (cfg && typeof cfg === "object" && "pipelines" in cfg) {
      const pipelines = (cfg as { pipelines?: unknown }).pipelines;
      if (pipelines && typeof pipelines === "object") {
        const keys = Object.keys(pipelines);
        return keys.length > 0 ? keys : ["default"];
      }
    }
    return ["default"];
  } catch {
    // File exists but unreadable — still a Forge project; default pipeline applies.
    return ["default"];
  }
}

async function readAvailableModels(): Promise<{
  available: AvailableModel[];
  authenticated: string[];
}> {
  // Defer the heavy imports to call-time so vitest specs that never hit this
  // path don't pay the cost (or fail when auth.json is absent).
  const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
  try {
    const auth = AuthStorage.create();
    const registry = ModelRegistry.create(auth);
    const available: AvailableModel[] = registry
      .getAvailable()
      .map((m) => ({ provider: m.provider, id: m.id }));
    const authenticated = Array.from(new Set(available.map((m) => m.provider)));
    return { available, authenticated };
  } catch {
    return { available: [], authenticated: [] };
  }
}

async function buildInitOptions(cwd: string): Promise<InitOptions> {
  const layered = loadLayeredConfig(cwd);
  const personaCatalogue = readPersonaCatalogue();
  const pipelineCatalogue = readPipelineCatalogue(cwd);
  const { available, authenticated } = await readAvailableModels();
  return {
    global: layered.global,
    project: layered.project,
    cwd,
    personaCatalogue,
    pipelineCatalogue,
    availableModels: available,
    authenticatedProviders: authenticated,
  };
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function runConfigTui(
  args: string[],
  cwd: string,
  cb: ConfigTuiCallbacks,
): Promise<number> {
  const parsed = parseConfigTuiArgs(args);
  const writeErr = cb.writeErr ?? cb.write;

  if ("error" in parsed) {
    writeErr(`${parsed.error}\n`);
    return 1;
  }

  if (parsed.kind === "show") {
    const showArgs: string[] = ["show"];
    if (parsed.resolved) showArgs.push("--resolved");
    if (parsed.json) showArgs.push("--json");
    const showParsed = parseConfigArgs(showArgs);
    if ("error" in showParsed) {
      writeErr(`${showParsed.error}\n`);
      return 1;
    }
    if (showParsed.subcommand === "usage") {
      for (const line of USAGE_LINES) cb.write(`${line}\n`);
      return 0;
    }
    return runConfigShow(showParsed, cwd, (line) => cb.write(`${line}\n`));
  }

  // Interactive routes (top-menu, edit-persona). edit-override stays a stub
  // until Slice 4c.
  if (parsed.kind === "edit-override") {
    if (cb.ctx) {
      cb.ctx.notify(`forge config: per-phase override editor lands in slice 4c.`, "info");
      return 0;
    }
    writeErr(`forge config: per-phase override editor lands in slice 4c.\n`);
    return 1;
  }

  if (parsed.kind === "top-menu" || parsed.kind === "edit-persona") {
    if (!cb.ctx?.mountConfigTui) {
      // Non-interactive surface (bin without a pi session).
      for (const line of USAGE_LINES) cb.write(`${line}\n`);
      cb.write(`\n`);
      cb.write(`Interactive TUI requires a pi session. Use \`/forge:config\` from inside pi.\n`);
      return 0;
    }
    const init = await buildInitOptions(cwd);
    return cb.ctx.mountConfigTui(init);
  }

  // Exhaustiveness — TS treats parsed as `never` here
  return 1;
}
