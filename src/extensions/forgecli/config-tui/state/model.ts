// Config TUI type definitions — View, Action, State, Buffer shapes.
// Split from state.ts (Phase 1: file split, no behavior change).

import type { GlobalConfig, PersonaModel, PipelineConfig, ProjectConfig } from "../../config-layer.js";
import type { Tier } from "../tier-meta.js";

// L4 phase override is either a persona-models key (string) or an inline {provider, model}.
export type PhaseOverride = string | PersonaModel;

export type ConfigLayer = "global" | "project";

// ── Views ────────────────────────────────────────────────────────────────────

export type View =
	// ── Tiered-baseline views (Phase A+) ──────────────────────────────────────
	| { kind: "tier-menu"; cursor: number }
	| {
			kind: "tier-picker";
			tier: Tier;
			step: "pick-provider" | "pick-model";
			provider: string | undefined;
			cursor: number;
			searchQuery: string;
	  }
	// ── Advanced menu (Phase D) ───────────────────────────────────────────
	| { kind: "advanced-menu"; cursor: number }
	// ── Advanced views ───────────────────────────────────────────────────────
	| { kind: "personas-list"; cursor: number }
	| { kind: "persona-picker"; cursor: number }
	| {
			kind: "persona-editor";
			persona: string;
			step: "pick-provider" | "pick-model" | "pick-layer";
			provider: string | undefined;
			model: string | undefined;
			/** Cursor index inside the active step's list (provider/model/layer). */
			cursor: number;
			/** Current search/filter string for the list (cleared on step transitions). */
			searchQuery: string;
	  }
	| { kind: "show-resolved"; cursor: number }
	// Slice 4c — per-phase overrides (Screens 4 + 5).
	| { kind: "overrides-list-pipelines"; cursor: number }
	| { kind: "overrides-list-phases"; pipeline: string; cursor: number }
	| {
			kind: "override-editor";
			pipeline: string;
			phaseRole: string;
			step: "pick-type" | "pick-name" | "pick-provider" | "pick-model";
			/** For the inline path: chosen provider before the model picker. */
			provider: string | undefined;
			cursor: number;
			/** Current search/filter string for the list (cleared on step transitions). */
			searchQuery: string;
	  };

// ── Selectors / accessors (read-only helpers used by renderers) ──────────────

export type TierAssignment =
	| { status: "set"; provider: string; model: string; layer: ConfigLayer }
	| { status: "mixed" }
	| { status: "unset" };

export interface ResolvedPersonaEntry {
	persona: string;
	provider: string;
	model: string;
	source: "L1" | "L2";
}

export interface PersonaPickerEntry {
	persona: string;
	assignment: ResolvedPersonaEntry | undefined;
	inCatalogue: boolean;
}

export interface PipelineOverrideSummary {
	pipeline: string;
	overrideCount: number;
}

// ── Buffer + state ───────────────────────────────────────────────────────────

export interface ConfigBuffer {
	global: GlobalConfig;
	project: ProjectConfig;
}

export interface AvailableModel {
	provider: string;
	id: string;
}

export interface InitOptions {
	global: GlobalConfig | null;
	project: ProjectConfig | null;
	cwd: string;
	personaCatalogue: string[];
	/** null when no `.forge/config.json` exists (forge-cli run outside a Forge project). */
	pipelineCatalogue: string[] | null;
	availableModels: AvailableModel[];
	authenticatedProviders: string[];
	/** If model discovery failed, surfaces the diagnostic instead of a silent empty list. */
	authError?: string;
	/** Schema validation errors from loadLayeredConfig (N-B-E). Non-blocking — TUI renders a warning banner. */
	configErrors?: string[];
}

export interface ConfigTuiState {
	buffer: ConfigBuffer;
	view: View[];
	cwd: string;
	personaCatalogue: string[];
	pipelineCatalogue: string[] | null;
	availableModels: AvailableModel[];
	authenticatedProviders: string[];
	/** True iff buffer differs from the initial state (or from disk). */
	dirty: boolean;
	/** Active write scope for tier-level commits (toggled by `tab` on tier-menu). */
	scope: ConfigLayer;
	/** If model/auth discovery failed at init, a diagnostic string. */
	authError: string | null;
	/** Schema validation errors from loadLayeredConfig (N-B-E). Non-blocking — rendered as a warning banner. */
	configErrors: string[] | null;
	/** Pending quit confirmation modal. */
	confirmQuit: boolean;
	/** True when the TUI should unmount. */
	shouldExit: boolean;
	/** Last save path + layer (auto-cleared after 3 seconds). */
	lastSaved: { target: string; layer: ConfigLayer } | null;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type ConfigTuiAction =
	// ── Tiered-baseline actions (Phase A+) ────────────────────────────────────
	| { kind: "select-tier"; tier: Tier }
	| { kind: "set-tier-provider"; tier: Tier; provider: string }
	| { kind: "commit-tier-model"; tier: Tier; provider: string; model: string; layer: ConfigLayer }
	| { kind: "toggle-scope" }
	// ── Legacy actions ────────────────────────────────────────────────────────
	| { kind: "push-view"; view: View }
	| { kind: "pop-view" }
	| { kind: "cursor-move"; delta: number }
	| { kind: "set-search"; query: string }
	| { kind: "begin-persona-edit"; persona: string }
	| { kind: "set-persona-provider"; provider: string }
	| { kind: "set-persona-model"; model: string }
	| { kind: "commit-persona-edit"; layer: ConfigLayer }
	| { kind: "delete-persona-entry"; layer: ConfigLayer; persona: string }
	| { kind: "begin-override-edit"; pipeline: string; phaseRole: string }
	| { kind: "set-override-step"; step: "pick-type" | "pick-name" | "pick-provider" | "pick-model" }
	| { kind: "set-override-provider"; provider: string }
	| { kind: "commit-override-name"; name: string }
	| { kind: "commit-override-inline"; provider: string; model: string }
	| { kind: "clear-phase-override"; pipeline: string; phaseRole: string }
	| { kind: "mark-clean"; lastSaved?: { target: string; layer: ConfigLayer } }
	| { kind: "clear-status" }
	| { kind: "request-quit" }
	| { kind: "confirm-quit"; discard: boolean };
