// advisory-render.ts — FEAT-009 T02 (rich advisory rendering).
//
// The halt-recovery advisor returns markdown; piping it straight through
// ctx.ui.notify (a plaintext, dimmed sink) rendered it as a raw grey wall of
// `##`/`**`/backtick source. This renders that markdown into a clean, bordered,
// terminal-friendly block that stays in the transcript/scrollback (a non-modal
// "widget"), so the operator can read it while the recovery menu handles input.
//
// Pure and deterministic — no ANSI colour (the notify sink does not reliably
// pass escape codes, and plain text keeps the border alignment honest). The
// substance of the fix is stripping markdown syntax + wrapping + framing.

const DEFAULT_WIDTH = 78;
const MIN_WIDTH = 24;

/** Strip inline markdown emphasis/code markers, keeping the text. */
function stripInline(s: string): string {
	return s
		.replace(/\*\*(.+?)\*\*/g, "$1") // bold
		.replace(/__(.+?)__/g, "$1") // bold (underscore)
		.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1") // italic
		.replace(/`([^`]+)`/g, "$1"); // inline code
}

/** Convert one markdown line to a clean text line (no framing yet). */
function transformLine(line: string): string {
	const trimmedRight = line.replace(/\s+$/, "");
	// Headings: drop leading #'s.
	const heading = /^#{1,6}\s+(.*)$/.exec(trimmedRight);
	if (heading) return stripInline(heading[1]).trim();
	// Bullets: normalise -/*/+ to a bullet glyph, preserve indent.
	const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(trimmedRight);
	if (bullet) return `${bullet[1]}• ${stripInline(bullet[2])}`;
	return stripInline(trimmedRight);
}

/** Greedy word-wrap a single logical line to `width` columns. */
function wrap(text: string, width: number): string[] {
	if (text.length === 0) return [""];
	const indentMatch = /^(\s*)/.exec(text);
	const indent = indentMatch ? indentMatch[1] : "";
	const words = text.slice(indent.length).split(/\s+/).filter(Boolean);
	if (words.length === 0) return [""];
	const lines: string[] = [];
	let cur = indent;
	for (const w of words) {
		const candidate = cur === indent ? indent + w : `${cur} ${w}`;
		if (candidate.length > width && cur !== indent) {
			lines.push(cur);
			cur = indent + w;
		} else if (candidate.length > width && cur === indent) {
			// single word longer than width — hard-break it
			let rest = w;
			while (rest.length > width) {
				lines.push(indent + rest.slice(0, width - indent.length));
				rest = rest.slice(width - indent.length);
			}
			cur = indent + rest;
		} else {
			cur = candidate;
		}
	}
	if (cur.length > 0 || lines.length === 0) lines.push(cur);
	return lines;
}

export interface RenderAdvisoryOptions {
	/** Total frame width (default 78, clamped to ≥24). */
	width?: number;
}

/**
 * Render an advisory's markdown body into a bordered block of plain-text lines.
 * `title` becomes the top-border label.
 */
export function renderAdvisoryBlock(
	title: string,
	markdown: string,
	opts: RenderAdvisoryOptions = {},
): string[] {
	const width = Math.max(MIN_WIDTH, opts.width ?? DEFAULT_WIDTH);
	const inner = width - 4; // "│ " + " │"

	// Transform + wrap, collapsing 3+ blank lines to one.
	const body: string[] = [];
	let blanks = 0;
	for (const raw of markdown.replace(/\r\n/g, "\n").split("\n")) {
		const t = transformLine(raw);
		if (t.trim() === "") {
			blanks++;
			if (blanks <= 1) body.push("");
			continue;
		}
		blanks = 0;
		for (const wl of wrap(t, inner)) body.push(wl);
	}
	// Trim leading/trailing blank lines.
	while (body.length && body[0] === "") body.shift();
	while (body.length && body[body.length - 1] === "") body.pop();

	// Frame.
	const label = ` ${title} `;
	const dashCount = Math.max(0, width - 2 - label.length);
	const top = `╭${label}${"─".repeat(dashCount)}╮`.slice(0, width);
	const bottom = `╰${"─".repeat(width - 2)}╯`;
	const framed = body.map((l) => {
		const padded = l.length > inner ? l.slice(0, inner) : l.padEnd(inner, " ");
		return `│ ${padded} │`;
	});
	return [top, ...framed, bottom];
}
