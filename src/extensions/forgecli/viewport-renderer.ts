// viewport-renderer.ts
//
// Pure-string helpers for the subagent viewport tail buffer.
// Centralises glyph selection, arg/result shape extraction, thinking one-liners,
// and running-usage formatting so run-task / run-sprint / fix-bug can share
// rendering without diverging.

import path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Per-tool glyph. Falls back to a generic arrow when unknown. */
const TOOL_GLYPHS: Record<string, string> = {
	bash: "$",
	read: "⌕",
	write: "✎",
	edit: "✎",
	glob: "⌕",
	grep: "⌕",
	notebookedit: "✎",
};

/** Bash patterns we want users to see flagged even when auto-approved. */
const RISKY_BASH = /\b(rm\s+-rf|git\s+push\s+--force|chmod\s+777|sudo\s|curl\s+[^|]*\|\s*sh\b|npm\s+publish\b)/;

export const RISKY_TAG = "🔒";

export interface GlyphInfo {
	glyph: string;
	risky: boolean;
}

export function toolGlyph(toolName: string, args: unknown): GlyphInfo {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const lower = toolName.toLowerCase();
	let glyph = TOOL_GLYPHS[lower];
	if (!glyph) {
		if (/store[-_]?cli|forge[-_]?store/i.test(toolName)) glyph = "⚙";
		else glyph = "→";
	}
	let risky = false;
	if (lower === "bash" && typeof a.command === "string" && RISKY_BASH.test(a.command)) {
		risky = true;
	}
	return { glyph, risky };
}

export function argHint(toolName: string, args: unknown, maxLen = 60): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const fp = (a.file_path ?? a.path) as unknown;
	if (typeof fp === "string") return path.basename(fp);
	if (typeof a.command === "string") return truncateAtBoundary(a.command, maxLen);
	if (typeof a.pattern === "string") return truncateAtBoundary(a.pattern, maxLen);
	if (typeof a.query === "string") return truncateAtBoundary(a.query, maxLen);
	return "";
}

/**
 * Truncate at a whitespace boundary when possible so we don't slice mid-token
 * (e.g. `FORGE_ROOT=$(node -e` cut at the open paren). Appends `…(+Nc)` so the
 * user knows there's more.
 */
export function truncateAtBoundary(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = s.slice(0, max);
	const lastSpace = head.lastIndexOf(" ");
	const cut = lastSpace > Math.floor(max * 0.6) ? lastSpace : max;
	const extra = s.length - cut;
	// Strip trailing whitespace before the ellipsis so the body is visually
	// clean and downstream string checks (`endsWith` / regex) behave predictably.
	return `${s.slice(0, cut).replace(/\s+$/, "")}…(+${extra}c)`;
}

/**
 * Extract a small "shape" hint from a tool result so users see `read ok 247L`
 * instead of `read ok`. Defensive: result shapes vary across tools and providers.
 */
export function resultShape(_toolName: string, result: unknown): string {
	try {
		if (typeof result === "string") {
			if (result.length === 0) return "empty";
			const lines = result.split(/\r?\n/).length;
			return lines > 1 ? `${lines}L` : `${result.length}c`;
		}
		if (result && typeof result === "object") {
			const r = result as Record<string, unknown>;
			if (typeof r.stdout === "string") {
				const out = r.stdout;
				if (out.length === 0) return "empty";
				const lines = out.split(/\r?\n/).length;
				return `${lines}L`;
			}
			if (typeof r.content === "string") {
				const lines = r.content.split(/\r?\n/).length;
				return `${lines}L`;
			}
			if (Array.isArray(r.content)) {
				let total = 0;
				for (const item of r.content) {
					const t = (item as { text?: unknown })?.text;
					if (typeof t === "string") total += t.split(/\r?\n/).length;
				}
				if (total > 0) return `${total}L`;
			}
		}
	} catch {
		// fall through to no hint
	}
	return "";
}

/**
 * Pull the first sentence (or first 100 chars) from any `thinking` block on an
 * assistant message. Returns `undefined` if no thinking content present.
 */
export function extractThinkingOneLiner(message: AgentMessage | undefined): string | undefined {
	if (!message || (message as { role?: string }).role !== "assistant") return undefined;
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		const b = block as { type?: string; thinking?: unknown };
		if (b?.type !== "thinking" || typeof b.thinking !== "string") continue;
		const text = b.thinking.trim();
		if (!text) continue;
		const m = text.match(/^[^\n.!?]+/);
		const first = (m ? m[0] : text).trim();
		return first.length > 100 ? `${first.slice(0, 100)}…` : first;
	}
	return undefined;
}

export interface UsageDelta {
	input: number;
	output: number;
	cacheRead: number;
}

/** Extract usage from an assistant message; returns zeros if missing. */
export function readUsage(message: AgentMessage | undefined): UsageDelta {
	const u = (message as { usage?: { input?: number; output?: number; cacheRead?: number } } | undefined)?.usage;
	return {
		input: u?.input ?? 0,
		output: u?.output ?? 0,
		cacheRead: u?.cacheRead ?? 0,
	};
}

/**
 * Extract the last assistant-authored text from a turn_end message and
 * collapse to a single-line preview (max 120 chars). Returns "" if the
 * message has no text content (e.g. all-tool-call turn).
 */
export function extractTurnPreview(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const msg = message as { role?: string; content?: unknown };
	if (msg.role !== "assistant") return "";
	const content = msg.content;
	if (!Array.isArray(content)) return "";
	for (const c of content) {
		if (!c || typeof c !== "object") continue;
		const part = c as { type?: string; text?: unknown };
		if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
			const flat = part.text.replace(/\s+/g, " ").trim();
			return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
		}
	}
	return "";
}

export function fmtTokenMeter(u: UsageDelta): string {
	return `↑${humanTokens(u.input)}↓${humanTokens(u.output)}`;
}

function humanTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format a one-shot phase-completion line for the tail buffer. */
export function fmtPhaseSummary(opts: {
	role: string;
	turns: number;
	tools: number;
	errors: number;
	wallSeconds: number;
	usage: UsageDelta;
	model?: string;
	provider?: string;
}): string {
	const { role, turns, tools, errors, wallSeconds, usage, model, provider } = opts;
	const errPart = errors > 0 ? ` err=${errors}` : "";
	const modelPart = model ? ` model=${model}${provider ? `/${provider}` : ""}` : "";
	return `▣ ${role}: turns=${turns} tools=${tools}${errPart} ${fmtTokenMeter(usage)} wall=${fmtWall(wallSeconds)}${modelPart}`;
}

/**
 * Build the sticky footer line shown at the bottom of the tail view.
 * Includes cacheRead only when nonzero — most non-Anthropic providers (ollama,
 * glm, etc.) return 0 for cache fields and we don't want the noise.
 */
export function fmtTokenFooter(usage: UsageDelta | undefined): string {
	if (!usage) return "";
	const cache = usage.cacheRead > 0 ? ` ⇪${humanTokens(usage.cacheRead)}` : "";
	return `↑${humanTokens(usage.input)} ↓${humanTokens(usage.output)}${cache}`;
}

function fmtWall(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}m${String(s).padStart(2, "0")}s`;
}
