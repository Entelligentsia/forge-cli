// Phase B tier-flow tests — pick Heavy / Standard / Light tier models,
// verify the correct persona entries are written to the buffer.
//
// Tests:
// - Pick Heavy → write 2 persona entries (architect, supervisor)
// - Pick Standard → 4 entries (engineer, bug-fixer, qa-engineer, product-manager)
// - Pick Light → 3 entries (collator, librarian, orchestrator)
// - Pick all three → 9 entries; verify schema-valid

import { describe, expect, it } from "vitest";
import {
  initialState,
  reducer,
  type ConfigTuiState,
  getTierAssignment,
  getAllTierAssignments,
} from "../../../src/extensions/forgecli/config-tui/state.js";
import { TIER_PERSONAS, type Tier } from "../../../src/extensions/forgecli/config-tui/tier-meta.js";
import type { ConfigLayer } from "../../../src/extensions/forgecli/config-layer.js";

function makeState(): ConfigTuiState {
  return initialState({
    global: null,
    project: null,
    cwd: "/home/x/proj",
    personaCatalogue: [
      "architect", "supervisor",
      "engineer", "bug-fixer", "qa-engineer", "product-manager",
      "collator", "librarian", "orchestrator",
    ],
    pipelineCatalogue: ["default"],
    availableModels: [
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "anthropic", id: "claude-sonnet-4-6" },
      { provider: "ollama", id: "qwen2.5:0.5b" },
    ],
    authenticatedProviders: ["anthropic", "ollama"],
  });
}

// ── Tier-picker flow tests ───────────────────────────────────────────────────

