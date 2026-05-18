// Tests for the config-TUI state reducer. Pure functions, no I/O.
// Plan 16 Slice 4b — Plan 16.

import { describe, expect, it } from "vitest";

import {
  initialState,
  reducer,
  type ConfigTuiState,
  type ConfigTuiAction,
  type View,
} from "../../../src/extensions/forgecli/config-tui/state.js";
import type { GlobalConfig, ProjectConfig } from "../../../src/extensions/forgecli/config-layer.js";

const emptyState = (): ConfigTuiState =>
  initialState({
    global: null,
    project: null,
    cwd: "/tmp/x",
    personaCatalogue: ["architect", "engineer", "supervisor", "scribe"],
    pipelineCatalogue: ["default", "hotfix"],
    availableModels: [
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "ollama", id: "glm-5.1:cloud" },
    ],
    authenticatedProviders: ["anthropic", "ollama"],
  });

describe("initialState", () => {
  it("starts on tier-menu when no config files exist", () => {
    const s = emptyState();
    expect(s.view.length).toBe(1);
    expect(s.view[0].kind).toBe("tier-menu");
  });

  it("starts on no-project when pipelineCatalogue is null", () => {
    const s = initialState({
      global: null,
      project: null,
      cwd: "/tmp/x",
      personaCatalogue: ["engineer"],
      pipelineCatalogue: null,
      availableModels: [],
      authenticatedProviders: [],
    });
    expect(s.view[0].kind).toBe("no-project");
  });

  it("starts on empty-state when both configs missing AND pipelineCatalogue exists", () => {
    const s = emptyState();
    expect(s.dirty).toBe(false);
    expect(s.buffer.global).toEqual({});
    expect(s.buffer.project).toEqual({});
    // Tier-menu replaces top-menu as the default view when a pipeline catalogue exists.
    // isEmpty is still true (no config files), but the view is now tier-menu.
    expect(s.isEmpty).toBe(true);
    expect(s.view[0].kind).toBe("tier-menu");
  });

  it("seeds buffer from global+project when both are present", () => {
    const global: GlobalConfig = {
      "persona-models": { engineer: { provider: "openai", model: "gpt-4o" } },
    };
    const project: ProjectConfig = {
      "persona-models": { architect: { provider: "anthropic", model: "claude-opus-4-5" } },
      pipelines: { default: { phases: { commit: { "model-override": "scribe" } } } },
    };
    const s = initialState({
      global,
      project,
      cwd: "/tmp/x",
      personaCatalogue: ["architect", "engineer", "scribe"],
      pipelineCatalogue: ["default"],
      availableModels: [],
      authenticatedProviders: [],
    });
    expect(s.buffer.global).toEqual(global);
    expect(s.buffer.project).toEqual(project);
    expect(s.isEmpty).toBe(false);
    expect(s.dirty).toBe(false);
  });
});

describe("reducer — view stack navigation", () => {
  it("push pushes a new view; pop returns to previous", () => {
    let s = emptyState();
    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    expect(s.view.length).toBe(2);
    expect(s.view[s.view.length - 1].kind).toBe("personas-list");

    s = reducer(s, { kind: "pop-view" });
    expect(s.view.length).toBe(1);
    expect(s.view[0].kind).toBe("tier-menu");
  });

  it("pop on the root view is a no-op (stack length never goes below 1)", () => {
    let s = emptyState();
    s = reducer(s, { kind: "pop-view" });
    expect(s.view.length).toBe(1);
  });

  it("cursor moves are bounded", () => {
    let s = emptyState();
    s = reducer(s, { kind: "push-view", view: { kind: "personas-list", cursor: 0 } });
    s = reducer(s, { kind: "cursor-move", delta: -1 });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("personas-list");
    if (top.kind === "personas-list") expect(top.cursor).toBe(0); // clamped at 0
  });
});

