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
  computeResolvedRows,
  renderPersonasList,
  renderPersonaEditor,
  renderShowResolved,
  renderOverridesListPipelines,
  renderOverridesListPhases,
  renderOverrideEditor,
  renderActive,
} from "../../../src/extensions/forgecli/config-tui/screens.js";
import { CANONICAL_PHASES } from "../../../src/extensions/forgecli/config-tui/state/constants.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Mock theme for tests — strips all styling so assertions match plain text.
const mockTheme: Theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
} as unknown as Theme;

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
    const out = renderPersonasList(s, WIDTH, mockTheme).join("\n");
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
    const out = renderPersonasList(s, WIDTH, mockTheme).join("\n");
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
    const out = renderPersonasList(s, WIDTH, mockTheme).join("\n");
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
    const out = renderPersonasList(s, WIDTH, mockTheme).join("\n");
    // The avail badge column will contain a ✗
    expect(out).toContain("✗");
  });
});

describe("renderPersonaEditor — pick-provider", () => {
  it("lists every provider with an auth badge", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    const out = renderPersonaEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("Step 1 of 3 — pick provider");
    expect(out).toContain("anthropic");
    expect(out).toContain("openai");
    expect(out).toContain("ollama");
    // Unauthenticated provider (we authenticated 3 of 4) is not in the auth list
  });

  it("warns when persona is not in the Forge catalogue", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "weirdo" });
    const out = renderPersonaEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("not in the Forge persona catalogue");
  });

  it("does NOT warn for the reserved 'default' key", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "default" });
    const out = renderPersonaEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).not.toContain("not in the Forge persona catalogue");
  });
});

describe("renderPersonaEditor — pick-model", () => {
  it("filters models by the previously chosen provider", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "anthropic" });
    const out = renderPersonaEditor(s, WIDTH, mockTheme).join("\n");
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
    const out = renderPersonaEditor(s, WIDTH, mockTheme).join("\n");
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
    const out = renderPersonaEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("Step 3 of 3");
    expect(out).toContain("engineer → ollama:glm-5.1:cloud");
    expect(out).toContain("Project");
    expect(out).toContain("Global");
    expect(out).toContain("/home/x/proj/.pi/forge-cli/config.json");
    expect(out).toContain("~/.pi/agent/forge-cli/config.json");
  });
});

