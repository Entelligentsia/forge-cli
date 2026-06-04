// dashboard/theme.ts — Themed helpers for the dashboard overlay.
//
// Every visible string in the dashboard routes through these helpers or
// through theme.fg()/bg()/bold() directly. No raw glyphs or colour strings
// should appear in component render methods.

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { NodeStatus } from "../orchestrator-tree.js";
import { truncateToWidth } from "@earendil-works/pi-tui";

export type { Theme };

// ── Inline style helpers ────────────────────────────────────────────────────

export function dim(text: string, theme: Theme): string {
	return theme.fg("dim", text);
}

export function accent(text: string, theme: Theme): string {
	return theme.fg("accent", text);
}

export function accentBold(text: string, theme: Theme): string {
	return theme.fg("accent", theme.bold(text));
}

export function warn(text: string, theme: Theme): string {
	return theme.fg("warning", text);
}

export function bold(text: string, theme: Theme): string {
	return theme.bold(text);
}

/** Border characters — themed. */
export function border(text: string, theme: Theme): string {
	return theme.fg("border", text);
}

// ── Themed glyphs ────────────────────────────────────────────────────────────

/** Cursor glyph — accent-coloured arrow when selected, space otherwise. */
export function cursor(isSelected: boolean, theme: Theme): string {
	return isSelected ? theme.fg("accent", "❯") : " ";
}

/** Collapse indicator for orchestrator nodes (▸). */
export function collapseIndicator(theme: Theme): string {
	return theme.fg("muted", "▸");
}

/** Prompt expand/collapse chevron. */
export function promptExpandIcon(isExpanded: boolean, theme: Theme): string {
	return isExpanded ? theme.fg("muted", "▼") : theme.fg("muted", "▶");
}

/** Status glyph for a node — themed per status colour. */
export function nodeGlyph(status: NodeStatus, theme: Theme): string {
	switch (status) {
		case "completed":
			return theme.fg("success", "✔");
		case "running":
			return theme.fg("accent", "●");
		case "cancelling":
			return theme.fg("warning", "⏳");
		case "cancelled":
			return theme.fg("muted", "⊘");
		case "failed":
			return theme.fg("error", "✗");
		case "escalated":
			return theme.fg("error", "▲");
		case "pending":
		default:
			return theme.fg("dim", "○");
	}
}

/** Human-readable status label. */
export function statusLabel(status: NodeStatus): string {
	switch (status) {
		case "completed":
			return "Completed";
		case "running":
			return "Running";
		case "cancelling":
			return "Cancelling…";
		case "cancelled":
			return "Cancelled";
		case "failed":
			return "Failed";
		case "escalated":
			return "Escalated";
		case "pending":
			return "Pending";
	}
}

/** Cancel-confirmation prompt warning glyph. */
export function cancelWarningGlyph(theme: Theme): string {
	return theme.fg("warning", "⚠");
}

// ── Width safety (ANSI-aware) ────────────────────────────────────────────────

/**
 * Truncate every line to the given visible width. Applied as a final
 * safety guard in every screen renderer so no line overflows the terminal.
 */
export function truncateLines(lines: string[], width: number): string[] {
	return lines.map((line) => truncateToWidth(line, width, ""));
}

