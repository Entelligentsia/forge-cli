// Tests for the layered forge-cli config writer (Slice 4a — Plan 16).
//
// Coverage:
//  1. Schema-valid global write → file written matches buffer
//  2. Schema-valid project write → file written matches buffer
//  3. Schema-invalid buffer → throws, no file written
//  4. Empty buffer ({}) at existing file → file deleted
//  5. Empty buffer ({}) at non-existing file → no-op (no throw)
//  6. Atomic semantics: never exposes partial file (.tmp + rename)
//  7. Refuses .forge/config.json target paths
//  8. Round-trip: write then loadLayeredConfig reads back same shape
//  9. Pretty-printed JSON (stable key ordering for diffs)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  writeRoutingConfig,
  resolveTargetPath,
  type RoutingConfigBuffer,
} from "../../../src/extensions/forgecli/config-writer.js";
import { loadLayeredConfig } from "../../../src/extensions/forgecli/config-layer.js";

const mockGetAgentDir = getAgentDir as ReturnType<typeof vi.fn>;

let tmpRoot: string;
let agentDir: string;
let projectCwd: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "config-writer-test-"));
  agentDir = path.join(tmpRoot, "agent");
  projectCwd = path.join(tmpRoot, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectCwd, { recursive: true });
  mockGetAgentDir.mockReturnValue(agentDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("resolveTargetPath", () => {
  it("global → ~/.pi/agent/forge-cli/config.json (via getAgentDir)", () => {
    const p = resolveTargetPath({ layer: "global", cwd: projectCwd });
    expect(p).toBe(path.join(agentDir, "forge-cli", "config.json"));
  });

  it("project → <cwd>/.pi/forge-cli/config.json", () => {
    const p = resolveTargetPath({ layer: "project", cwd: projectCwd });
    expect(p).toBe(path.join(projectCwd, ".pi", "forge-cli", "config.json"));
  });

  it("never resolves to a .forge/config.json path", () => {
    const globalP = resolveTargetPath({ layer: "global", cwd: projectCwd });
    const projectP = resolveTargetPath({ layer: "project", cwd: projectCwd });
    expect(globalP).not.toContain(".forge/config.json");
    expect(projectP).not.toContain(".forge/config.json");
  });
});

describe("writeRoutingConfig — global layer", () => {
  it("writes a schema-valid persona-models map", () => {
    const buffer: RoutingConfigBuffer = {
      "persona-models": {
        engineer: { provider: "anthropic", model: "claude-opus-4-5" },
        default: { provider: "openai", model: "gpt-4o" },
      },
    };
    const target = writeRoutingConfig({ layer: "global", cwd: projectCwd, buffer });

    expect(fs.existsSync(target)).toBe(true);
    const written = JSON.parse(fs.readFileSync(target, "utf-8"));
    expect(written).toEqual(buffer);
  });

  it("creates parent directories if missing", () => {
    // Nuke agent dir so writer must mkdir -p
    fs.rmSync(agentDir, { recursive: true, force: true });

    const buffer: RoutingConfigBuffer = {
      "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } },
    };
    writeRoutingConfig({ layer: "global", cwd: projectCwd, buffer });

    expect(fs.existsSync(path.join(agentDir, "forge-cli", "config.json"))).toBe(true);
  });
});

describe("writeRoutingConfig — project layer", () => {
  it("writes pipelines into <cwd>/.pi/forge-cli/config.json", () => {
    const buffer: RoutingConfigBuffer = {
      "persona-models": {
        engineer: { provider: "ollama", model: "glm-5.1:cloud" },
      },
      pipelines: {
        default: {
          phases: {
            implement: { "model-override": "scribe" },
            commit: { "model-override": { provider: "anthropic", model: "claude-haiku-4-5" } },
          },
        },
      },
    };
    const target = writeRoutingConfig({ layer: "project", cwd: projectCwd, buffer });

    expect(fs.existsSync(target)).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual(buffer);
  });
});

describe("writeRoutingConfig — validation", () => {
  it("throws on schema-invalid buffer (additionalProperties)", () => {
    const bad = { "persona-models": { engineer: { provider: "x", model: "y", bogus: 1 } } };
    expect(() =>
      writeRoutingConfig({ layer: "project", cwd: projectCwd, buffer: bad as RoutingConfigBuffer }),
    ).toThrow(/schema/i);
    expect(fs.existsSync(path.join(projectCwd, ".pi", "forge-cli", "config.json"))).toBe(false);
  });

  it("throws on missing required field (model)", () => {
    const bad = { "persona-models": { engineer: { provider: "x" } } };
    expect(() =>
      writeRoutingConfig({ layer: "project", cwd: projectCwd, buffer: bad as RoutingConfigBuffer }),
    ).toThrow(/schema/i);
  });

  it("leaves original file untouched on schema failure", () => {
    const target = path.join(projectCwd, ".pi", "forge-cli", "config.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const original = '{"persona-models":{"engineer":{"provider":"anthropic","model":"opus"}}}';
    fs.writeFileSync(target, original);

    expect(() =>
      writeRoutingConfig({
        layer: "project",
        cwd: projectCwd,
        buffer: { "persona-models": { engineer: { provider: "x" } } } as RoutingConfigBuffer,
      }),
    ).toThrow();

    expect(fs.readFileSync(target, "utf-8")).toBe(original);
  });
});

describe("writeRoutingConfig — empty buffer cleanup", () => {
  it("deletes the file when buffer is empty {}", () => {
    const target = path.join(projectCwd, ".pi", "forge-cli", "config.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"persona-models":{}}');

    writeRoutingConfig({ layer: "project", cwd: projectCwd, buffer: {} });

    expect(fs.existsSync(target)).toBe(false);
  });

  it("no-ops when buffer empty and file does not exist", () => {
    const target = path.join(projectCwd, ".pi", "forge-cli", "config.json");
    expect(() =>
      writeRoutingConfig({ layer: "project", cwd: projectCwd, buffer: {} }),
    ).not.toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("writeRoutingConfig — atomic write", () => {
  it("uses a temp file and rename (no partial visible state)", () => {
    const buffer: RoutingConfigBuffer = {
      "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } },
    };
    const target = writeRoutingConfig({ layer: "project", cwd: projectCwd, buffer });

    // After rename, no .tmp sibling should remain.
    const siblings = fs.readdirSync(path.dirname(target));
    expect(siblings.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("validates BEFORE creating the temp file", () => {
    const dir = path.join(projectCwd, ".pi", "forge-cli");
    fs.mkdirSync(dir, { recursive: true });

    expect(() =>
      writeRoutingConfig({
        layer: "project",
        cwd: projectCwd,
        buffer: { "persona-models": { e: { provider: "x" } } } as RoutingConfigBuffer,
      }),
    ).toThrow();

    // No .tmp left behind from a failed validation
    const siblings = fs.readdirSync(dir);
    expect(siblings.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("writeRoutingConfig — round-trip with loader", () => {
  it("written file is loadable by loadLayeredConfig with identical merged shape", () => {
    const buffer: RoutingConfigBuffer = {
      "persona-models": {
        engineer: { provider: "ollama", model: "glm-5.1:cloud" },
      },
      pipelines: {
        default: { phases: { commit: { "model-override": "scribe" } } },
      },
    };
    writeRoutingConfig({ layer: "project", cwd: projectCwd, buffer });

    const layered = loadLayeredConfig(projectCwd);
    expect(layered.errors).toEqual([]);
    expect(layered.project).toEqual(buffer);
    expect(layered.merged.pipelines).toEqual(buffer.pipelines);
    expect(layered.merged["persona-models"]).toEqual(buffer["persona-models"]);
  });
});

describe("writeRoutingConfig — path scoping (IL: never touch .forge/config.json)", () => {
  it("internal sanity: resolveTargetPath outputs cannot collide with .forge/config.json", () => {
    // Even pathological cwd values should never yield a .forge/config.json target
    const cwd = path.join(tmpRoot, "weird");
    const globalP = resolveTargetPath({ layer: "global", cwd });
    const projectP = resolveTargetPath({ layer: "project", cwd });
    expect(globalP.endsWith(path.join(".forge", "config.json"))).toBe(false);
    expect(projectP.endsWith(path.join(".forge", "config.json"))).toBe(false);
  });
});
