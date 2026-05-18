// Screen renderers and routing — barrel re-export for backward compatibility.
//
// Phase 3: theming + width safety. All screen classes now use theme helpers
// for visible strings and truncate their output to terminal width.

import type { ConfigTuiState, View } from "./state.js";
import {
  getActiveView,
} from "./state/selectors.js";
import type { Theme } from "@earendil-works/pi-coding-agent";

import { TierMenuScreen } from "./screens/tier-menu.js";
// Phase B: import { TierPickerScreen } from "./screens/tier-picker.js";
import { ConfirmQuitScreen, renderSaveBanner } from "./screens/confirm-quit.js";
import { TopMenuScreen } from "./screens/top-menu.js";
import { PersonasListScreen } from "./screens/personas-list.js";
import { PersonaPickerScreen } from "./screens/persona-picker.js";
import { PersonaEditorScreen } from "./screens/persona-editor.js";
import { ShowResolvedScreen, computeResolvedRows } from "./screens/show-resolved.js";
import { OverridesListPipelinesScreen } from "./screens/overrides-list.js";
import { OverridesListPhasesScreen } from "./screens/overrides-list-phases.js";
import { OverrideEditorScreen } from "./screens/override-editor.js";
import type { MenuItem } from "./screens/top-menu.js";

// ── Screen instances for renderActive ───────────────────────────────────────

const SCREEN_INSTANCES: Record<string, { render(state: ConfigTuiState, width: number, theme: Theme): string[] }> = {
  "tier-menu": new TierMenuScreen(),
  "tier-picker": new TopMenuScreen(),  // Phase B placeholder
  "no-project": new TopMenuScreen(),
  "empty-state": new TopMenuScreen(),
  "top-menu": new TopMenuScreen(),
  "personas-list": new PersonasListScreen(),
  "persona-picker": new PersonaPickerScreen(),
  "persona-editor": new PersonaEditorScreen(),
  "show-resolved": new ShowResolvedScreen(),
  "overrides-list-pipelines": new OverridesListPipelinesScreen(),
  "overrides-list-phases": new OverridesListPhasesScreen(),
  "override-editor": new OverrideEditorScreen(),
};

// ── Re-exports for backward compatibility ───────────────────────────────────

export { TierMenuScreen } from "./screens/tier-menu.js";
// Phase B: export { TierPickerScreen } from "./screens/tier-picker.js";
export { TopMenuScreen } from "./screens/top-menu.js";
export { PersonasListScreen } from "./screens/personas-list.js";
export { PersonaPickerScreen } from "./screens/persona-picker.js";
export { PersonaEditorScreen } from "./screens/persona-editor.js";
export { ShowResolvedScreen, computeResolvedRows, type ResolvedRow } from "./screens/show-resolved.js";
export { OverridesListPipelinesScreen } from "./screens/overrides-list.js";
export { OverridesListPhasesScreen } from "./screens/overrides-list-phases.js";
export { OverrideEditorScreen } from "./screens/override-editor.js";
export { ConfirmQuitScreen, renderSaveBanner } from "./screens/confirm-quit.js";
export { type InputResult, type Screen } from "./screens/types.js";
export { type MenuItem } from "./screens/top-menu.js";

// ── Legacy render functions (backward-compatible wrappers) ────────────────────

export function renderTierMenu(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["tier-menu"].render(state, width, theme);
}

export function renderTopMenu(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["top-menu"].render(state, width, theme);
}

export function renderEmptyState(state: ConfigTuiState, width: number, theme: Theme): string[] {
  const stateForRender: ConfigTuiState = { ...state, isEmpty: true };
  return SCREEN_INSTANCES["empty-state"].render(stateForRender, width, theme);
}

export function renderNoProject(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["no-project"].render(state, width, theme);
}

export function renderPersonasList(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["personas-list"].render(state, width, theme);
}

export function renderPersonaPicker(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["persona-picker"].render(state, width, theme);
}

export function renderPersonaEditor(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["persona-editor"].render(state, width, theme);
}

export function renderShowResolved(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["show-resolved"].render(state, width, theme);
}

export function renderOverridesListPipelines(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["overrides-list-pipelines"].render(state, width, theme);
}

export function renderOverridesListPhases(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["overrides-list-phases"].render(state, width, theme);
}

export function renderOverrideEditor(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["override-editor"].render(state, width, theme);
}

// ── Top-level router ─────────────────────────────────────────────────────────

export function renderActive(state: ConfigTuiState, width: number, theme: Theme): string[] {
  const view = getActiveView(state);
  const screen = SCREEN_INSTANCES[view.kind];
  const lines = screen ? screen.render(state, width, theme) : [];
  // Decorations: save banner stacks at the bottom, confirm-quit modal on top.
  return [...lines, ...renderSaveBanner(state, width, theme), ...new ConfirmQuitScreen().render(state, width, theme)];
}