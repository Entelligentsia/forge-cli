// Top-menu screen — renders the main menu (top-menu, empty-state, no-project variants)
// and handles input for all three.
// Phase 3: data-driven menu items with actions, full theming, width safety.

import type { ConfigTuiState, View, ConfigTuiAction } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import {
  getActiveView,
  listResolvedPersonas,
  uniqueProviders,
} from "../state/selectors.js";
import { rule, authStatusLine, resolvedSummary, safeLines } from "./shared.js";
import { padRight, cursor, accentBold, muted, warning, dirtyMarker } from "../theme.js";

type MenuViewKind = "top-menu" | "empty-state" | "no-project";

export interface MenuItem {
  label: (s: ConfigTuiState, theme: Theme) => string;
  /** If null, the item is a stub and fireMenuItem should return an error. */
  action: (s: ConfigTuiState) => ConfigTuiAction | null;
}

function topMenuItems(state: ConfigTuiState, theme: Theme): MenuItem[] {
  if (state.isEmpty) {
    return [
      { label: () => "Add a persona-model assignment   (creates a config file)", action: () => ({ kind: "push-view", view: { kind: "persona-picker", cursor: 0 } }) },
      { label: () => "Show resolved (read-only view)", action: () => ({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } }) },
    ];
  }
  const items: MenuItem[] = [
    {
      label: (s) => {
        const personas = listResolvedPersonas(s);
        const globalCount = Object.keys(s.buffer.global["persona-models"] ?? {}).length;
        const projectCount = Object.keys(s.buffer.project["persona-models"] ?? {}).length;
        return `Personas                              ${personas.length} defined  (${globalCount} global · ${projectCount} project)`;
      },
      action: () => ({ kind: "push-view", view: { kind: "personas-list", cursor: 0 } }),
    },
    {
      label: (s) => {
        const pipelineHas = Object.keys(s.buffer.project.pipelines ?? {}).length;
        return `Per-phase overrides                          ${pipelineHas > 0 ? `${pipelineHas} pipeline${pipelineHas === 1 ? "" : "s"}` : "0 set"}`;
      },
      action: () => ({ kind: "push-view", view: { kind: "overrides-list-pipelines", cursor: 0 } }),
    },
    { label: () => "Show resolved (per pipeline, per phase)", action: () => ({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } }) },
  ];
  if (state.pipelineCatalogue) {
    items.push({
      label: (s) => `Pipelines                              ${(s.pipelineCatalogue ?? []).length} known  (read from .forge)`,
      action: () => null, // stub
    });
  }
  items.push({ label: () => "Forge plugin config (read-only)", action: () => null }); // stub
  return items;
}

function noProjectMenuItems(state: ConfigTuiState): MenuItem[] {
  const globalCount = Object.keys(state.buffer.global["persona-models"] ?? {}).length;
  return [
    { label: () => `Personas (global)                              ${globalCount} defined`, action: () => ({ kind: "push-view", view: { kind: "personas-list", cursor: 0 } }) },
    { label: () => "Show resolved                                  N/A — no pipeline catalogue", action: () => ({ kind: "push-view", view: { kind: "show-resolved", cursor: 0 } }) },
  ];
}

