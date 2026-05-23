// lib/parsers.ts — Shared frontmatter block parser (FORGE-S25-T19).
//
// Provides a single `parseFrontmatterBlock(content, { allowNesting })` entry
// point that supersedes the private `parseFrontmatter()` in
// parsers/persona-skill-loader.ts and the private `parseWorkflowFrontmatter()`
// in parsers/workflow-loader.ts.
//
// Design notes:
//   - `parseFrontmatterBlock` throws `FrontmatterParseError` (module-local typed
//     error). Callers catch it and re-throw as their own typed error to preserve
//     existing error contracts without introducing circular dependencies.
//   - Always returns `{ frontmatter, body }` for consistency regardless of
//     `allowNesting`. Callers that do not need `body` (e.g. workflow-loader) may
//     ignore it.
//   - `parseInlineArray` and `stripQuotes` are private helpers for the nested
//     YAML case.
//
// Iron Laws (forge-cli-engineer):
//   IL6 — no shell-string interpolation; pure in-memory string processing.
//   IL7 — no silent continuation; malformed input throws FrontmatterParseError.

export type FrontmatterParseErrorCode = "invalid_frontmatter";

export class FrontmatterParseError extends Error {
	public readonly code: FrontmatterParseErrorCode;
	constructor(code: FrontmatterParseErrorCode, message: string) {
		super(message);
		this.name = "FrontmatterParseError";
		this.code = code;
	}
}

export interface ParsedBlock {
	frontmatter: Record<string, unknown>;
	body: string;
}

export interface ParseOptions {
	/** When true, supports nested (indented) block keys as in workflow frontmatter.
	 *  When false, only flat key: value pairs are parsed (persona/skill frontmatter). */
	allowNesting: boolean;
}

// --- Private helpers for nested parsing ---

function parseInlineArray(raw: string): string[] | null {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
	const inner = trimmed.slice(1, -1);
	if (inner.trim() === "") return [];
	return inner
		.split(",")
		.map((s) => {
			const t = s.trim();
			if (
				(t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
				(t.startsWith("'") && t.endsWith("'") && t.length >= 2)
			) {
				return t.slice(1, -1);
			}
			return t;
		})
		.filter((s) => s.length > 0);
}

function stripQuotes(value: string): string {
	const v = value.trim();
	if (
		(v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
		(v.startsWith("'") && v.endsWith("'") && v.length >= 2)
	) {
		return v.slice(1, -1);
	}
	return v;
}

// --- Core implementation ---

/**
 * Parse the YAML-like frontmatter block from a markdown string.
 *
 * Returns `{ frontmatter: {}, body: content }` if the content does not start with `---`.
 * Throws `FrontmatterParseError("invalid_frontmatter", …)` on malformed input.
 *
 * @param content  Raw markdown string (may have CRLF line endings).
 * @param opts     `allowNesting: false` → flat key:value only (persona/skill);
 *                 `allowNesting: true`  → supports indented child blocks (workflow).
 */
export function parseFrontmatterBlock(content: string, opts: ParseOptions): ParsedBlock {
	// Normalise CRLF for line-based parsing while preserving body reconstruction.
	const lines = content.split(/\r?\n/);

	if (lines.length === 0 || lines[0] !== "---") {
		return { frontmatter: {}, body: content };
	}

	const fm: Record<string, unknown> = {};
	let i = 1;
	let closed = false;

	if (!opts.allowNesting) {
		// --- Flat parsing (persona-skill-loader behaviour) ---
		for (; i < lines.length; i++) {
			const line = lines[i];
			if (line === "---") {
				closed = true;
				i++;
				break;
			}
			// Allow blank lines inside frontmatter.
			if (line.trim() === "") continue;
			const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
			if (!m) {
				throw new FrontmatterParseError(
					"invalid_frontmatter",
					`Malformed frontmatter line ${i + 1}: ${JSON.stringify(line)}`,
				);
			}
			const value = m[2].trim();
			// Strip matching surrounding quotes if present.
			let parsed: string = value;
			if (
				(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
				(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
			) {
				parsed = value.slice(1, -1);
			}
			fm[m[1]] = parsed;
		}
	} else {
		// --- Nested parsing (workflow-loader behaviour) ---
		let currentBlock: string | null = null;
		let blockChildren: Record<string, unknown> = {};

		for (; i < lines.length; i++) {
			const line = lines[i];

			if (line === "---") {
				if (currentBlock !== null) {
					fm[currentBlock] = blockChildren;
					currentBlock = null;
					blockChildren = {};
				}
				closed = true;
				i++;
				break;
			}

			if (line.trim() === "") continue;

			// Indented line → child of current block.
			if (/^\s/.test(line)) {
				if (currentBlock === null) {
					throw new FrontmatterParseError(
						"invalid_frontmatter",
						`Indented frontmatter line ${i + 1} with no parent block: ${JSON.stringify(line)}`,
					);
				}
				const childMatch = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
				if (!childMatch) {
					throw new FrontmatterParseError(
						"invalid_frontmatter",
						`Malformed indented frontmatter line ${i + 1}: ${JSON.stringify(line)}`,
					);
				}
				const childKey = childMatch[1];
				const childRaw = childMatch[2].trim();
				const arr = parseInlineArray(childRaw);
				blockChildren[childKey] = arr !== null ? arr : stripQuotes(childRaw);
				continue;
			}

			// Top-level key:value or bare block key.
			const topMatch = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
			if (!topMatch) {
				throw new FrontmatterParseError(
					"invalid_frontmatter",
					`Malformed frontmatter line ${i + 1}: ${JSON.stringify(line)}`,
				);
			}

			if (currentBlock !== null) {
				fm[currentBlock] = blockChildren;
				currentBlock = null;
				blockChildren = {};
			}

			const key = topMatch[1];
			const rawValue = topMatch[2].trim();

			if (rawValue === "") {
				currentBlock = key;
				blockChildren = {};
			} else {
				const arr = parseInlineArray(rawValue);
				fm[key] = arr !== null ? arr : stripQuotes(rawValue);
			}
		}
	}

	if (!closed) {
		throw new FrontmatterParseError(
			"invalid_frontmatter",
			"Frontmatter block opened with `---` but never closed",
		);
	}

	const body = lines.slice(i).join("\n");
	return { frontmatter: fm, body };
}
