// Behavioral tests for ConfigTuiComponent — drives keystrokes through the
// reducer and verifies render output + onSaved/onError side effects.
//
// Plan 16 Slice 4b.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConfigTuiComponent } from "../../../src/extensions/forgecli/config-tui/component.js";

const WIDTH = 80;

let tmp: string;
let agentDir: string;
let cwd: string;
let savedAgentDirEnv: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-tui-component-"));
  agentDir = path.join(tmp, "agent");
  cwd = path.join(tmp, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  savedAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedAgentDirEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDirEnv;
});

interface Harness {
  exits: number[];
  saved: string[];
  errors: string[];
}

function makeHarness() {
  const h: Harness = { exits: [], saved: [], errors: [] };
  return {
    h,
    onExit: (c: number) => h.exits.push(c),
    onSaved: (t: string) => h.saved.push(t),
    onError: (m: string) => h.errors.push(m),
  };
}

describe("ConfigTuiComponent — top-menu", () => {
  it("renders empty-state when no configs exist", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("No forge-cli config files found");
  });

  it("renders no-project when pipelineCatalogue is null", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: null,
      availableModels: [],
      authenticatedProviders: [],
      onExit,
      onSaved,
      onError,
    });
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("No project root found");
  });

  it("q on a clean state exits with code 0", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [],
      authenticatedProviders: [],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("q");
    expect(h.exits).toEqual([0]);
  });
});

describe("ConfigTuiComponent — navigate to personas list", () => {
  it("from non-empty top-menu, '1' or enter opens personas-list", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: { "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    expect(comp.render(WIDTH).join("\n")).toContain("Personas");

    comp.handleInput("1");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas");
  });

  it("from empty-state, '1' or enter jumps straight to persona-editor for 'default'", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("1");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("forge config › personas › default");
    expect(out).toContain("Step 1 of 3");
  });
});

describe("ConfigTuiComponent — full edit flow with persistence", () => {
  it("pick provider → model → project layer → writes file + onSaved fires", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [
        { provider: "anthropic", id: "claude-opus-4-5" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
      ],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });

    // From empty-state, "1" enters persona-editor for "default"
    comp.handleInput("1");
    // Pick anthropic via shortcut
    comp.handleInput("a");
    expect(comp.render(WIDTH).join("\n")).toContain("Step 2 of 3");
    // Pick first model via enter
    comp.handleInput("\r");
    expect(comp.render(WIDTH).join("\n")).toContain("Step 3 of 3");
    // Pick project layer
    comp.handleInput("p");

    expect(h.saved.length).toBe(1);
    expect(h.errors).toEqual([]);
    expect(h.saved[0]).toBe(path.join(cwd, ".pi", "forge-cli", "config.json"));

    const written = JSON.parse(fs.readFileSync(h.saved[0], "utf-8"));
    expect(written["persona-models"]["default"]).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("commit to global layer writes ~/.pi/agent/forge-cli/config.json", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "ollama", id: "glm-5.1:cloud" }],
      authenticatedProviders: ["ollama"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("1");
    comp.handleInput("l"); // ollama shortcut
    comp.handleInput("\r"); // pick first model
    comp.handleInput("g"); // global layer

    expect(h.saved[0]).toBe(path.join(agentDir, "forge-cli", "config.json"));
    const written = JSON.parse(fs.readFileSync(h.saved[0], "utf-8"));
    expect(written["persona-models"]["default"].provider).toBe("ollama");
  });
});

describe("ConfigTuiComponent — esc navigation", () => {
  it("esc from personas-list returns to top-menu", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: { "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("1");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas");
    comp.handleInput("\x1b"); // ESC
    expect(comp.render(WIDTH).join("\n")).not.toContain("forge config › personas");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config");
  });
});

describe("ConfigTuiComponent — dirty-quit confirm", () => {
  it("q after a successful commit shows confirm overlay; y exits, n cancels", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    // Make a dirty edit
    comp.handleInput("1");
    comp.handleInput("a");
    comp.handleInput("\r");
    comp.handleInput("p");
    expect(h.saved.length).toBe(1);

    // After commit, dirty=true. q opens confirm.
    comp.handleInput("q");
    expect(h.exits).toEqual([]);

    // n cancels
    comp.handleInput("n");
    expect(h.exits).toEqual([]);

    // q again, y exits
    comp.handleInput("q");
    comp.handleInput("y");
    expect(h.exits).toEqual([0]);
  });
});
