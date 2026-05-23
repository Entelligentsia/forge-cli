// forge-artifact-tool.ts — typed artifact read/write/list tool for subagent sessions.
//
// Resolves phase artifact paths from (entityType, entityId, artifactName) tuples.
// Validates JSON summary artifacts on write. Eliminates path derivation as a
// failure mode for low-tier models.

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// ── Artifact catalog ────────────────────────────────────────────────────────

const ARTIFACT_CATALOG: Record<string, { filename: string; type: "md" | "json" }> = {
	"plan":                    { filename: "PLAN.md",                    type: "md" },
	"plan-review":             { filename: "PLAN_REVIEW.md",             type: "md" },
	"progress":                { filename: "PROGRESS.md",                type: "md" },
	"code-review":             { filename: "CODE_REVIEW.md",             type: "md" },
	"validation-report":       { filename: "VALIDATION_REPORT.md",       type: "md" },
	"architect-approval":      { filename: "ARCHITECT_APPROVAL.md",      type: "md" },
	"triage":                  { filename: "TRIAGE.md",                  type: "md" },
	"bug-report":              { filename: "BUG_REPORT.md",              type: "md" },
	"index":                   { filename: "INDEX.md",                   type: "md" },
	"cost-report":             { filename: "COST_REPORT.md",             type: "md" },
	"timesheet":               { filename: "TIMESHEET.md",               type: "md" },
	"plan-summary":            { filename: "PLAN-SUMMARY.json",            type: "json" },
	"review-plan-summary":     { filename: "REVIEW-PLAN-SUMMARY.json",     type: "json" },
	"implementation-summary":  { filename: "IMPLEMENTATION-SUMMARY.json",  type: "json" },
	"review-code-summary":     { filename: "REVIEW-CODE-SUMMARY.json",     type: "json" },
	"review-impl-summary":     { filename: "REVIEW-IMPL-SUMMARY.json",     type: "json" },
	"validation-summary":      { filename: "VALIDATION-SUMMARY.json",      type: "json" },
	"approve-summary":         { filename: "APPROVE-SUMMARY.json",         type: "json" },
	"commit-summary":          { filename: "COMMIT-SUMMARY.json",          type: "json" },
	"triage-summary":          { filename: "TRIAGE-SUMMARY.json",          type: "json" },
	"writeback-summary":       { filename: "WRITEBACK-SUMMARY.json",       type: "json" },
	"collation-summary":       { filename: "COLLATION-SUMMARY.json",       type: "json" },
};

const ARTIFACT_NAMES = Object.keys(ARTIFACT_CATALOG).sort();

// ── Summary JSON validation ─────────────────────────────────────────────────

const SUMMARY_REQUIRED = ["objective", "key_changes", "verdict", "written_at"] as const;

function validateSummaryJson(content: string): string | null {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(content) as Record<string, unknown>;
	} catch (e) {
		return `Invalid JSON: ${(e as Error).message}`;
	}
	const missing = SUMMARY_REQUIRED.filter((f) => !(f in obj));
	if (missing.length > 0) return `Missing required fields: ${missing.join(", ")}`;
	if (typeof obj.objective !== "string") return `"objective" must be a string`;
	if (!Array.isArray(obj.key_changes)) return `"key_changes" must be an array`;
	if (typeof obj.verdict !== "string") return `"verdict" must be a string`;
	if (typeof obj.written_at !== "string") return `"written_at" must be a string`;
	return null;
}

// ── Entity path resolution ──────────────────────────────────────────────────

function resolveEntityDir(
	entity: string,
	entityId: string,
	engineeringPath: string,
): string | null {
	switch (entity) {
		case "task": {
			const match = entityId.match(/^(.+-S\d+)-T\d+$/);
			if (!match) return null;
			return path.join(engineeringPath, "sprints", match[1], entityId);
		}
		case "bug":
			return path.join(engineeringPath, "bugs", entityId);
		case "sprint":
			return path.join(engineeringPath, "sprints", entityId);
		default:
			return null;
	}
}

// ── Tool builder ────────────────────────────────────────────────────────────

