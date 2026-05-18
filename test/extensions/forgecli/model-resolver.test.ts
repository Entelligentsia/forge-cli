// Tests for the cascade model resolver (Slice 1 — Plan 16).
//
// Coverage (every cascade level):
//  1.  L4-inline hit: phases[i].model-override = {provider, model} → returned directly
//  2.  L4-name hit: phases[i].model-override = string → resolved via lookupPersonaModel
//  3.  L4-name miss: string references nonexistent persona-model → falls through to L3+
//  4.  L3 hit: pipelines[name].persona-models[personaNoun] wins
//  5.  L3 absent, L2 hit: project persona-models wins
//  6.  L2 absent, L1 hit: global persona-models wins
//  7.  L1 absent, 'default' persona-model wins
//  8.  'default' absent → inherit (model: undefined)
//  9.  Project overrides global per-persona without affecting other personas
// 10.  project 'default' overrides global 'default'
// 11.  Empty configs → inherit for all personas
// 12.  L4-inline beats L4-name (inline always wins)
// 13.  lookupPersonaModel: L3 → L2 → L1 → default → missing

import { describe, expect, it } from "vitest";

import {
  resolveModelForPhase,
  lookupPersonaModel,
  type MergedConfig,
} from "../../../src/extensions/forgecli/model-resolver.js";

// Helper to build a MergedConfig from pieces
function merged(opts: {
  globalPersonaModels?: Record<string, { provider: string; model: string }>;
  projectPersonaModels?: Record<string, { provider: string; model: string }>;
  pipelines?: MergedConfig["pipelines"];
}): MergedConfig {
  return {
    "persona-models": {
      ...(opts.globalPersonaModels ?? {}),
      ...(opts.projectPersonaModels ?? {}),
    },
    _global: opts.globalPersonaModels
      ? { "persona-models": opts.globalPersonaModels }
      : null,
    _project: opts.projectPersonaModels
      ? { "persona-models": opts.projectPersonaModels }
      : null,
    pipelines: opts.pipelines,
  };
}

