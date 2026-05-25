// Confirm-quit overlay — renders and handles input for the quit-confirmation dialog.
// Phase 3: themed adaptive-width dialog using DynamicBorder, width safety.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { ConfigTuiState } from "../state/model.js";
import { muted, success, error as themedError } from "../theme.js";
import type { InputResult, Screen } from "./types.js";

export class ConfirmQuitScreen implements Screen {
	render(state: ConfigTuiState, width: number, theme: Theme): string[] {
		if (!state.confirmQuit) return [];

		// Adaptive-width confirm dialog, min 50, max terminal width - 4.
		const dialogWidth = Math.max(50, Math.min(width - 4, 70));

		const lines: string[] = [];
		lines.push("");

		// Themed border top
		lines.push(...new DynamicBorder((s) => theme.fg("borderAccent", s)).render(dialogWidth));

		// Dialog content
		const bgFn = (s: string) => theme.bg("selectedBg", s);

		const contentLines = [
			themedError("  Unsaved changes — discard and quit?", theme),
			"",
			`  ${muted("y / enter", theme)} — ${muted("discard and quit", theme)}`,
			`  ${muted("n / esc", theme)}   — ${muted("cancel (stay in TUI)", theme)}`,
		];

		// Pad content lines to fill dialog width with themed background
		for (const line of contentLines) {
			const padLen = Math.max(0, dialogWidth - line.length);
			lines.push(bgFn(line + " ".repeat(padLen)));
		}

		// Themed border bottom
		lines.push(...new DynamicBorder((s) => theme.fg("borderAccent", s)).render(dialogWidth));

		return lines;
	}

	handleInput(data: string, _state: ConfigTuiState): InputResult {
		if (matchesKey(data, "y") || matchesKey(data, Key.enter)) {
			return { kind: "dispatch", action: { kind: "confirm-quit", discard: true } };
		}
		if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
			return { kind: "dispatch", action: { kind: "confirm-quit", discard: false } };
		}
		return { kind: "no-op" };
	}
}

/** Render the save banner (non-interactive decoration). Kept as a plain function
 *  since it has no input handling — the orchestrator appends it after the active
 *  screen's render output. */
export function renderSaveBanner(state: ConfigTuiState, _width: number, theme: Theme): string[] {
	if (!state.lastSaved) return [];
	return ["", success(`  ✓ Saved → ${state.lastSaved.target}  (${state.lastSaved.layer})`, theme)];
}
