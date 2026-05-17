// viewport-theme.ts
//
// Paints subagent-tail lines using pi's Theme. The tail buffer (see
// viewport-renderer.ts) stores plain strings so transcripts and audit logs
// stay ANSI-clean; this module is the single place that maps line categories
// to theme colors at render time.
//
// Why parse at render time rather than colour at emit time:
//   1. Theme may change after a line is emitted (user toggles theme).
//   2. The tail buffer doubles as a fall-back trace; ANSI escapes there would
//      bleed into any plaintext consumer (clipboard, transcript debugging).
//   3. Run-task.ts has no direct theme access — it runs as a command handler;
//      Theme lives in the TUI widget callback. Painting at render keeps the
//      emit path theme-agnostic and testable in isolation.
//
// Mapping (single source of truth for line category → ThemeColor):
//
//   prefix `[role HH:MM:SS …]`  → dim
//   `$ bash …`                   → bashMode (glyph) + text (rest)
//   `⌕ read/grep/glob …`         → accent (glyph)
//   `✎ write/edit …`             → warning (glyph)  -- mutation
//   `⚙ store-cli …`              → toolTitle (glyph)
//   `→ …`  fallback              → muted (glyph)
//   `← tool ok 247L`             → success (glyph + "ok N L")
//   `⚠ tool failed: …`           → error
//   `🔒 …`                       → error bold (glyph)
//   `✱ thinking line`            → thinkingText italic
//   `» "preview"`                → muted italic
//   `⇉ batched N`                → dim
//   `▣ summary`                  → accent bold
//   `─── phase X/Y …`            → accent bold

import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Parse one tail line into prefix + body, then colour both halves.
 * Returns the line unchanged if no theme is available.
 */
export function paintTailLine(line: string, theme: Theme | undefined): string {
	if (!theme) return line;

	// Prefix: `[role HH:MM:SS t<turn> ↑X↓Y]` — everything up to the first `]`.
	const closeIdx = line.indexOf("]");
	if (closeIdx === -1) {
		// No structured prefix — phase begin lines like `─── phase … ───`
		// still get themed via body matcher.
		return paintBody(line, theme);
	}

	const prefix = line.slice(0, closeIdx + 1);
	const body = line.slice(closeIdx + 1);

	const paintedPrefix = theme.fg("dim", prefix);
	const paintedBody = paintBody(body, theme);
	return `${paintedPrefix}${paintedBody}`;
}

function paintBody(body: string, theme: Theme): string {
	// Body always starts with whitespace + glyph + payload, except phase-boundary
	// lines which start with `─`. Find the first non-space char to classify.
	const trimmed = body.replace(/^\s+/, "");
	if (trimmed.length === 0) return body;
	const leadingWs = body.slice(0, body.length - trimmed.length);
	// Use codePointAt so non-BMP emoji like 🔒 (U+1F512, surrogate pair in
	// UTF-16) match correctly. `trimmed[0]` returns only the high surrogate.
	const cp = trimmed.codePointAt(0);
	const first = cp !== undefined ? String.fromCodePoint(cp) : "";

	switch (first) {
		case "$": // bash
			return `${leadingWs}${theme.fg("bashMode", "$")}${trimmed.slice(1)}`;
		case "⌕": // read/grep/glob
			return `${leadingWs}${theme.fg("accent", "⌕")}${trimmed.slice(1)}`;
		case "✎": // write/edit
			return `${leadingWs}${theme.fg("warning", "✎")}${trimmed.slice(1)}`;
		case "⚙": // store-cli
			return `${leadingWs}${theme.fg("toolTitle", "⚙")}${trimmed.slice(1)}`;
		case "→": // fallback tool
			return `${leadingWs}${theme.fg("muted", "→")}${trimmed.slice(1)}`;
		case "←": // tool result OK
			return `${leadingWs}${theme.fg("success", trimmed)}`;
		case "⚠": // tool failed
			return `${leadingWs}${theme.fg("error", trimmed)}`;
		case "🔒": // risky bash
			return `${leadingWs}${theme.bold(theme.fg("error", trimmed))}`;
		case "✱": // thinking
			return `${leadingWs}${theme.italic(theme.fg("thinkingText", trimmed))}`;
		case "»": // model preview text
			return `${leadingWs}${theme.italic(theme.fg("muted", trimmed))}`;
		case "⇉": // batched
			return `${leadingWs}${theme.fg("dim", trimmed)}`;
		case "▣": // phase summary
			return `${leadingWs}${theme.bold(theme.fg("accent", trimmed))}`;
		case "─": // phase boundary line `─── phase X/Y begin · taskId ───`
			return `${leadingWs}${theme.bold(theme.fg("accent", trimmed))}`;
		case "↻": // auto retry
			return `${leadingWs}${theme.fg("warning", trimmed)}`;
		case "◌": // compaction
			return `${leadingWs}${theme.fg("muted", trimmed)}`;
		default:
			return body;
	}
}
