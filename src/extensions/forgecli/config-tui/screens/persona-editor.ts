// Persona-editor screen — 3-step wizard (provider → model → layer).
// Phase 3: full theming, width safety.

import type { ConfigTuiState } from "../state/model.js";
import type { ConfigLayer } from "../../config-writer.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, listResolvedPersonas, uniqueProviders } from "../state/selectors.js";
import { rule, authBadgeFor, windowList, safeLines } from "./shared.js";
import { padRight, cursor, accentBold, accent, muted, warning, dirtyMarker } from "../theme.js";

export class PersonaEditorScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "persona-editor") {
      return ["(renderPersonaEditor called with wrong active view)"];
    }
    const lines: string[] = [];
    const inCatalogue = state.personaCatalogue.includes(view.persona) || view.persona === "default";

    lines.push(accentBold(`forge config › personas › ${view.persona}`, theme));
    lines.push(rule(width, theme));

    if (view.step === "pick-provider") {
      lines.push(accent("  Step 1 of 3 — pick provider", theme));
      if (!inCatalogue) {
        lines.push(warning(`  ⚠ '${view.persona}' is not in the Forge persona catalogue.`, theme));
      }
      lines.push("");
      lines.push(`  ${muted(padRight("Provider", 56), theme)}  ${muted("AUTH", theme)}`);
      const providers = uniqueProviders(state);
      const win = windowList(providers, view.cursor);
      if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
      win.visible.forEach((p, i) => {
        const absoluteIdx = win.start + i;
        const cur = cursor(absoluteIdx === view.cursor, theme);
        const auth = authBadgeFor(state, p, theme);
        lines.push(`  ${cur} ${padRight(p, 56)}${auth}`);
      });
      if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));
      lines.push("");
      lines.push(muted("  ↑/↓ select   enter advance   esc back", theme));
    } else if (view.step === "pick-model") {
      lines.push(accent(`  Step 2 of 3 — pick model (provider: ${view.provider ?? "(unknown)"})`, theme));
      lines.push("");
      const models = state.availableModels.filter((m) => m.provider === view.provider);
      if (models.length === 0) {
        lines.push(muted("  No models available for this provider.", theme));
        lines.push(muted(`  (Run \`pi /login ${view.provider}\` then return.)`, theme));
      } else {
        const win = windowList(models, view.cursor);
        if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
        win.visible.forEach((m, i) => {
          const absoluteIdx = win.start + i;
          const cur = cursor(absoluteIdx === view.cursor, theme);
          lines.push(`  ${cur} ${m.id}`);
        });
        if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));
      }
      lines.push("");
      lines.push(muted("  ↑/↓ select   enter advance   esc back", theme));
    } else {
      // pick-layer
      lines.push(accent("  Step 3 of 3 — pick write target", theme));
      lines.push("");
      lines.push(`  ${view.persona} → ${view.provider}:${view.model}`);
      lines.push("");
      const targets = ["project", "global"] as const;
      const targetLabels = [
        `Project   ${state.cwd}/.pi/forge-cli/config.json`,
        `Global    ~/.pi/agent/forge-cli/config.json`,
      ];
      targets.forEach((_, i) => {
        const cur = cursor(i === view.cursor, theme);
        lines.push(`  ${cur} ${targetLabels[i]}`);
      });
      lines.push("");
      lines.push(muted("  ↑/↓ select   enter confirm and write   p/g shortcuts   esc cancel", theme));
    }

    if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);
    return safeLines(lines, width);
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