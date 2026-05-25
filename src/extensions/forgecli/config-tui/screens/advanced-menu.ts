// Advanced-menu screen — hub for per-persona / per-step overrides.
// Phase D: routes to existing personas-list and overrides-list-pipelines
// with explanation banners and plain-English headings.
// Reached only from the tier-menu's "Advanced" row — the user has to
// actively opt in to see these.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ConfigTuiState } from "../state/model.js";
import { getActiveView } from "../state/selectors.js";
import { accentBold, cursor, dirtyMarker, muted } from "../theme.js";
import { rule, safeLines } from "./shared.js";
import type { InputResult, Screen } from "./types.js";

/** Interactive row count: 3 items. */
const ITEM_COUNT = 3;

export class AdvancedMenuScreen implements Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[] {
		const view = getActiveView(state);
		if (view.kind !== "advanced-menu") {
			return ["(advanced-menu called with wrong active view)"];
		}
		const cursorIdx = view.cursor;
		const lines: string[] = [];

		// ── Header ─────────────────────────────────────────────────────────
		lines.push(accentBold("forge config › advanced", theme));
		lines.push(rule(width, theme));

		// ── Explanation banner ─────────────────────────────────────────────
		lines.push(muted("Most users don't need these. The three tier knobs above", theme));
		lines.push(muted("cover the 80% path. Use these if you need fine-grained", theme));
		lines.push(muted("control over a specific persona or step.", theme));
		lines.push("");

		// ── Menu items ─────────────────────────────────────────────────────
		const items = ["Override one persona's model", "Override one step's model", "Edit raw persona-models entries"];
		for (let i = 0; i < items.length; i++) {
			const cur = cursor(i === cursorIdx, theme);
			lines.push(`  ${cur} ${items[i]}`);
		}

		lines.push("");
		lines.push(muted("  esc back   q quit", theme));
		if (state.dirty) lines.push(`  ${dirtyMarker(theme)}`);

		return safeLines(lines, width);
	}

	handleInput(data: string, state: ConfigTuiState): InputResult {
		const view = getActiveView(state);
		if (view.kind !== "advanced-menu") return { kind: "no-op" };

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

		// ── Enter: act on current cursor position ─────────────────────────
		if (matchesKey(data, Key.enter)) {
			if (view.cursor === 0) {
				// "Override one persona's model" → personas-list
				return { kind: "dispatch", action: { kind: "push-view", view: { kind: "personas-list", cursor: 0 } } };
			}
			if (view.cursor === 1) {
				// "Override one step's model" → overrides-list-pipelines
				return {
					kind: "dispatch",
					action: { kind: "push-view", view: { kind: "overrides-list-pipelines", cursor: 0 } },
				};
			}
			if (view.cursor === 2) {
				// "Edit raw persona-models entries" → persona-picker
				return { kind: "dispatch", action: { kind: "push-view", view: { kind: "persona-picker", cursor: 0 } } };
			}
		}

		// ── Shortcuts ──────────────────────────────────────────────────────
		if (matchesKey(data, "1"))
			return { kind: "dispatch", action: { kind: "push-view", view: { kind: "personas-list", cursor: 0 } } };
		if (matchesKey(data, "2"))
			return {
				kind: "dispatch",
				action: { kind: "push-view", view: { kind: "overrides-list-pipelines", cursor: 0 } },
			};
		if (matchesKey(data, "3"))
			return { kind: "dispatch", action: { kind: "push-view", view: { kind: "persona-picker", cursor: 0 } } };

		return { kind: "no-op" };
	}
}
