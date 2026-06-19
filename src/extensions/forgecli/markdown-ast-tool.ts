// Markdown-AST tool — FORGE: structural access to Markdown for the model.
//
// A single native pi tool (`forge_markdown`) that parses Markdown into an AST
// (remark/mdast) and exposes structural operations so a model reasons over
// document STRUCTURE (headings, sections, tables, frontmatter) instead of
// treating a KB doc / brief / sprint artifact as a flat string.
//
// Native TS tool (NOT a .cjs wrapper): Markdown is one language with a pure-JS
// CommonMark parser, so there is no grammar wasm, no ABI coupling, and nothing
// to provision — just vendored npm deps bundled by tsc. Validated by the spike
// at test/poc/spike-md-ast/ (RESULT.md): MASTER_INDEX.md outline = 85.6x token
// reduction; GFM tables + YAML frontmatter parsed; round-trip clean.
//
// Read-only v1: outline | ast | section | tables | frontmatter. A structural
// `edit` op (parse → mutate → stringify) is deferred pending a fidelity policy.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FORGE_MARKDOWN_DESCRIPTION } from "./tool-contracts.js";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { toString as mdToString } from "mdast-util-to-string";
import { load as loadYaml } from "js-yaml";
import type { Root, Heading, Table, TableRow, TableCell, RootContent } from "mdast";

// ── Parser (configured once, reused) ──────────────────────────────────────────

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ["yaml"]);

function parseMarkdown(source: string): Root {
	return processor.parse(source) as Root;
}

function lineOf(node: { position?: { start: { line: number } } }): number {
	return node.position?.start.line ?? 0;
}

// ── outline: heading tree + section line ranges ───────────────────────────────

interface OutlineHeading {
	depth: number;
	text: string;
	startLine: number;
	endLine: number;
}

function computeOutline(tree: Root, source: string): { headings: OutlineHeading[]; totalLines: number } {
	const totalLines = source.split("\n").length;
	const headingNodes = tree.children.filter((c): c is Heading => c.type === "heading");
	const headings = headingNodes.map((h, i) => {
		let endLine = totalLines;
		for (let j = i + 1; j < headingNodes.length; j++) {
			if (headingNodes[j].depth <= h.depth) {
				endLine = lineOf(headingNodes[j]) - 1;
				break;
			}
		}
		return { depth: h.depth, text: mdToString(h), startLine: lineOf(h), endLine };
	});
	return { headings, totalLines };
}

function formatOutline(headings: OutlineHeading[], name: string): string {
	const lines = headings.map((h) => {
		const indent = "  ".repeat(h.depth - 1);
		const span = h.startLine === h.endLine ? `${h.startLine}` : `${h.startLine}-${h.endLine}`;
		return `${indent}${"#".repeat(h.depth)} ${h.text}  [${span}]`;
	});
	return [name, ...lines].join("\n");
}

// ── ast: compact structural dump ──────────────────────────────────────────────

interface AstNode {
	type: string;
	line: number;
	depth?: number;
	lang?: string;
	ordered?: boolean;
	text?: string;
	children?: AstNode[];
}

const PREVIEW_TYPES = new Set(["heading", "paragraph", "code", "tableCell", "listItem"]);

function compactAst(node: RootContent | Root): AstNode {
	const n = node as RootContent & { depth?: number; lang?: string; ordered?: boolean };
	const out: AstNode = { type: n.type, line: lineOf(n as { position?: { start: { line: number } } }) };
	if (typeof n.depth === "number") out.depth = n.depth;
	if (n.lang) out.lang = n.lang;
	if (typeof n.ordered === "boolean") out.ordered = n.ordered;
	if (PREVIEW_TYPES.has(n.type)) {
		const t = mdToString(n as never).replace(/\s+/g, " ").trim();
		if (t) out.text = t.length > 80 ? `${t.slice(0, 79)}…` : t;
	}
	const kids = (n as { children?: RootContent[] }).children;
	if (kids && kids.length && n.type !== "paragraph" && n.type !== "heading") {
		out.children = kids.map((c) => compactAst(c));
	}
	return out;
}

// ── section: exact source slice under a heading ───────────────────────────────

/**
 * Strip a leading section-number prefix (e.g. "5.2 ", "10. ", "1 ") and lowercase,
 * so a query of "Objective" resolves a heading of "1. Objective". Observed friction:
 * models ask by plain title, but headings carry numbers → exact match misses and the
 * model burns a retry (CART-S01-T01 plan phase: 5 such misses).
 */
function normalizeHeading(s: string): string {
	return s.replace(/^\s*\d+(\.\d+)*\.?\s+/, "").trim().toLowerCase();
}

/**
 * Resolve a heading query against the outline with graceful tolerance:
 *   1. exact, case-insensitive
 *   2. numbering-insensitive equality ("Objective" ↔ "1. Objective")
 *   3. numbering-insensitive substring (first match in document order)
 * Returns null only when nothing plausibly matches.
 */
function matchHeading(headings: OutlineHeading[], query: string): OutlineHeading | null {
	const q = query.trim().toLowerCase();
	const exact = headings.find((x) => x.text.trim().toLowerCase() === q);
	if (exact) return exact;

	const qn = normalizeHeading(query);
	if (!qn) return null;
	const eq = headings.find((x) => normalizeHeading(x.text) === qn);
	if (eq) return eq;

	return headings.find((x) => normalizeHeading(x.text).includes(qn)) ?? null;
}

