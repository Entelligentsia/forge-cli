// Behavioral tests for ConfigTuiComponent — drives keystrokes through the
// reducer and verifies render output + onSaved/onError side effects.
//
// Plan 16 Slice 4b. Phase A: entry view is tier-menu (replaces top-menu).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConfigTuiComponent } from "../../../src/extensions/forgecli/config-tui/component.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Mock theme for tests — strips all styling so assertions match plain text.
const mockTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
} as unknown as Theme;

const WIDTH = 80;

let tmp: string;
// Post-FORGE-S20-T11 (v0.10.0): the global config now resolves via the
// central path resolver at $FORGE_CLI_HOME (or ~/.pi/forge-cli). The
// `agentDir` variable name is retained for readability — semantically
// it's now the forge-cli user root.
let agentDir: string;
let cwd: string;
let savedForgeCliHome: string | undefined;
let savedSkipMig: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "config-tui-component-"));
  agentDir = path.join(tmp, "forge-cli-user");
  cwd = path.join(tmp, "proj");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  savedForgeCliHome = process.env.FORGE_CLI_HOME;
  savedSkipMig = process.env.FORGE_CLI_SKIP_MIGRATION;
  process.env.FORGE_CLI_HOME = agentDir;
  process.env.FORGE_CLI_SKIP_MIGRATION = "1";
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedForgeCliHome === undefined) delete process.env.FORGE_CLI_HOME;
  else process.env.FORGE_CLI_HOME = savedForgeCliHome;
  if (savedSkipMig === undefined) delete process.env.FORGE_CLI_SKIP_MIGRATION;
  else process.env.FORGE_CLI_SKIP_MIGRATION = savedSkipMig;
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

describe("ConfigTuiComponent — tier-menu landing (Phase A)", () => {
  it("renders tier-menu when no configs exist", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    expect(out).toContain("forge config");
    expect(out).toContain("Choose models for your AI workflow");
    expect(out).toContain("Heavy");
    expect(out).toContain("Standard");
    expect(out).toContain("Light");
  });

  it("renders tier-menu when pipelineCatalogue is null (no-project)", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    // Phase E: no-project is gone; tier-menu handles all cases
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("forge config");
    expect(out).toContain("Heavy");
  });

  it("q on a clean state exits with code 0", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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

describe("ConfigTuiComponent — navigate to personas list (via advanced/advanced-menu)", () => {
  it("'a' from tier-menu opens advanced-menu (which has personas-list)", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    expect(comp.render(WIDTH).join("\n")).toContain("advanced");
    comp.handleInput("1"); // advanced-menu → personas-list
    expect(comp.render(WIDTH).join("\n")).toContain("per-persona overrides");
  });

  it("from advanced-menu, personas-list picker → editor flow works", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    // tier-menu → advanced-menu → "1" opens personas-list
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("1"); // advanced-menu → personas-list
    // personas-list is empty → 'n' opens persona-picker
    comp.handleInput("n");
    comp.handleInput("\r"); // confirm 'engineer' → persona-editor
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("Step 1 of 3");
  });
});

