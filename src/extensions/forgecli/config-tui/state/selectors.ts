// Config TUI selectors — read-only derived data from state.
// Split from state.ts (Phase 1).

import type { ConfigTuiState, View, ResolvedPersonaEntry, PersonaPickerEntry, PipelineOverrideSummary, PhaseOverride } from "./model.js";

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