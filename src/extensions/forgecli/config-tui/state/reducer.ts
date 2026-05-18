// Config TUI reducer — pure (state, action) → state. No I/O.
// Split from state.ts (Phase 1).

import type { ConfigTuiAction, ConfigTuiState, View } from "./model.js";
import type { PersonaModel } from "../../config-layer.js";
import { writePersonaEntry, deletePersonaEntry, writePhaseOverride, clearPhaseOverride } from "./buffer.js";

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
        top.kind === "persona-picker" ||
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
      const entry: import("../../config-layer.js").PersonaModel = { provider: top.provider, model: top.model };
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
        phaseRole: action.phaseRole,
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
        top.phaseRole,
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
      const buffer = writePhaseOverride(state.buffer, top.pipeline, top.phaseRole, {
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
      const buffer = clearPhaseOverride(state.buffer, action.pipeline, action.phaseRole);
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