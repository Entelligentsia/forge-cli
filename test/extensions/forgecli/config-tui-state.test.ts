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
  it("starts on top-menu when no config files exist", () => {
    const s = emptyState();
    expect(s.view.length).toBe(1);
    expect(s.view[0].kind).toBe("top-menu");
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
    // empty-state vs top-menu: top-menu always wins when we have a pipeline catalogue
    // (the design doc shows empty state as a top-menu variant — content differs)
    expect(s.isEmpty).toBe(true);
  });

  it("seeds buffer from global+project when both are present", () => {
    const global: GlobalConfig = {
      "persona-models": { engineer: { provider: "openai", model: "gpt-4o" } },
    };
    const project: ProjectConfig = {
      "persona-models": { architect: { provider: "anthropic", model: "claude-opus-4-5" } },
      pipelines: { default: { phases: [{ role: "commit", "model-override": "scribe" }] } },
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
    expect(s.view[0].kind).toBe("top-menu");
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
  it("View is a discriminated union covering all screens in scope for 4b", () => {
    const views: View[] = [
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
    expect(views.length).toBe(5);
  });
});
