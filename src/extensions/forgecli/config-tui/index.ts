// Config-TUI public re-exports.
// Phase 2: barrel file for the config-tui extension module.

export { createConfigTuiComponent, type ConfigTuiComponentOptions } from "./component.js";
export type { ConfigLayer } from "../config-writer.js";

// Re-export state types and functions for consumers
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
} from "./state/model.js";

export {
  CANONICAL_PHASES,
  initialState,
  reducer,
  getActiveView,
  listResolvedPersonas,
  listPersonaPickerEntries,
  uniqueProviders,
  listPipelineOverrideSummaries,
  getPhaseOverride,
  writePersonaEntry,
  deletePersonaEntry,
  writePhaseOverride,
  clearPhaseOverride,
} from "./state.js";

// Re-export screen types for consumers that need them
export type { InputResult, Screen } from "./screens/types.js";