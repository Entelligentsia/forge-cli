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
} from "./selectors.js";
export {
  writePersonaEntry,
  deletePersonaEntry,
  writePhaseOverride,
  clearPhaseOverride,
} from "./buffer.js";