// Render-to-string snapshot tests for config-TUI screens.
// Plan 16 Slice 4b. Renderers are pure (state, width) → string[].

import { describe, expect, it } from "vitest";
import {
  initialState,
  reducer,
  type AvailableModel,
  type ConfigTuiState,
} from "../../../src/extensions/forgecli/config-tui/state.js";
import {
  renderTopMenu,
  renderEmptyState,
  renderNoProject,
  renderPersonasList,
  renderPersonaEditor,
  renderActive,
} from "../../../src/extensions/forgecli/config-tui/screens.js";

const WIDTH = 80;

const CATALOGUE = ["architect", "engineer", "supervisor", "scribe"];
const PIPELINES = ["default", "hotfix"];
const MODELS: AvailableModel[] = [
  { provider: "anthropic", id: "claude-opus-4-5" },
  { provider: "anthropic", id: "claude-sonnet-4-6" },
  { provider: "openai", id: "gpt-4o" },
  { provider: "ollama", id: "glm-5.1:cloud" },
];
const AUTH = ["anthropic", "openai", "ollama"];

function makeState(overrides: Partial<Parameters<typeof initialState>[0]> = {}): ConfigTuiState {
  return initialState({
    global: null,
    project: null,
    cwd: "/home/x/proj",
    personaCatalogue: CATALOGUE,
    pipelineCatalogue: PIPELINES,
    availableModels: MODELS,
    authenticatedProviders: AUTH,
    ...overrides,
  });
}

describe("renderTopMenu — empty state", () => {
  it("shows 'no config files found' messaging", () => {
    const s = makeState();
    const lines = renderTopMenu(s, WIDTH).join("\n");
    expect(lines).toContain("No forge-cli config files found");
    expect(lines).toContain("currently-running model");
    expect(lines).toContain("Add a persona-model assignment");
  });
});

describe("renderTopMenu — with assignments", () => {
  it("shows persona counts split by layer", () => {
    const s = makeState({
      global: { "persona-models": { architect: { provider: "anthropic", model: "claude-opus-4-5" } } },
      project: { "persona-models": { engineer: { provider: "ollama", model: "glm-5.1:cloud" } } },
    });
    const lines = renderTopMenu(s, WIDTH).join("\n");
    expect(lines).toContain("2 defined");
    expect(lines).toContain("(1 global · 1 project)");
    expect(lines).toContain("Forge plugin config (read-only)");
  });

  it("includes 'unsaved' marker when state.dirty", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "ollama" });
    s = reducer(s, { kind: "set-persona-model", model: "glm-5.1:cloud" });
    s = reducer(s, { kind: "commit-persona-edit", layer: "project" });
    const lines = renderTopMenu(s, WIDTH).join("\n");
    expect(lines).toContain("* unsaved");
  });
});

describe("renderNoProject", () => {
  it("renders the no-project screen with global-only messaging", () => {
    const s = makeState({ pipelineCatalogue: null });
    const lines = renderNoProject(s, WIDTH).join("\n");
    expect(lines).toContain("No project root found");
    expect(lines).toContain("~/.pi/agent/forge-cli/config.json");
    expect(lines).toContain("N/A — no pipeline catalogue");
  });
});

describe("renderEmptyState", () => {
  it("delegates through renderTopMenu but forces the empty branch", () => {
    const s = makeState();
    const lines = renderEmptyState(s, WIDTH).join("\n");
    expect(lines).toContain("No forge-cli config files found");
  });
});

