// Persona-editor screen — 3-step wizard (provider → model → layer).
// Phase 2: extracted from component.ts handlePersonaEditorInput + screens.ts renderPersonaEditor.

import type { ConfigTuiState } from "../state/model.js";
import type { ConfigLayer } from "../../config-writer.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, listResolvedPersonas, uniqueProviders } from "../state/selectors.js";
import { rule, authBadgeFor, windowList } from "./shared.js";
import { padRight } from "../theme.js";

export class PersonaEditorScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "persona-editor") {
      return ["(renderPersonaEditor called with wrong active view)"];
    }
    const lines: string[] = [];
    const inCatalogue = state.personaCatalogue.includes(view.persona) || view.persona === "default";

    lines.push(`forge config › personas › ${view.persona}`);
    lines.push(rule(width, theme));

    if (view.step === "pick-provider") {
      lines.push(`  Step 1 of 3 — pick provider`);
      if (!inCatalogue) {
        lines.push(`  ⚠ '${view.persona}' is not in the Forge persona catalogue.`);
      }
      lines.push("");
      lines.push(`  Provider                                                  AUTH`);
      const providers = uniqueProviders(state);
      const win = windowList(providers, view.cursor);
      if (win.aboveCount > 0) lines.push(`    ↑ ${win.aboveCount} more above`);
      win.visible.forEach((p, i) => {
        const absoluteIdx = win.start + i;
        const cursor = absoluteIdx === view.cursor ? "▸" : " ";
        const auth = authBadgeFor(state, p, theme);
        lines.push(`  ${cursor} ${padRight(p, 56)}${auth}`);
      });
      if (win.belowCount > 0) lines.push(`    ↓ ${win.belowCount} more below`);
      lines.push("");
      lines.push(`  ↑/↓ select   enter advance   esc back`);
    } else if (view.step === "pick-model") {
      lines.push(`  Step 2 of 3 — pick model (provider: ${view.provider ?? "(unknown)"})`);
      lines.push("");
      const models = state.availableModels.filter((m) => m.provider === view.provider);
      if (models.length === 0) {
        lines.push(`  No models available for this provider.`);
        lines.push(`  (Run \`pi /login ${view.provider}\` then return.)`);
      } else {
        const win = windowList(models, view.cursor);
        if (win.aboveCount > 0) lines.push(`    ↑ ${win.aboveCount} more above`);
        win.visible.forEach((m, i) => {
          const absoluteIdx = win.start + i;
          const cursor = absoluteIdx === view.cursor ? "▸" : " ";
          lines.push(`  ${cursor} ${m.id}`);
        });
        if (win.belowCount > 0) lines.push(`    ↓ ${win.belowCount} more below`);
      }
      lines.push("");
      lines.push(`  ↑/↓ select   enter advance   esc back`);
    } else {
      // pick-layer
      lines.push(`  Step 3 of 3 — pick write target`);
      lines.push("");
      lines.push(`  ${view.persona} → ${view.provider}:${view.model}`);
      lines.push("");
      const targets = ["project", "global"] as const;
      const targetLines = [
        `Project   ${state.cwd}/.pi/forge-cli/config.json`,
        `Global    ~/.pi/agent/forge-cli/config.json`,
      ];
      targets.forEach((_, i) => {
        const cursor = i === view.cursor ? "▸" : " ";
        lines.push(`  ${cursor} ${targetLines[i]}`);
      });
      lines.push("");
      lines.push(`  ↑/↓ select   enter confirm and write   p/g shortcuts   esc cancel`);
    }

    if (state.dirty) lines.push(`  * unsaved`);
    return lines;
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    if (view.kind !== "persona-editor") return { kind: "no-op" };

    if (view.step === "pick-provider") {
      return this.handlePickProviderInput(data, state, view);
    }
    if (view.step === "pick-model") {
      return this.handlePickModelInput(data, state, view);
    }
    // pick-layer
    return this.handlePickLayerInput(data, state, view);
  }

  private handlePickProviderInput(data: string, state: ConfigTuiState, view: Extract<import("../state/model.js").View, { kind: "persona-editor" }>): InputResult {
    const providers = uniqueProviders(state);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < providers.length - 1) {
        return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      }
      return { kind: "consumed" };
    }
    if (matchesKey(data, Key.enter)) {
      const provider = providers[view.cursor];
      if (provider) return { kind: "dispatch", action: { kind: "set-persona-provider", provider } };
      return { kind: "consumed" };
    }
    // Quick single-letter shortcuts: a=anthropic, o=openai, g=google, l=ollama
    const shortcut = providerShortcut(data, providers);
    if (shortcut) return { kind: "dispatch", action: { kind: "set-persona-provider", provider: shortcut } };
    return { kind: "no-op" };
  }

  private handlePickModelInput(data: string, state: ConfigTuiState, view: Extract<import("../state/model.js").View, { kind: "persona-editor" }>): InputResult {
    const models = state.availableModels.filter((m) => m.provider === view.provider);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < models.length - 1) {
        return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      }
      return { kind: "consumed" };
    }
    if (matchesKey(data, Key.enter)) {
      const target = models[view.cursor];
      if (target) return { kind: "dispatch", action: { kind: "set-persona-model", model: target.id } };
      return { kind: "consumed" };
    }
    return { kind: "no-op" };
  }

  private handlePickLayerInput(data: string, _state: ConfigTuiState, view: Extract<import("../state/model.js").View, { kind: "persona-editor" }>): InputResult {
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      return { kind: "consumed" };
    }
    if (matchesKey(data, "g")) {
      return { kind: "dispatch-seq", actions: [
        { kind: "commit-persona-edit", layer: "global" as ConfigLayer },
      ] };
    }
    if (matchesKey(data, "p")) {
      return { kind: "dispatch-seq", actions: [
        { kind: "commit-persona-edit", layer: "project" as ConfigLayer },
      ] };
    }
    if (matchesKey(data, Key.enter)) {
      const layer: ConfigLayer = view.cursor === 0 ? "project" : "global";
      return { kind: "dispatch-seq", actions: [
        { kind: "commit-persona-edit", layer },
      ] };
    }
    return { kind: "no-op" };
  }
}

function providerShortcut(data: string, providers: string[]): string | null {
  const pairs: Array<[Parameters<typeof matchesKey>[1], string]> = [
    ["a", "anthropic"],
    ["o", "openai"],
    ["g", "google"],
    ["l", "ollama"],
    ["r", "openrouter"],
  ];
  for (const [key, provider] of pairs) {
    if (matchesKey(data, key) && providers.includes(provider)) {
      return provider;
    }
  }
  return null;
}