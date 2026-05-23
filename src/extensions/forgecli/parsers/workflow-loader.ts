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
import { parseFrontmatterBlock, FrontmatterParseError } from "../lib/parsers.js";

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

// ── Frontmatter parser (delegates to lib/parsers.ts) ─────────────────────

/**
 * Parse the YAML-like frontmatter of a workflow markdown file.
 *
 * Returns `{}` if the file does not start with `---`.
 * Throws `WorkflowLoaderError("invalid_frontmatter", ...)` on malformed YAML.
 */
export function parseWorkflowFrontmatter(rawMarkdown: string): WorkflowFrontmatter {
	try {
		const { frontmatter } = parseFrontmatterBlock(rawMarkdown, { allowNesting: true });
		return frontmatter as WorkflowFrontmatter;
	} catch (err) {
		if (err instanceof FrontmatterParseError) {
			throw new WorkflowLoaderError("invalid_frontmatter", err.message);
		}
		throw err;
	}
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