describe("ConfigTuiComponent — tier-picker flow (Phase A)", () => {
  it("'1' from tier-menu opens Heavy tier-picker", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["architect", "engineer", "supervisor"],
      pipelineCatalogue: ["default"],
      availableModels: [
        { provider: "anthropic", id: "claude-opus-4-5" },
        { provider: "ollama", id: "glm-5.1:cloud" },
      ],
      authenticatedProviders: ["anthropic", "ollama"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("1"); // tier-menu → Heavy tier-picker
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("Heavy");
    expect(out).toContain("pick provider");
    expect(out).toContain("architect");
    expect(out).toContain("supervisor");
  });

  it("pick provider → model writes all tier personas and persists", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["architect", "engineer", "supervisor", "collator",
        "bug-fixer", "qa-engineer", "product-manager", "librarian", "orchestrator"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("1"); // Heavy tier-picker
    comp.handleInput("\r"); // pick anthropic
    comp.handleInput("\r"); // pick claude-opus-4-5 → commit

    // Writes architect + supervisor to project (default scope)
    expect(h.saved.length).toBe(1);
    const written = JSON.parse(fs.readFileSync(h.saved[0], "utf-8"));
    expect(written["persona-models"]["architect"]).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    expect(written["persona-models"]["supervisor"]).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
  });

  it("tab toggles scope before commit", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: null,
      project: null,
      cwd,
      personaCatalogue: ["architect", "supervisor"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    // Toggle scope to global before picking
    comp.handleInput("\t"); // tab → scope = global
    comp.handleInput("1"); // Heavy tier-picker
    comp.handleInput("\r"); // pick anthropic
    comp.handleInput("\r"); // pick model → commit to global

    expect(h.saved.length).toBe(1);
    expect(h.saved[0]).toBe(path.join(agentDir, "config.json"));
    const written = JSON.parse(fs.readFileSync(h.saved[0], "utf-8"));
    expect(written["persona-models"]["architect"]).toBeDefined();
    expect(written["persona-models"]["supervisor"]).toBeDefined();
  });
});

describe("ConfigTuiComponent — full edit flow with persistence (advanced-menu path)", () => {
  it("pick provider → model → project layer → writes file + onSaved fires", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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

    // Navigate: tier-menu → "a" → advanced-menu → "3" → persona-picker
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker
    comp.handleInput("\r"); // picker: confirm first entry → editor 'default' → editor
    // Pick anthropic via search + enter (replaces old shortcut)
    comp.handleInput("a"); // type into search filter → filters to "anthropic"
    comp.handleInput("\r"); // select filtered provider → advances to pick-model
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

  it("commit to global layer writes ~/.pi/forge-cli/config.json (v0.10.0 layout)", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker
    comp.handleInput("\r"); // picker: confirm 'default' → editor
    comp.handleInput("l"); // type into search → filters to "ollama"
    comp.handleInput("\r"); // select filtered provider (ollama)
    comp.handleInput("\r"); // pick first model
    comp.handleInput("g"); // global layer

    expect(h.saved[0]).toBe(path.join(agentDir, "config.json"));
    const written = JSON.parse(fs.readFileSync(h.saved[0], "utf-8"));
    expect(written["persona-models"]["default"].provider).toBe("ollama");
  });
});

