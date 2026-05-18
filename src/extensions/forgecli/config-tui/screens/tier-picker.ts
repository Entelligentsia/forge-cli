// Tier-picker screen — provider + model picker for a workload tier.
// Phase A: minimal placeholder. Phase B adds full provider/model picking flow.
// Reuses the same UX patterns as persona-editor but scoped to a tier.

import type { ConfigTuiState } from "../state/model.js";
import type { ConfigLayer } from "../../config-writer.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, uniqueProviders } from "../state/selectors.js";
import { TIER_LABELS, TIER_SUB_LABELS, tierPersonaLine } from "../tier-meta.js";
import type { Tier } from "../tier-meta.js";
import { rule, authBadgeFor, windowList, safeLines } from "./shared.js";
import { padRight, cursor, accentBold, accent, muted, warning, dirtyMarker } from "../theme.js";

export class TierPickerScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "tier-picker") {
      return ["(tier-picker called with wrong active view)"];
    }
    const tierLabel = TIER_LABELS[view.tier];
    const lines: string[] = [];

    if (view.step === "pick-provider") {
      lines.push(accentBold(`forge config › ${tierLabel} › pick provider`, theme));
      lines.push(rule(width, theme));
      lines.push(muted(`  This will run for: ${tierPersonaLine(view.tier)}`, theme));
      lines.push("");

      const providers = uniqueProviders(state);
      const win = windowList(providers, view.cursor);
      if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
      win.visible.forEach((p, i) => {
        const absoluteIdx = win.start + i;
        const cur = cursor(absoluteIdx === view.cursor, theme);
        const auth = authBadgeFor(state, p, theme);
        const modelCount = state.availableModels.filter((m) => m.provider === p).length;
        const countLabel = `${modelCount} model${modelCount === 1 ? "" : "s"}`;
        lines.push(`  ${cur} ${padRight(p, 18)} ${auth}   ${muted(countLabel, theme)}`);
      });
      if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));
      lines.push("");
      lines.push(muted("  ↑↓ select   enter advance   esc back", theme));
    } else if (view.step === "pick-model") {
      lines.push(accentBold(`forge config › ${tierLabel} › pick model`, theme));
      lines.push(rule(width, theme));
      lines.push(muted(`  provider: ${view.provider ?? "(unknown)"}`, theme));
      lines.push(muted(`  This will run for: ${tierPersonaLine(view.tier)}`, theme));
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
      lines.push(muted("  ↑↓ select   enter save   esc back", theme));
    }

    if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);
    return safeLines(lines, width);
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    if (view.kind !== "tier-picker") return { kind: "no-op" };

    if (view.step === "pick-provider") {
      return this.handlePickProviderInput(data, state, view);
    }
    if (view.step === "pick-model") {
      return this.handlePickModelInput(data, state, view);
    }
    return { kind: "no-op" };
  }

  private handlePickProviderInput(
    data: string,
    state: ConfigTuiState,
    view: Extract<import("../state/model.js").View, { kind: "tier-picker" }>,
  ): InputResult {
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
      if (provider) {
        return { kind: "dispatch", action: { kind: "set-tier-provider", tier: view.tier, provider } };
      }
      return { kind: "consumed" };
    }
    return { kind: "no-op" };
  }

  private handlePickModelInput(
    data: string,
    state: ConfigTuiState,
    view: Extract<import("../state/model.js").View, { kind: "tier-picker" }>,
  ): InputResult {
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
      if (target && view.provider) {
        return { kind: "dispatch", action: { kind: "commit-tier-model", tier: view.tier, provider: view.provider, model: target.id, layer: state.scope } };
      }
      return { kind: "consumed" };
    }
    return { kind: "no-op" };
  }
}