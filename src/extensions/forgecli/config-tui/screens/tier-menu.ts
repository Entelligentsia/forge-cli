// Tier-menu screen — the new landing view for forge:config.
// Phase A: replaces top-menu as the default entry point.
// Shows three workload tiers (Heavy / Standard / Light) as primary CTAs,
// a scope toggle, and secondary navigation to show-resolved / advanced.

import type { ConfigTuiState, View } from "../state/model.js";
import type { ConfigLayer } from "../../config-writer.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, getAllScopedTierAssignments, type ScopedTierAssignment } from "../state/selectors.js";
import { TIERS, TIER_LABELS, TIER_SUB_LABELS, tierPersonaLine } from "../tier-meta.js";
import type { Tier } from "../tier-meta.js";
import { rule, safeLines } from "./shared.js";
import { padRight, cursor, accentBold, accent, muted, warning, error as themedError, dirtyMarker } from "../theme.js";

/** Interactive row count: 3 tiers + show-resolved + advanced = 5. */
const ITEM_COUNT = 5;

export class TierMenuScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "tier-menu") {
      return ["(tier-menu called with wrong active view)"];
    }
    const cursorIdx = view.cursor;
    const lines: string[] = [];

    // ── Header ─────────────────────────────────────────────────────────
    lines.push(accentBold("forge config", theme));
    lines.push(rule(width, theme));

    // ── Config schema error banner (N-B-E, non-blocking) ───────────────
    if (state.configErrors && state.configErrors.length > 0) {
      for (const e of state.configErrors) {
        lines.push(themedError(`  ⚠ Config error   ${e}`, theme));
      }
      lines.push("");
    }

    // ── "Active right now" summary ─────────────────────────────────────
    lines.push(muted("Active right now", theme));
    const scopedAssignments = getAllScopedTierAssignments(state, state.scope);
    for (const { tier, assignment } of scopedAssignments) {
      const label = padRight(TIER_LABELS[tier], 10);
      if (assignment.status === "set") {
        const modelStr = `${assignment.provider}:${assignment.model}`;
        const layerLabel = `(${assignment.layer})`;
        lines.push(`  ${label} ${modelStr}    ${muted(layerLabel, theme)}`);
      } else if (assignment.status === "set-in-other-layer") {
        const otherLabel = assignment.otherLayer === "global" ? "global" : "project";
        const modelStr = `${assignment.provider}:${assignment.model}`;
        lines.push(`  ${label} ${muted(modelStr + " (" + otherLabel + ")", theme)}`);
      } else if (assignment.status === "mixed") {
        lines.push(`  ${label} ${warning("mixed — personas differ", theme)}`);
      } else {
        lines.push(`  ${label} ${muted("not set — falls back to pi current", theme)}`);
      }
    }

    // Scope row
    const scopeLabel = state.scope === "global" ? "global" : `project ( ${state.cwd} )`;
    const altLabel = state.scope === "global" ? "project" : "global";
    lines.push(`  ${padRight("Scope", 10)} ${accent(scopeLabel, theme)}    ${muted(altLabel, theme)}`);

    lines.push("");

    // ── "Choose models for your AI workflow" ────────────────────────────
    lines.push(muted("Choose models for your AI workflow", theme));
    lines.push(rule(width, theme));

    // Tier rows (items 0–2)
    for (let i = 0; i < TIERS.length; i++) {
      const tier = TIERS[i];
      const cur = cursor(i === cursorIdx, theme);
      const label = padRight(TIER_LABELS[tier], 10);
      const subLabel = muted(`(${TIER_SUB_LABELS[tier]})`, theme);
      const tierScoped = scopedAssignments.find((a) => a.tier === tier)!.assignment;
      const valueStr =
        tierScoped.status === "set"
          ? `${tierScoped.provider}:${tierScoped.model}`
          : tierScoped.status === "set-in-other-layer"
            ? muted(`(${tierScoped.otherLayer})`, theme)
            : tierScoped.status === "mixed"
              ? warning("mixed", theme)
              : muted("not set", theme);
      lines.push(`  ${cur} ${label} ${subLabel}  ${valueStr}`);
    }

    // "Show what runs at each step" (item 3)
    {
      const cur = cursor(3 === cursorIdx, theme);
      lines.push(`  ${cur} ${muted("Show what runs at each step", theme)}`);
    }

    // "Advanced — per-persona / per-step overrides" (item 4)
    {
      const cur = cursor(4 === cursorIdx, theme);
      lines.push(`  ${cur} ${muted("Advanced — per-persona / per-step overrides", theme)}`);
    }

    lines.push("");

    // ── Footer ──────────────────────────────────────────────────────────
    const tierWord =
      cursorIdx < 3 ? "enter pick model" : "enter open";
    lines.push(muted(`  ${tierWord}   tab toggle scope   q quit`, theme));
    if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);

    return safeLines(lines, width);
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    if (view.kind !== "tier-menu") return { kind: "no-op" };

    // ── Navigation ──────────────────────────────────────────────────────
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < ITEM_COUNT - 1) {
        return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      }
      return { kind: "consumed" };
    }

    // ── Tab: toggle scope ───────────────────────────────────────────────
    if (matchesKey(data, Key.tab)) {
      return { kind: "dispatch", action: { kind: "toggle-scope" } };
    }

    // ── Enter: act on current cursor position ───────────────────────────
    if (matchesKey(data, Key.enter)) {
      if (view.cursor < 3) {
        // Tier row → open tier picker
        const tier = TIERS[view.cursor]!;
        return { kind: "dispatch", action: { kind: "select-tier", tier } };
      }
      if (view.cursor === 3) {
        // "Show what runs at each step"
        return { kind: "dispatch", action: { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } } };
      }
      if (view.cursor === 4) {
        // "Advanced" → advanced-menu (Phase D)
        return { kind: "dispatch", action: { kind: "push-view", view: { kind: "advanced-menu", cursor: 0 } } };
      }
    }

    // ── Shortcuts: 1/2/3 for tiers, s for show, a for advanced ──────────
    if (matchesKey(data, "1")) return { kind: "dispatch", action: { kind: "select-tier", tier: "heavy" } };
    if (matchesKey(data, "2")) return { kind: "dispatch", action: { kind: "select-tier", tier: "standard" } };
    if (matchesKey(data, "3")) return { kind: "dispatch", action: { kind: "select-tier", tier: "light" } };
    if (matchesKey(data, "s")) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "show-resolved", cursor: 0 } } };
    if (matchesKey(data, "a")) return { kind: "dispatch", action: { kind: "push-view", view: { kind: "advanced-menu", cursor: 0 } } };

    return { kind: "no-op" };
  }
}