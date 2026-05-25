// Screen renderers and routing — barrel re-export for backward compatibility.
//
// Phase 3: theming + width safety. All screen classes now use theme helpers
// for visible strings and truncate their output to terminal width.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { AdvancedMenuScreen } from "./screens/advanced-menu.js";
import { ConfirmQuitScreen, renderSaveBanner } from "./screens/confirm-quit.js";
import { OverrideEditorScreen } from "./screens/override-editor.js";
import { OverridesListPipelinesScreen } from "./screens/overrides-list.js";
import { OverridesListPhasesScreen } from "./screens/overrides-list-phases.js";
import { PersonaEditorScreen } from "./screens/persona-editor.js";
import { PersonaPickerScreen } from "./screens/persona-picker.js";
import { PersonasListScreen } from "./screens/personas-list.js";
import { computeResolvedRows, ShowResolvedScreen } from "./screens/show-resolved.js";
import { TierMenuScreen } from "./screens/tier-menu.js";
import { TierPickerScreen } from "./screens/tier-picker.js";
import { getActiveView } from "./state/selectors.js";
import type { ConfigTuiState, View } from "./state.js";

// ── Screen instances for renderActive ───────────────────────────────────────

const SCREEN_INSTANCES: Record<string, { render(state: ConfigTuiState, width: number, theme: Theme): string[] }> = {
	"tier-menu": new TierMenuScreen(),
	"tier-picker": new TierPickerScreen(),
	"advanced-menu": new AdvancedMenuScreen(),
	"personas-list": new PersonasListScreen(),
	"persona-picker": new PersonaPickerScreen(),
	"persona-editor": new PersonaEditorScreen(),
	"show-resolved": new ShowResolvedScreen(),
	"overrides-list-pipelines": new OverridesListPipelinesScreen(),
	"overrides-list-phases": new OverridesListPhasesScreen(),
	"override-editor": new OverrideEditorScreen(),
};

// ── Re-exports for backward compatibility ───────────────────────────────────

export { AdvancedMenuScreen } from "./screens/advanced-menu.js";
export { ConfirmQuitScreen, renderSaveBanner } from "./screens/confirm-quit.js";
export { OverrideEditorScreen } from "./screens/override-editor.js";
export { OverridesListPipelinesScreen } from "./screens/overrides-list.js";
export { OverridesListPhasesScreen } from "./screens/overrides-list-phases.js";
export { PersonaEditorScreen } from "./screens/persona-editor.js";
export { PersonaPickerScreen } from "./screens/persona-picker.js";
export { PersonasListScreen } from "./screens/personas-list.js";
export { computeResolvedRows, type ResolvedRow, ShowResolvedScreen } from "./screens/show-resolved.js";
export { TierMenuScreen } from "./screens/tier-menu.js";
export { TierPickerScreen } from "./screens/tier-picker.js";
export type { InputResult, Screen } from "./screens/types.js";

// ── Render functions (backward-compatible wrappers) ──────────────────────

export function renderTierMenu(state: ConfigTuiState, width: number, theme: Theme): string[] {
	return SCREEN_INSTANCES["tier-menu"].render(state, width, theme);
}

export function renderAdvancedMenu(state: ConfigTuiState, width: number, theme: Theme): string[] {
	return SCREEN_INSTANCES["advanced-menu"].render(state, width, theme);
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
