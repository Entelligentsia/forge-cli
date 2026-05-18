// Persona-picker screen — renders and handles input for the "pick which persona" view.
// Phase 2: extracted from component.ts handlePersonaPickerInput + screens.ts renderPersonaPicker.

import type { ConfigTuiState } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, listPersonaPickerEntries } from "../state/selectors.js";
import { rule, windowList } from "./shared.js";
import { padRight } from "../theme.js";

export class PersonaPickerScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "persona-picker") {
      return ["(renderPersonaPicker called with wrong active view)"];
    }
    const entries = listPersonaPickerEntries(state);
    const lines: string[] = [];
    lines.push(`forge config › personas › pick which`);
    lines.push(rule(width, theme));
    lines.push(`  Pick a persona to assign a model to:`);
    lines.push("");

    const nameCol = Math.max(9, ...entries.map((e) => e.persona.length));
    const win = windowList(entries, view.cursor, 12);
    if (win.aboveCount > 0) lines.push(`    ↑ ${win.aboveCount} more above`);
    win.visible.forEach((entry, i) => {
      const absoluteIdx = win.start + i;
      const cursor = absoluteIdx === view.cursor ? "▸" : " ";
      let status: string;
      if (entry.assignment) {
        const layer = entry.assignment.source.endsWith("L2") ? "L2" : "L1";
        status = `currently: ${entry.assignment.provider}:${entry.assignment.model} (${layer})`;
      } else if (entry.persona === "default") {
        status = "fallback for every persona";
      } else {
        status = "currently: inherit";
      }
      const cat = entry.inCatalogue ? " " : "⚠";
      lines.push(`  ${cursor} ${cat} ${padRight(entry.persona, nameCol)}  ${status}`);
    });
    if (win.belowCount > 0) lines.push(`    ↓ ${win.belowCount} more below`);
    lines.push("");
    lines.push(`  ↑/↓ select   enter open editor   esc back`);
    return lines;
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    if (view.kind !== "persona-picker") return { kind: "no-op" };

    const entries = listPersonaPickerEntries(state);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < entries.length - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      return { kind: "consumed" };
    }
    if (matchesKey(data, Key.enter)) {
      const target = entries[view.cursor];
      if (target) {
        // Pop the picker and push the editor in one render cycle.
        return {
          kind: "dispatch-seq",
          actions: [
            { kind: "pop-view" },
            { kind: "begin-persona-edit", persona: target.persona },
          ],
        };
      }
      return { kind: "consumed" };
    }
    return { kind: "no-op" };
  }
}