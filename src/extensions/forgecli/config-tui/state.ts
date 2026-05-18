// Config TUI state model — pure functions, no I/O.
//
// Plan 16 Slice 4b. The TUI is driven by a reducer over a flat ConfigTuiState.
// View stack lives inside state (state.view: View[]) so navigation is a state
// transition like any other action. The buffer holds the in-memory edit state
// for both layers (global + project) and is committed atomically to disk by
// config-writer when the user confirms a write.

import type {
  GlobalConfig,
  PersonaModel,
  PipelineConfig,
  ProjectConfig,
} from "../config-layer.js";

export type ConfigLayer = "global" | "project";

// ── Views ────────────────────────────────────────────────────────────────────

export type View =
  | { kind: "top-menu" }
  | { kind: "empty-state" }
  | { kind: "no-project" }
  | { kind: "personas-list"; cursor: number }
  | {
      kind: "persona-editor";
      persona: string;
      step: "pick-provider" | "pick-model" | "pick-layer";
      provider: string | undefined;
      model: string | undefined;
    };

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
  | { kind: "request-quit" }
  | { kind: "confirm-quit"; discard: boolean };

// ── Constructors ─────────────────────────────────────────────────────────────

export function initialState(opts: InitOptions): ConfigTuiState {
  const buffer: ConfigBuffer = {
    global: opts.global ? cloneJSON(opts.global) : {},
    project: opts.project ? cloneJSON(opts.project) : {},
  };

  const isEmpty = !opts.global && !opts.project;

  const firstView: View =
    opts.pipelineCatalogue === null ? { kind: "no-project" } : { kind: "top-menu" };

  return {
    buffer,
    view: [firstView],
    cwd: opts.cwd,
    personaCatalogue: opts.personaCatalogue,
    pipelineCatalogue: opts.pipelineCatalogue,
    availableModels: opts.availableModels,
    authenticatedProviders: opts.authenticatedProviders,
    dirty: false,
    isEmpty,
    confirmQuit: false,
    shouldExit: false,
  };
}

// ── Reducer ──────────────────────────────────────────────────────────────────

export function reducer(state: ConfigTuiState, action: ConfigTuiAction): ConfigTuiState {
  switch (action.kind) {
    case "push-view":
      return { ...state, view: [...state.view, action.view] };

    case "pop-view":
      if (state.view.length <= 1) return state;
      return { ...state, view: state.view.slice(0, -1) };

    case "cursor-move": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "personas-list") return state;
      const newCursor = Math.max(0, top.cursor + action.delta);
      const replaced: View = { ...top, cursor: newCursor };
      return { ...state, view: [...state.view.slice(0, -1), replaced] };
    }

    case "begin-persona-edit": {
      const editor: View = {
        kind: "persona-editor",
        persona: action.persona,
        step: "pick-provider",
        provider: undefined,
        model: undefined,
      };
      return { ...state, view: [...state.view, editor] };
    }

    case "set-persona-provider": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "persona-editor") return state;
      const updated: View = {
        ...top,
        provider: action.provider,
        model: undefined,
        step: "pick-model",
      };
      return { ...state, view: [...state.view.slice(0, -1), updated] };
    }

    case "set-persona-model": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "persona-editor") return state;
      const updated: View = { ...top, model: action.model, step: "pick-layer" };
      return { ...state, view: [...state.view.slice(0, -1), updated] };
    }

    case "commit-persona-edit": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "persona-editor") return state;
      if (!top.provider || !top.model) return state;
      const entry: PersonaModel = { provider: top.provider, model: top.model };
      const buffer = writePersonaEntry(state.buffer, action.layer, top.persona, entry);
      return {
        ...state,
        buffer,
        view: state.view.slice(0, -1),
        dirty: true,
      };
    }

    case "delete-persona-entry": {
      const buffer = deletePersonaEntry(state.buffer, action.layer, action.persona);
      const changed = buffer !== state.buffer;
      return changed ? { ...state, buffer, dirty: true } : state;
    }

    case "request-quit":
      if (!state.dirty) return { ...state, shouldExit: true };
      return { ...state, confirmQuit: true };

    case "confirm-quit":
      return { ...state, confirmQuit: false, shouldExit: action.discard };

    default:
      return state;
  }
}

// ── Buffer helpers ───────────────────────────────────────────────────────────

function writePersonaEntry(
  buffer: ConfigBuffer,
  layer: ConfigLayer,
  persona: string,
  entry: PersonaModel,
): ConfigBuffer {
  const targetLayer = buffer[layer];
  const personaModels = { ...(targetLayer["persona-models"] ?? {}) };
  personaModels[persona] = entry;
  const updatedLayer = { ...targetLayer, "persona-models": personaModels };
  return { ...buffer, [layer]: updatedLayer };
}

function deletePersonaEntry(
  buffer: ConfigBuffer,
  layer: ConfigLayer,
  persona: string,
): ConfigBuffer {
  const targetLayer = buffer[layer];
  const personaModels = { ...(targetLayer["persona-models"] ?? {}) };
  if (!(persona in personaModels)) return buffer;
  delete personaModels[persona];
  const updatedLayer = { ...targetLayer };
  if (Object.keys(personaModels).length === 0) {
    delete updatedLayer["persona-models"];
  } else {
    updatedLayer["persona-models"] = personaModels;
  }
  return { ...buffer, [layer]: updatedLayer };
}

function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Selectors / accessors (read-only helpers used by renderers) ──────────────

export interface ResolvedPersonaEntry {
  persona: string;
  provider: string;
  model: string;
  source: "L1" | "L2" | "default-L1" | "default-L2";
}

/**
 * Walks both buffer layers to surface the effective persona-model assignments.
 * Distinct from the runtime resolver (model-resolver.ts) because the TUI only
 * needs L1/L2 — pipelines/L3/L4 live on their own screens (Slice 4c).
 */
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

export function getActiveView(state: ConfigTuiState): View {
  return state.view[state.view.length - 1];
}
