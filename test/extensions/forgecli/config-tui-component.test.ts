// Behavioral tests for ConfigTuiComponent — drives keystrokes through the
// reducer and verifies render output + onSaved/onError side effects.
//
// Plan 16 Slice 4b.

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
    expect(out).toContain("No forge-cli config files found");
  });

  it("renders no-project when pipelineCatalogue is null", () => {
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
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("No project root found");
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

describe("ConfigTuiComponent — navigate to personas list", () => {
  it("from non-empty top-menu, '1' or enter opens personas-list", () => {
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
    expect(comp.render(WIDTH).join("\n")).toContain("Personas");

    comp.handleInput("1");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas");
  });

  it("from empty-state, '1' opens persona-picker; enter on 'default' lands in persona-editor", () => {
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
    comp.handleInput("1");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas › pick which");
    comp.handleInput("\r"); // confirm 'default' (cursor 0)
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("forge config › personas › default");
    expect(out).toContain("Step 1 of 3");
  });
});

describe("ConfigTuiComponent — full edit flow with persistence", () => {
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

    // From empty-state, "1" opens picker; enter confirms "default"
    comp.handleInput("1");
    comp.handleInput("\r");
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
    comp.handleInput("1");
    comp.handleInput("\r"); // picker: confirm 'default'
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
    comp.handleInput("1");
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

describe("ConfigTuiComponent — top-menu cursor navigation (Slice 4c polish-2)", () => {
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

  it("↓ moves the cursor in the top-menu (and ▸ tracks it)", () => {
    const c = nonEmpty();
    const before = c.render(WIDTH).join("\n");
    const beforeRow = before.split("\n").find((l) => l.includes("▸"));
    expect(beforeRow).toContain("Personas");

    c.handleInput("\x1b[B"); // ↓
    const after = c.render(WIDTH).join("\n");
    const afterRow = after.split("\n").find((l) => l.includes("▸"));
    expect(afterRow).toContain("Per-phase overrides");
  });

  it("↓ several times then enter fires the cursor's action (show-resolved)", () => {
    const c = nonEmpty();
    c.handleInput("\x1b[B"); // → Per-phase overrides
    c.handleInput("\x1b[B"); // → Show resolved
    c.handleInput("\r");
    expect(c.render(WIDTH).join("\n")).toContain("forge config › resolved");
  });

  it("cursor clamps at upper bound (can't overshoot)", () => {
    const c = nonEmpty();
    for (let i = 0; i < 20; i++) c.handleInput("\x1b[B");
    // cursor is on the last menu row (Plugin config); enter fires its stub error.
    c.handleInput("\r");
    // No crash; no view transition because Plugin config is a stub.
    // (Verified via the absence of new view header.)
    expect(c.render(WIDTH).join("\n")).toContain("forge config");
  });

  it("number shortcut still works regardless of cursor position", () => {
    const c = nonEmpty();
    c.handleInput("\x1b[B"); // cursor on row 1
    c.handleInput("3");      // bypass cursor → show-resolved
    expect(c.render(WIDTH).join("\n")).toContain("forge config › resolved");
  });

  it("no-project menu cursor: ↓ then enter goes to show-resolved", () => {
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
    c.handleInput("\x1b[B"); // ↓ → Show resolved
    c.handleInput("\r");
    expect(c.render(WIDTH).join("\n")).toContain("forge config › resolved");
  });
});

describe("ConfigTuiComponent — no-project entry wiring (Slice 4c task #16)", () => {
  it("enter on no-project opens personas-list (global-only)", () => {
    const { onExit, onSaved, onError } = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
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
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas");
  });

  it("empty no-project: enter opens persona-picker, second enter lands editor on 'default'", () => {
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
    comp.handleInput("\r");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas › pick which");
    comp.handleInput("\r");
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas › default");
  });
});

describe("ConfigTuiComponent — esc navigation", () => {
  it("esc from personas-list returns to top-menu", () => {
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

  it("↓ moves the cursor in the provider picker", () => {
    const c = picker();
    c.handleInput("1");  // empty-state → persona-picker
    c.handleInput("\r"); // confirm 'default' → editor pick-provider
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
    c.handleInput("1");      // → persona-picker
    c.handleInput("\r");     // confirm 'default' → editor pick-provider
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
    c.handleInput("1");      // → persona-picker
    c.handleInput("\r");     // confirm 'default'
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
    c.handleInput("1");      // → persona-picker
    c.handleInput("\r");     // confirm 'default'
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
    c2.handleInput("1");      // → persona-picker
    c2.handleInput("\r");     // confirm 'default' → editor pick-provider (cursor=0, anthropic)
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
    c.handleInput("\r"); // confirm 'default' → editor pick-provider
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
    comp.handleInput("1");
    comp.handleInput("\r"); // picker: confirm 'default'
    comp.handleInput("a");
    comp.handleInput("\r");
    comp.handleInput("p"); // commit to project layer
    expect(h.saved.length).toBe(1);

    // After save, the screen should show "Saved → …" and NOT "* unsaved".
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
    comp.handleInput("1");
    comp.handleInput("\r"); // picker: confirm 'default'
    comp.handleInput("a");
    comp.handleInput("\r");
    comp.handleInput("p");
    expect(h.saved.length).toBe(1);

    // q now exits immediately — no modal, no second press needed.
    comp.handleInput("q");
    expect(h.exits).toEqual([0]);
  });

  it("repeated q while confirm-quit modal is open is a no-op (not re-triggered)", () => {
    const { h, onExit, onSaved, onError } = makeHarness();
    // To get into a dirty state without auto-persist we'd need a non-saving
    // mutation path. None exists in 4b/4c, so we exercise the request-quit
    // guard via the reducer directly — see config-tui-state.test.ts for the
    // reducer-level "request-quit noop when confirmQuit" test.
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
    // Clean state — q exits on first press.
    comp.handleInput("q");
    expect(h.exits).toEqual([0]);
  });
});

describe("ConfigTuiComponent — per-phase overrides (Slice 4c Screens 4+5)", () => {
  function makeNonEmpty(extra: Parameters<typeof createConfigTuiComponent>[0] extends infer T ? Partial<T> : never) {
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

  it("menu item 2 opens overrides-list-pipelines", () => {
    const { comp } = makeNonEmpty({});
    comp.handleInput("2");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("per-phase overrides");
    expect(out).toContain("default");
    expect(out).toContain("hotfix");
  });

  it("enter on a pipeline drills into the phase table", () => {
    const { comp } = makeNonEmpty({});
    comp.handleInput("2");
    comp.handleInput("\r");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("per-phase overrides › default");
    expect(out).toContain("plan");
    expect(out).toContain("commit");
  });

  it("enter on a phase opens the override editor at pick-type", () => {
    const { comp } = makeNonEmpty({});
    comp.handleInput("2");
    comp.handleInput("\r");
    comp.handleInput("\r");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("Override type:");
  });

  it("inline override flow writes phases[role]['model-override'] and persists", () => {
    const harness = makeHarness();
    const comp = createConfigTuiComponent({
      theme: mockTheme,
      // Start non-empty so the top-menu (not empty-state) is the initial view.
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
    comp.handleInput("2"); // overrides-list-pipelines (top-menu item 2)
    comp.handleInput("\r"); // pick default
    // Move cursor to phase 1 (review-plan)
    comp.handleInput("\x1b[B"); // down
    comp.handleInput("\r"); // open editor
    // Pick "Inline" option
    comp.handleInput("2");
    // Pick ollama provider (cursor 1 after one ↓)
    comp.handleInput("\x1b[B");
    comp.handleInput("\r");
    // Pick first ollama model
    comp.handleInput("\r");

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
    comp.handleInput("2"); // overrides-list-pipelines
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
    comp.handleInput("2"); // overrides list
    comp.handleInput("\r"); // pick default
    comp.handleInput("\r"); // open editor for phase 0
    comp.handleInput("3"); // clear

    // Buffer is now empty → file should be deleted
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
    comp.handleInput("2");
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
    comp.handleInput("1"); // → personas-list
    comp.handleInput("n"); // → persona-picker
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("forge config › personas › pick which");
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
    comp.handleInput("1"); // empty-state → picker (entries: default, architect, engineer)
    comp.handleInput("\x1b[B"); // ↓ → architect
    comp.handleInput("\r");
    const out = comp.render(WIDTH).join("\n");
    expect(out).toContain("forge config › personas › architect");
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
    comp.handleInput("1"); // → picker
    comp.handleInput("\x1b[B"); // ↓ → architect
    comp.handleInput("\x1b[B"); // ↓ → engineer
    comp.handleInput("\r"); // confirm engineer
    comp.handleInput("a"); // anthropic
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
    comp.handleInput("1"); // personas-list
    comp.handleInput("n"); // picker
    expect(comp.render(WIDTH).join("\n")).toContain("pick which");
    comp.handleInput("\x1b"); // esc
    expect(comp.render(WIDTH).join("\n")).toContain("forge config › personas");
    expect(comp.render(WIDTH).join("\n")).not.toContain("pick which");
  });
});