export function buildForgeArtifact(projectRoot: string, engineeringPath: string): ToolDefinition {
	const artifactNameList = ARTIFACT_NAMES.join(", ");

	return {
		name: "forge_artifact",
		label: "Forge Artifact",
		description:
			"Read, write, or list phase artifacts (PLAN.md, PROGRESS.md, *-SUMMARY.json, etc.) " +
			"for a task, bug, or sprint. Resolves paths automatically from entity ID — never " +
			"construct artifact paths manually.\n\n" +
			`Known artifacts: ${artifactNameList}.\n\n` +
			"JSON summary artifacts are validated on write (objective, key_changes, verdict, written_at required). " +
			"Use 'list' to see which artifacts already exist for an entity.",
		promptSnippet:
			"Use forge_artifact to read/write phase outputs (PLAN.md, PROGRESS.md, *-SUMMARY.json). " +
			"Never construct artifact paths manually — the tool resolves them from entity IDs.",
		parameters: Type.Object({
			command: Type.Union(
				[Type.Literal("read"), Type.Literal("write"), Type.Literal("list")],
				{ description: "read: fetch content. write: create/overwrite with validation. list: show existing artifacts." },
			),
			entity: Type.Union(
				[Type.Literal("task"), Type.Literal("bug"), Type.Literal("sprint")],
				{ description: "Entity type." },
			),
			entityId: Type.String({
				description: "Entity ID (e.g. HELLO-S99-T02, HELLO-B01-shout-flag, HELLO-S99).",
			}),
			artifact: Type.Optional(
				Type.String({
					description:
						`Artifact name (required for read/write). One of: ${artifactNameList}.`,
				}),
			),
			content: Type.Optional(
				Type.String({
					description: "Content to write (required for write command).",
				}),
			),
		}),
		async execute(_toolCallId, _params) {
			const params = _params as {
				command: "read" | "write" | "list";
				entity: "task" | "bug" | "sprint";
				entityId: string;
				artifact?: string;
				content?: string;
			};

			const entityDir = resolveEntityDir(params.entity, params.entityId, engineeringPath);
			if (!entityDir) {
				return errResult(
					`Cannot resolve ${params.entity} directory for "${params.entityId}". ` +
					`Expected ID pattern: task=PREFIX-SNN-TNN, bug=PREFIX-BNN-slug, sprint=PREFIX-SNN.`,
				);
			}

			const absDir = path.resolve(projectRoot, entityDir);

			if (params.command === "list") {
				if (!fs.existsSync(absDir)) {
					return okResult(`No artifacts found — directory does not exist: ${entityDir}/`);
				}
				const files = fs.readdirSync(absDir).filter((f) => f.endsWith(".md") || f.endsWith(".json"));
				const known: string[] = [];
				const other: string[] = [];
				for (const f of files) {
					const catalogEntry = Object.entries(ARTIFACT_CATALOG).find(([, v]) => v.filename === f);
					if (catalogEntry) {
						known.push(`  ${catalogEntry[0]} → ${f}`);
					} else {
						other.push(`  (unlisted) ${f}`);
					}
				}
				const lines = [`Artifacts in ${entityDir}/:`];
				if (known.length > 0) lines.push(...known);
				if (other.length > 0) lines.push(...other);
				if (known.length === 0 && other.length === 0) lines.push("  (empty)");
				return okResult(lines.join("\n"));
			}

			if (!params.artifact) {
				return errResult(`"artifact" is required for ${params.command}. Known: ${artifactNameList}`);
			}

			const catalogEntry = ARTIFACT_CATALOG[params.artifact];
			if (!catalogEntry) {
				const suggestions = ARTIFACT_NAMES.filter((n) => n.includes(params.artifact!.toLowerCase()));
				return errResult(
					`Unknown artifact "${params.artifact}". Known: ${artifactNameList}.` +
					(suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : ""),
				);
			}

			const filePath = path.join(absDir, catalogEntry.filename);

			if (params.command === "read") {
				if (!fs.existsSync(filePath)) {
					return errResult(`Artifact not found: ${path.join(entityDir, catalogEntry.filename)}`);
				}
				const content = fs.readFileSync(filePath, "utf8");
				return okResult(content);
			}

			if (params.command === "write") {
				if (!params.content) {
					return errResult(`"content" is required for write.`);
				}

				if (catalogEntry.type === "json") {
					const validationError = validateSummaryJson(params.content);
					if (validationError) {
						return errResult(
							`Summary validation failed for ${catalogEntry.filename}: ${validationError}. ` +
							`Required fields: ${SUMMARY_REQUIRED.join(", ")}.`,
						);
					}
				}

				fs.mkdirSync(absDir, { recursive: true });
				fs.writeFileSync(filePath, params.content, "utf8");
				return okResult(`Wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${path.join(entityDir, catalogEntry.filename)}`);
			}

			return errResult(`Unknown command: ${params.command}`);
		},
	};
}

// ── Result helpers (same pattern as forge-tools.ts) ─────────────────────────

function okResult(text: string) {
	return {
		content: [{ type: "text" as const, text: text || "OK" }],
		details: {} as unknown,
	};
}

function errResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {} as unknown,
		isError: true as const,
	};
}
