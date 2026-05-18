// Personas-list screen — renders and handles input for the persona list view.
// Phase 2: extracted from component.ts handlePersonasListInput + screens.ts renderPersonasList.

import type { ConfigTuiState, View } from "../state/model.js";
import type { ConfigLayer } from "../../config-writer.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, listResolvedPersonas } from "../state/selectors.js";
import { rule } from "./shared.js";
import { padRight } from "../theme.js";

export class PersonasListScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "personas-list") {
      return ["(renderPersonasList called with wrong active view)"];
    }
    const personas = listResolvedPersonas(state);
    const lines: string[] = [];
    lines.push(`forge config › personas`);
    lines.push(rule(width, theme));

    if (personas.length === 0) {
      lines.push(`  (no persona-model assignments)`);
      lines.push(`  n new persona-model assignment   esc back`);
      return lines;
    }

    const personaCol = Math.max(
      7,
      ...personas.map((p) => p.persona.length),
    );
    const modelCol = Math.max(
      16,
      ...personas.map((p) => `${p.provider}:${p.model}`.length),
    );

    lines.push(`  ${padRight("PERSONA", personaCol)}  ${padRight("PROVIDER:MODEL", modelCol)}  SOURCE  AVAIL`);
    personas.forEach((p, i) => {
      const cursor = i === view.cursor ? "▸" : " ";
      const modelStr = `${p.provider}:${p.model}`;
      const avail = state.availableModels.some(
        (m) => m.provider === p.provider && m.id === p.model,
      )
        ? "✓"
        : "✗";
      const sourceCol = p.source.replace(/-(L1|L2)$/, " ($1)");
      lines.push(
        `  ${cursor} ${padRight(p.persona, personaCol)}  ${padRight(modelStr, modelCol)}  ${padRight(sourceCol, 8)} ${avail}`,
      );
    });

    // Catalogue context
    const assignedSet = new Set(personas.map((p) => p.persona));
    const unassignedFromCatalogue = state.personaCatalogue.filter(
      (p) => !assignedSet.has(p),
    );
    if (unassignedFromCatalogue.length > 0) {
      lines.push("");
      lines.push(`  Personas with no assignment (use 'default'):`);
      lines.push(`    ${unassignedFromCatalogue.join(", ")}`);
    }

    const orphans = personas
      .map((p) => p.persona)
      .filter((p) => p !== "default" && !state.personaCatalogue.includes(p));
    if (orphans.length > 0) {
      lines.push("");
      lines.push(`  ⚠ Not in Forge persona catalogue:`);
      lines.push(`    ${orphans.join(", ")}`);
    }

    lines.push("");
    lines.push(`  enter edit   n new   d delete (in current layer)   esc back`);
    if (state.dirty) lines.push(`  * unsaved`);
    return lines;
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    if (view.kind !== "personas-list") return { kind: "no-op" };

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      const max = Math.max(0, listResolvedPersonas(state).length - 1);
      if (view.cursor < max) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      return { kind: "consumed" };
    }
    if (matchesKey(data, Key.enter)) {
      const personas = listResolvedPersonas(state);
      const target = personas[view.cursor];
      if (target) {
        return { kind: "dispatch", action: { kind: "begin-persona-edit", persona: target.persona } };
      }
      return { kind: "consumed" };
    }
    if (matchesKey(data, "n")) {
      return { kind: "dispatch", action: { kind: "push-view", view: { kind: "persona-picker", cursor: 0 } } };
    }
    if (matchesKey(data, "d")) {
      const personas = listResolvedPersonas(state);
      const target = personas[view.cursor];
      if (target) {
        const layer: ConfigLayer = target.source.endsWith("L2") ? "project" : "global";
        return { kind: "dispatch", action: { kind: "delete-persona-entry", layer, persona: target.persona } };
      }
      return { kind: "consumed" };
    }
    return { kind: "no-op" };
  }
}