describe("reducer — persona edit", () => {
  it("begin-persona-edit pushes the editor with the chosen persona", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("persona-editor");
    if (top.kind === "persona-editor") {
      expect(top.persona).toBe("engineer");
      expect(top.step).toBe("pick-provider");
    }
  });

  it("set-persona-provider advances to pick-model and remembers the provider", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "ollama" });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("persona-editor");
    if (top.kind === "persona-editor") {
      expect(top.provider).toBe("ollama");
      expect(top.step).toBe("pick-model");
    }
  });

  it("commit-persona-edit writes into the chosen layer's buffer and marks dirty", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "ollama" });
    s = reducer(s, { kind: "set-persona-model", model: "glm-5.1:cloud" });
    s = reducer(s, { kind: "commit-persona-edit", layer: "project" });

    expect(s.dirty).toBe(true);
    expect(s.buffer.project?.["persona-models"]?.engineer).toEqual({
      provider: "ollama",
      model: "glm-5.1:cloud",
    });
    // editor closed
    expect(s.view[s.view.length - 1].kind).not.toBe("persona-editor");
  });

  it("commit-persona-edit with layer=global writes to the global buffer", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "architect" });
    s = reducer(s, { kind: "set-persona-provider", provider: "anthropic" });
    s = reducer(s, { kind: "set-persona-model", model: "claude-opus-4-5" });
    s = reducer(s, { kind: "commit-persona-edit", layer: "global" });

    expect(s.buffer.global?.["persona-models"]?.architect).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    expect(s.buffer.project?.["persona-models"]).toBeUndefined();
  });

  it("delete-persona-entry removes a layer's entry and may clean up empty maps", () => {
    let s = initialState({
      global: null,
      project: { "persona-models": { engineer: { provider: "ollama", model: "glm-5.1:cloud" } } },
      cwd: "/tmp/x",
      personaCatalogue: ["engineer"],
      pipelineCatalogue: ["default"],
      availableModels: [],
      authenticatedProviders: [],
    });
    expect(s.buffer.project?.["persona-models"]?.engineer).toBeDefined();
    s = reducer(s, { kind: "delete-persona-entry", layer: "project", persona: "engineer" });
    expect(s.buffer.project?.["persona-models"]?.engineer).toBeUndefined();
    expect(s.dirty).toBe(true);
  });
});

describe("reducer — mark-clean (Slice 4c polish)", () => {
  it("mark-clean resets dirty and records lastSaved", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "anthropic" });
    s = reducer(s, { kind: "set-persona-model", model: "claude-opus-4-5" });
    s = reducer(s, { kind: "commit-persona-edit", layer: "project" });
    expect(s.dirty).toBe(true);
    expect(s.lastSaved).toBeNull();

    s = reducer(s, {
      kind: "mark-clean",
      lastSaved: { target: "/tmp/x/.pi/forge-cli/config.json", layer: "project" },
    });
    expect(s.dirty).toBe(false);
    expect(s.lastSaved).toEqual({
      target: "/tmp/x/.pi/forge-cli/config.json",
      layer: "project",
    });
  });

  it("clear-status clears lastSaved without touching dirty", () => {
    let s = emptyState();
    s = reducer(s, {
      kind: "mark-clean",
      lastSaved: { target: "/tmp/x", layer: "global" },
    });
    expect(s.lastSaved).not.toBeNull();
    s = reducer(s, { kind: "clear-status" });
    expect(s.lastSaved).toBeNull();
  });
});

