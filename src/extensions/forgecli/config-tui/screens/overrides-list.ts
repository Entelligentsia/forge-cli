// Overrides-list-pipelines screen — list of pipelines with override counts.
// Phase 3: full theming, width safety.

import type { ConfigTuiState } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, listPipelineOverrideSummaries } from "../state/selectors.js";
import { rule, windowList, safeLines } from "./shared.js";
import { padRight, accentBold, muted, dirtyMarker } from "../theme.js";

export class OverridesListPipelinesScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "overrides-list-pipelines") {
      return ["(renderOverridesListPipelines called with wrong active view)"];
    }
    const summaries = listPipelineOverrideSummaries(state);
    const lines: string[] = [];
    lines.push(accentBold("forge config › per-phase overrides", theme));
    lines.push(rule(width, theme));

    if (summaries.length === 0) {
      lines.push(muted("  (no pipeline catalogue available)", theme));
      lines.push(muted("  esc back", theme));
      return safeLines(lines, width);
    }

    lines.push(muted("  Pipelines:", theme));
    const win = windowList(summaries, view.cursor);
    if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
    win.visible.forEach((s, i) => {
      const absoluteIdx = win.start + i;
      const cur = absoluteIdx === view.cursor ? theme.fg("accent", "▸") : " ";
      const status = s.overrideCount === 0
        ? muted("none", theme)
        : accentBold(`${s.overrideCount} override${s.overrideCount === 1 ? "" : "s"}`, theme);
      lines.push(`  ${cur} ${padRight(s.pipeline, 18)} ${status}`);
    });
    if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));

    lines.push("");
    lines.push(muted("  enter inspect highlighted pipeline   esc back", theme));
    if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);
    return safeLines(lines, width);
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    if (view.kind !== "overrides-list-pipelines") return { kind: "no-op" };

    const summaries = listPipelineOverrideSummaries(state);
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      if (view.cursor < summaries.length - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
      return { kind: "consumed" };
    }
    if (matchesKey(data, Key.enter)) {
      const target = summaries[view.cursor];
      if (target) {
        return { kind: "dispatch", action: {
          kind: "push-view",
          view: { kind: "overrides-list-phases", pipeline: target.pipeline, cursor: 0 },
        } };
      }
      return { kind: "consumed" };
    }
    return { kind: "no-op" };
  }
}