describe("ConfigTuiComponent — arrow keys + requestRender", () => {
  it("↓ (\\x1b[B) on personas-list moves cursor down and calls requestRender", () => {
    const { onExit, onSaved, onError } = makeHarness();
    let renderCalls = 0;
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("1"); // advanced-menu → personas-list
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
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("1"); // advanced-menu → personas-list
    comp.handleInput("\x1b[B"); // down
    comp.handleInput("\x1b[A"); // up
    const out = comp.render(WIDTH).join("\n");
    expect(out.split("\n").filter((l) => l.includes("▸"))[0]).toContain("architect");
  });

  it("implements Focusable interface", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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

describe("ConfigTuiComponent — tier-menu cursor navigation (Phase A)", () => {
  function nonEmpty() {
    const { onExit, onSaved, onError } = makeHarness();
    return createConfigTuiComponent({
      theme: mockTheme,
      global: { "persona-models": { engineer: { provider: "ollama", model: "glm-5.1:cloud" } } },
      project: null,
      cwd,
      personaCatalogue: ["engineer", "architect"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "ollama", id: "glm-5.1:cloud" }],
      authenticatedProviders: ["ollama"],
      onExit,
      onSaved,
      onError,
    });
  }

  it("↓ moves the cursor in the tier-menu (and ▸ tracks it)", () => {
    const c = nonEmpty();
    const before = c.render(WIDTH).join("\n");
    const beforeRow = before.split("\n").find((l) => l.includes("▸"));
    expect(beforeRow).toContain("Heavy");

    c.handleInput("\x1b[B"); // ↓
    const after = c.render(WIDTH).join("\n");
    const afterRow = after.split("\n").find((l) => l.includes("▸"));
    expect(afterRow).toContain("Standard");
  });

  it("'s' shortcut opens show-resolved", () => {
    const c = nonEmpty();
    c.handleInput("s");
    expect(c.render(WIDTH).join("\n")).toContain("forge config › current setup");
  });

  it("navigate to 'show-resolved' via cursor and enter", () => {
    const c = nonEmpty();
    c.handleInput("\x1b[B"); // ↓ Standard
    c.handleInput("\x1b[B"); // ↓ Light
    c.handleInput("\x1b[B"); // ↓ Show what runs at each step
    c.handleInput("\r");     // enter
    expect(c.render(WIDTH).join("\n")).toContain("forge config › current setup");
  });

  it("cursor clamps at upper bound (can't overshoot)", () => {
    const c = nonEmpty();
    for (let i = 0; i < 20; i++) c.handleInput("\x1b[B");
    // cursor is on the last item (Advanced); enter opens advanced-menu
    c.handleInput("\r");
    const out = c.render(WIDTH).join("\n");
    expect(out).toContain("advanced");
  });

  it("tab toggles scope", () => {
    const c = nonEmpty();
    const before = c.render(WIDTH).join("\n");
    // Default scope is project
    expect(before).toContain("project");
    c.handleInput("\t"); // tab → global
    const after = c.render(WIDTH).join("\n");
    expect(after).toContain("global");
  });

  it("no-project mode: tier-menu still works, enter on tier rows opens picker", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const c = createConfigTuiComponent({
      theme: mockTheme,
      global: { "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["engineer"],
      pipelineCatalogue: null, // no-project
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    // Phase E: no-project view is gone; tier-menu handles all cases
    const out = c.render(WIDTH).join("\n");
    expect(out).toContain("forge config");
    expect(out).toContain("Heavy");
  });
});

describe("ConfigTuiComponent — no-project entry wiring (Phase E: tier-menu handles all)", () => {
  it("enter on tier-menu when no project opens tier-picker", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: { "persona-models": { architect: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["architect"],
      pipelineCatalogue: null, // no .forge → still tier-menu
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    // Phase E: tier-menu handles no-project too
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("forge config");
    // Enter on tier row opens tier-picker
    comp.handleInput("\r");
    expect(comp.render(WIDTH).join("\n")).toContain("pick provider");
  });

  it("'1' on no-project opens Heavy tier-picker", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    expect(comp.render(WIDTH).join("\n")).toContain("Heavy");
    expect(comp.render(WIDTH).join("\n")).toContain("pick provider");
  });

  it("empty no-project: 'a' opens advanced-menu", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a");
    expect(comp.render(WIDTH).join("\n")).toContain("advanced");
  });
});

describe("ConfigTuiComponent — esc navigation", () => {
  it("esc from personas-list returns to advanced-menu", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("1"); // advanced-menu → personas-list
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › per-persona overrides");
    comp.handleInput("\x1b"); // ESC → back to advanced-menu
    expect(comp.render(WIDTH).join("\n")).not.toContain("forge config › per-persona overrides");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config");
  });

  it("esc from advanced-menu returns to tier-menu", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    expect(comp.render(WIDTH).join("\n")).toContain("advanced");
    comp.handleInput("\x1b"); // ESC → back to tier-menu
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("Choose models for your AI workflow");
  });
});

describe("ConfigTuiComponent — picker cursor (Slice 4c task #15)", () => {
  function picker() {
    const { onExit, onSaved, onError } = makeHarness();
    return createConfigTuiComponent({
      theme: mockTheme,
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

  // Navigate to persona-editor via advanced-menu → persona-picker
  function goToEditor(comp: ReturnType<typeof createConfigTuiComConent>) {
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker
    comp.handleInput("\r"); // confirm first entry → persona-editor (pick-provider step)
  }

  it("↓ moves the cursor in the provider picker", () => {
    const c = picker();
    goToEditor(c);
    const before = c.render(WIDTH).join("\n");
    c.handleInput("\x1b[B"); // ↓
    const after = c.render(WIDTH).join("\n");
    const beforeCursorRow = before.split("\n").find((l) => l.includes("▸"));
    const afterCursorRow = after.split("\n").find((l) => l.includes("▸"));
    expect(beforeCursorRow).toBeDefined();
    expect(afterCursorRow).toBeDefined();
    expect(beforeCursorRow).not.toBe(afterCursorRow);
  });

  it("enter on provider picker picks the cursor row (not [0])", () => {
    const c = picker();
    goToEditor(c);
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
    goToEditor(c);
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
    goToEditor(c);
    c.handleInput("\r");     // pick anthropic
    c.handleInput("\x1b[B"); // ↓ → sonnet
    c.handleInput("\x1b[B"); // ↓ → haiku
    c.handleInput("\r");     // pick model
    const out = c.render(WIDTH).join("\n");
    expect(out).toContain("Step 3 of 3");
    expect(out).toContain("default → anthropic:claude-haiku-4-5");
  });

  it("layer picker cursor: ↓ then enter writes to global", () => {
    const { h } = makeHarness();
    const c2 = createConfigTuiComponent({
      theme: mockTheme,
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
    goToEditor(c2); // → persona-editor pick-provider
    c2.handleInput("\r");     // pick anthropic
    c2.handleInput("\r");     // pick claude-opus-4-5
    c2.handleInput("\x1b[B"); // ↓ in layer picker (project → global)
    c2.handleInput("\r");     // confirm
    expect(h.saved.length).toBe(1);
    expect(h.saved[0]).toBe(path.join(agentDir, "config.json"));
    expect(h.saved[0]).not.toContain(path.join(cwd, ".pi", "forge-cli"));
  });

  it("cursor stays clamped at upper bound (can't overshoot)", () => {
    const c = picker();
    goToEditor(c);
    // 3 providers — try to move ↓ 10 times
    for (let i = 0; i < 10; i++) c.handleInput("\x1b[B");
    c.handleInput("\r"); // enter — should pick the last provider (openai)
    const out = c.render(WIDTH).join("\n");
    expect(out).toContain("provider: openai");
  });
});

describe("ConfigTuiComponent — save clears dirty + lastSaved banner (Slice 4c polish)", () => {
  it("commit clears dirty flag and records lastSaved", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker
    comp.handleInput("\r"); // picker: confirm 'default'
    comp.handleInput("a"); // type into search → filters to "anthropic"
    comp.handleInput("\r"); // select filtered provider (anthropic)
    comp.handleInput("\r"); // pick first model
    comp.handleInput("p"); // commit to project layer
    expect(h.saved.length).toBe(1);

    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("✓ Saved");
    expect(out).toContain(h.saved[0]);
    expect(out).not.toContain("* unsaved");
  });

  it("q after a successful commit exits cleanly (dirty was cleared)", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker
    comp.handleInput("\r"); // picker: confirm first entry
    comp.handleInput("a"); // type into search → filters to "anthropic"
    comp.handleInput("\r"); // select filtered provider (anthropic)
    comp.handleInput("\r"); // pick first model
    comp.handleInput("p"); // project layer
    expect(h.saved.length).toBe(1);

    comp.handleInput("q");
    expect(h.exits).toEqual([0]);
  });

  it("repeated q while confirm-quit modal is open is a no-op (not re-triggered)", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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

describe("ConfigTuiComponent — per-step overrides (Slice 4c Screens 4+5)", () => {
  function makeNonEmpty(extra: Record<string, unknown> = {}) {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: {
        "persona-models": {
          scribe: { provider: "anthropic", model: "claude-haiku-4-5" },
        },
      },
      project: null,
      cwd,
      personaCatalogue: ["engineer", "scribe"],
      pipelineCatalogue: ["default", "hotfix"],
      availableModels: [
        { provider: "anthropic", id: "claude-opus-4-5" },
        { provider: "anthropic", id: "claude-haiku-4-5" },
        { provider: "ollama", id: "glm-5.1:cloud" },
      ],
      authenticatedProviders: ["anthropic", "ollama"],
      onExit,
      onSaved,
      onError,
      ...extra,
    });
    return { comp };
  }

  // Navigate: tier-menu → "a" → advanced-menu → "2" → overrides-list-pipelines
  function goToOverrides(comp: ReturnType<typeof createConfigTuiComponent>) {
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("2"); // advanced-menu → overrides-list-pipelines
  }

  it("menu item 2 opens overrides-list-pipelines (via advanced-menu)", () => {
    const { comp } = makeNonEmpty();
    goToOverrides(comp);
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("per-step overrides");
    expect(out).toContain("default");
    expect(out).toContain("hotfix");
  });

  it("enter on a pipeline drills into the phase table", () => {
    const { comp } = makeNonEmpty();
    goToOverrides(comp);
    comp.handleInput("\r");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("per-step overrides › default");
    expect(out).toContain("plan");
    expect(out).toContain("commit");
  });

  it("enter on a phase opens the override editor at pick-type", () => {
    const { comp } = makeNonEmpty();
    goToOverrides(comp);
    comp.handleInput("\r");
    comp.handleInput("\r");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("Override type:");
  });

  it("inline override flow writes phases[role]['model-override'] and persists", () => {
    const harness = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: { "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["engineer", "scribe"],
      pipelineCatalogue: ["default", "hotfix"],
      availableModels: [
        { provider: "anthropic", id: "claude-opus-4-5" },
        { provider: "ollama", id: "glm-5.1:cloud" },
      ],
      authenticatedProviders: ["anthropic", "ollama"],
      onExit: harness.onExit,
      onSaved: harness.onSaved,
      onError: harness.onError,
    });
    goToOverrides(comp); // tier-menu → advanced-menu → overrides-list
    comp.handleInput("\r"); // pick default
    comp.handleInput("\x1b[B"); // down to phase 1
    comp.handleInput("\r"); // open editor
    comp.handleInput("2"); // Inline
    comp.handleInput("\x1b[B"); // down to ollama
    comp.handleInput("\r"); // pick ollama
    comp.handleInput("\r"); // pick first model

    const projectPath = path.join(cwd, ".pi", "forge-cli", "config.json");
    const written = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
    expect(written.pipelines.default.phases["review-plan"]["model-override"]).toEqual({
      provider: "ollama",
      model: "glm-5.1:cloud",
    });
  });

  it("by-name override writes a string override", () => {
    const harness = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: {
        "persona-models": {
          scribe: { provider: "anthropic", model: "claude-haiku-4-5" },
        },
      },
      project: null,
      cwd,
      personaCatalogue: ["engineer", "scribe"],
      pipelineCatalogue: ["default"],
      availableModels: [
        { provider: "anthropic", id: "claude-haiku-4-5" },
      ],
      authenticatedProviders: ["anthropic"],
      onExit: harness.onExit,
      onSaved: harness.onSaved,
      onError: harness.onError,
    });
    goToOverrides(comp);
    comp.handleInput("\r"); // pick default
    comp.handleInput("\r"); // editor for phase 0
    comp.handleInput("1"); // by-name
    comp.handleInput("\r"); // pick first persona (scribe)

    const projectPath = path.join(cwd, ".pi", "forge-cli", "config.json");
    const written = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
    expect(written.pipelines.default.phases.plan["model-override"]).toBe("scribe");
  });

  it("clear from editor (option 3) deletes override and persists; clean buffer drops file", () => {
    const harness = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: null,
      project: {
        pipelines: {
          default: {
            phases: { plan: { "model-override": "scribe" } },
          },
        },
      },
      cwd,
      personaCatalogue: ["engineer", "scribe"],
      pipelineCatalogue: ["default"],
      availableModels: [],
      authenticatedProviders: [],
      onExit: harness.onExit,
      onSaved: harness.onSaved,
      onError: harness.onError,
    });
    goToOverrides(comp);
    comp.handleInput("\r"); // pick default
    comp.handleInput("\r"); // open editor for phase 0
    comp.handleInput("3"); // clear

    const projectPath = path.join(cwd, ".pi", "forge-cli", "config.json");
    expect(fs.existsSync(projectPath)).toBe(false);
    expect(harness.h.errors).toEqual([]);
  });

  it("space on phase row clears its override", () => {
    const harness = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: null,
      project: {
        pipelines: {
          default: {
            phases: { "review-plan": { "model-override": "scribe" } },
          },
        },
      },
      cwd,
      personaCatalogue: ["engineer", "scribe"],
      pipelineCatalogue: ["default"],
      availableModels: [],
      authenticatedProviders: [],
      onExit: harness.onExit,
      onSaved: harness.onSaved,
      onError: harness.onError,
    });
    goToOverrides(comp);
    comp.handleInput("\r");
    comp.handleInput("\x1b[B"); // move to phase 1
    comp.handleInput(" "); // space → clear

    const projectPath = path.join(cwd, ".pi", "forge-cli", "config.json");
    expect(fs.existsSync(projectPath)).toBe(false);
  });
});