describe("reducer — quit prompt", () => {
  it("request-quit on a clean state immediately marks shouldExit", () => {
    let s = emptyState();
    s = reducer(s, { kind: "request-quit" });
    expect(s.shouldExit).toBe(true);
  });

  it("request-quit while confirmQuit modal is open is a no-op (no re-trigger)", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "ollama" });
    s = reducer(s, { kind: "set-persona-model", model: "glm-5.1:cloud" });
    s = reducer(s, { kind: "commit-persona-edit", layer: "project" });
    // dirty is true (no mark-clean dispatched in this reducer-only test)
    s = reducer(s, { kind: "request-quit" });
    expect(s.confirmQuit).toBe(true);
    expect(s.shouldExit).toBe(false);

    // Second request-quit should be a no-op — does NOT toggle confirmQuit off
    // or re-enter shouldExit logic.
    const before = s;
    s = reducer(s, { kind: "request-quit" });
    expect(s).toBe(before); // referential equality — reducer returned same object
  });

  it("request-quit on a dirty state opens a confirm overlay; confirming exits", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "ollama" });
    s = reducer(s, { kind: "set-persona-model", model: "glm-5.1:cloud" });
    s = reducer(s, { kind: "commit-persona-edit", layer: "project" });
    expect(s.dirty).toBe(true);

    s = reducer(s, { kind: "request-quit" });
    expect(s.shouldExit).toBe(false);
    expect(s.confirmQuit).toBe(true);

    s = reducer(s, { kind: "confirm-quit", discard: true });
    expect(s.shouldExit).toBe(true);
  });

  it("confirm-quit with discard=false cancels the quit", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-persona-edit", persona: "engineer" });
    s = reducer(s, { kind: "set-persona-provider", provider: "ollama" });
    s = reducer(s, { kind: "set-persona-model", model: "glm-5.1:cloud" });
    s = reducer(s, { kind: "commit-persona-edit", layer: "project" });
    s = reducer(s, { kind: "request-quit" });
    s = reducer(s, { kind: "confirm-quit", discard: false });
    expect(s.shouldExit).toBe(false);
    expect(s.confirmQuit).toBe(false);
  });
});

describe("reducer — exhaustiveness", () => {
  it("unknown action does not throw; returns state unchanged", () => {
    const s = emptyState();
    // @ts-expect-error — testing runtime resilience to bad action
    const next = reducer(s, { kind: "bogus" });
    expect(next).toBe(s);
  });
});

describe("View kinds", () => {
  it("View is a discriminated union covering all screens in scope for Phase A+D", () => {
    const views: View[] = [
      { kind: "tier-menu", cursor: 0 },
      { kind: "tier-picker", tier: "heavy", step: "pick-provider", provider: undefined, cursor: 0 },
      { kind: "advanced-menu", cursor: 0 },
      { kind: "top-menu", cursor: 0 },
      { kind: "empty-state", cursor: 0 },
      { kind: "no-project", cursor: 0 },
      { kind: "personas-list", cursor: 0 },
      {
        kind: "persona-editor",
        persona: "engineer",
        step: "pick-provider",
        provider: undefined,
        model: undefined,
        cursor: 0,
      },
    ];
    expect(views.length).toBe(8);
  });
});

