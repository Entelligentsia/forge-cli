// Config TUI state model — re-exports from split modules.
// Phase 1: This file is now a barrel that re-exports everything from state/.
// The implementation lives in state/model.ts, state/init.ts, state/reducer.ts,
// state/selectors.ts, state/buffer.ts, and state/constants.js.
// Phase 3: authError added to InitOptions and ConfigTuiState.

export type {
  View,
  ConfigBuffer,
  AvailableModel,
  InitOptions,
  ConfigTuiState,
  ConfigTuiAction,
  PhaseOverride,
  ConfigLayer,
  ResolvedPersonaEntry,
  PersonaPickerEntry,
  PipelineOverrideSummary,
  TierAssignment,
} from "./state/model.js";

export { CANONICAL_PHASES } from "./state/constants.js";
export { initialState } from "./state/init.js";
export { reducer } from "./state/reducer.js";
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
} from "./state/selectors.js";
export {
  writePersonaEntry,
  deletePersonaEntry,
  writePhaseOverride,
  clearPhaseOverride,
  writeTierAssignment,
} from "./state/buffer.js";