// Top-menu screen — renders the main menu (top-menu, empty-state, no-project variants)
// and handles input for all three.
// Phase 2: extracted from component.ts handleTopLevelInput + screens.ts renderTopMenu/EmptyState/NoProject.

import type { ConfigTuiState, View } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import {
  getActiveView,
  listResolvedPersonas,
  uniqueProviders,
} from "../state/selectors.js";
import { rule, authStatusLine, resolvedSummary, windowList } from "./shared.js";
import { padRight } from "../theme.js";

type MenuViewKind = "top-menu" | "empty-state" | "no-project";

export interface MenuItem {
  label: (s: ConfigTuiState) => string;
}

function topMenuItems(state: ConfigTuiState): MenuItem[] {
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

function noProjectMenuItems(state: ConfigTuiState): MenuItem[] {
  const globalCount = Object.keys(state.buffer.global["persona-models"] ?? {}).length;
  return [
    { label: () => `1. Personas (global)                              ${globalCount} defined` },
    { label: () => `2. Show resolved                                  N/A — no pipeline catalogue` },
  ];
}

export class TopMenuScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    const cursor = view.kind === "top-menu" || view.kind === "empty-state" || view.kind === "no-project" ? view.cursor : 0;
    const lines: string[] = [];

    if (view.kind === "no-project") {
      lines.push("forge config");
      lines.push(rule(width, theme));
      lines.push(`  No project root found (no .forge/ at cwd).`);
      lines.push("");
      lines.push(`  Editing global config only:`);
      lines.push(`    ~/.pi/agent/forge-cli/config.json`);
      lines.push("");
      const items = noProjectMenuItems(state);
      items.forEach((it, i) => {
        const mark = i === cursor ? "▸" : " ";
        lines.push(`  ${mark} ${it.label(state)}`);
      });
      lines.push(`    q. Quit`);
      lines.push("");
      lines.push(`  ↑/↓ select   enter open   1-2 shortcuts   q quit`);
      return lines;
    }

    // top-menu or empty-state
    lines.push("forge config");
    lines.push(rule(width, theme));
    lines.push(authStatusLine(state, theme));
    lines.push(resolvedSummary(state, theme));
    lines.push("");

    if (view.kind === "empty-state" || state.isEmpty) {
      lines.push(`  No forge-cli config files found.`);
      lines.push(`    Global:  ~/.pi/agent/forge-cli/config.json`);
      lines.push(`    Project: ${state.cwd}/.pi/forge-cli/config.json`);
      lines.push("");
      lines.push(`  Every Forge persona will run on pi's currently-running model.`);
      lines.push(`  To customise:`);
      lines.push("");
    }

    const items = topMenuItems(state);
    items.forEach((it, i) => {
      const mark = i === cursor ? "▸" : " ";
      lines.push(`  ${mark} ${it.label(state)}`);
    });
    lines.push(`    q. Quit`);

    lines.push("");
    lines.push(`  ↑/↓ select   enter open   1-5 shortcuts   q quit   ? help`);
    if (state.dirty) lines.push(`  * unsaved`);
    return lines;
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    const isMenu =
      view.kind === "top-menu" || view.kind === "empty-state" || view.kind === "no-project";
    const itemCount = isMenu ? topLevelItemCount(state, view) : 0;

    if (isMenu && (matchesKey(data, Key.up) || matchesKey(data, "k"))) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (isMenu && (matchesKey(data, Key.down) || matchesKey(data, "j"))) {
      const cursor = (view as { cursor: number }).cursor;
      if (cursor < itemCount - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      return { kind: "consumed" };
    }

    if (matchesKey(data, Key.enter) && isMenu) {
      return fireMenuItem(view.kind as MenuViewKind, (view as { cursor: number }).cursor, state);
    }

    if (matchesKey(data, "1")) return fireMenuItem(view.kind as MenuViewKind, 0, state);
    if (matchesKey(data, "2")) return fireMenuItem(view.kind as MenuViewKind, 1, state);
    if (matchesKey(data, "3")) return fireMenuItem(view.kind as MenuViewKind, 2, state);

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
  if (state.isEmpty) {
    if (index === 0) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "persona-picker", cursor: 0 } } };
    if (index === 1) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } } };
    return { kind: "no-op" };
  }
  if (viewKind === "no-project") {
    if (index === 0) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "personas-list", cursor: 0 } } };
    if (index === 1) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } } };
    return { kind: "no-op" };
  }
  if (viewKind === "empty-state") {
    if (index === 0) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "persona-picker", cursor: 0 } } };
    if (index === 1) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } } };
    return { kind: "no-op" };
  }
  // top-menu (non-empty, has pipelines)
  if (index === 0) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "personas-list", cursor: 0 } } };
  if (index === 1) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "overrides-list-pipelines", cursor: 0 } } };
  if (index === 2) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } } };
  // Items 3 and 4 are stubs — surface an error message.
  if (index === 3 && state.pipelineCatalogue) return { kind: "error", message: "Pipeline catalogue browser lands in a follow-up slice." };
  if (index === 3 || index === 4) return { kind: "error", message: "Plugin config view lands in a follow-up slice." };
  return { kind: "no-op" };
}