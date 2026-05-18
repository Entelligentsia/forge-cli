// Shared entrypoint for the forge config TUI / show routes.
//
// Plan 16 Slice 4a. Both surfaces — `forge config` (bin) and `/forge:config`
// (in-session pi command) — call into this module. Slice 4a wires:
//   - arg parsing (top-menu | show | edit persona | edit override)
//   - show route delegating to the existing runConfigShow (Slice 3)
//   - stub responses for interactive routes (real screens land in 4b/4c)

import { parseConfigArgs, runConfigShow } from "../../../bin/config.js";

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
 * Caller-provided interaction surface. Both bin and pi-extension wrap this
 * differently — the bin uses stdout/stderr writers; the extension passes a
 * notify-capable ctx and a write that goes to nowhere.
 */
export interface ConfigTuiCallbacks {
  write: (line: string) => void;
  writeErr?: (line: string) => void;
  /** Present only when invoked inside a pi session (TUI mount available). */
  ctx?: {
    notify: (msg: string, level?: string) => void;
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
    // Delegate to the existing Slice 3 implementation. parseConfigArgs takes the
    // legacy ["show", ...flags] form.
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

  if (parsed.kind === "top-menu") {
    if (cb.ctx) {
      cb.ctx.notify(
        "forge config TUI — interactive top menu lands in slice 4b. Try `forge config show --resolved` for now.",
        "info",
      );
      return 0;
    }
    for (const line of USAGE_LINES) cb.write(`${line}\n`);
    return 0;
  }

  if (parsed.kind === "edit-persona" || parsed.kind === "edit-override") {
    if (cb.ctx) {
      cb.ctx.notify(
        `forge config TUI — interactive editor lands in slice 4b/4c.`,
        "info",
      );
      return 0;
    }
    writeErr(`forge config: interactive editing requires a pi session (slice 4b/4c).\n`);
    return 1;
  }

  // Exhaustiveness — TS treats parsed as `never` here
  return 1;
}
