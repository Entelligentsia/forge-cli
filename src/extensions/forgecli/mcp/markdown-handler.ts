// mcp/markdown-handler.ts — in-process markdown AST handler for forge_markdown
// MCP tool. FORGE-S34-T04.
//
// Implements the same five operations as the pi-path markdown-ast-tool.ts but
// adapted for the MCP handler signature. Logic is copied inline — do NOT import
// from markdown-ast-tool.ts which imports pi types and would leak them into the
// bundle.
//
// Operations: outline | ast | section | tables | frontmatter
//
// Iron Law 6 compliance: purely in-process, no subprocess spawning.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import { toString as mdToString } from "mdast-util-to-string";
import { load as loadYaml } from "js-yaml";
import type { Root, Heading, Table, TableRow, TableCell, RootContent } from "mdast";
import type { McpToolResult } from "./cjs-handlers.js";

// ── Parser (configured once per module load) ──────────────────────────────────

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

function normalizeHeading(s: string): string {
	return s.replace(/^\s*\d+(\.\d+)*\.?\s+/, "").trim().toLowerCase();
}

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
		const rows = t.children.map((r: TableRow) =>
			r.children.map((cell: TableCell) => mdToString(cell).trim()),
		);
		tables.push({ line: lineOf(t), header: rows[0] ?? [], rows: rows.slice(1), align: t.align ?? [] });
	}
	return tables;
}

// ── frontmatter: YAML → object ─────────────────────────────────────────────────

function extractFrontmatter(tree: Root): Record<string, unknown> | null {
	const fm = tree.children.find((c: RootContent) => c.type === "yaml") as
		| { value?: string }
		| undefined;
	if (!fm?.value) return null;
	const parsed = loadYaml(fm.value);
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

// ── Result helpers ────────────────────────────────────────────────────────────

function okResult(text: string): McpToolResult {
	return { content: [{ type: "text", text: text || "OK" }] };
}

function errResult(text: string): McpToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

// ── Handler factory ───────────────────────────────────────────────────────────

/**
 * Create the forge_markdown MCP handler. `projectRoot` anchors relative paths.
 */
export function createMarkdownHandler(
	projectRoot: string,
): (args: Record<string, unknown>) => Promise<McpToolResult> {
	return async function markdownHandler(args: Record<string, unknown>): Promise<McpToolResult> {
		const operation = String(args["operation"] ?? "");
		const filePath = String(args["path"] ?? "");
		const heading = typeof args["heading"] === "string" ? args["heading"] : undefined;

		const abs = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);

		if (!existsSync(abs)) {
			return errResult(`forge_markdown: file not found: ${filePath}`);
		}

		let source: string;
		try {
			source = readFileSync(abs, "utf8");
		} catch (err: unknown) {
			return errResult(
				`forge_markdown: cannot read ${filePath}: ${(err as { message?: string }).message}`,
			);
		}

		let tree: Root;
		try {
			tree = parseMarkdown(source);
		} catch (err: unknown) {
			return errResult(
				`forge_markdown: parse failed for ${filePath}: ${(err as { message?: string }).message}`,
			);
		}

		switch (operation) {
			case "outline": {
				const { headings } = computeOutline(tree, source);
				if (!headings.length) return okResult(`(no headings in ${path.basename(abs)})`);
				return okResult(formatOutline(headings, path.basename(abs)));
			}
			case "section": {
				if (!heading) return errResult("forge_markdown: operation=section requires `heading`.");
				const section = extractSection(tree, source, heading);
				if (section === null)
					return errResult(`forge_markdown: heading not found: "${heading}"`);
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
				return errResult(`forge_markdown: unknown operation "${operation}".`);
		}
	};
}