describe("Phase B — tier-picker flow", () => {
  it("select-tier pushes tier-picker view", () => {
    let s = makeState();
    s = reducer(s, { kind: "select-tier", tier: "heavy" });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("tier-picker");
    if (top.kind === "tier-picker") {
      expect(top.tier).toBe("heavy");
      expect(top.step).toBe("pick-provider");
    }
  });

  it("set-tier-provider advances tier-picker to pick-model", () => {
    let s = makeState();
    s = reducer(s, { kind: "select-tier", tier: "heavy" });
    s = reducer(s, { kind: "set-tier-provider", tier: "heavy", provider: "anthropic" });
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("tier-picker");
    if (top.kind === "tier-picker") {
      expect(top.step).toBe("pick-model");
      expect(top.provider).toBe("anthropic");
    }
  });

  it("commit-tier-model for Heavy writes 2 persona entries (architect, supervisor)", () => {
    let s = makeState();
    s = reducer(s, { kind: "select-tier", tier: "heavy" });
    s = reducer(s, { kind: "set-tier-provider", tier: "heavy", provider: "anthropic" });
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "anthropic",
      model: "claude-opus-4-5",
      layer: "global",
    });

    // Should pop tier-picker, return to tier-menu
    const top = s.view[s.view.length - 1];
    expect(top.kind).toBe("tier-menu");

    // Buffer should have architect + supervisor set
    const personaModels = s.buffer.global["persona-models"] ?? {};
    expect(personaModels.architect).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
    expect(personaModels.supervisor).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
    expect(Object.keys(personaModels).length).toBe(2);

    // Dirty flag
    expect(s.dirty).toBe(true);

    // Tier selector should reflect set
    const assignment = getTierAssignment(s, "heavy");
    expect(assignment.status).toBe("set");
    if (assignment.status === "set") {
      expect(assignment.provider).toBe("anthropic");
      expect(assignment.model).toBe("claude-opus-4-5");
      expect(assignment.layer).toBe("global");
    }
  });

  it("commit-tier-model for Standard writes 4 persona entries", () => {
    let s = makeState();
    s = reducer(s, { kind: "select-tier", tier: "standard" });
    s = reducer(s, { kind: "set-tier-provider", tier: "standard", provider: "anthropic" });
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "standard",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      layer: "global",
    });

    const personaModels = s.buffer.global["persona-models"] ?? {};
    const expectedPersonas = ["engineer", "bug-fixer", "qa-engineer", "product-manager"];
    for (const p of expectedPersonas) {
      expect(personaModels[p]).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    }
    expect(Object.keys(personaModels).length).toBe(4);

    // Standard tier set
    expect(getTierAssignment(s, "standard").status).toBe("set");
    // Heavy and Light still unset
    expect(getTierAssignment(s, "heavy").status).toBe("unset");
    expect(getTierAssignment(s, "light").status).toBe("unset");
  });

  it("commit-tier-model for Light writes 3 persona entries", () => {
    let s = makeState();
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "light",
      provider: "ollama",
      model: "qwen2.5:0.5b",
      layer: "global",
    });

    const personaModels = s.buffer.global["persona-models"] ?? {};
    const expectedPersonas = ["collator", "librarian", "orchestrator"];
    for (const p of expectedPersonas) {
      expect(personaModels[p]).toEqual({ provider: "ollama", model: "qwen2.5:0.5b" });
    }
    expect(Object.keys(personaModels).length).toBe(3);
  });

  it("pick all three tiers → 9 persona entries total", () => {
    let s = makeState();

    // Pick Heavy
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "anthropic",
      model: "claude-opus-4-5",
      layer: "global",
    });

    // Pick Standard
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "standard",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      layer: "global",
    });

    // Pick Light
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "light",
      provider: "ollama",
      model: "qwen2.5:0.5b",
      layer: "global",
    });

    const personaModels = s.buffer.global["persona-models"] ?? {};
    const allKeys = Object.keys(personaModels);
    expect(allKeys.length).toBe(9);

    // All 9 personas accounted for
    const all9 = new Set([
      "architect", "supervisor",
      "engineer", "bug-fixer", "qa-engineer", "product-manager",
      "collator", "librarian", "orchestrator",
    ]);
    expect(new Set(allKeys)).toEqual(all9);

    // Heavy tier should show heavy model
    const heavyAssignment = getTierAssignment(s, "heavy");
    expect(heavyAssignment.status).toBe("set");
    if (heavyAssignment.status === "set") {
      expect(heavyAssignment.provider).toBe("anthropic");
      expect(heavyAssignment.model).toBe("claude-opus-4-5");
    }

    // Standard tier
    const standardAssignment = getTierAssignment(s, "standard");
    expect(standardAssignment.status).toBe("set");
    if (standardAssignment.status === "set") {
      expect(standardAssignment.provider).toBe("anthropic");
      expect(standardAssignment.model).toBe("claude-sonnet-4-6");
    }

    // Light tier
    const lightAssignment = getTierAssignment(s, "light");
    expect(lightAssignment.status).toBe("set");
    if (lightAssignment.status === "set") {
      expect(lightAssignment.provider).toBe("ollama");
      expect(lightAssignment.model).toBe("qwen2.5:0.5b");
    }

    // Verify getAllTierAssignments reflects all three
    const all = getAllTierAssignments(s);
    expect(all.every((a) => a.assignment.status === "set")).toBe(true);
  });

  it("commit to project layer writes to project buffer", () => {
    let s = makeState();
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "anthropic",
      model: "claude-opus-4-5",
      layer: "project",
    });

    // Should be in project, not global
    expect(s.buffer.project["persona-models"]?.architect).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    expect(s.buffer.project["persona-models"]?.supervisor).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-5",
    });
    expect(s.buffer.global["persona-models"]).toBeUndefined();

    // Selector reflects project layer
    const assignment = getTierAssignment(s, "heavy");
    expect(assignment.status).toBe("set");
    if (assignment.status === "set") {
      expect(assignment.layer).toBe("project");
    }
  });

  it("re-picking a tier overwrites previous persona entries", () => {
    let s = makeState();

    // First: Heavy = anthropic:claude-opus-4-5
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "anthropic",
      model: "claude-opus-4-5",
      layer: "global",
    });

    // Then: Heavy = ollama:qwen2.5:0.5b (change mind)
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "ollama",
      model: "qwen2.5:0.5b",
      layer: "global",
    });

    const personaModels = s.buffer.global["persona-models"] ?? {};
    expect(personaModels.architect).toEqual({ provider: "ollama", model: "qwen2.5:0.5b" });
    expect(personaModels.supervisor).toEqual({ provider: "ollama", model: "qwen2.5:0.5b" });

    const assignment = getTierAssignment(s, "heavy");
    expect(assignment.status).toBe("set");
    if (assignment.status === "set") {
      expect(assignment.provider).toBe("ollama");
    }
  });

  it("commit-tier-model pops tier-picker view back to tier-menu", () => {
    let s = makeState();
    expect(s.view[s.view.length - 1].kind).toBe("tier-menu");

    s = reducer(s, { kind: "select-tier", tier: "heavy" });
    expect(s.view[s.view.length - 1].kind).toBe("tier-picker");

    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "anthropic",
      model: "claude-opus-4-5",
      layer: "global",
    });
    expect(s.view[s.view.length - 1].kind).toBe("tier-menu");
  });

  it("schema-valid: persona-model values are {provider, model} objects", () => {
    let s = makeState();
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "anthropic",
      model: "claude-opus-4-5",
      layer: "global",
    });

    const personaModels = s.buffer.global["persona-models"] ?? {};
    for (const [key, val] of Object.entries(personaModels)) {
      expect(typeof key).toBe("string");
      expect(val).toHaveProperty("provider");
      expect(val).toHaveProperty("model");
      expect(typeof (val as Record<string, unknown>).provider).toBe("string");
      expect(typeof (val as Record<string, unknown>).model).toBe("string");
    }
  });
});

describe("Phase B — toggle-scope flow", () => {
  it("toggle-scope switches between global and project", () => {
    let s = makeState();
    // Default scope in a project is "project"
    expect(s.scope).toBe("project");

    s = reducer(s, { kind: "toggle-scope" });
    expect(s.scope).toBe("global");

    s = reducer(s, { kind: "toggle-scope" });
    expect(s.scope).toBe("project");
  });

  it("scope determines which layer commit-tier-model writes to", () => {
    let s = makeState();
    // Start in project scope
    expect(s.scope).toBe("project");

    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "heavy",
      provider: "anthropic",
      model: "claude-opus-4-5",
      layer: s.scope,
    });

    // Written to project layer
    expect(s.buffer.project["persona-models"]?.architect).toBeDefined();
    expect(s.buffer.global["persona-models"]).toBeUndefined();

    // Toggle to global and commit Standard
    s = reducer(s, { kind: "toggle-scope" });
    s = reducer(s, {
      kind: "commit-tier-model",
      tier: "standard",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      layer: s.scope,
    });

    // Standard personas in global, heavy in project
    expect(s.buffer.global["persona-models"]?.engineer).toBeDefined();
    expect(s.buffer.project["persona-models"]?.architect).toBeDefined();
  });
});