export class TopMenuScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    const cursorIdx = view.kind === "top-menu" || view.kind === "empty-state" || view.kind === "no-project" ? view.cursor : 0;
    const lines: string[] = [];

    if (view.kind === "no-project") {
      lines.push(accentBold("forge config", theme));
      lines.push(rule(width, theme));
      lines.push(muted("  No project root found (no .forge/ at cwd).", theme));
      lines.push("");
      lines.push(muted("  Editing global config only:", theme));
      lines.push(muted("    ~/.pi/agent/forge-cli/config.json", theme));
      lines.push("");
      const items = noProjectMenuItems(state);
      items.forEach((it, i) => {
        const mark = cursor(i === cursorIdx, theme);
        lines.push(`  ${mark} ${it.label(state, theme)}`);
      });
      lines.push(`    ${muted("q", theme)}. ${muted("Quit", theme)}`);
      lines.push("");
      lines.push(muted("  ↑/↓ select   enter open   1-2 shortcuts   q quit", theme));
      return safeLines(lines, width);
    }

    // top-menu or empty-state
    lines.push(accentBold("forge config", theme));
    lines.push(rule(width, theme));
    lines.push(authStatusLine(state, theme));
    lines.push(resolvedSummary(state, theme));
    lines.push("");

    if (view.kind === "empty-state" || state.isEmpty) {
      lines.push(muted("  No forge-cli config files found.", theme));
      lines.push(muted("    Global:  ~/.pi/agent/forge-cli/config.json", theme));
      lines.push(muted(`    Project: ${state.cwd}/.pi/forge-cli/config.json`, theme));
      lines.push("");
      lines.push(muted("  Every Forge persona will run on pi's currently-running model.", theme));
      lines.push(muted("  To customise:", theme));
      lines.push("");
    }

    const items = topMenuItems(state, theme);
    items.forEach((it, i) => {
      const mark = cursor(i === cursorIdx, theme);
      lines.push(`  ${mark} ${it.label(state, theme)}`);
    });
    lines.push(`    q. ${muted("Quit", theme)}`);

    lines.push("");
    lines.push(muted("  ↑/↓ select   enter open   1-5 shortcuts   q quit   ? help", theme));
    if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);
    return safeLines(lines, width);
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    const isMenu =
      view.kind === "top-menu" || view.kind === "empty-state" || view.kind === "no-project";
    if (!isMenu) return { kind: "no-op" };

    const itemViewKind = view.kind as MenuViewKind;
    const items = itemViewKind === "no-project"
      ? noProjectMenuItems(state)
      : topMenuItems(state, undefined as unknown as Theme); // items array for counting only
    const itemCount = topLevelItemCount(state, view);

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      const cursorVal = (view as { cursor: number }).cursor;
      if (cursorVal < itemCount - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      return { kind: "consumed" };
    }

    if (matchesKey(data, Key.enter)) {
      return fireMenuItem(itemViewKind, (view as { cursor: number }).cursor, state);
    }

    if (matchesKey(data, "1")) return fireMenuItem(itemViewKind, 0, state);
    if (matchesKey(data, "2")) return fireMenuItem(itemViewKind, 1, state);
    if (matchesKey(data, "3")) return fireMenuItem(itemViewKind, 2, state);

    // 'r' shortcut → show resolved (always works on top-level views).
    if (matchesKey(data, "r")) {
      return { kind: "dispatch", action: { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } } };
    }

    return { kind: "no-op" };
  }
}

function topLevelItemCount(state: ConfigTuiState, view: View): number {
  if (view.kind === "no-project") return 2;
  if (view.kind === "empty-state" || state.isEmpty) return 2;
  if (view.kind === "top-menu") {
    return state.pipelineCatalogue ? 5 : 4;
  }
  return 0;
}

function fireMenuItem(viewKind: MenuViewKind, index: number, state: ConfigTuiState): InputResult {
  // Use data-driven menu items to derive the action.
  if (state.isEmpty) {
    const items = topMenuItems(state, undefined as unknown as Theme);
    const item = items[index];
    if (!item) return { kind: "no-op" };
    const action = item.action(state);
    if (action === null) return { kind: "error", message: "This feature lands in a follow-up slice." };
    return { kind: "dispatch", action };
  }
  if (viewKind === "no-project") {
    const items = noProjectMenuItems(state);
    const item = items[index];
    if (!item) return { kind: "no-op" };
    const action = item.action(state);
    if (action === null) return { kind: "error", message: "This feature lands in a follow-up slice." };
    return { kind: "dispatch", action };
  }
  if (viewKind === "empty-state") {
    const items = topMenuItems(state, undefined as unknown as Theme);
    const item = items[index];
    if (!item) return { kind: "no-op" };
    const action = item.action(state);
    if (action === null) return { kind: "error", message: "This feature lands in a follow-up slice." };
    return { kind: "dispatch", action };
  }
  // top-menu (non-empty, has pipelines)
  const items = topMenuItems(state, undefined as unknown as Theme);
  const item = items[index];
  if (!item) return { kind: "no-op" };
  const action = item.action(state);
  if (action === null) return { kind: "error", message: "This feature lands in a follow-up slice." };
  return { kind: "dispatch", action };
}