describe("ConfigTuiComponent — persona picker", () => {
  it("'n' on personas-list opens the picker (not direct to default editor)", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: { "persona-models": { default: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: null,
      cwd,
      personaCatalogue: ["engineer", "architect", "supervisor"],
      pipelineCatalogue: ["default"],
      availableModels: [{ provider: "anthropic", id: "claude-opus-4-5" }],
      authenticatedProviders: ["anthropic"],
      onExit,
      onSaved,
      onError,
    });
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker
    comp.handleInput("n"); // → persona-picker
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("pick which");
    expect(out).toContain("default");
    expect(out).toContain("architect");
    expect(out).toContain("engineer");
    expect(out).toContain("supervisor");
  });

  it("picker → arrow down → enter advances editor with the chosen persona", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: null,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker (entries: default, architect, engineer)
    comp.handleInput("\x1b[B"); // ↓ → architect
    comp.handleInput("\r");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("architect");
    expect(out).toContain("Step 1 of 3");
  });

  it("end-to-end: pick non-default persona and save writes correct key", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: null,
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("3"); // advanced-menu → persona-picker
    comp.handleInput("\x1b[B"); // ↓ → architect
    comp.handleInput("\x1b[B"); // ↓ → engineer
    comp.handleInput("\r"); // confirm engineer
    comp.handleInput("a"); // type into search → filters to "anthropic"
    comp.handleInput("\r"); // select filtered provider (anthropic)
    comp.handleInput("\r"); // first model
    comp.handleInput("p"); // project layer
    expect(h.saved.length).toBe(1);
    const written = JSON.parse(fs.readFileSync(h.saved[0], "utf-8"));
    expect(written["persona-models"]).toHaveProperty("engineer");
    expect(written["persona-models"].engineer).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    expect(written["persona-models"]).not.toHaveProperty("default");
  });

  it("esc from picker pops back to the originating view", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      global: { "persona-models": { default: { provider: "anthropic", model: "claude-opus-4-5" } } },
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
    comp.handleInput("a"); // tier-menu → advanced-menu
    comp.handleInput("1"); // personas-list
    comp.handleInput("n"); // picker
    expect(comp.render(WIDTH).join("\n")).toContain("pick which");
    comp.handleInput("\x1b"); // esc
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › per-persona overrides");
    expect(comp.render(WIDTH).join("\n")).not.toContain("pick which");
  });
});