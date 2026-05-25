// Config TUI state model — re-exports from split modules.
// Phase 1: This file is now a barrel that re-exports everything from state/.
// The implementation lives in state/model.ts, state/init.ts, state/reducer.ts,
// state/selectors.ts, state/buffer.ts, and state/constants.js.
// Phase 3: authError added to InitOptions and ConfigTuiState.

export {
	clearPhaseOverride,
	deletePersonaEntry,
	writePersonaEntry,
	writePhaseOverride,
	writeTierAssignment,
} from "./state/buffer.js";

export { CANONICAL_PHASES } from "./state/constants.js";
export { initialState } from "./state/init.js";
export type {
	AvailableModel,
	ConfigBuffer,
	ConfigLayer,
	ConfigTuiAction,
	ConfigTuiState,
	InitOptions,
	PersonaPickerEntry,
	PhaseOverride,
	PipelineOverrideSummary,
	ResolvedPersonaEntry,
	TierAssignment,
	View,
} from "./state/model.js";
export { reducer } from "./state/reducer.js";
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
} from "./state/selectors.js";
