// forge-artifact-tool.ts — thin runCjs shim delegating to plugin artifact.cjs.
//
// All logic (artifact catalog, path resolution, summary JSON validation) lives
// in forge/forge/tools/artifact.cjs as the canonical plugin-side implementation.
// This module is a lightweight wrapper that dispatches read/write/list calls via
// runCjs to the plugin tool, keeping forge-cli in sync automatically whenever
// the plugin is updated.
//
// Content-passing strategy for write:
//   - Inline (<64KB): content is passed as the 4th positional argv argument.
//   - Large (>=64KB): content is written to a temp file and passed as @<path>.
//     artifact.cjs recognises the @-prefix convention and reads from the file.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { compressMarkdown, countTokens } from "@entelligentsia/forge-compress";
import { runCjs as defaultRunCjs, type CompressionStats } from "./forge-tools.js";

type RunCjsFn = (
	toolPath: string,
	argv: string[],
	signal: AbortSignal | undefined,
	timeoutMs: number,
	projectRoot: string,
) => Promise<{ stdout: string; stderr: string }>;

// ── Artifact name list (for parameter description only — logic lives in plugin) ──
//
// The canonical list lives in the plugin registry tools/lib/artifact-kinds.cjs
// (ADR artifact-resolution). We load it in-process from the bundled payload so
// the description never drifts from the registry. This array is the FALLBACK
// when the registry module can't be loaded (e.g. an older bundled payload that
// predates artifact-kinds.cjs, or a path-resolution miss).
const FALLBACK_ARTIFACT_NAMES = [
	"plan",
	"plan-review",
	"progress",
	"code-review",
	"validation-report",
	"architect-approval",
	"triage",
	"bug-report",
	"index",
	"cost-report",
	"timesheet",
	"plan-summary",
	"review-plan-summary",
	"implementation-summary",
	"review-code-summary",
	"review-impl-summary",
	"validation-summary",
	"approve-summary",
	"commit-summary",
	"triage-summary",
	"writeback-summary",
	"collation-summary",
].sort();

// Load the canonical kind names from the plugin registry in the bundled payload.
// Pure-data module (object literals + pure fns), so an in-process require is safe
// and cheap — no subprocess. Falls back to the inlined list on any failure.
function loadArtifactKindNames(toolDir: string): string[] {
	try {
		const require = createRequire(import.meta.url);
		const reg = require(path.join(toolDir, "lib", "artifact-kinds.cjs")) as {
			ARTIFACT_NAMES?: unknown;
		};
		if (Array.isArray(reg.ARTIFACT_NAMES) && reg.ARTIFACT_NAMES.every((n) => typeof n === "string")) {
			return reg.ARTIFACT_NAMES as string[];
		}
	} catch {
		/* registry not loadable (older payload / path miss) — use fallback */
	}
	return FALLBACK_ARTIFACT_NAMES;
}

const INLINE_CONTENT_LIMIT = 64 * 1024; // 64KB

// ── Tool builder ────────────────────────────────────────────────────────────

export function buildForgeArtifact(
	projectRoot: string,
	_engineeringPath: string,
	toolDir: string,
	_runCjsOverride?: RunCjsFn,
): ToolDefinition {
	const toolPath = path.join(toolDir, "artifact.cjs");
	const runCjs = _runCjsOverride ?? defaultRunCjs;
	const ARTIFACT_NAME_LIST = loadArtifactKindNames(toolDir).join(", ");

	return {
		name: "forge_artifact",
		label: "Forge Artifact",
		description:
			"Read, write, or list phase artifacts (PLAN.md, PROGRESS.md, *-SUMMARY.json, etc.) " +
			"for a task, bug, or sprint. Resolves paths automatically from entity ID — never " +
			"construct artifact paths manually.\n\n" +
			`Known artifacts: ${ARTIFACT_NAME_LIST}.\n\n` +
			"JSON summary artifacts are validated on write (objective, key_changes, verdict, written_at required). " +
			"Use 'list' to see which artifacts already exist for an entity.",
		promptSnippet:
			"Use forge_artifact to read/write phase outputs (PLAN.md, PROGRESS.md, *-SUMMARY.json). " +
			"Never construct artifact paths manually — the tool resolves them from entity IDs.",
		parameters: Type.Object({
			command: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("list"), Type.Literal("exists"), Type.Literal("url"), Type.Literal("delete")], {
				description: "read: fetch content. write: create/overwrite with validation. list: show existing artifacts. exists: true/false. url: backend URL (file:// for fs). delete: remove the artifact.",
			}),
			entity: Type.Union([Type.Literal("task"), Type.Literal("bug"), Type.Literal("sprint")], {
				description: "Entity type.",
			}),
			entityId: Type.String({
				description: "Entity ID (e.g. HELLO-S99-T02, HELLO-B01-shout-flag, HELLO-S99).",
			}),
			artifact: Type.Optional(
				Type.String({
					description: `Artifact name (required for read/write). One of: ${ARTIFACT_NAME_LIST}.`,
				}),
			),
			content: Type.Optional(
				Type.String({
					description: "Content to write (required for write command).",
				}),
			),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as {
				command: "read" | "write" | "list" | "exists" | "url" | "delete";
				entity: "task" | "bug" | "sprint";
				entityId: string;
				artifact?: string;
				content?: string;
			};

			let tmpFile: string | null = null;
			try {
				const argv: string[] = [params.command, params.entity, params.entityId];

				if (params.command !== "list") {
					if (!params.artifact) {
						return errResult(`"artifact" is required for ${params.command}. Known: ${ARTIFACT_NAME_LIST}`);
					}
					argv.push(params.artifact);
				}

				if (params.command === "write") {
					if (!params.content) {
						return errResult(`"content" is required for write.`);
					}
					const bytes = Buffer.byteLength(params.content, "utf8");
					if (bytes >= INLINE_CONTENT_LIMIT) {
						// Write to a temp file and pass @<path>
						tmpFile = path.join(os.tmpdir(), `forge-artifact-${Date.now()}-${process.pid}.tmp`);
						fs.writeFileSync(tmpFile, params.content, "utf8");
						argv.push(`@${tmpFile}`);
					} else {
						argv.push(params.content);
					}
				}

				const { stdout, stderr } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);

				if (stderr && stderr.trim()) {
					return errResult(stderr.trim());
				}
				const output = stdout.trim() || "OK";
				if (params.command === "read" && params.artifact && !params.artifact.endsWith("-summary")) {
					const before = countTokens(output);
					const compressed = compressMarkdown(output, { mode: "map" });
					const after = countTokens(compressed);
					if (after < before) {
						const saved = Math.round((1 - after / before) * 100);
						process.stderr.write(`\x1b[2m[forge-compress] artifact:read ${before}→${after} tok (${saved}% saved)\x1b[0m\n`);
						return okResult(compressed, { tool: "artifact:read", before, after, saved });
					}
				}
				return okResult(output);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_artifact failed: ${e.message ?? "unknown error"}`);
			} finally {
				if (tmpFile) {
					try {
						fs.unlinkSync(tmpFile);
					} catch {
						/* best-effort cleanup */
					}
				}
			}
		},
	};
}

// ── Result helpers ────────────────────────────────────────────────────────────

function okResult(text: string, compression?: CompressionStats) {
	return {
		content: [{ type: "text" as const, text: text || "OK" }],
		details: compression ? { compression } : ({} as unknown),
	};
}

function errResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {} as unknown,
		isError: true as const,
	};
}
