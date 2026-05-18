// Barrel re-export for config-tui state modules.
// Split from state.ts (Phase 1). All public symbols remain accessible from
// the same import path: `./state.js` → re-exports from split modules.

export type {
  View,
  ConfigBuffer,
  AvailableModel,
  InitOptions,
  ConfigTuiState,
  ConfigTuiAction,
  PhaseOverride,
  ResolvedPersonaEntry,
  PersonaPickerEntry,
  PipelineOverrideSummary,
  TierAssignment,
} from "./model.js";

export { CANONICAL_PHASES } from "./constants.js";
export { initialState } from "./init.js";
export { reducer } from "./reducer.js";
export {
  getActiveView,
  listResolvedPersonas,
  listPersonaPickerEntries,
  uniqueProviders,
  listPipelineOverrideSummaries,
  getPhaseOverride,
  getTierAssignment,
  getAllTierAssignments,
  getTierForPersona,
  getPersonasInTier,
  getPhaseTable,
  sourceToLabel,
  type PhaseTableRow,
  type ScopedTierAssignment,
  getScopedTierAssignment,
  getAllScopedTierAssignments,
  isConfigEmpty,
  personaSourceLabel,
} from "./selectors.js";
export {
  writePersonaEntry,
  deletePersonaEntry,
  writePhaseOverride,
  clearPhaseOverride,
  writeTierAssignment,
} from "./buffer.js";