// Config TUI type definitions — View, Action, State, Buffer shapes.
// Split from state.ts (Phase 1: file split, no behavior change).

import type {
  GlobalConfig,
  PersonaModel,
  PipelineConfig,
  ProjectConfig,
} from "../../config-layer.js";

// L4 phase override is either a persona-models key (string) or an inline {provider, model}.
export type PhaseOverride = string | PersonaModel;

export type ConfigLayer = "global" | "project";

// ── Views ────────────────────────────────────────────────────────────────────

export type View =
  | { kind: "top-menu"; cursor: number }
  | { kind: "empty-state"; cursor: number }
  | { kind: "no-project"; cursor: number }
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
    };

// ── Selectors / accessors (read-only helpers used by renderers) ──────────────

export interface ResolvedPersonaEntry {
  persona: string;
  provider: string;
  model: string;
  source: "L1" | "L2" | "default-L1" | "default-L2";
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
  /** True iff both global and project were absent at init. */
  isEmpty: boolean;
  /** Pending quit confirmation modal. */
  confirmQuit: boolean;
  /** True when the TUI should unmount. */
  shouldExit: boolean;
  /** Last save path + layer (auto-cleared after 3 seconds). */
  lastSaved: { target: string; layer: ConfigLayer } | null;
}

// ── Actions ──────────────────────────────────────────────────────────────────

export type ConfigTuiAction =
  | { kind: "push-view"; view: View }
  | { kind: "pop-view" }
  | { kind: "cursor-move"; delta: number }
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