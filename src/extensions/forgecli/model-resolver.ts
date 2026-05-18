import type { MergedConfig, PersonaModel } from "./config-layer.js";

export type { MergedConfig } from "./config-layer.js";

export type ResolveSource =
  | "L4-inline"
  | "L4-name"
  | "L3"
  | "L2"
  | "L1"
  | "default"
  | "inherit";

export type LookupSource = "L3" | "L2" | "L1" | "default" | "missing";

export interface ResolveResult {
  model: { provider: string; model: string } | undefined;
  source: ResolveSource;
}

export interface LookupResult {
  model: { provider: string; model: string } | undefined;
  source: LookupSource;
}

function toModel(pm: PersonaModel): { provider: string; model: string } {
  return { provider: pm.provider, model: pm.model };
}

/**
 * Look up a persona-model name through L3 → L2 → L1 → default → missing.
 * Used by resolveModelForPhase for L4-name resolution and direct persona lookups.
 */
export function lookupPersonaModel(
  personaName: string,
  pipelineName: string,
  merged: MergedConfig,
): LookupResult {
  // L3 — pipeline-level persona-models
  const l3 = merged.pipelines?.[pipelineName]?.["persona-models"]?.[personaName];
  if (l3) return { model: toModel(l3), source: "L3" };

  // L2 — project persona-models
  const l2 = merged._project?.["persona-models"]?.[personaName];
  if (l2) return { model: toModel(l2), source: "L2" };

  // L1 — global persona-models
  const l1 = merged._global?.["persona-models"]?.[personaName];
  if (l1) return { model: toModel(l1), source: "L1" };

  // default persona-model (same L3→L2→L1 walk with key="default")
  if (personaName !== "default") {
    const defL3 = merged.pipelines?.[pipelineName]?.["persona-models"]?.["default"];
    if (defL3) return { model: toModel(defL3), source: "default" };

    const defL2 = merged._project?.["persona-models"]?.["default"];
    if (defL2) return { model: toModel(defL2), source: "default" };

    const defL1 = merged._global?.["persona-models"]?.["default"];
    if (defL1) return { model: toModel(defL1), source: "default" };
  }

  return { model: undefined, source: "missing" };
}

/**
 * Resolve the {provider, model} pair for a specific phase invocation.
 *
 * Cascade order:
 *   L4-inline → L4-name → L3 → L2 → L1 → default persona-model → inherit
 *
 * When source is "inherit", model is undefined — caller must skip setModel.
 */
export function resolveModelForPhase(
  pipelineName: string,
  phaseIndex: number,
  personaNoun: string,
  merged: MergedConfig,
): ResolveResult {
  const phase = merged.pipelines?.[pipelineName]?.phases?.[phaseIndex];
  const override = phase?.["model-override"];

  if (override !== undefined) {
    // L4-inline: override is an inline {provider, model} object
    if (typeof override === "object") {
      return { model: toModel(override), source: "L4-inline" };
    }

    // L4-name: override is a persona-model key string
    const named = lookupPersonaModel(override, pipelineName, merged);
    if (named.source !== "missing") {
      return { model: named.model, source: "L4-name" };
    }
    // L4-name miss: fall through with original personaNoun
  }

  // L3 → L2 → L1 → default → missing
  const lookup = lookupPersonaModel(personaNoun, pipelineName, merged);
  if (lookup.source === "missing") {
    return { model: undefined, source: "inherit" };
  }
  return { model: lookup.model, source: lookup.source as ResolveSource };
}
