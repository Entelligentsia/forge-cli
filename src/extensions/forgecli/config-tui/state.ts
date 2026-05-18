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

// L4 phase override is either a persona-models key (string) or an inline {provider, model}.
export type PhaseOverride = string | PersonaModel;

export type ConfigLayer = "global" | "project";

// ── Views ────────────────────────────────────────────────────────────────────

export type View =
  | { kind: "top-menu"; cursor: number }
  | { kind: "empty-state"; cursor: number }
  | { kind: "no-project"; cursor: number }
  | { kind: "personas-list"; cursor: number }
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
      phaseIndex: number;
      step: "pick-type" | "pick-name" | "pick-provider" | "pick-model";
      /** For the inline path: chosen provider before the model picker. */
      provider: string | undefined;
      cursor: number;
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
  /** Last save path + layer (cleared a few seconds after display). */
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
  // Slice 4c — per-phase override actions. Project-only (L4 lives on
  // project.pipelines[name].phases[i]["model-override"]).
  | { kind: "begin-override-edit"; pipeline: string; phaseIndex: number }
  | { kind: "set-override-step"; step: "pick-type" | "pick-name" | "pick-provider" | "pick-model" }
  | { kind: "set-override-provider"; provider: string }
  | { kind: "commit-override-name"; name: string }
  | { kind: "commit-override-inline"; provider: string; model: string }
  | { kind: "clear-phase-override"; pipeline: string; phaseIndex: number }
  | { kind: "mark-clean"; lastSaved?: { target: string; layer: ConfigLayer } }
  | { kind: "clear-status" }
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
    opts.pipelineCatalogue === null
      ? { kind: "no-project", cursor: 0 }
      : { kind: "top-menu", cursor: 0 };

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
    lastSaved: null,
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
      // Every cursored view variant gets the same lower-bound clamp; the
      // component clamps the upper bound based on per-view item counts.
      if (
        top.kind === "personas-list" ||
        top.kind === "show-resolved" ||
        top.kind === "persona-editor" ||
        top.kind === "top-menu" ||
        top.kind === "empty-state" ||
        top.kind === "no-project" ||
        top.kind === "overrides-list-pipelines" ||
        top.kind === "overrides-list-phases" ||
        top.kind === "override-editor"
      ) {
        const newCursor = Math.max(0, top.cursor + action.delta);
        const replaced: View = { ...top, cursor: newCursor };
        return { ...state, view: [...state.view.slice(0, -1), replaced] };
      }
      return state;
    }

    case "begin-persona-edit": {
      const editor: View = {
        kind: "persona-editor",
        persona: action.persona,
        step: "pick-provider",
        provider: undefined,
        model: undefined,
        cursor: 0,
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
        cursor: 0,
      };
      return { ...state, view: [...state.view.slice(0, -1), updated] };
    }

    case "set-persona-model": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "persona-editor") return state;
      const updated: View = {
        ...top,
        model: action.model,
        step: "pick-layer",
        cursor: 0,
      };
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

    case "begin-override-edit": {
      const editor: View = {
        kind: "override-editor",
        pipeline: action.pipeline,
        phaseIndex: action.phaseIndex,
        step: "pick-type",
        provider: undefined,
        cursor: 0,
      };
      return { ...state, view: [...state.view, editor] };
    }

    case "set-override-step": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "override-editor") return state;
      const updated: View = { ...top, step: action.step, cursor: 0 };
      return { ...state, view: [...state.view.slice(0, -1), updated] };
    }

    case "set-override-provider": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "override-editor") return state;
      const updated: View = {
        ...top,
        provider: action.provider,
        step: "pick-model",
        cursor: 0,
      };
      return { ...state, view: [...state.view.slice(0, -1), updated] };
    }

    case "commit-override-name": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "override-editor") return state;
      const buffer = writePhaseOverride(
        state.buffer,
        top.pipeline,
        top.phaseIndex,
        action.name,
      );
      return {
        ...state,
        buffer,
        view: state.view.slice(0, -1),
        dirty: true,
      };
    }

    case "commit-override-inline": {
      const top = state.view[state.view.length - 1];
      if (top.kind !== "override-editor") return state;
      const buffer = writePhaseOverride(state.buffer, top.pipeline, top.phaseIndex, {
        provider: action.provider,
        model: action.model,
      });
      return {
        ...state,
        buffer,
        view: state.view.slice(0, -1),
        dirty: true,
      };
    }

    case "clear-phase-override": {
      const buffer = clearPhaseOverride(state.buffer, action.pipeline, action.phaseIndex);
      const changed = buffer !== state.buffer;
      // If invoked from inside the override-editor, also pop back to the phases list.
      const top = state.view[state.view.length - 1];
      const view =
        changed && top.kind === "override-editor" ? state.view.slice(0, -1) : state.view;
      return changed ? { ...state, buffer, dirty: true, view } : state;
    }

    case "mark-clean":
      return { ...state, dirty: false, lastSaved: action.lastSaved ?? state.lastSaved };

    case "clear-status":
      return { ...state, lastSaved: null };

    case "request-quit":
      // If a confirm-quit modal is already open, another `q` is a no-op
      // (user must press y/n/esc). This is what makes repeated `q` "tricky"
      // — without this guard, every q re-fires the modal and looks broken.
      if (state.confirmQuit) return state;
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