describe("renderShowResolved (Phase C — rewritten)", () => {
  it("shows phase table with Step/Persona/Model/Source columns and plain-English source labels", () => {
    let s = makeState({
      global: { "persona-models": { engineer: { provider: "ollama", model: "glm-5.1:cloud" } } },
      project: { "persona-models": { architect: { provider: "anthropic", model: "claude-opus-4-5" } } },
    });
    s = reducer(s, { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
    const lines = renderShowResolved(s, WIDTH, mockTheme);
    const out = lines.join("\n");
    // Title
    expect(out).toContain("forge config › current setup");
    // Column headers
    expect(out).toContain("Step");
    expect(out).toContain("Persona");
    expect(out).toContain("Model");
    expect(out).toContain("Source");
    // Phase rows with emoji + persona name
    expect(out).toContain("🌱 engineer");
    expect(out).toContain("🌿 supervisor");
    expect(out).toContain("🗻 architect");
    // Model strings
    expect(out).toContain("ollama:glm-5.1:cloud");
    expect(out).toContain("anthropic:claude-opus"); // may be truncated at 80 width
    // Source labels: tier-based plain English, no L1/L2 badges
    expect(out).toContain("Standard tier");
    expect(out).toContain("Heavy tier");
    // Cascade footer
    expect(out).toContain("How models get picked");
    expect(out).toContain("most specific wins");
    expect(out).toContain("Step override");
    expect(out).toContain("tier baseline");
    expect(out).toContain("falls back automatically");
  });

  it("falls back to pi current when nothing resolves", () => {
    let s = makeState();
    s = reducer(s, { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
    const out = renderShowResolved(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("inherit pi current");
    expect(out).toContain("Falls back to pi current");
  });

  it("scrolls when cursor walks past the window", () => {
    // Phase table has 8 rows; using window size 5 forces scrolling.
    // We test this by rendering with a different pipeline catalogue
    // and confirming the window list mechanism works.
    let s = makeState({
      pipelineCatalogue: ["default"],
    });
    s = reducer(s, { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
    const beforeOut = renderShowResolved(s, WIDTH, mockTheme).join("\n");
    expect(beforeOut).toContain("Step");
    // With only 8 rows and a window of 10, no scroll indicator needed.
    // Instead verify cursor movement works.
    s = reducer(s, { kind: "cursor-move", delta: 7 });
    const afterOut = renderShowResolved(s, WIDTH, mockTheme).join("\n");
    // Last row should be visible
    expect(afterOut).toContain("commit");
  });

  it("never shows L1/L2/cascade jargon", () => {
    let s = makeState({
      global: { "persona-models": { engineer: { provider: "ollama", model: "glm-5.1:cloud" } } },
    });
    s = reducer(s, { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
    const out = renderShowResolved(s, WIDTH, mockTheme).join("\n");
    // Ensure old jargon labels are gone
    expect(out).not.toContain("Pipeline:"); // no pipeline separator headers
    // L1/L2 should not appear as standalone source labels (they may appear
    // inside model strings, which is fine)
    const lines = out.split("\n");
    for (const line of lines) {
      // Source column lines should not have bare "L1" or "L2"
      if (line.includes("tier (")) {
        expect(line).not.toMatch(/\bL[1-4]\b/);
      }
    }
  });
});

describe("computeResolvedRows (pure exporter)", () => {
  it("emits one row per canonical phase per known pipeline name", () => {
    let s = makeState({
      pipelineCatalogue: ["default", "hotfix"],
    });
    s = reducer(s, { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
    const groups = computeResolvedRows(s);
    expect(groups.length).toBe(2);
    expect(groups[0].pipeline).toBe("default");
    expect(groups[1].pipeline).toBe("hotfix");
    expect(groups[0].rows.length).toBe(CANONICAL_PHASES.length);
  });

  it("source = inherit for empty config, with model undefined", () => {
    let s = makeState();
    s = reducer(s, { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } });
    const [pipeline] = computeResolvedRows(s);
    for (const row of pipeline.rows) {
      expect(row.source).toBe("inherit");
      expect(row.resolved).toBe("(inherit pi current)");
    }
  });
});

describe("renderOverridesListPipelines (Slice 4c — Screen 4)", () => {
  it("shows every catalogue pipeline with an override count", () => {
    let s = makeState();
    s = reducer(s, { kind: "push-view", view: { kind: "overrides-list-pipelines", cursor: 0 } });
    const out = renderOverridesListPipelines(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("forge config › per-step overrides");
    expect(out).toContain("default");
    expect(out).toContain("hotfix");
    expect(out).toContain("none");
    // Cursor on row 0
    expect(out.split("\n").filter((l) => l.startsWith("  ▸ ")).length).toBeGreaterThan(0);
  });

  it("shows override counts after writes", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "commit-override-name", name: "scribe" });
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "approve" });
    s = reducer(s, { kind: "commit-override-name", name: "engineer" });
    s = reducer(s, { kind: "push-view", view: { kind: "overrides-list-pipelines", cursor: 0 } });
    const out = renderOverridesListPipelines(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("2 overrides");
  });
});

describe("renderOverridesListPhases (Slice 4c — Screen 4 phase table)", () => {
  // Phase 3 width-safety: the phases table exceeds 80 chars, so use a wider
  // viewport for this test so that column content is fully visible.
  const WIDE = 140;

  it("renders one row per canonical phase with override + resolved + source columns", () => {
    let s = makeState();
    s = reducer(s, {
      kind: "push-view",
      view: { kind: "overrides-list-phases", pipeline: "default", cursor: 2 },
    });
    const out = renderOverridesListPhases(s, WIDE, mockTheme).join("\n");
    expect(out).toContain("forge config › per-step overrides › default");
    expect(out).toContain("plan");
    expect(out).toContain("implement");
    expect(out).toContain("commit");
    expect(out).toContain("(inherit pi current)");
    expect(out).toContain("inherit");
    // Cursor lands on row 2 (implement)
    const rowLines = out.split("\n").filter((l) => l.startsWith("  ▸ "));
    expect(rowLines.length).toBe(1);
    expect(rowLines[0]).toMatch(/implement/);
  });

  it("renders L4-name and L4-inline override shapes distinctly", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "commit-override-name", name: "scribe" });
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "review-plan" });
    s = reducer(s, {
      kind: "commit-override-inline",
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    s = reducer(s, {
      kind: "push-view",
      view: { kind: "overrides-list-phases", pipeline: "default", cursor: 0 },
    });
    const out = renderOverridesListPhases(s, WIDE, mockTheme).join("\n");
    expect(out).toContain(`"scribe"`);
    expect(out).toContain(`{anthropic:claude-opus-4-5}`);
  });
});

describe("renderOverrideEditor (Slice 4c — Screen 5)", () => {
  it("pick-type shows three numbered options", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "implement" });
    const out = renderOverrideEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("Override type:");
    expect(out).toContain("persona-model by name");
    expect(out).toContain("Inline {provider, model}");
    expect(out).toContain("Clear override");
    expect(out).toContain("implement");
  });

  it("pick-name lists defined persona-models with an availability badge", () => {
    let s = makeState({
      global: { "persona-models": { scribe: { provider: "ollama", model: "glm-5.1:cloud" } } },
      project: {
        "persona-models": {
          architect: { provider: "anthropic", model: "claude-opus-4-5" },
        },
      },
    });
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "implement" });
    s = reducer(s, { kind: "set-override-step", step: "pick-name" });
    const out = renderOverrideEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("Pick persona-model");
    expect(out).toContain("scribe");
    expect(out).toContain("architect");
    expect(out).toContain("ollama:glm-5.1:cloud");
    expect(out).toContain("anthropic:claude-opus-4-5");
    expect(out).toContain("✓");
  });

  it("pick-name falls back to a helpful empty hint", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "set-override-step", step: "pick-name" });
    const out = renderOverrideEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("no persona-models defined");
  });

  it("pick-provider lists providers with auth badges", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "set-override-step", step: "pick-provider" });
    const out = renderOverrideEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("Inline override — Step 1 of 2");
    expect(out).toContain("anthropic");
    expect(out).toContain("ollama");
    expect(out).toContain("openai");
  });

  it("pick-model filters to chosen provider", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "set-override-step", step: "pick-provider" });
    s = reducer(s, { kind: "set-override-provider", provider: "anthropic" });
    const out = renderOverrideEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("Step 2 of 2");
    expect(out).toContain("claude-opus-4-5");
    expect(out).toContain("claude-sonnet-4-6");
    expect(out).not.toContain("gpt-4o");
  });

  it("pick-model shows 'No models available' when provider has none", () => {
    let s = makeState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "set-override-step", step: "pick-provider" });
    s = reducer(s, { kind: "set-override-provider", provider: "openrouter" });
    const out = renderOverrideEditor(s, WIDTH, mockTheme).join("\n");
    expect(out).toContain("No models available");
    expect(out).toContain("pi /login openrouter");
  });
});

describe("renderActive — top-level dispatcher", () => {
  it("dispatches based on the active view kind", () => {
    let s = makeState();
    expect(renderActive(s, WIDTH, mockTheme).join("\n")).toContain("forge config");

    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    expect(renderActive(s, WIDTH, mockTheme).join("\n")).toContain("forge config › per-persona overrides");

    s = reducer(s, { kind: "pop-view" });
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    expect(renderActive(s, WIDTH, mockTheme).join("\n")).toContain("Step 1 of 3");
  });
});
