// Config TUI selectors — read-only derived data from state.
// Split from state.ts (Phase 1).

import type { ConfigTuiState, View, ResolvedPersonaEntry, PersonaPickerEntry, PipelineOverrideSummary, PhaseOverride, TierAssignment } from "./model.js";
import type { ConfigLayer } from "../../config-writer.js";
import { TIERS, TIER_PERSONAS, PERSONA_META, type Tier } from "../tier-meta.js";

export function getActiveView(state: ConfigTuiState): View {
  return state.view[state.view.length - 1];
}

export function listResolvedPersonas(
  state: ConfigTuiState,
): ResolvedPersonaEntry[] {
  const out = new Map<string, ResolvedPersonaEntry>();
  const projectMap = state.buffer.project["persona-models"] ?? {};
  const globalMap = state.buffer.global["persona-models"] ?? {};

  for (const [persona, entry] of Object.entries(globalMap)) {
    const source = persona === "default" ? "default-L1" : "L1";
    out.set(persona, { persona, provider: entry.provider, model: entry.model, source });
  }
  // Project layer wins per-key
  for (const [persona, entry] of Object.entries(projectMap)) {
    const source = persona === "default" ? "default-L2" : "L2";
    out.set(persona, { persona, provider: entry.provider, model: entry.model, source });
  }

  return [...out.values()].sort((a, b) => a.persona.localeCompare(b.persona));
}

export function listPersonaPickerEntries(state: ConfigTuiState): PersonaPickerEntry[] {
  const assignmentsByName = new Map(
    listResolvedPersonas(state).map((p) => [p.persona, p] as const),
  );
  const catalogue = state.personaCatalogue.filter((p) => p !== "default").sort();
  const order: string[] = ["default", ...catalogue];
  const seen = new Set(order);
  for (const name of assignmentsByName.keys()) {
    if (!seen.has(name)) {
      order.push(name);
      seen.add(name);
    }
  }
  return order.map((persona) => ({
    persona,
    assignment: assignmentsByName.get(persona),
    inCatalogue: persona === "default" || state.personaCatalogue.includes(persona),
  }));
}

export function uniqueProviders(state: ConfigTuiState): string[] {
  const providers = new Set<string>();
  for (const m of state.availableModels) providers.add(m.provider);
  for (const p of state.authenticatedProviders) providers.add(p);
  return [...providers].sort();
}

export function listPipelineOverrideSummaries(
  state: ConfigTuiState,
): PipelineOverrideSummary[] {
  const names = state.pipelineCatalogue ?? ["default"];
  return names.map((pipeline) => {
    const phases = state.buffer.project.pipelines?.[pipeline]?.phases ?? {};
    const overrideCount = Object.values(phases).filter(
      (p) => p["model-override"] !== undefined,
    ).length;
    return { pipeline, overrideCount };
  });
}

export function getPhaseOverride(
  state: ConfigTuiState,
  pipeline: string,
  phaseRole: string,
): PhaseOverride | undefined {
  return state.buffer.project.pipelines?.[pipeline]?.phases?.[phaseRole]?.[
    "model-override"
  ];
}

// ── Tier selectors ───────────────────────────────────────────────────────────

/** Determine the effective model for an entire tier.
 *  Returns "set" when all personas in the tier resolve to the same model,
 *  "mixed" when some are missing or they diverge, "unset" when none are resolved. */
export function getTierAssignment(
  state: ConfigTuiState,
  tier: Tier,
): TierAssignment {
  const personas = TIER_PERSONAS[tier];
  const resolved = listResolvedPersonas(state);
  const resolvedMap = new Map(
    resolved.map((p) => [p.persona, p] as const),
  );

  const entries = personas.map(
    (p) => resolvedMap.get(p),
  );

  // All tier personas must be in the resolved map.
  const allPresent = entries.every((e) => e !== undefined);
  if (!allPresent) {
    // If none are resolved → unset; if partial → mixed
    const anyPresent = entries.some((e) => e !== undefined);
    return anyPresent ? { status: "mixed" } : { status: "unset" };
  }

  // All present — check they agree on provider:model
  const first = entries[0]!;
  const allSame = entries.every(
    (e) => e!.provider === first.provider && e!.model === first.model,
  );
  if (!allSame) return { status: "mixed" };

  const layer: ConfigLayer = first.source.endsWith("L2") ? "project" : "global";
  return { status: "set", provider: first.provider, model: first.model, layer };
}

/** Return all three tier assignments as an array (stable order: heavy, standard, light). */
export function getAllTierAssignments(state: ConfigTuiState): Array<{ tier: Tier; assignment: TierAssignment }> {
  return TIERS.map((tier) => ({ tier, assignment: getTierAssignment(state, tier) }));
}

/** Which tier does a persona belong to? Returns undefined for unknown names. */
export function getTierForPersona(persona: string): Tier | undefined {
  return PERSONA_META[persona]?.tier;
}

/** Persona names in a tier. */
export function getPersonasInTier(tier: Tier): readonly string[] {
  return TIER_PERSONAS[tier];
}