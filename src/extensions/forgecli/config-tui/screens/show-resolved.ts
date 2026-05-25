// Show-resolved screen — "Show what runs at each step" (Screen 3).
// Phase C: rewritten to the phase-table format with emoji + persona names +
// plain-English tier-source labels + cascade footer.
// No more L1/L2 badges, no more "cascade" jargon.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { resolveModelForPhase } from "../../model-resolver.js";
import type { ConfigTuiState } from "../state/model.js";
import { getActiveView, getPhaseTable, type PhaseTableRow } from "../state/selectors.js";
import { accentBold, cursor, muted, padRight } from "../theme.js";
import { PHASE_PERSONA_TABLE } from "../tier-meta.js";
import { cascadeFooter, rule, safeLines, windowList } from "./shared.js";
import type { InputResult, Screen } from "./types.js";

// Keep computeResolvedRows for backward compat (barrel re-export).
export interface ResolvedRow {
	index: number;
	role: string;
	persona: string;
	resolved: string;
	source: string;
	available: boolean;
}

/**
 * Legacy compute helper — kept for backward compatibility in barrel re-export.
 * Prefer getPhaseTable() for new code.
 */
export function computeResolvedRows(state: ConfigTuiState): Array<{ pipeline: string; rows: ResolvedRow[] }> {
	const pipelineNames: string[] = state.pipelineCatalogue ? state.pipelineCatalogue : ["default"];
	return pipelineNames.map((pipeline) => ({
		pipeline,
		rows: PHASE_PERSONA_TABLE.map((phase, i) => {
			const result = resolveModelForPhase(pipeline, phase.role, phase.personaNoun, {
				...state.buffer.global,
				...state.buffer.project,
				_global: state.buffer.global,
				_project: state.buffer.project,
			});
			const resolved = result.model ? `${result.model.provider}:${result.model.model}` : "(inherit pi current)";
			const available = result.model
				? state.availableModels.some((m) => m.provider === result.model!.provider && m.id === result.model!.model)
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

/**
 * Build a single table row with ANSI-safe column truncation.
 * Each column value is padded or truncated to its allocated visible width.
 * Truncated values have their trailing ANSI resets stripped (truncateToWidth
 * appends \\x1b[0m to close styles; since we control the content, this is
 * safe to strip).
 */
function buildRow(parts: Array<{ text: string; width: number }>): string {
	return parts
		.map(({ text, width }) => {
			const vis = visibleWidth(text);
			if (vis > width) {
				// Truncate and strip trailing ANSI reset that truncateToWidth adds
				const raw = truncateToWidth(text, width, "");
				return raw.replace(/\x1b\[0m$/, "");
			}
			// Pad with spaces to hit the target visible width
			return text + " ".repeat(width - vis);
		})
		.join(" ");
}

export class ShowResolvedScreen implements Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[] {
		const view = getActiveView(state);
		if (view.kind !== "show-resolved") {
			return ["(show-resolved called with wrong active view)"];
		}
		const lines: string[] = [];

		// ── Column sizing ──────────────────────────────────────────────────
		// Reserve enough room for source labels. Longest: "Falls back to pi current" = 24.
		const minSource = 24;
		const leading = 4; // "  {cursor} "
		const gap = 3; // 3 single-space gaps between 4 columns
		// stepCol: longest step is "review-plan"/"review-code" = 11 vis
		// Use 11 so model gets more room, and step names fit exactly.
		const stepCol = 11;
		// personaCol: emoji(2 vis) + space + name; names up to ~12 chars
		// padOrTruncate handles overflow gracefully.
		const personaCol = 14;
		// modelCol: flexible; long models get truncated with visible ellipsis
		const modelCol = Math.max(16, width - leading - gap - stepCol - personaCol - minSource);

		// ── Title ───────────────────────────────────────────────────────────
		lines.push(accentBold("forge config › current setup", theme));
		lines.push(rule(width, theme));

		// ── Column headers ─────────────────────────────────────────────────
		lines.push(
			`  ${muted(padRight("Step", stepCol), theme)} ${muted(padRight("Persona", personaCol), theme)} ${muted(padRight("Model", modelCol), theme)} ${muted("Source", theme)}`,
		);

		// ── Phase rows ─────────────────────────────────────────────────────
		const rows = getPhaseTable(state);
		const win = windowList(rows, view.cursor, 10);

		if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} row(s) above`, theme));

		for (let i = 0; i < win.visible.length; i++) {
			const row = win.visible[i];
			const absoluteIdx = win.start + i;
			const cur = cursor(absoluteIdx === view.cursor, theme);

			const rowStr = buildRow([
				{ text: row.role, width: stepCol },
				{ text: `${row.personaEmoji} ${row.persona}`, width: personaCol },
				{ text: row.resolved, width: modelCol },
				// Source column is the last column — no fixed width needed
			]);

			lines.push(`  ${cur} ${rowStr} ${row.sourceLabel}`);
		}

		if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} row(s) below`, theme));

		// ── Cascade footer ─────────────────────────────────────────────────
		lines.push(...cascadeFooter(width, theme));

		// ── Navigation ─────────────────────────────────────────────────────
		lines.push("");
		lines.push(muted(`  ↑/↓ scroll   esc back   q quit`, theme));

		return safeLines(lines, width);
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
