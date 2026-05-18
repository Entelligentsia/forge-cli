// Overrides-list-pipelines screen — list of pipelines with override counts.
// Phase 2: extracted from component.ts handleOverridesListPipelinesInput + screens.ts renderOverridesListPipelines.

import type { ConfigTuiState } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView, listPipelineOverrideSummaries } from "../state/selectors.js";
import { rule, windowList } from "./shared.js";
import { padRight } from "../theme.js";

export class OverridesListPipelinesScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "overrides-list-pipelines") {
      return ["(renderOverridesListPipelines called with wrong active view)"];
    }
    const summaries = listPipelineOverrideSummaries(state);
    const lines: string[] = [];
    lines.push(`forge config › per-phase overrides`);
    lines.push(rule(width, theme));

    if (summaries.length === 0) {
      lines.push(`  (no pipeline catalogue available)`);
      lines.push(`  esc back`);
      return lines;
    }

    lines.push(`  Pipelines:`);
    const win = windowList(summaries, view.cursor);
    if (win.aboveCount > 0) lines.push(`    ↑ ${win.aboveCount} more above`);
    win.visible.forEach((s, i) => {
      const absoluteIdx = win.start + i;
      const cursor = absoluteIdx === view.cursor ? "▸" : " ";
      const status = s.overrideCount === 0
        ? "none"
        : `${s.overrideCount} override${s.overrideCount === 1 ? "" : "s"}`;
      lines.push(`  ${cursor} ${padRight(s.pipeline, 18)} ${status}`);
    });
    if (win.belowCount > 0) lines.push(`    ↓ ${win.belowCount} more below`);

    lines.push("");
    lines.push(`  enter inspect highlighted pipeline   esc back`);
    if (state.dirty) lines.push(`  * unsaved`);
    return lines;
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