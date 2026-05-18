// Screen renderers and routing — barrel re-export for backward compatibility.
//
// Phase 1 originally had all render functions here. Phase 2 extracts each screen
// into its own module under screens/*.ts, each implementing the Screen interface.
// This file now re-exports the render functions for backward compatibility with
// existing tests and consumers.
//
// The renderActive router is preserved here as well, delegating to the same
// Screen instances that the orchestrator (component.ts) uses.

import type { ConfigTuiState, View } from "./state.js";
import { CANONICAL_PHASES } from "./state/constants.js";
import {
  getActiveView,
  getPhaseOverride,
  listPersonaPickerEntries,
  listPipelineOverrideSummaries,
  listResolvedPersonas,
  uniqueProviders,
} from "./state/selectors.js";
import { resolveModelForPhase } from "../model-resolver.js";
import { rule, authBadgeFor, authStatusLine, resolvedSummary, windowList, formatOverride } from "./screens/shared.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { padRight, cursor, accentBold, dim, muted, warning } from "./theme.js";

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
// These delegate to the new Screen instances so that tests that import
// renderTopMenu, renderPersonasList, etc. still work.

export function topMenuItems(state: ConfigTuiState): MenuItem[] {
  // TopMenuScreen.topMenuItems is inside the module; re-implement the call path
  // by using the screen instance's render, but we need the items list.
  // Since topMenuItems is only used in render, and is now internal to TopMenuScreen,
  // we expose a backward-compat wrapper by re-importing from the module.
  // However, topMenuItems is a local function in top-menu.ts now, not exported.
  // For backward compatibility we keep the logic here:
  if (state.isEmpty) {
    return [
      { label: () => `1. Add a persona-model assignment   (creates a config file)` },
      { label: () => `2. Show resolved (read-only view)` },
    ];
  }
  const items: MenuItem[] = [
    {
      label: (s) => {
        const personas = listResolvedPersonas(s);
        const globalCount = Object.keys(s.buffer.global["persona-models"] ?? {}).length;
        const projectCount = Object.keys(s.buffer.project["persona-models"] ?? {}).length;
        return `1. Personas                              ${personas.length} defined  (${globalCount} global · ${projectCount} project)`;
      },
    },
    {
      label: (s) => {
        const pipelineHas = Object.keys(s.buffer.project.pipelines ?? {}).length;
        return `2. Per-phase overrides                          ${pipelineHas > 0 ? `${pipelineHas} pipeline${pipelineHas === 1 ? "" : "s"}` : "0 set"}`;
      },
    },
    { label: () => `3. Show resolved (per pipeline, per phase)` },
  ];
  if (state.pipelineCatalogue) {
    items.push({
      label: (s) =>
        `4. Pipelines                              ${(s.pipelineCatalogue ?? []).length} known  (read from .forge)`,
    });
  }
  items.push({ label: () => `5. Forge plugin config (read-only)` });
  return items;
}

export function noProjectMenuItems(state: ConfigTuiState): MenuItem[] {
  const globalCount = Object.keys(state.buffer.global["persona-models"] ?? {}).length;
  return [
    { label: () => `1. Personas (global)                              ${globalCount} defined` },
    { label: () => `2. Show resolved                                  N/A — no pipeline catalogue` },
  ];
}

export function renderTopMenu(state: ConfigTuiState, width: number, theme: Theme): string[] {
  return SCREEN_INSTANCES["top-menu"].render(state, width, theme);
}

export function renderEmptyState(state: ConfigTuiState, width: number, theme: Theme): string[] {
  // Force the "empty" branch by using a copy with isEmpty=true
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