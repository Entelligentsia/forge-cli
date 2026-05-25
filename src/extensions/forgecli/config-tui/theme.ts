// Config-TUI theme helpers — wraps pi Theme for consistent styling.
//
// Every render function receives a Theme instance and uses these helpers
// (or calls theme.fg/bg/bg directly) for all visible text. No raw string
// styling should appear in screen renderers — route everything through
// here or through theme methods so theme changes propagate globally.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type { Theme };

// ── Structural helpers ──────────────────────────────────────────────────────

/** Horizontal rule spanning the full width, themed as a border. */
export function rule(width: number, theme: Theme): string {
	return theme.fg("border", "─".repeat(Math.max(1, width)));
}

/** Breadcrumb: "forge config › personas › pick which". */
export function breadcrumb(parts: string[], width: number, theme: Theme): string {
	const raw = parts.join(" › ");
	const truncated = truncateToWidth(raw, width, "");
	return theme.fg("accent", theme.bold(truncated));
}

// ── Inline style helpers ────────────────────────────────────────────────────

export function cursor(isSelected: boolean, theme: Theme): string {
	return isSelected ? theme.fg("accent", "▸") : " ";
}

export function authBadge(ok: boolean, theme: Theme): string {
	return ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
}

export function warning(text: string, theme: Theme): string {
	return theme.fg("warning", text);
}

export function muted(text: string, theme: Theme): string {
	return theme.fg("muted", text);
}

export function dim(text: string, theme: Theme): string {
	return theme.fg("dim", text);
}

export function accent(text: string, theme: Theme): string {
	return theme.fg("accent", text);
}

export function accentBold(text: string, theme: Theme): string {
	return theme.fg("accent", theme.bold(text));
}

export function error(text: string, theme: Theme): string {
	return theme.fg("error", text);
}

export function success(text: string, theme: Theme): string {
	return theme.fg("success", text);
}

/** Mark an unsaved-change indicator — themed as warning. */
export function dirtyMarker(theme: Theme): string {
	return theme.fg("warning", "* unsaved");
}

/** Tier badge — displays Heavy / Standard / Light in accent color. */
export function tierBadge(tier: "heavy" | "standard" | "light", theme: Theme): string {
	const labels: Record<string, string> = { heavy: "Heavy", standard: "Standard", light: "Light" };
	return theme.fg("accent", labels[tier] ?? tier);
}

// ── Padding (ANSI-aware) ────────────────────────────────────────────────────

/**
 * Right-pad a string that may contain ANSI escape codes to a given visible width.
 * Uses visibleWidth so ANSI codes don't inflate the padding.
 * Does NOT truncate — allows over-wide columns. Width-safety truncation
 * is applied at the line level by truncateLines() / safeLines().
 */
export function padRight(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return text;
	return text + " ".repeat(width - vis);
}

/**
 * Truncate a potentially-ANSI string to a visible width, padding with spaces
 * if shorter. This replaces the old padRight for column-aligned output and
 * is safe for themed text.
 */
export function padOrTruncate(text: string, width: number): string {
	const vis = visibleWidth(text);
	if (vis >= width) return truncateToWidth(text, width, "");
	return text + " ".repeat(width - vis);
}

// ── Width safety ─────────────────────────────────────────────────────────────

/**
 * Truncate every line to the given visible width. Applied as a final safety
 * guard in every screen's render method so no line overflows the terminal.
 */
export function truncateLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width, ""));
}
