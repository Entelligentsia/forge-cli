// Config TUI state constructor — pure function, no I/O.
// Split from state.ts (Phase 1).

import type { ConfigTuiState, InitOptions, View } from "./model.js";

export function initialState(opts: InitOptions): ConfigTuiState {
  const buffer: ConfigTuiState["buffer"] = {
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
    authError: opts.authError ?? null,
    confirmQuit: false,
    shouldExit: false,
    lastSaved: null,
  };
}

function cloneJSON<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}