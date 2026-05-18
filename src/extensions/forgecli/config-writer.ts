// Atomic, schema-validated writer for forge-cli routing config files.
//
// Plan 16, Slice 4a. Writes ONLY to:
//   - global layer (L1) → join(getAgentDir(), "forge-cli", "config.json")
//   - project layer (L2/L3/L4) → join(cwd, ".pi", "forge-cli", "config.json")
//
// Never writes to .forge/config.json — that's the plugin's pipeline catalogue,
// read-only from this TUI.
//
// Write protocol:
//   1. Validate buffer against forge-cli-schema.json. Throw on fail.
//   2. If buffer is empty ({}) and target file exists → unlink. Return target.
//   3. Otherwise: write to <target>.tmp, fsync, rename atomically to <target>.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import schema from "./forge-cli-schema.json" with { type: "json" };
import type { PersonaModelsMap, PipelineConfig } from "./config-layer.js";

export type ConfigLayer = "global" | "project";

export interface RoutingConfigBuffer {
  "persona-models"?: PersonaModelsMap;
  pipelines?: Record<string, PipelineConfig>;
}

export interface WriteOptions {
  layer: ConfigLayer;
  cwd: string;
  buffer: RoutingConfigBuffer;
}

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

export function resolveTargetPath(opts: { layer: ConfigLayer; cwd: string }): string {
  if (opts.layer === "global") {
    return path.join(getAgentDir(), "forge-cli", "config.json");
  }
  return path.join(opts.cwd, ".pi", "forge-cli", "config.json");
}

function isEmpty(buffer: RoutingConfigBuffer): boolean {
  const personaCount = Object.keys(buffer["persona-models"] ?? {}).length;
  const pipelineCount = Object.keys(buffer.pipelines ?? {}).length;
  return personaCount === 0 && pipelineCount === 0;
}

export function writeRoutingConfig(opts: WriteOptions): string {
  const target = resolveTargetPath(opts);

  // Empty buffer → delete file if present.
  if (isEmpty(opts.buffer)) {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    return target;
  }

  // Validate FIRST. Any failure short-circuits before touching the filesystem.
  const ok = validate(opts.buffer);
  if (!ok) {
    const messages =
      validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") ?? "unknown";
    throw new Error(`forge-cli config schema error: ${messages}`);
  }

  // Ensure parent dir exists.
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Atomic write: temp file + rename. Pretty-print for human-readable diffs.
  const tmpPath = `${target}.tmp`;
  const serialized = `${JSON.stringify(opts.buffer, null, 2)}\n`;

  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, serialized);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, target);

  return target;
}
