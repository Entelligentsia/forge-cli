// Show-resolved screen — read-only resolved routing table (per pipeline, per phase).
// Phase 2: extracted from component.ts handleShowResolvedInput + screens.ts renderShowResolved.

import type { ConfigTuiState } from "../state/model.js";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { InputResult, Screen } from "./types.js";
import { getActiveView } from "../state/selectors.js";
import { CANONICAL_PHASES } from "../state/constants.js";
import { resolveModelForPhase } from "../../model-resolver.js";
import { rule, windowList } from "./shared.js";
import { padRight } from "../theme.js";

export interface ResolvedRow {
  index: number;
  role: string;
  persona: string;
  resolved: string;
  source: string;
  available: boolean;
}

/**
 * Pure compute helper: walk every pipeline × phase, resolve via
 * resolveModelForPhase, and return rows for rendering or JSON export.
 */
export function computeResolvedRows(
  state: ConfigTuiState,
): Array<{ pipeline: string; rows: ResolvedRow[] }> {
  const pipelineNames: string[] = state.pipelineCatalogue
    ? state.pipelineCatalogue
    : ["default"];
  return pipelineNames.map((pipeline) => ({
    pipeline,
    rows: CANONICAL_PHASES.map((phase, i) => {
      const result = resolveModelForPhase(pipeline, phase.role, phase.personaNoun, {
        ...state.buffer.global,
        ...state.buffer.project,
        _global: state.buffer.global,
        _project: state.buffer.project,
      });
      const resolved = result.model
        ? `${result.model.provider}:${result.model.model}`
        : "(inherit pi current)";
      const available = result.model
        ? state.availableModels.some(
            (m) => m.provider === result.model!.provider && m.id === result.model!.model,
          )
        : true;
      return {
        index: i,
        role: phase.role,
        persona: phase.personaNoun,
        resolved,
        source: result.source,
        available,
      };
    }),
  }));
}

export class ShowResolvedScreen implements Screen {
  render(state: ConfigTuiState, width: number, theme: Theme): string[] {
    const view = getActiveView(state);
    if (view.kind !== "show-resolved") {
      return ["(renderShowResolved called with wrong active view)"];
    }
    const lines: string[] = [];
    lines.push(`forge config › resolved`);
    lines.push(rule(width, theme));

    // Layer files: presence at L1/L2 paths.
    lines.push(`  Layer files:`);
    const globalExists =
      state.buffer.global["persona-models"] && Object.keys(state.buffer.global["persona-models"]).length > 0;
    const projectExists =
      state.buffer.project["persona-models"] && Object.keys(state.buffer.project["persona-models"]).length > 0;
    lines.push(`    L1  ~/.pi/agent/forge-cli/config.json                  ${globalExists ? "exists" : "absent"}`);
    lines.push(`    L2  ${state.cwd}/.pi/forge-cli/config.json    ${projectExists ? "exists" : "absent"}`);
    lines.push("");

    if (state.pipelineCatalogue === null) {
      lines.push(`  No pipeline catalogue (forge-cli outside a Forge project).`);
      lines.push(`  Default pipeline shown below (canonical 8-phase chain).`);
      lines.push("");
    }

    const allRows = computeResolvedRows(state);
    const totalRows = allRows.reduce((acc, p) => acc + p.rows.length, 0);
    const flat: Array<{ pipeline: string; row: ResolvedRow }> = [];
    for (const p of allRows) for (const r of p.rows) flat.push({ pipeline: p.pipeline, row: r });

    const win = windowList(flat, view.cursor, 12);
    if (win.aboveCount > 0) lines.push(`    ↑ ${win.aboveCount} row(s) above`);

    let currentPipeline = "";
    for (let i = 0; i < win.visible.length; i++) {
      const item = win.visible[i];
      const absoluteIdx = win.start + i;
      const cursor = absoluteIdx === view.cursor ? "▸" : " ";
      if (item.pipeline !== currentPipeline) {
        currentPipeline = item.pipeline;
        const totalPipelinePhases = allRows.find((p) => p.pipeline === item.pipeline)?.rows.length ?? 0;
        lines.push("");
        lines.push(`  Pipeline: ${item.pipeline}  (${totalPipelinePhases} phases)`);
        lines.push(`    #  ROLE          PERSONA       RESOLVED                        SOURCE     AVAIL`);
      }
      const r = item.row;
      const idxStr = String(r.index).padStart(2, " ");
      const roleStr = padRight(r.role, 13);
      const personaStr = padRight(r.persona, 13);
      const resolvedStr = padRight(r.resolved, 31);
      const sourceStr = padRight(r.source, 10);
      const avail = r.available ? "✓" : "✗";
      lines.push(`  ${cursor} ${idxStr}  ${roleStr} ${personaStr} ${resolvedStr} ${sourceStr} ${avail}`);
    }

    if (win.belowCount > 0) lines.push(`    ↓ ${win.belowCount} row(s) below`);
    lines.push("");
    lines.push(`  ↑/↓ scroll   esc back   q quit   (total rows: ${totalRows})`);
    return lines;
  }

  handleInput(data: string, state: ConfigTuiState): InputResult {
    const view = getActiveView(state);
    if (view.kind !== "show-resolved") return { kind: "no-op" };

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
    }
    return { kind: "no-op" };
  }
}