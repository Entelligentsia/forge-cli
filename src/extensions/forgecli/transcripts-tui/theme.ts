// Transcripts-TUI theme helpers — wraps pi Theme for consistent styling.
//
// Local copies of the handful of helpers this TUI needs (config-tui keeps
// its own set; copying ~6 trivial theme-only helpers avoids cross-TUI
// coupling — see forge-cli-ui-engineer skill, module layout).
//
// Every render function receives a Theme instance and routes all visible
// text through these helpers or theme.fg/bg/bold directly (Iron Law 1).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type { Theme };

/** Horizontal rule spanning the full width, themed as a border. */
export function rule(width: number, theme: Theme): string {
	return theme.fg("border", "─".repeat(Math.max(1, width)));
}

export function cursor(isSelected: boolean, theme: Theme): string {
	return isSelected ? theme.fg("accent", "▸") : " ";
}

export function muted(text: string, theme: Theme): string {
	return theme.fg("muted", text);
}

export function accent(text: string, theme: Theme): string {
	return theme.fg("accent", text);
}

export function accentBold(text: string, theme: Theme): string {
	return theme.fg("accent", theme.bold(text));
}

/**
 * Truncate a potentially-ANSI string to a visible width, padding with
 * spaces if shorter. ANSI-safe column alignment (Iron Law 10).
 */
export function padOrTruncate(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - vis);
}

/**
 * Truncate every line to the given visible width. Final safety guard in
 * every screen's render (Iron Law 2, layer 1).
 */
export function truncateLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width, ""));
}

/** Alias matching the config-tui screens/shared.ts vocabulary. */
export function safeLines(lines: string[], width: number): string[] {
	return truncateLines(lines, width);
}