describe("reducer — per-phase overrides (Slice 4c)", () => {
  it("begin-override-edit pushes the editor at step pick-type", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "implement" });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("override-editor");
    if (top.kind === "override-editor") {
      expect(top.pipeline).toBe("default");
      expect(top.phaseRole).toBe("implement");
      expect(top.step).toBe("pick-type");
      expect(top.cursor).toBe(0);
    }
  });

  it("set-override-step transitions and resets cursor", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "cursor-move", delta: 2 });
    s = reducer(s, { kind: "set-override-step", step: "pick-name" });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("override-editor");
    if (top.kind === "override-editor") {
      expect(top.step).toBe("pick-name");
      expect(top.cursor).toBe(0);
    }
  });

  it("set-override-provider advances to pick-model", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "set-override-step", step: "pick-provider" });
    s = reducer(s, { kind: "set-override-provider", provider: "ollama" });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("override-editor");
    if (top.kind === "override-editor") {
      expect(top.step).toBe("pick-model");
      expect(top.provider).toBe("ollama");
    }
  });

  it("commit-override-name writes a string override, pops editor, marks dirty", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "implement" });
    s = reducer(s, { kind: "commit-override-name", name: "scribe" });
    expect(s.dirty).toBe(true);
    expect(s.view[s.view.length - 1].kind).not.toBe("override-editor");
    const phases = s.buffer.project.pipelines?.default?.phases ?? {};
    expect(Object.keys(phases)).toEqual(["implement"]);
    expect(phases.implement?.["model-override"]).toBe("scribe");
  });

  it("commit-override-inline writes a {provider, model} pair", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "hotfix", phaseRole: "plan" });
    s = reducer(s, { kind: "commit-override-inline", provider: "anthropic", model: "claude-haiku-4-5" });
    expect(s.dirty).toBe(true);
    const phases = s.buffer.project.pipelines?.hotfix?.phases ?? {};
    expect(phases.plan?.["model-override"]).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });

  it("clear-phase-override removes the override and cleans up empty structures", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "commit-override-name", name: "scribe" });
    expect(s.buffer.project.pipelines?.default?.phases?.plan?.["model-override"]).toBe("scribe");

    s = reducer(s, { kind: "clear-phase-override", pipeline: "default", phaseRole: "plan" });
    // Single override removed → pipeline is now empty → pipelines key dropped
    expect(s.buffer.project.pipelines).toBeUndefined();
    expect(s.dirty).toBe(true);
  });

  it("clear-phase-override preserves the pipeline if other overrides remain", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "commit-override-name", name: "scribe" });
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "commit" });
    s = reducer(s, { kind: "commit-override-name", name: "engineer" });

    s = reducer(s, { kind: "clear-phase-override", pipeline: "default", phaseRole: "plan" });
    const phases = s.buffer.project.pipelines?.default?.phases ?? {};
    expect(Object.keys(phases)).toEqual(["commit"]);
    expect(phases.commit?.["model-override"]).toBe("engineer");
  });

  it("clear-phase-override is a no-op when nothing was set", () => {
    let s = emptyState();
    const before = s;
    s = reducer(s, { kind: "clear-phase-override", pipeline: "default", phaseRole: "plan" });
    expect(s).toBe(before);
  });

  it("clear-phase-override pops the editor when invoked from inside it", () => {
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "commit-override-name", name: "scribe" });
    // Re-enter the editor (to simulate user choosing "Clear override" inside the type picker)
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    expect(s.view[s.view.length - 1].kind).toBe("override-editor");
    s = reducer(s, { kind: "clear-phase-override", pipeline: "default", phaseRole: "plan" });
    expect(s.view[s.view.length - 1].kind).not.toBe("override-editor");
  });
});

describe("selectors — per-phase override summaries", () => {
  it("listPipelineOverrideSummaries returns one row per catalogue pipeline", async () => {
    const { listPipelineOverrideSummaries } = await import(
      "../../../src/extensions/forgecli/config-tui/state.js"
    );
    let s = emptyState();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "plan" });
    s = reducer(s, { kind: "commit-override-name", name: "scribe" });
    const rows = listPipelineOverrideSummaries(s);
    expect(rows.length).toBe(2); // default + hotfix from emptyState catalogue
    expect(rows.find((r) => r.pipeline === "default")?.overrideCount).toBe(1);
    expect(rows.find((r) => r.pipeline === "hotfix")?.overrideCount).toBe(0);
  });

  it("getPhaseOverride returns the stored override or undefined", async () => {
    const { getPhaseOverride } = await import(
      "../../../src/extensions/forgecli/config-tui/state.js"
    );
    let s = emptyState();
    expect(getPhaseOverride(s, "default", "plan")).toBeUndefined();
    s = reducer(s, { kind: "begin-override-edit", pipeline: "default", phaseRole: "implement" });
    s = reducer(s, { kind: "commit-override-inline", provider: "ollama", model: "glm-4.6" });
    expect(getPhaseOverride(s, "default", "implement")).toEqual({ provider: "ollama", model: "glm-4.6" });
  });
});
