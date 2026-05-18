// Tests for the layered forge-cli config loader (Slice 1 — Plan 16).
//
// Coverage:
//  1. Both files missing → {global: null, project: null, merged: {}}
//  2. Global only → merged equals global
//  3. Project only → merged equals project; pipelines carried
//  4. Both → persona-models shallow-merged, project wins per key; pipelines from project
//  5. Schema-invalid global → error surfaced, project still loads
//  6. Schema-invalid project → error surfaced, global still loads
//  7. Walk-up discovery: project config located at cwd/.pi/forge-cli/config.json (cwd-direct)
//  8. PI_CODING_AGENT_DIR env var honored for global path
//  9. getAgentDir() used for global path (no reimplementation)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock getAgentDir so tests are hermetic (no ~/.pi dependency).
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: vi.fn(),
}));

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  loadLayeredConfig,
  type LayeredConfig,
} from "../../../src/extensions/forgecli/config-layer.js";

const mockGetAgentDir = getAgentDir as ReturnType<typeof vi.fn>;

let tmpRoot: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-config-layer-"));
  agentDir = path.join(tmpRoot, "agent");
  projectDir = path.join(tmpRoot, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  mockGetAgentDir.mockReturnValue(agentDir);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

function writeGlobal(content: unknown): void {
  const dir = path.join(agentDir, "forge-cli");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(content));
}

function writeProject(content: unknown): void {
  const dir = path.join(projectDir, ".pi", "forge-cli");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(content));
}

// 1. Both files missing
describe("loadLayeredConfig", () => {
  it("returns nulls and empty merged when both files are missing", () => {
    const result = loadLayeredConfig(projectDir);
    expect(result.global).toBeNull();
    expect(result.project).toBeNull();
    expect(result.merged._global).toBeNull();
    expect(result.merged._project).toBeNull();
    expect(result.merged["persona-models"]).toBeUndefined();
    expect(result.merged.pipelines).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  // 2. Global only
  it("merged equals global when only global file exists", () => {
    writeGlobal({
      "persona-models": {
        engineer: { provider: "anthropic", model: "claude-opus-4-5" },
      },
    });
    const result = loadLayeredConfig(projectDir);
    expect(result.global).not.toBeNull();
    expect(result.project).toBeNull();
    expect(result.merged["persona-models"]).toEqual({
      engineer: { provider: "anthropic", model: "claude-opus-4-5" },
    });
    expect(result.errors).toEqual([]);
  });

  // 3. Project only — merged equals project; pipelines carried
  it("merged equals project when only project file exists, pipelines carried", () => {
    writeProject({
      "persona-models": {
        engineer: { provider: "openai", model: "gpt-4o" },
      },
      pipelines: {
        default: {
          phases: [{ role: "plan" }],
        },
      },
    });
    const result = loadLayeredConfig(projectDir);
    expect(result.global).toBeNull();
    expect(result.project).not.toBeNull();
    expect(result.merged["persona-models"]).toEqual({
      engineer: { provider: "openai", model: "gpt-4o" },
    });
    expect(result.merged.pipelines?.["default"]).toBeDefined();
    expect(result.errors).toEqual([]);
  });

  // 4. Both → shallow-merge, project wins on key collision
  it("shallow-merges persona-models with project winning on key collision", () => {
    writeGlobal({
      "persona-models": {
        engineer: { provider: "anthropic", model: "claude-opus-4-5" },
        architect: { provider: "anthropic", model: "claude-opus-4-5" },
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    });
    writeProject({
      "persona-models": {
        engineer: { provider: "openai", model: "gpt-4o" },
      },
    });
    const result = loadLayeredConfig(projectDir);
    // Project's engineer wins
    expect(result.merged["persona-models"]?.["engineer"]).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
    // Global's architect survives
    expect(result.merged["persona-models"]?.["architect"]).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    // Global's default survives
    expect(result.merged["persona-models"]?.["default"]).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(result.errors).toEqual([]);
  });

  // 4b. Pipelines come only from project
  it("pipelines come only from project config, not global", () => {
    writeGlobal({
      "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } },
    });
    writeProject({
      pipelines: {
        default: {
          "persona-models": { supervisor: { provider: "openai", model: "gpt-4o" } },
          phases: [{ role: "plan" }, { role: "implement" }],
        },
      },
    });
    const result = loadLayeredConfig(projectDir);
    expect(result.merged.pipelines?.["default"]).toBeDefined();
    expect(result.merged.pipelines?.["default"]["persona-models"]?.["supervisor"]).toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  // 5. Schema-invalid global → error surfaced, project still loads
  it("surfaces schema error for invalid global but still loads project", () => {
    writeGlobal({ "persona-models": { engineer: "not-an-object" } });
    writeProject({
      "persona-models": { architect: { provider: "google", model: "gemini-2.5-flash" } },
    });
    const result = loadLayeredConfig(projectDir);
    expect(result.global).toBeNull();
    expect(result.project).not.toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/global/i);
    // Project still loaded into merged
    expect(result.merged["persona-models"]?.["architect"]).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });

  // 6. Schema-invalid project → error surfaced, global still loads
  it("surfaces schema error for invalid project but still loads global", () => {
    writeGlobal({
      "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } },
    });
    writeProject({ unknownTopLevelKey: true });
    const result = loadLayeredConfig(projectDir);
    expect(result.global).not.toBeNull();
    expect(result.project).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/project/i);
    // Global still in merged
    expect(result.merged["persona-models"]?.["engineer"]).toBeDefined();
  });

  // 7. Project config located at cwd/.pi/forge-cli/config.json (cwd-direct, no walk-up)
  it("finds project config at cwd/.pi/forge-cli/config.json directly (no walk-up)", () => {
    const subDir = path.join(projectDir, "subdir", "deep");
    fs.mkdirSync(subDir, { recursive: true });
    // Config at projectDir root — NOT in subDir
    writeProject({
      "persona-models": { engineer: { provider: "openai", model: "gpt-4o" } },
    });
    // Running from subDir: no walk-up, project config absent
    const resultFromSub = loadLayeredConfig(subDir);
    expect(resultFromSub.project).toBeNull();
    // Running from projectDir: found
    const resultFromRoot = loadLayeredConfig(projectDir);
    expect(resultFromRoot.project).not.toBeNull();
  });

  // 8. PI_CODING_AGENT_DIR honored: getAgentDir() is called (not reimplemented)
  it("calls getAgentDir() to resolve global config path", () => {
    const customAgentDir = path.join(tmpRoot, "custom-agent-dir");
    fs.mkdirSync(path.join(customAgentDir, "forge-cli"), { recursive: true });
    fs.writeFileSync(
      path.join(customAgentDir, "forge-cli", "config.json"),
      JSON.stringify({ "persona-models": { scribe: { provider: "google", model: "gemini-2.5-flash" } } }),
    );
    mockGetAgentDir.mockReturnValue(customAgentDir);

    const result = loadLayeredConfig(projectDir);
    expect(mockGetAgentDir).toHaveBeenCalled();
    expect(result.global).not.toBeNull();
    expect(result.merged["persona-models"]?.["scribe"]).toEqual({
      provider: "google",
      model: "gemini-2.5-flash",
    });
  });

  // 9. Empty config files → empty merged
  it("returns empty persona-models and pipelines for empty config objects", () => {
    writeGlobal({});
    writeProject({});
    const result = loadLayeredConfig(projectDir);
    // Both are schema-valid empty objects — no errors
    expect(result.errors).toEqual([]);
    expect(result.merged["persona-models"]).toBeUndefined();
    expect(result.merged.pipelines).toBeUndefined();
  });
});
