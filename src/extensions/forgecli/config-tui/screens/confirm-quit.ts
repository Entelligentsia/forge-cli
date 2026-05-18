// Confirm-quit overlay — renders and handles input for the quit-confirmation dialog.
// Phase 2: extracted from component.ts handleInput + screens.ts renderConfirmQuitOverlay.

import type { ConfigTuiState } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { InputResult, Screen } from "./types.js";
import { Key, matchesKey } from "@earendil-works/pi-tui";

export class ConfirmQuitScreen implements Screen {
  render(state: ConfigTuiState, _width: number, _theme: Theme): string[] {
    if (!state.confirmQuit) return [];
    return [
      "",
      `  ┌─────────────────────────────────────────────────────────┐`,
      `  │  Unsaved changes — discard and quit?                    │`,
      `  │                                                         │`,
      `  │  y / enter — discard and quit                           │`,
      `  │  n / esc   — cancel (stay in TUI)                       │`,
      `  └─────────────────────────────────────────────────────────┘`,
    ];
  }

  handleInput(data: string, _state: ConfigTuiState): InputResult {
    if (matchesKey(data, "y") || matchesKey(data, Key.enter)) {
      return { kind: "dispatch", action: { kind: "confirm-quit", discard: true } };
    }
    if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
      return { kind: "dispatch", action: { kind: "confirm-quit", discard: false } };
    }
    return { kind: "no-op" };
  }
}

/** Render the save banner (non-interactive decoration). Kept as a plain function
 *  since it has no input handling — the orchestrator appends it after the active
 *  screen's render output. */
export function renderSaveBanner(state: ConfigTuiState, _width: number, _theme: Theme): string[] {
  if (!state.lastSaved) return [];
  return [
    "",
    `  ✓ Saved → ${state.lastSaved.target}  (${state.lastSaved.layer})`,
  ];
}