// Full merged config used by most tests
function fullMerged(): MergedConfig {
  return {
    _global: {
      "persona-models": {
        architect: { provider: "anthropic", model: "claude-opus-4-5" },
        engineer: { provider: "ollama", model: "glm-5.1:cloud" },
        scribe: { provider: "google", model: "gemini-2.5-flash" },
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
    },
    _project: {
      "persona-models": {
        engineer: { provider: "openai", model: "gpt-4o" },
      },
    },
    "persona-models": {
      architect: { provider: "anthropic", model: "claude-opus-4-5" },
      engineer: { provider: "openai", model: "gpt-4o" }, // project wins
      scribe: { provider: "google", model: "gemini-2.5-flash" },
      default: { provider: "anthropic", model: "claude-sonnet-4-6" },
    },
    pipelines: {
      default: {
        "persona-models": {
          supervisor: { provider: "anthropic", model: "claude-opus-4-5" },
        },
        phases: {
          implement: { "model-override": "scribe" },
          commit: { "model-override": { provider: "anthropic", model: "claude-haiku-4-5" } },
        },
      },
    },
  };
}

describe("resolveModelForPhase", () => {
  // 1. L4-inline hit
  it("returns L4-inline when phase has inline {provider,model} override", () => {
    const cfg = fullMerged();
    const result = resolveModelForPhase("default", "commit", "scribe", cfg);
    expect(result.source).toBe("L4-inline");
    expect(result.model).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  // 2. L4-name hit
  it("returns L4-name when phase override is a resolvable persona-model name", () => {
    const cfg = fullMerged();
    const result = resolveModelForPhase("default", "implement", "engineer", cfg);
    expect(result.source).toBe("L4-name");
    // 'scribe' resolves via persona-models merged map → google:gemini-2.5-flash
    expect(result.model).toEqual({ provider: "google", model: "gemini-2.5-flash" });
  });

  // 3. L4-name miss → falls through using original personaNoun
  it("falls through to L3 when L4-name string references unknown persona-model", () => {
    const cfg: MergedConfig = {
      _global: null,
      _project: {
        "persona-models": {
          engineer: { provider: "openai", model: "gpt-4o" },
        },
      },
      "persona-models": {
        engineer: { provider: "openai", model: "gpt-4o" },
      },
      pipelines: {
        default: {
          phases: {
            plan: { "model-override": "nonexistent-persona" },
          },
        },
      },
    };
    const result = resolveModelForPhase("default", "plan", "engineer", cfg);
    // Falls through: engineer in project layer → L2
    expect(result.source).toBe("L2");
    expect(result.model).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  // 4. L3 hit
  it("returns L3 when pipeline-level persona-models entry matches", () => {
    const cfg = fullMerged();
    // supervisor is only in L3 (pipeline persona-models)
    const result = resolveModelForPhase("default", "review-plan", "supervisor", cfg);
    expect(result.source).toBe("L3");
    expect(result.model).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
  });

  // 5. L3 absent, L2 hit
  it("returns L2 when no L3 entry but project persona-models has the persona", () => {
    const cfg = fullMerged();
    // engineer has L3 absent but L2 present (project override)
    // Phase 0 (plan) has no model-override
    const result = resolveModelForPhase("default", "plan", "engineer", cfg);
    expect(result.source).toBe("L2");
    expect(result.model).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  // 6. L2 absent, L1 hit
  it("returns L1 when L3 and L2 absent but global persona-models has the persona", () => {
    const cfg: MergedConfig = {
      _global: {
        "persona-models": {
          architect: { provider: "anthropic", model: "claude-opus-4-5" },
        },
      },
      _project: null,
      "persona-models": {
        architect: { provider: "anthropic", model: "claude-opus-4-5" },
      },
      pipelines: {
        default: {
          phases: {},
        },
      },
    };
    const result = resolveModelForPhase("default", "approve", "architect", cfg);
    expect(result.source).toBe("L1");
    expect(result.model).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
  });

  // 7. L1 absent, 'default' wins
  it("returns default when persona not found at any layer but default is set", () => {
    const cfg: MergedConfig = {
      _global: {
        "persona-models": {
          default: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
      _project: null,
      "persona-models": {
        default: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      pipelines: { default: { phases: {} } },
    };
    const result = resolveModelForPhase("default", "plan", "product-manager", cfg);
    expect(result.source).toBe("default");
    expect(result.model).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  // 8. 'default' absent → inherit
  it("returns inherit when cascade bottoms out with no config at all", () => {
    const cfg: MergedConfig = {
      _global: null,
      _project: null,
      "persona-models": {},
      pipelines: { default: { phases: {} } },
    };
    const result = resolveModelForPhase("default", "plan", "engineer", cfg);
    expect(result.source).toBe("inherit");
    expect(result.model).toBeUndefined();
  });

  // 9. Project overrides global per-persona without affecting others
  it("project override of engineer does not affect architect from global", () => {
    const cfg = fullMerged();
    const engineerResult = resolveModelForPhase("default", "plan", "engineer", cfg);
    const architectResult = resolveModelForPhase("default", "plan", "architect", cfg);
    // engineer: project (openai:gpt-4o) wins
    expect(engineerResult.source).toBe("L2");
    expect(engineerResult.model?.provider).toBe("openai");
    // architect: only in global
    expect(architectResult.source).toBe("L1");
    expect(architectResult.model?.provider).toBe("anthropic");
  });

  // 10. project 'default' overrides global 'default'
  it("project default persona-model overrides global default", () => {
    const cfg: MergedConfig = {
      _global: {
        "persona-models": {
          default: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
      _project: {
        "persona-models": {
          default: { provider: "openai", model: "gpt-4o-mini" },
        },
      },
      "persona-models": {
        default: { provider: "openai", model: "gpt-4o-mini" },
      },
      pipelines: { default: { phases: {} } },
    };
    const result = resolveModelForPhase("default", "plan", "product-manager", cfg);
    expect(result.source).toBe("default");
    expect(result.model).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  // 11. Empty configs → inherit for all personas
  it("empty configs produce inherit for every persona", () => {
    const cfg: MergedConfig = {
      _global: null,
      _project: null,
      "persona-models": {},
    };
    for (const persona of ["engineer", "architect", "supervisor", "scribe"]) {
      const result = resolveModelForPhase("default", "plan", persona, cfg);
      expect(result.source).toBe("inherit");
      expect(result.model).toBeUndefined();
    }
  });

  // 12. No phase entry for role → falls through (graceful)
  it("returns inherit gracefully when phase role has no override entry", () => {
    const cfg = fullMerged();
    const result = resolveModelForPhase("default", "unknown-role", "engineer", cfg);
    // No L4; falls through to L2 (engineer is in project persona-models)
    expect(result.source).toBe("L2");
    expect(result.model).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  // 13. Unknown pipeline falls through to persona-models
  it("unknown pipeline name falls through to persona-models cascade", () => {
    const cfg = fullMerged();
    const result = resolveModelForPhase("nonexistent-pipeline", "plan", "scribe", cfg);
    // No L3 for this pipeline; scribe in global → L1
    expect(result.source).toBe("L1");
    expect(result.model).toEqual({ provider: "google", model: "gemini-2.5-flash" });
  });
});

describe("lookupPersonaModel", () => {
  // L3 → L2 → L1 → default → missing
  it("returns L3 when pipeline-level persona-models has the name", () => {
    const cfg = fullMerged();
    const result = lookupPersonaModel("supervisor", "default", cfg);
    expect(result.source).toBe("L3");
    expect(result.model).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
  });

  it("returns L2 when L3 absent but project has the persona", () => {
    const cfg = fullMerged();
    const result = lookupPersonaModel("engineer", "default", cfg);
    // L3 has no engineer override for default pipeline, L2 has it
    expect(result.source).toBe("L2");
    expect(result.model).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("returns L1 when L3+L2 absent but global has the persona", () => {
    const cfg = fullMerged();
    const result = lookupPersonaModel("architect", "default", cfg);
    // L3: default pipeline only has supervisor; L2: project only has engineer
    expect(result.source).toBe("L1");
    expect(result.model).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
  });

  it("returns default when persona not found at any layer", () => {
    const cfg = fullMerged();
    const result = lookupPersonaModel("product-manager", "default", cfg);
    expect(result.source).toBe("default");
    expect(result.model).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
  });

  it("returns missing when persona not found and no default", () => {
    const cfg: MergedConfig = {
      _global: null,
      _project: null,
      "persona-models": {},
    };
    const result = lookupPersonaModel("engineer", "default", cfg);
    expect(result.source).toBe("missing");
    expect(result.model).toBeUndefined();
  });
});