function writePhaseOverride(
  buffer: ConfigBuffer,
  pipelineName: string,
  phaseIndex: number,
  override: PhaseOverride,
): ConfigBuffer {
  const project = { ...buffer.project };
  const pipelines = { ...(project.pipelines ?? {}) };
  const pipeline: PipelineConfig = { ...(pipelines[pipelineName] ?? {}) };
  const phases = [...(pipeline.phases ?? [])];
  // Pad with empty slots so phaseIndex is addressable.
  while (phases.length <= phaseIndex) phases.push({});
  phases[phaseIndex] = { ...phases[phaseIndex], "model-override": override };
  pipeline.phases = phases;
  pipelines[pipelineName] = pipeline;
  project.pipelines = pipelines;
  return { ...buffer, project };
}

function clearPhaseOverride(
  buffer: ConfigBuffer,
  pipelineName: string,
  phaseIndex: number,
): ConfigBuffer {
  const existingPipeline = buffer.project.pipelines?.[pipelineName];
  const existingPhases = existingPipeline?.phases;
  if (!existingPhases) return buffer;
  const existingPhase = existingPhases[phaseIndex];
  if (!existingPhase || existingPhase["model-override"] === undefined) return buffer;

  const project = { ...buffer.project };
  const pipelines = { ...(project.pipelines ?? {}) };
  const pipeline: PipelineConfig = { ...pipelines[pipelineName] };
  const phases = [...existingPhases];
  const nextPhase = { ...phases[phaseIndex] };
  delete nextPhase["model-override"];
  phases[phaseIndex] = nextPhase;

  // Trim trailing fully-empty slots so a one-time override doesn't leave a
  // long array of {} behind.
  while (phases.length > 0 && Object.keys(phases[phases.length - 1]).length === 0) {
    phases.pop();
  }
  if (phases.length === 0) {
    delete pipeline.phases;
  } else {
    pipeline.phases = phases;
  }

  // If the pipeline has no persona-models and no remaining phase overrides, drop it.
  const hasPipelinePersonaModels =
    pipeline["persona-models"] !== undefined &&
    Object.keys(pipeline["persona-models"]).length > 0;
  const hasNonEmptyPhases = (pipeline.phases ?? []).some(
    (p) => Object.keys(p).length > 0,
  );
  if (!hasPipelinePersonaModels && !hasNonEmptyPhases) {
    delete pipelines[pipelineName];
  } else {
    pipelines[pipelineName] = pipeline;
  }

  if (Object.keys(pipelines).length === 0) {
    delete project.pipelines;
  } else {
    project.pipelines = pipelines;
  }

  return { ...buffer, project };
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

// ── Slice 4c selectors — per-phase overrides ─────────────────────────────────

/**
 * One row per pipeline currently known to the TUI. A pipeline is "known" when
 * it appears in the project pipeline catalogue (from .forge/config.json). If
 * the catalogue is null we fall back to ["default"] so the editor still works
 * outside a Forge project (rare; the override editor is only reachable from
 * the top-menu which itself requires a project).
 */
export interface PipelineOverrideSummary {
  pipeline: string;
  overrideCount: number;
}

export function listPipelineOverrideSummaries(
  state: ConfigTuiState,
): PipelineOverrideSummary[] {
  const names = state.pipelineCatalogue ?? ["default"];
  return names.map((pipeline) => {
    const phases = state.buffer.project.pipelines?.[pipeline]?.phases ?? [];
    const overrideCount = phases.filter(
      (p) => p["model-override"] !== undefined,
    ).length;
    return { pipeline, overrideCount };
  });
}

/**
 * Resolve the override (if any) on a given pipeline + phase index.
 */
export function getPhaseOverride(
  state: ConfigTuiState,
  pipeline: string,
  phaseIndex: number,
): PhaseOverride | undefined {
  return state.buffer.project.pipelines?.[pipeline]?.phases?.[phaseIndex]?.[
    "model-override"
  ];
}
