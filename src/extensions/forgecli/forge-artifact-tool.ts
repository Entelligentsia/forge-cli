// forge-artifact-tool.ts — typed artifact read/write/list tool for subagent sessions.
//
// Resolves phase artifact paths from (entityType, entityId, artifactName) tuples.
// Validates JSON summary artifacts on write. Eliminates path derivation as a
// failure mode for low-tier models.
//
// v0.19.1 (forge-cli#33): resolveEntityDir now reads the store record's `path`
// field instead of constructing paths from the entity ID alone. Bug, sprint, and
// task directories can include descriptive slugs (e.g.
// engineering/bugs/BUG-001-sprint-runner-context-accumulation) that are not
// derivable from the ID alone.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveToolDir } from "./store-resolver.js";

// ── Artifact catalog ────────────────────────────────────────────────────────

const ARTIFACT_CATALOG: Record<string, { filename: string; type: "md" | "json" }> = {
	plan: { filename: "PLAN.md", type: "md" },
	"plan-review": { filename: "PLAN_REVIEW.md", type: "md" },
	progress: { filename: "PROGRESS.md", type: "md" },
	"code-review": { filename: "CODE_REVIEW.md", type: "md" },
	"validation-report": { filename: "VALIDATION_REPORT.md", type: "md" },
	"architect-approval": { filename: "ARCHITECT_APPROVAL.md", type: "md" },
	triage: { filename: "TRIAGE.md", type: "md" },
	"bug-report": { filename: "BUG_REPORT.md", type: "md" },
	index: { filename: "INDEX.md", type: "md" },
	"cost-report": { filename: "COST_REPORT.md", type: "md" },
	timesheet: { filename: "TIMESHEET.md", type: "md" },
	"plan-summary": { filename: "PLAN-SUMMARY.json", type: "json" },
	"review-plan-summary": { filename: "REVIEW-PLAN-SUMMARY.json", type: "json" },
	"implementation-summary": { filename: "IMPLEMENTATION-SUMMARY.json", type: "json" },
	"review-code-summary": { filename: "REVIEW-CODE-SUMMARY.json", type: "json" },
	"review-impl-summary": { filename: "REVIEW-IMPL-SUMMARY.json", type: "json" },
	"validation-summary": { filename: "VALIDATION-SUMMARY.json", type: "json" },
	"approve-summary": { filename: "APPROVE-SUMMARY.json", type: "json" },
	"commit-summary": { filename: "COMMIT-SUMMARY.json", type: "json" },
	"triage-summary": { filename: "TRIAGE-SUMMARY.json", type: "json" },
	"writeback-summary": { filename: "WRITEBACK-SUMMARY.json", type: "json" },
	"collation-summary": { filename: "COLLATION-SUMMARY.json", type: "json" },
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

/**
 * Test override for readStorePath — allows unit tests to inject a mock
 * without touching node:child_process. Reset to {} after each test.
 */
export const _testOverrides: {
	readStorePath?:
		| ((entity: string, entityId: string, toolDir: string, projectRoot: string) => string | null)
		| undefined;
} = {};

/** Read a store record via store-cli and return its `path` field, or null on failure. */
function readStorePath(entity: string, entityId: string, toolDir: string, projectRoot: string): string | null {
	// Test injection: if a mock is set, use it directly.
	if (_testOverrides.readStorePath) {
		return _testOverrides.readStorePath(entity, entityId, toolDir, projectRoot);
	}
	const cliPath = path.join(toolDir, "store-cli.cjs");
	try {
		const result = execFileSync("node", [cliPath, "read", entity, entityId, "--json"], {
			cwd: projectRoot,
			encoding: "utf8",
			timeout: 10_000,
		});
		const record = JSON.parse(result as string) as { path?: string };
		if (typeof record.path === "string" && record.path.length > 0) {
			return record.path;
		}
	} catch {
		// Store unavailable or record not found — fall through to ID-only resolution.
	}
	return null;
}

/**
 * Resolve entity directory using the store record's `path` field when available,
 * falling back to ID-only construction for tasks (sprint dir derived from
 * sprint record path or sprint ID) and sprints/bugs (direct ID).
 *
 * forge-cli#33: the store record is the canonical source for entity directory
 * paths — slug-suffixed directories like `BUG-001-sprint-runner-context-accumulation`
 * cannot be derived from the entity ID alone.
 */
function resolveEntityDir(
	entity: string,
	entityId: string,
	engineeringPath: string,
	toolDir: string,
	projectRoot: string,
): string | null {
	switch (entity) {
		case "bug": {
			// Read bug record's path field — canonical source for slug-suffixed dirs.
			const storePath = readStorePath("bug", entityId, toolDir, projectRoot);
			if (storePath) return storePath;
			// Fallback: ID-only construction.
			return path.join(engineeringPath, "bugs", entityId);
		}
		case "sprint": {
			const storePath = readStorePath("sprint", entityId, toolDir, projectRoot);
			if (storePath) return storePath;
			return path.join(engineeringPath, "sprints", entityId);
		}
		case "task": {
			// For tasks, the path includes the sprint directory (which may have
			// a slug suffix). Read the task record's path field.
			const storePath = readStorePath("task", entityId, toolDir, projectRoot);
			if (storePath) return storePath;
			// Fallback: derive from sprint prefix. Try sprint record for slug.
			const match = entityId.match(/^(.+-S\d+)-T\d+$/);
			if (!match) return null;
			const sprintId = match[1];
			const sprintPath = readStorePath("sprint", sprintId, toolDir, projectRoot);
			if (sprintPath) {
				return path.join(sprintPath, entityId);
			}
			// Last resort: ID-only construction.
			return path.join(engineeringPath, "sprints", sprintId, entityId);
		}
		default:
			return null;
	}
}

// ── Tool builder ────────────────────────────────────────────────────────────

export function buildForgeArtifact(projectRoot: string, engineeringPath: string, toolDir: string): ToolDefinition {
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
			command: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("list")], {
				description: "read: fetch content. write: create/overwrite with validation. list: show existing artifacts.",
			}),
			entity: Type.Union([Type.Literal("task"), Type.Literal("bug"), Type.Literal("sprint")], {
				description: "Entity type.",
			}),
			entityId: Type.String({
				description: "Entity ID (e.g. HELLO-S99-T02, HELLO-B01-shout-flag, HELLO-S99).",
			}),
			artifact: Type.Optional(
				Type.String({
					description: `Artifact name (required for read/write). One of: ${artifactNameList}.`,
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

			const entityDir = resolveEntityDir(params.entity, params.entityId, engineeringPath, toolDir, projectRoot);
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
				return okResult(
					`Wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${path.join(entityDir, catalogEntry.filename)}`,
				);
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
