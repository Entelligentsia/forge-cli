// workflow-loader.ts — Parses a materialized workflow markdown file.
// Exports WorkflowFrontmatter (TypeBox), loadWorkflow(), extractAudience(),
// and parseWorkflowFrontmatter() (FORGE-S21-T01).
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL6 — no shell-string interpolation; all I/O via fs synchronous APIs.
//   IL7 — no silent continuation; malformed state throws typed errors.

import * as fs from "node:fs";
import { type Static, Type } from "typebox";

// ── Types ─────────────────────────────────────────────────────────────────

export const AUDIENCE_VALUES = ["orchestrator-only", "subagent", "any"] as const;
export type AudienceValue = (typeof AUDIENCE_VALUES)[number];

export const WorkflowFrontmatterSchema = Type.Object(
	{
		audience: Type.Optional(
			Type.Union([
				Type.Literal("orchestrator-only"),
				Type.Literal("subagent"),
				Type.Literal("any"),
			]),
		),
		deps: Type.Optional(
			Type.Object(
				{
					personas: Type.Optional(Type.Array(Type.String())),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
);

export type WorkflowFrontmatter = Static<typeof WorkflowFrontmatterSchema>;

export interface LoadedWorkflow {
	filePath: string;
	rawMarkdown: string;
	frontmatter: WorkflowFrontmatter;
	/** Resolved audience; defaults to "any" when the key is absent. */
	audience: AudienceValue;
}

// ── Errors ────────────────────────────────────────────────────────────────

export type WorkflowLoaderErrorCode = "missing_file" | "invalid_frontmatter" | "validation_failed";

export class WorkflowLoaderError extends Error {
	public readonly code: WorkflowLoaderErrorCode;
	constructor(code: WorkflowLoaderErrorCode, message: string) {
		super(message);
		this.name = "WorkflowLoaderError";
		this.code = code;
	}
}

// ── Frontmatter parser ────────────────────────────────────────────────────

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

/**
 * Parse the YAML-like frontmatter of a workflow markdown file.
 *
 * Returns `{}` if the file does not start with `---`.
 * Throws `WorkflowLoaderError("invalid_frontmatter", ...)` on malformed YAML.
 */
export function parseWorkflowFrontmatter(rawMarkdown: string): WorkflowFrontmatter {
	const lines = rawMarkdown.split(/\r?\n/);
	if (lines.length === 0 || lines[0] !== "---") {
		return {};
	}

	const fm: Record<string, unknown> = {};
	let currentBlock: string | null = null;
	let blockChildren: Record<string, unknown> = {};
	let closed = false;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];

		if (line === "---") {
			if (currentBlock !== null) {
				fm[currentBlock] = blockChildren;
				currentBlock = null;
				blockChildren = {};
			}
			closed = true;
			break;
		}

		if (line.trim() === "") continue;

		// Indented line → child of current block.
		if (/^\s/.test(line)) {
			if (currentBlock === null) {
				throw new WorkflowLoaderError(
					"invalid_frontmatter",
					`Indented frontmatter line ${i + 1} with no parent block: ${JSON.stringify(line)}`,
				);
			}
			const childMatch = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
			if (!childMatch) {
				throw new WorkflowLoaderError(
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
			throw new WorkflowLoaderError(
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

	if (!closed) {
		throw new WorkflowLoaderError(
			"invalid_frontmatter",
			"Workflow frontmatter block opened with `---` but never closed",
		);
	}

	return fm as WorkflowFrontmatter;
}

// ── Audience extraction ───────────────────────────────────────────────────

/**
 * Extract the audience value from a parsed WorkflowFrontmatter.
 * Returns "any" when the key is absent or has an unrecognised value.
 */
export function extractAudience(frontmatter: WorkflowFrontmatter): AudienceValue {
	const raw = frontmatter.audience;
	if (!raw) return "any";
	if ((AUDIENCE_VALUES as ReadonlyArray<string>).includes(raw)) return raw as AudienceValue;
	return "any";
}

// ── loadWorkflow ──────────────────────────────────────────────────────────

/**
 * Load and parse a materialized workflow markdown file.
 *
 * Throws `WorkflowLoaderError("missing_file", ...)` if the file is absent or unreadable.
 * Throws `WorkflowLoaderError("invalid_frontmatter", ...)` if frontmatter is malformed.
 */
export function loadWorkflow(workflowPath: string): LoadedWorkflow {
	if (!fs.existsSync(workflowPath)) {
		throw new WorkflowLoaderError("missing_file", `Workflow not found: ${workflowPath}`);
	}
	let rawMarkdown: string;
	try {
		rawMarkdown = fs.readFileSync(workflowPath, "utf8");
	} catch (err: unknown) {
		const e = err as { message?: string };
		throw new WorkflowLoaderError(
			"missing_file",
			`Failed to read workflow ${workflowPath}: ${e.message ?? "unknown"}`,
		);
	}
	const frontmatter = parseWorkflowFrontmatter(rawMarkdown);
	const audience = extractAudience(frontmatter);
	return { filePath: workflowPath, rawMarkdown, frontmatter, audience };
}
