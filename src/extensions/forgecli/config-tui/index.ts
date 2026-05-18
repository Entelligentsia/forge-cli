// Config-TUI public re-exports.
// Phase 3: theming + width safety + data-driven menus + auth error surfacing.

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
  TierAssignment,
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
  getTierAssignment,
  getAllTierAssignments,
  getTierForPersona,
  getPersonasInTier,
  writePersonaEntry,
  deletePersonaEntry,
  writePhaseOverride,
  clearPhaseOverride,
  writeTierAssignment,
} from "./state.js";

// Re-export screen types for consumers that need them
export type { InputResult, Screen } from "./screens/types.js";