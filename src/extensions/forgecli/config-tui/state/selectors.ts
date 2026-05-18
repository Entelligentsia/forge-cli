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
    out.set(persona, { persona, provider: entry.provider, model: entry.model, source: "L1" as const });
  }
  // Project layer wins per-key
  for (const [persona, entry] of Object.entries(projectMap)) {
    out.set(persona, { persona, provider: entry.provider, model: entry.model, source: "L2" as const });
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

// ── Phase table selector ────────────────────────────────────────────────────

import { PHASE_PERSONA_TABLE, TIER_LABELS } from "../tier-meta.js";
import { resolveModelForPhase, type ResolveSource } from "../../model-resolver.js";

/** A row in the phase table (Screen 3 — "Show what runs at each step"). */
export interface PhaseTableRow {
  /** Phase role (e.g. "plan", "review-plan"). */
  role: string;
  /** Persona name (e.g. "engineer"). */
  persona: string;
  /** Persona emoji (e.g. "🌱"). */
  personaEmoji: string;
  /** Persona tier ("heavy" | "standard" | "light"). */
  tier: Tier;
  /** Resolved model string ("provider:model") or "(inherit pi current)". */
  resolved: string;
  /** Raw model resolver source ("L1", "L2", "L4-inline", etc.). */
  rawSource: ResolveSource;
  /** Human-readable source label (e.g. "Standard tier (global)"). */
  sourceLabel: string;
}

/** Map a model-resolver source + persona tier + resolved-layer to a
 *  human-readable source label per the plan's cascade vocabulary.
 *
 *  | Internal | Plain English |
 *  |-----------|---------------|
 *  | L4-inline / L4-name | "Step override" |
 *  | L3 | "Per-persona override (pipeline)" |
 *  | L2 | "{Tier} tier (project)" |
 *  | L1 | "{Tier} tier (global)" |
 *  | default | "Default fallback" |
 *  | inherit | "Falls back to pi current" |
 */
export function sourceToLabel(
  rawSource: ResolveSource,
  tier: Tier | undefined,
  isProject: boolean,
): string {
  switch (rawSource) {
    case "L4-inline":
    case "L4-name":
      return "Step override";
    case "L3":
      return "Per-persona override";
    case "L2":
      if (tier) return `${TIER_LABELS[tier]} tier (project)`;
      return "Per-persona (project)";
    case "L1":
      if (tier) return `${TIER_LABELS[tier]} tier (global)`;
      return "Per-persona (global)";
    case "default":
      return "Default fallback";
    case "inherit":
      return "Falls back to pi current";
  }
}

/** Build the phase table for Screen 3.
 *  Joins PHASE_PERSONA_TABLE with model resolution results. */
export function getPhaseTable(state: ConfigTuiState): PhaseTableRow[] {
  const pipelineNames = state.pipelineCatalogue ?? ["default"];
  const pipeline = pipelineNames[0] ?? "default";

  return PHASE_PERSONA_TABLE.map((phase) => {
    const result = resolveModelForPhase(pipeline, phase.role, phase.personaNoun, {
      ...state.buffer.global,
      ...state.buffer.project,
      _global: state.buffer.global,
      _project: state.buffer.project,
    });
    const resolved = result.model
      ? `${result.model.provider}:${result.model.model}`
      : "(inherit pi current)";
    const meta = PERSONA_META[phase.personaNoun];
    const isProject = result.source === "L2" || result.source === "L4-inline" || result.source === "L4-name" || result.source === "L3";
    return {
      role: phase.role,
      persona: phase.personaNoun,
      personaEmoji: meta?.emoji ?? "",
      tier: phase.tier,
      resolved,
      rawSource: result.source,
      sourceLabel: sourceToLabel(result.source, phase.tier, isProject),
    };
  });
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

/** Scope-aware tier assignment: returns what's set at the given scope layer.
 *  When scope is "global", shows global-layer assignments only.
 *  When scope is "project", shows the resolved (merged) view since project
 *  layer is where overrides live on top of global.
 *  If a tier has no assignment at the active scope layer but has one at
 *  the other layer, shows { status: "set-in-other-layer" } with the details. */
export type ScopedTierAssignment =
  | { status: "set"; provider: string; model: string; layer: ConfigLayer }
  | { status: "set-in-other-layer"; provider: string; model: string; otherLayer: ConfigLayer }
  | { status: "mixed" }
  | { status: "unset" };

export function getScopedTierAssignment(
  state: ConfigTuiState,
  tier: Tier,
  scope: ConfigLayer,
): ScopedTierAssignment {
  const personas = TIER_PERSONAS[tier];
  const targetBuffer = state.buffer[scope];
  const otherBuffer = state.buffer[scope === "global" ? "project" : "global"];
  const targetPersonaModels = targetBuffer["persona-models"] ?? {};
  const otherPersonaModels = otherBuffer["persona-models"] ?? {};

  // Check if all personas in this tier have assignments in the target layer
  const targetEntries = personas.map((p) => targetPersonaModels[p]);
  const targetPresent = targetEntries.filter((e) => e !== undefined);

  if (targetPresent.length === personas.length) {
    // All tier personas have assignments in target layer
    const allSame = targetEntries.every(
      (e) => e !== undefined && e.provider === targetEntries[0]!.provider && e.model === targetEntries[0]!.model,
    );
    if (allSame) {
      return {
        status: "set",
        provider: targetEntries[0]!.provider,
        model: targetEntries[0]!.model,
        layer: scope,
      };
    }
    return { status: "mixed" };
  }

  if (targetPresent.length === 0) {
    // No assignments in target layer
    // Check if any are set in the other layer
    const otherEntries = personas.map((p) => otherPersonaModels[p]);
    const otherPresent = otherEntries.filter((e) => e !== undefined);
    if (otherPresent.length > 0) {
      // Some are set in the other layer — show that
      const allSameOther = otherPresent.every(
        (e) => e.provider === otherPresent[0]!.provider && e.model === otherPresent[0]!.model,
      );
      if (allSameOther) {
        return {
          status: "set-in-other-layer",
          provider: otherPresent[0]!.provider,
          model: otherPresent[0]!.model,
          otherLayer: scope === "global" ? "project" : "global",
        };
      }
      return { status: "mixed" };
    }
    return { status: "unset" };
  }

  // Partial assignments in target layer
  return { status: "mixed" };
}

export function getAllScopedTierAssignments(
  state: ConfigTuiState,
  scope: ConfigLayer,
): Array<{ tier: Tier; assignment: ScopedTierAssignment }> {
  return TIERS.map((tier) => ({ tier, assignment: getScopedTierAssignment(state, tier, scope) }));
}

/** Which tier does a persona belong to? Returns undefined for unknown names. */
export function getTierForPersona(persona: string): Tier | undefined {
  return PERSONA_META[persona]?.tier;
}

/** Persona names in a tier. */
export function getPersonasInTier(tier: Tier): readonly string[] {
  return TIER_PERSONAS[tier];
}

// ── isEmpty selector (Phase E — replaces state.isEmpty snapshot) ──────────

/** True when neither global nor project config has any persona-model assignments.
 *  Replaces the old `state.isEmpty` snapshot — this is derived from buffer,
 *  so it stays correct after mutations. */
export function isConfigEmpty(state: ConfigTuiState): boolean {
  const g = state.buffer.global;
  const p = state.buffer.project;
  const gEmpty = !g || !g["persona-models"] || Object.keys(g["persona-models"]).length === 0;
  const pEmpty = !p || !p["persona-models"] || Object.keys(p["persona-models"]).length === 0;
  return gEmpty && pEmpty;
}

// ── Source label for persona list display ─────────────────────────────────

/** Human-readable source label for a persona-model assignment.
 *  Replaces the old raw L1/L2/default-L1/default-L2 display.
 *  Uses tier labels when the persona has a known tier, otherwise falls back
 *  to generic "global"/"project" labels. */
export function personaSourceLabel(persona: string, source: "L1" | "L2"): string {
  const tier = PERSONA_META[persona]?.tier;
  const layer = source === "L1" ? "global" : "project";
  if (persona === "default") {
    return `Default fallback (${layer})`;
  }
  if (tier) {
    return `${TIER_LABELS[tier]} tier (${layer})`;
  }
  return `Per-persona (${layer})`;
}