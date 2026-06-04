// Overrides-list-phases screen — phases of a single pipeline with overrides.
// Phase 3: full theming, width safety.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { resolveModelForPhase } from "../../config/model-resolver.js";
import { CANONICAL_PHASES } from "../state/constants.js";
import type { ConfigTuiState } from "../state/model.js";
import { getActiveView, getPhaseOverride } from "../state/selectors.js";
import { accentBold, dirtyMarker, muted, padRight } from "../theme.js";
import { formatOverride, rule, safeLines, windowList } from "./shared.js";
import type { InputResult, Screen } from "./types.js";

export class OverridesListPhasesScreen implements Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[] {
		const view = getActiveView(state);
		if (view.kind !== "overrides-list-phases") {
			return ["(renderOverridesListPhases called with wrong active view)"];
		}
		const lines: string[] = [];
		lines.push(accentBold(`forge config › per-step overrides › ${view.pipeline}`, theme));
		lines.push(rule(width, theme));
		lines.push(muted("  Pipeline phases (canonical order from orchestrator):", theme));
		lines.push("");
		lines.push(
			`    ${muted("#", theme)}  ${muted(padRight("ROLE", 13), theme)} ${muted(padRight("PERSONA", 13), theme)} ${muted(padRight("OVERRIDE", 25), theme)} ${muted(padRight("RESOLVED", 25), theme)} ${muted("SOURCE", theme)}`,
		);

		const win = windowList([...CANONICAL_PHASES], view.cursor, 12);
		if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} row(s) above`, theme));

		win.visible.forEach((phase, i) => {
			const absoluteIdx = win.start + i;
			const cur = absoluteIdx === view.cursor ? theme.fg("accent", "▸") : " ";
			const override = getPhaseOverride(state, view.pipeline, phase.role);
			const overrideStr = padRight(formatOverride(override), 25);
			const result = resolveModelForPhase(view.pipeline, phase.role, phase.personaNoun, {
				...state.buffer.global,
				...state.buffer.project,
				_global: state.buffer.global,
				_project: state.buffer.project,
			});
			const resolved = result.model ? `${result.model.provider}:${result.model.model}` : "(inherit pi current)";
			const resolvedStr = padRight(resolved, 25);
			const idxStr = String(absoluteIdx).padStart(2, " ");
			const roleStr = padRight(phase.role, 13);
			const personaStr = padRight(phase.personaNoun, 13);
			lines.push(`  ${cur} ${idxStr}  ${roleStr} ${personaStr} ${overrideStr} ${resolvedStr} ${result.source}`);
		});

		if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} row(s) below`, theme));
		lines.push("");
		lines.push(muted("  enter edit override   space clear (back to persona)   esc back", theme));
		if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);
		return safeLines(lines, width);
	}

	handleInput(data: string, state: ConfigTuiState): InputResult {
		const view = getActiveView(state);
		if (view.kind !== "overrides-list-phases") return { kind: "no-op" };

		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (view.cursor < CANONICAL_PHASES.length - 1) {
				return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
			}
			return { kind: "consumed" };
		}
		if (matchesKey(data, Key.enter)) {
			const phase = CANONICAL_PHASES[view.cursor];
			if (phase) {
				return {
					kind: "dispatch",
					action: {
						kind: "begin-override-edit",
						pipeline: view.pipeline,
						phaseRole: phase.role,
					},
				};
			}
			return { kind: "consumed" };
		}
		// space → clear override on current row (then persist)
		if (matchesKey(data, Key.space)) {
			const phase = CANONICAL_PHASES[view.cursor];
			if (phase) {
				return {
					kind: "dispatch",
					action: {
						kind: "clear-phase-override",
						pipeline: view.pipeline,
						phaseRole: phase.role,
					},
				};
			}
			return { kind: "consumed" };
		}
		return { kind: "no-op" };
	}
}
