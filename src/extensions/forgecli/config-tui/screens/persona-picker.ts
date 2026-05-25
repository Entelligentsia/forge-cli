// Persona-picker screen — renders and handles input for the "pick which persona" view.
// Phase 3: full theming, width safety.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ConfigTuiState } from "../state/model.js";
import { getActiveView, listPersonaPickerEntries } from "../state/selectors.js";
import { accentBold, cursor, muted, padRight } from "../theme.js";
import { rule, safeLines, windowList } from "./shared.js";
import type { InputResult, Screen } from "./types.js";

export class PersonaPickerScreen implements Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[] {
		const view = getActiveView(state);
		if (view.kind !== "persona-picker") {
			return ["(renderPersonaPicker called with wrong active view)"];
		}
		const entries = listPersonaPickerEntries(state);
		const lines: string[] = [];
		lines.push(accentBold("forge config › personas › pick which", theme));
		lines.push(rule(width, theme));
		lines.push(muted("  Pick a persona to assign a model to:", theme));
		lines.push("");

		const nameCol = Math.max(9, ...entries.map((e) => e.persona.length));
		const win = windowList(entries, view.cursor, 12);
		if (win.aboveCount > 0) lines.push(muted(`    ↑ ${win.aboveCount} more above`, theme));
		win.visible.forEach((entry, i) => {
			const absoluteIdx = win.start + i;
			const cur = cursor(absoluteIdx === view.cursor, theme);
			let status: string;
			if (entry.assignment) {
				const layer = entry.assignment.source.endsWith("L2") ? "project" : "global";
				status = muted(`currently: ${entry.assignment.provider}:${entry.assignment.model} (${layer})`, theme);
			} else if (entry.persona === "default") {
				status = muted("fallback for every persona", theme);
			} else {
				status = muted("currently: inherit", theme);
			}
			const cat = entry.inCatalogue ? " " : theme.fg("warning", "⚠");
			lines.push(`  ${cur} ${cat} ${padRight(entry.persona, nameCol)}  ${status}`);
		});
		if (win.belowCount > 0) lines.push(muted(`    ↓ ${win.belowCount} more below`, theme));
		lines.push("");
		lines.push(muted("  ↑/↓ select   enter open editor   esc back", theme));
		return safeLines(lines, width);
	}

	handleInput(data: string, state: ConfigTuiState): InputResult {
		const view = getActiveView(state);
		if (view.kind !== "persona-picker") return { kind: "no-op" };

		const entries = listPersonaPickerEntries(state);
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			return { kind: "dispatch", action: { kind: "cursor-move", delta: -1 } };
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			if (view.cursor < entries.length - 1) return { kind: "dispatch", action: { kind: "cursor-move", delta: 1 } };
			return { kind: "consumed" };
		}
		if (matchesKey(data, Key.enter)) {
			const target = entries[view.cursor];
			if (target) {
				// Pop the picker and push the editor in one render cycle.
				return {
					kind: "dispatch-seq",
					actions: [{ kind: "pop-view" }, { kind: "begin-persona-edit", persona: target.persona }],
				};
			}
			return { kind: "consumed" };
		}
		return { kind: "no-op" };
	}
}
