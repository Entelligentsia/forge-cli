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

describe("ConfigTuiComponent — arrow keys + requestRender", () => {
  it("↓ (\\x1b[B) on personas-list moves cursor down and calls requestRender", () => {
    const { onExit, onSaved, onError } = makeHarness();
    let renderCalls = 0;
    const comp = createConfigTuiComponent({
      global: {
        "persona-models": {
          architect: { provider: "anthropic", model: "claude-opus-4-5" },
          engineer: { provider: "anthropic", model: "claude-opus-4-5" },
          scribe: { provider: "anthropic", model: "claude-opus-4-5" },
        },
      },
      project: null,
      cwd,
      personaCatalogue: ["architect", "engineer", "scribe"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
      requestRender: () => renderCalls++,
    });
    comp.handleInput("1"); // top-menu → personas-list
    const renderCountBefore = renderCalls;
    comp.handleInput("\x1b[B"); // ↓ raw escape sequence
    expect(renderCalls).toBeGreaterThan(renderCountBefore);
    // cursor moved
    const out = comp.render(WIDTH).join("\n");
    expect(out.split("\n").filter((l) => l.includes("▸"))[0]).toContain("engineer");
  });

  it("↑ (\\x1b[A) on personas-list moves cursor up", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: {
        "persona-models": {
          architect: { provider: "anthropic", model: "claude-opus-4-5" },
          engineer: { provider: "anthropic", model: "claude-opus-4-5" },
        },
      },
      project: null,
      cwd,
      personaCatalogue: ["architect", "engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("1");
    comp.handleInput("\x1b[B"); // down
    comp.handleInput("\x1b[A"); // up
    const out = comp.render(WIDTH).join("\n");
    expect(out.split("\n").filter((l) => l.includes("▸"))[0]).toContain("architect");
  });

  it("implements Focusable interface", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: [],
      pipelineCatalogue: ["default"],
      availableModels: [],
      authenticatedProviders: [],
      onExit,
      onSaved,
      onError,
    });
    expect(comp.focused).toBe(false);
    comp.focused = true;
    expect(comp.focused).toBe(true);
  });
});

describe("ConfigTuiComponent — no-project entry wiring (Slice 4c task #16)", () => {
  it("enter on no-project opens personas-list (global-only)", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: { "persona-models": { architect: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["architect"],
      pipelineCatalogue: null, // no .forge → no-project view
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    expect(comp.render(WIDTH).join("\n")).toContain("No project root found");
    comp.handleInput("\r");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas");
  });

  it("'1' on no-project also opens personas-list", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: { "persona-models": { architect: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["architect"],
      pipelineCatalogue: null,
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("1");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas");
  });

  it("empty no-project: enter still jumps to persona-editor for 'default'", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["architect"],
      pipelineCatalogue: null,
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("\r");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas › default");
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

describe("ConfigTuiComponent — picker cursor (Slice 4c task #15)", () => {
  function picker() {
    const { onExit, onSaved, onError } = makeHarness();
    return createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [
        { provider: "anthropic", id: "claude-opus-4-5" },
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "anthropic", id: "claude-haiku-4-5" },
        { provider: "openai", id: "gpt-4o" },
        { provider: "ollama", id: "glm-5.1:cloud" },
      ],
      authenticatedProviders: ["anthropic", "openai", "ollama"],
      onExit,
      onSaved,
      onError,
    });
  }

  it("↓ moves the cursor in the provider picker", () => {
    const c = picker();
    c.handleInput("1");  // empty-state → editor for "default" persona, pick-provider step
    const before = c.render(WIDTH).join("\n");
    c.handleInput("\x1b[B"); // ↓
    const after = c.render(WIDTH).join("\n");
    // Cursor should have moved off the first provider row onto the second.
    const beforeCursorRow = before.split("\n").find((l) => l.includes("▸"));
    const afterCursorRow = after.split("\n").find((l) => l.includes("▸"));
    expect(beforeCursorRow).toBeDefined();
    expect(afterCursorRow).toBeDefined();
    expect(beforeCursorRow).not.toBe(afterCursorRow);
  });

  it("enter on provider picker picks the cursor row (not [0])", () => {
    const c = picker();
    c.handleInput("1");      // → persona-editor pick-provider
    c.handleInput("\x1b[B"); // ↓ to second provider
    c.handleInput("\x1b[B"); // ↓ to third provider
    c.handleInput("\r");     // enter
    const out = c.render(WIDTH).join("\n");
    expect(out).toContain("Step 2 of 3");
    // Third provider (alphabetical: anthropic, ollama, openai) → openai
    expect(out).toContain("provider: openai");
  });

  it("↓ moves the cursor in the model picker", () => {
    const c = picker();
    c.handleInput("1");      // pick-provider
    c.handleInput("\r");     // enter — picks first provider (anthropic, cursor=0)
    const before = c.render(WIDTH).join("\n");
    c.handleInput("\x1b[B"); // ↓ in model list
    const after = c.render(WIDTH).join("\n");
    const beforeRow = before.split("\n").find((l) => l.includes("▸"));
    const afterRow = after.split("\n").find((l) => l.includes("▸"));
    expect(beforeRow).toContain("claude-opus-4-5");
    expect(afterRow).toContain("claude-sonnet-4-6");
  });

  it("enter on model picker uses cursor selection", () => {
    const c = picker();
    c.handleInput("1");      // pick-provider
    c.handleInput("\r");     // anthropic
    c.handleInput("\x1b[B"); // ↓ → sonnet
    c.handleInput("\x1b[B"); // ↓ → haiku
    c.handleInput("\r");     // pick model
    const out = c.render(WIDTH).join("\n");
    expect(out).toContain("Step 3 of 3");
    expect(out).toContain("default → anthropic:claude-haiku-4-5");
  });

  it("layer picker cursor: ↓ then enter writes to global", () => {
    const { h } = makeHarness();
    const c = picker();
    // overwrite handlers with new harness
    const c2 = createConfigTuiComponent({
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit: () => {},
      onSaved: (t: string) => h.saved.push(t),
      onError: (m: string) => h.errors.push(m),
    });
    c2.handleInput("1");      // pick-provider, cursor=0 (anthropic)
    c2.handleInput("\r");     // pick anthropic
    c2.handleInput("\r");     // pick claude-opus-4-5
    c2.handleInput("\x1b[B"); // ↓ in layer picker (project → global)
    c2.handleInput("\r");     // confirm
    expect(h.saved.length).toBe(1);
    // Global path uses the test's mocked PI_CODING_AGENT_DIR (tmp/agent/),
    // so just check it landed in the global layer rather than project layer.
    expect(h.saved[0]).toContain("agent/forge-cli/config.json");
    expect(h.saved[0]).not.toContain(".pi/forge-cli/config.json");
  });

  it("cursor stays clamped at upper bound (can't overshoot)", () => {
    const c = picker();
    c.handleInput("1");
    // 3 providers — try to move ↓ 10 times
    for (let i = 0; i < 10; i++) c.handleInput("\x1b[B");
    c.handleInput("\r"); // enter — should pick the last provider (openai)
    const out = c.render(WIDTH).join("\n");
    expect(out).toContain("provider: openai");
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