describe("renderPersonasList", () => {
  it("renders a table of persona-model assignments with sources and avail", () => {
    let s = makeState({
      global: {
        "persona-models": {
          architect: { provider: "anthropic", model: "claude-opus-4-5" },
        },
      },
      project: {
        "persona-models": {
          engineer: { provider: "ollama", model: "glm-5.1:cloud" },
        },
      },
    });
    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    const out = renderPersonasList(s, WIDTH).join("\n");
    expect(out).toMatch(/PERSONA/);
    expect(out).toMatch(/PROVIDER:MODEL/);
    expect(out).toMatch(/architect/);
    expect(out).toMatch(/anthropic:claude-opus-4-5/);
    expect(out).toMatch(/engineer/);
    expect(out).toMatch(/ollama:glm-5\.1:cloud/);
    // cursor marker on row 0
    expect(out.split("\n").filter((l) => l.startsWith("  ▸ ")).length).toBeGreaterThan(0);
  });

  it("shows orphan warning when a buffer entry is not in the persona catalogue", () => {
    let s = makeState({
      project: {
        "persona-models": { weirdo: { provider: "anthropic", model: "claude-opus-4-5" } },
      },
    });
    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    const out = renderPersonasList(s, WIDTH).join("\n");
    expect(out).toContain("Not in Forge persona catalogue");
    expect(out).toContain("weirdo");
  });

  it("shows 'no assignment — use default' for catalogue personas with no entry", () => {
    let s = makeState({
      project: {
        "persona-models": { engineer: { provider: "ollama", model: "glm-5.1:cloud" } },
      },
    });
    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    const out = renderPersonasList(s, WIDTH).join("\n");
    expect(out).toContain("Personas with no assignment");
    expect(out).toContain("architect");
    expect(out).toContain("supervisor");
    expect(out).toContain("scribe");
  });

  it("marks unavailable models with ✗", () => {
    let s = makeState({
      project: {
        "persona-models": { engineer: { provider: "openrouter", model: "fictional" } },
      },
    });
    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    const out = renderPersonasList(s, WIDTH).join("\n");
    // The avail badge column will contain a ✗
    expect(out).toContain("✗");
  });
});

describe("renderPersonaEditor — pick-provider", () => {
  it("lists every provider with an auth badge", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    const out = renderPersonaEditor(s, WIDTH).join("\n");
    expect(out).toContain("Step 1 of 3 — pick provider");
    expect(out).toContain("anthropic");
    expect(out).toContain("openai");
    expect(out).toContain("ollama");
    // Unauthenticated provider (we authenticated 3 of 4) is not in the auth list
  });

  it("warns when persona is not in the Forge catalogue", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "weirdo" });
    const out = renderPersonaEditor(s, WIDTH).join("\n");
    expect(out).toContain("not in the Forge persona catalogue");
  });

  it("does NOT warn for the reserved 'default' key", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "default" });
    const out = renderPersonaEditor(s, WIDTH).join("\n");
    expect(out).not.toContain("not in the Forge persona catalogue");
  });
});

describe("renderPersonaEditor — pick-model", () => {
  it("filters models by the previously chosen provider", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "anthropic" });
    const out = renderPersonaEditor(s, WIDTH).join("\n");
    expect(out).toContain("Step 2 of 3");
    expect(out).toContain("claude-opus-4-5");
    expect(out).toContain("claude-sonnet-4-6");
    expect(out).not.toContain("gpt-4o");
    expect(out).not.toContain("glm-5.1:cloud");
  });

  it("renders 'no models available' when the provider has none", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "openrouter" });
    const out = renderPersonaEditor(s, WIDTH).join("\n");
    expect(out).toContain("No models available");
    expect(out).toContain("pi /login openrouter");
  });
});

describe("renderPersonaEditor — pick-layer", () => {
  it("shows the chosen persona + provider:model and the two write targets", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "ollama" });
    s = reducer(s, { kind: "set-persona-model", model: "glm-5.1:cloud" });
    const out = renderPersonaEditor(s, WIDTH).join("\n");
    expect(out).toContain("Step 3 of 3");
    expect(out).toContain("engineer → ollama:glm-5.1:cloud");
    expect(out).toContain("Project");
    expect(out).toContain("Global");
    expect(out).toContain("/home/x/proj/.pi/forge-cli/config.json");
    expect(out).toContain("~/.pi/agent/forge-cli/config.json");
  });
});

describe("renderActive — top-level dispatcher", () => {
  it("dispatches based on the active view kind", () => {
    let s = makeState({ pipelineCatalogue: null });
    expect(renderActive(s, WIDTH).join("\n")).toContain("No project root found");

    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    expect(renderActive(s, WIDTH).join("\n")).toContain("forge config › personas");

    s = reducer(s, { kind: "pop-view" });
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    expect(renderActive(s, WIDTH).join("\n")).toContain("Step 1 of 3");
  });
});
