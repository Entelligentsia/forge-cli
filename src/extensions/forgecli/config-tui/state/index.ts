// Barrel re-export for config-tui state modules.
// Split from state.ts (Phase 1). All public symbols remain accessible from
// the same import path: `./state.js` → re-exports from split modules.

export {
	clearPhaseOverride,
	deletePersonaEntry,
	writePersonaEntry,
	writePhaseOverride,
	writeTierAssignment,
} from "./buffer.js";

export { CANONICAL_PHASES } from "./constants.js";
export { initialState } from "./init.js";
export type {
	AvailableModel,
	ConfigBuffer,
	ConfigTuiAction,
	ConfigTuiState,
	InitOptions,
	PersonaPickerEntry,
	PhaseOverride,
	PipelineOverrideSummary,
	ResolvedPersonaEntry,
	TierAssignment,
	View,
} from "./model.js";
export { reducer } from "./reducer.js";
export {
	getActiveView,
	getAllScopedTierAssignments,
	getAllTierAssignments,
	getPersonasInTier,
	getPhaseOverride,
	getPhaseTable,
	getScopedTierAssignment,
	getTierAssignment,
	getTierForPersona,
	isConfigEmpty,
	listPersonaPickerEntries,
	listPipelineOverrideSummaries,
	listResolvedPersonas,
	type PhaseTableRow,
	personaSourceLabel,
	type ScopedTierAssignment,
	sourceToLabel,
	uniqueProviders,
} from "./selectors.js";
