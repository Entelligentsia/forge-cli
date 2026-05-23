// Shared entrypoint for the forge config TUI / show routes.
//
// Plan 16 Slice 4a+4b. Both surfaces — `forge config` (bin) and `/forge:config`
// (in-session pi command) — call into this module.
//
// Slice 4a wired: arg parsing, show-route delegation, stub responses for
// interactive routes.
// Slice 4b wires: tier-menu and edit-persona routes mount the TUI via
// cb.ctx.mountConfigTui (supplied by the pi-extension wrapper). The bin path
// stays non-interactive (no ctx) and prints a friendly fallback.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfigArgs, runConfigDispatch, runConfigShow } from "../../../bin/config.js";
import { loadLayeredConfig } from "../config-layer.js";
import type { AvailableModel, InitOptions } from "./state.js";

export type ConfigTuiRoute =
  | { kind: "tier-menu" }
  | { kind: "show"; resolved: boolean; json: boolean }
  | { kind: "dispatch"; pipeline: string | undefined; json: boolean }
  | { kind: "edit-persona"; persona: string }
  | { kind: "edit-override"; pipeline: string; phaseRole: string };

export interface ConfigTuiArgsError {
  error: string;
}

export type ParseConfigTuiResult = ConfigTuiRoute | ConfigTuiArgsError;

export function parseConfigTuiArgs(args: string[]): ParseConfigTuiResult {
  if (args.length === 0) {
    return { kind: "tier-menu" };
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

  if (head === "dispatch") {
    let json = false;
    let pipeline: string | undefined;
    for (const flag of rest) {
      if (flag === "--json") { json = true; continue; }
      if (flag.startsWith("--pipeline=")) { pipeline = flag.slice("--pipeline=".length); continue; }
      return { error: `forge config dispatch: unknown flag "${flag}"` };
    }
    return { kind: "dispatch", pipeline, json };
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
      const phaseRole = editRest[1];
      if (!pipeline || !phaseRole) {
        return {
          error: `forge config edit override: usage "edit override <pipeline> <phaseRole>"`,
        };
      }
      return { kind: "edit-override", pipeline, phaseRole };
    }
    return { error: `forge config edit: unknown target "${target ?? ""}" (try "persona" or "override")` };
  }

  return {
    error:
      `forge config: unknown subcommand "${head}". Try: forge config [show [--resolved] [--json] | dispatch [--pipeline=<name>] [--json] | edit persona <name> | edit override <pipeline> <phaseRole>]`,
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
    /** The running session's ModelRegistry, which includes extension-registered
     *  providers (e.g. ollama-cloud). When provided, discover models through
     *  it instead of creating a fresh registry. */
    modelRegistry?: import("@earendil-works/pi-coding-agent").ModelRegistry;
  };
}

const USAGE_LINES = [
  "Usage:",
  "  forge config                              Open interactive config TUI",
  "  forge config show [--resolved] [--json]   Print routing config",
  "  forge config dispatch [--pipeline=<name>] [--json]",
  "                                            Per-phase dispatch trace (no LLM call)",
  "  forge config edit persona <name>          Edit a persona-model assignment",
  "  forge config edit override <pipeline> <phaseRole>",
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

async function readAvailableModels(
  sessionRegistry?: import("@earendil-works/pi-coding-agent").ModelRegistry,
): Promise<{
  available: AvailableModel[];
  authenticated: string[];
  authError: string | null;
}> {
  // Prefer the running session's ModelRegistry which includes extension-registered
  // providers (e.g. ollama-cloud). Fall back to a fresh registry for CLI use.
  let registry: import("@earendil-works/pi-coding-agent").ModelRegistry;
  if (sessionRegistry) {
    // Refresh to pick up any changes since the session started.
    sessionRegistry.refresh();
    registry = sessionRegistry;
  } else {
    const { AuthStorage, ModelRegistry } = await import("@earendil-works/pi-coding-agent");
    const auth = AuthStorage.create();
    registry = ModelRegistry.create(auth);
  }
  try {
    const available: AvailableModel[] = registry
      .getAvailable()
      .map((m) => ({ provider: m.provider, id: m.id }));
    const authenticated = Array.from(new Set(available.map((m) => m.provider)));
    return { available, authenticated, authError: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { available: [], authenticated: [], authError: `Auth discovery failed: ${msg}` };
  }
}

async function buildInitOptions(
  cwd: string,
  sessionRegistry?: import("@earendil-works/pi-coding-agent").ModelRegistry,
): Promise<InitOptions> {
  const layered = loadLayeredConfig(cwd);
  const personaCatalogue = readPersonaCatalogue();
  const pipelineCatalogue = readPipelineCatalogue(cwd);
  const { available, authenticated, authError } = await readAvailableModels(sessionRegistry);
  return {
    global: layered.global,
    project: layered.project,
    cwd,
    personaCatalogue,
    pipelineCatalogue,
    availableModels: available,
    authenticatedProviders: authenticated,
    authError: authError ?? undefined,
    configErrors: layered.errors.length > 0 ? layered.errors : undefined,
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

  if (parsed.kind === "dispatch") {
    const dispatchArgs: string[] = ["dispatch"];
    if (parsed.json) dispatchArgs.push("--json");
    if (parsed.pipeline) dispatchArgs.push(`--pipeline=${parsed.pipeline}`);
    const dispatchParsed = parseConfigArgs(dispatchArgs);
    if ("error" in dispatchParsed) {
      writeErr(`${dispatchParsed.error}\n`);
      return 1;
    }
    if (dispatchParsed.subcommand !== "dispatch") {
      writeErr(`forge config dispatch: internal arg-parsing error\n`);
      return 1;
    }
    return runConfigDispatch(dispatchParsed, cwd, (line) => cb.write(`${line}\n`));
  }

  // Interactive routes (tier-menu, edit-persona). edit-override stays a stub
  // until Slice 4c.
  if (parsed.kind === "edit-override") {
    if (cb.ctx) {
      cb.ctx.notify(`forge config: per-phase override editor lands in slice 4c.`, "info");
      return 0;
    }
    writeErr(`forge config: per-phase override editor lands in slice 4c.\n`);
    return 1;
  }

  if (parsed.kind === "tier-menu" || parsed.kind === "edit-persona") {
    if (!cb.ctx?.mountConfigTui) {
      // Non-interactive surface (bin without a pi session).
      for (const line of USAGE_LINES) cb.write(`${line}\n`);
      cb.write(`\n`);
      cb.write(`Interactive TUI requires a pi session. Use \`/forge:config\` from inside pi.\n`);
      return 0;
    }
    const init = await buildInitOptions(cwd, cb.ctx?.modelRegistry);
    return cb.ctx.mountConfigTui(init);
  }

  // Exhaustiveness — TS treats parsed as `never` here
  return 1;
}