function extractSection(tree: Root, source: string, heading: string): string | null {
	const { headings } = computeOutline(tree, source);
	const h = matchHeading(headings, heading);
	if (!h) return null;
	return source.split("\n").slice(h.startLine - 1, h.endLine).join("\n");
}

// ── Reusable helpers (consumed by forge_artifact for managed-artifact reads) ───

/** Extract the exact source of a heading's section from a markdown string. */
export function extractMarkdownSection(source: string, heading: string): string | null {
	return extractSection(parseMarkdown(source), source, heading);
}

/** Render a heading-tree outline (with section line ranges) for a markdown string. */
export function outlineMarkdown(source: string, name: string): string {
	const { headings } = computeOutline(parseMarkdown(source), source);
	return formatOutline(headings, name);
}

/** List heading texts (in document order) for a markdown string. */
export function listMarkdownHeadings(source: string): string[] {
	return computeOutline(parseMarkdown(source), source).headings.map((h) => h.text);
}

// ── tables: GFM tables as structured rows ─────────────────────────────────────

interface MdTable {
	line: number;
	header: string[];
	rows: string[][];
	align: (string | null)[];
}

function extractTables(tree: Root): MdTable[] {
	const tables: MdTable[] = [];
	for (const node of tree.children) {
		if (node.type !== "table") continue;
		const t = node as Table;
		const rows = t.children.map((r: TableRow) => r.children.map((cell: TableCell) => mdToString(cell).trim()));
		tables.push({ line: lineOf(t), header: rows[0] ?? [], rows: rows.slice(1), align: t.align ?? [] });
	}
	return tables;
}

// ── frontmatter: YAML → object ────────────────────────────────────────────────

function extractFrontmatter(tree: Root): Record<string, unknown> | null {
	const fm = tree.children.find((c: RootContent) => c.type === "yaml") as { value?: string } | undefined;
	if (!fm?.value) return null;
	const parsed = loadYaml(fm.value);
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

// ── Result helpers (mirror forge-tools.ts shape) ──────────────────────────────

function okResult(text: string) {
	return { content: [{ type: "text" as const, text: text || "OK" }], details: {} as unknown };
}
function errResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} as unknown, isError: true as const };
}

// ── Tool definition ───────────────────────────────────────────────────────────

const MARKDOWN_OPERATION = Type.Union(
	[
		Type.Literal("outline"),
		Type.Literal("ast"),
		Type.Literal("section"),
		Type.Literal("tables"),
		Type.Literal("frontmatter"),
	],
	{ description: "The structural operation to run against the markdown file." },
);

/**
 * Build the `forge_markdown` tool. Read-only structural access to a Markdown
 * file. `projectRoot` anchors relative paths.
 */
export function buildForgeMarkdown(projectRoot: string): ToolDefinition {
	return {
		name: "forge_markdown",
		label: "Forge Markdown AST",
		description: FORGE_MARKDOWN_DESCRIPTION,
		promptSnippet:
			"Use forge_markdown with operation=outline to map a long markdown doc cheaply, then operation=section to pull " +
			"one part; operation=tables/frontmatter to read structured data instead of parsing text by hand.",
		parameters: Type.Object({
			operation: MARKDOWN_OPERATION,
			path: Type.String({ description: "Path to the markdown file (absolute, or relative to the project root)." }),
			heading: Type.Optional(
				Type.String({ description: "Heading text to extract (required for operation=section; case-insensitive)." }),
			),
		}),
		// eslint-disable-next-line @typescript-eslint/require-await
		async execute(_toolCallId, _params) {
			const params = _params as { operation: string; path: string; heading?: string };
			const abs = path.isAbsolute(params.path) ? params.path : path.join(projectRoot, params.path);
			if (!existsSync(abs)) return errResult(`forge_markdown: file not found: ${params.path}`);
			let source: string;
			try {
				source = readFileSync(abs, "utf8");
			} catch (err: unknown) {
				return errResult(`forge_markdown: cannot read ${params.path}: ${(err as { message?: string }).message}`);
			}
			let tree: Root;
			try {
				tree = parseMarkdown(source);
			} catch (err: unknown) {
				return errResult(`forge_markdown: parse failed for ${params.path}: ${(err as { message?: string }).message}`);
			}

			switch (params.operation) {
				case "outline": {
					const { headings } = computeOutline(tree, source);
					if (!headings.length) return okResult(`(no headings in ${path.basename(abs)})`);
					return okResult(formatOutline(headings, path.basename(abs)));
				}
				case "section": {
					if (!params.heading) return errResult("forge_markdown: operation=section requires `heading`.");
					const section = extractSection(tree, source, params.heading);
					if (section === null) return errResult(`forge_markdown: heading not found: "${params.heading}"`);
					return okResult(section);
				}
				case "tables": {
					return okResult(JSON.stringify(extractTables(tree), null, 2));
				}
				case "frontmatter": {
					const fm = extractFrontmatter(tree);
					return okResult(fm ? JSON.stringify(fm, null, 2) : "(no frontmatter)");
				}
				case "ast": {
					return okResult(JSON.stringify(compactAst(tree), null, 1));
				}
				default:
					return errResult(`forge_markdown: unknown operation "${params.operation}".`);
			}
		},
	};
}
