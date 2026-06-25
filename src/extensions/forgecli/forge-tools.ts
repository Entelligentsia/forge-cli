// Production forge tool wrappers — FORGE-S16-T03.
//
// Implements four pi custom tools that wrap the Forge deterministic .cjs tools:
//   forge_collate        → forge/tools/collate.cjs
//   forge_store          → forge/tools/store-cli.cjs
//   forge_validate_store → forge/tools/validate-store.cjs
//   forge_config         → forge/tools/manage-config.cjs
//
// AC4 note: the upstream .cjs tools do NOT accept a --forge-root flag; they
// use findProjectRoot() which walks up from process.cwd(). The equivalent
// guarantee is provided by capturing forgeRoot at extension-init time and
// passing `cwd: projectRoot` to execFileAsync on every call — no per-call
// process.cwd() derivation occurs in this module.
//
// Iron Law 6 compliance: execFile with argv arrays only. No shell strings.

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { askUserToolDefinition } from "./ask-user-tool.js";
import {
	FORGE_COLLATE_DESCRIPTION,
	FORGE_STORE_DESCRIPTION,
	FORGE_COMMIT_DESCRIPTION,
	FORGE_VALIDATE_STORE_DESCRIPTION,
	FORGE_CONFIG_DESCRIPTION,
	FORGE_STORE_DESCRIBE_DESCRIPTION,
	FORGE_STORE_TEMPLATE_DESCRIPTION,
	FORGE_STORE_QUERY_DESCRIPTION,
	FORGE_VERIFY_APPLY_DESCRIPTION,
	FORGE_PREFLIGHT_DESCRIPTION,
	FORGE_BANNER_DESCRIPTION,
	FORGE_MARKDOWN_DESCRIPTION,
} from "./tool-contracts.js";
import {
	compressStoreQuery,
	compressEntity,
	compressEntityList,
	compressValidateStore,
	countTokens,
} from "@entelligentsia/forge-compress";
import { buildForgeArtifact } from "./forge-artifact-tool.js";
import { buildForgeMarkdown } from "./markdown-ast-tool.js";
import { runCjs, type CompressionStats } from "./lib/run-cjs.js";
import {
	assertBugStatusOwnership,
	assertOrchestratorOnlyEmit,
	assertPhaseOwnership,
	PhaseOwnershipError,
} from "./subagent/phase-guard.js";
// FORGE-S25-T22 (N-C-D): adopt shared resolveToolDir from store-resolver instead of duplicating.
// The private copy was identical to store-resolver.resolveToolDir; deleted per R2 Pass-3 scope-corrected.
import { resolveToolDir } from "./store/store-resolver.js";

// ── Result helpers ───────────────────────────────────────────────────────────

// runCjs + CompressionStats live in lib/run-cjs.ts (extracted to break the
// forge-tools ↔ forge-artifact-tool import cycle).

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

function compressWithTelemetry(
	raw: string,
	toolName: string,
	compressFn: (input: string) => string,
): { text: string; stats: CompressionStats | undefined } {
	const before = countTokens(raw);
	const compressed = compressFn(raw);
	const after = countTokens(compressed);
	if (after >= before) return { text: raw, stats: undefined };
	const saved = Math.round((1 - after / before) * 100);
	// No stderr print here: raw writes corrupt active TUI overlays (/forge:dashboard).
	// Savings surface through the returned stats → tool-result details.compression →
	// viewport/events → session-registry/orchestrator-tree → dashboard "⇌Nt" suffix.
	return { text: compressed, stats: { tool: toolName, before, after, saved } };
}

// ── Tool definition set ─────────────────────────────────────────────────────

export interface ForgeToolDefs {
	store: ToolDefinition;
	commit: ToolDefinition;
	collate: ToolDefinition;
	validateStore: ToolDefinition;
	config: ToolDefinition;
	storeDescribe: ToolDefinition;
	storeTemplate: ToolDefinition;
	storeQuery: ToolDefinition;
	verifyApply: ToolDefinition;
	artifact: ToolDefinition;
	preflight: ToolDefinition;
	banner: ToolDefinition;
	markdown: ToolDefinition;
}

// Extra tools injected into every subagent dispatch alongside the forge tool
// surface. Populated once at extension init (e.g. dynamically-discovered grove
// code-nav tools via the MCP bridge). Like forge_ask_user, these are registered
// on the host session but are NOT inherited into createAgentSession subagents,
// so they must be injected as customTools for orchestrator dispatch to reach
// them. Empty by default — set via setExtraSubagentTools.
let extraSubagentTools: ToolDefinition[] = [];

/**
 * Register tools that every subagent dispatch should receive in addition to the
 * forge tool surface. Called once at extension init after the host session
 * registers them. Idempotent — last call wins.
 */
export function setExtraSubagentTools(tools: ToolDefinition[]): void {
	extraSubagentTools = tools;
}

/**
 * Return all forge tool definitions for subagent injection.
 *
 * Every subagent gets the full tool surface (~2K tokens, <4% of session cost).
 * Transcript analysis showed per-persona filtering provided no benefit — models
 * never picked the wrong tool, and withholding tools forced bash workarounds.
 */
export function getSubagentTools(defs: ForgeToolDefs, _personaName?: string): ToolDefinition[] {
	// forge_ask_user is appended so a subagent can reach the human via the
	// ask-broker (forge_ask_user is registered on the host session only; it is
	// NOT inherited into createAgentSession subagents, so it must be injected as
	// a customTool here for every orchestrator dispatch). extraSubagentTools
	// (e.g. grove code-nav) ride the same channel for the same reason.
	return [...Object.values(defs), askUserToolDefinition, ...extraSubagentTools];
}

/**
 * The tool-discipline system prompt block appended to subagent prompts when
 * forge tools are injected. Exported so forge-subagent.ts can include it
 * without duplicating the text.
 */
export const FORGE_TOOL_DISCIPLINE = `
## Forge Tool Discipline

All forge_* tools wrap local .cjs scripts via direct exec — deterministic, no LLM,
no agent loop. Prefer them over shelling out.

- Store CRUD: call \`forge_store\` (named tool). Canonical write is 2-positional:
  \`{command:"write", args:["<entity>","<json>"]}\`. The id lives INSIDE the json
  (e.g. \`{"sprintId":"X-S01","title":"...","status":"planning","taskIds":[],"createdAt":"..."}\`).
  DO NOT pass id as a separate arg — \`["sprint","X-S01","<json>"]\` (3-arg) FAILS.
- Before writing any record, call \`forge_store_template\` for the canonical shape and
  \`forge_store_describe\` for required fields, status enums, and FK constraints.
- Use \`forge_store_query\` (nlp/query/schema) for lookups instead of grepping \`.forge/store/\`.
- Use \`forge_collate\` to refresh the KB; \`forge_validate_store\` for integrity checks;
  \`forge_config\` for project config reads/writes.
- Use \`forge_artifact\` to read/write/list phase artifacts (PLAN.md, PROGRESS.md, *-SUMMARY.json).
  Never construct artifact paths manually — the tool resolves them from entity IDs.
- Use \`forge_verify_apply\` after applying edits to confirm changes landed on disk.
  If \`unchanged\` is non-empty, re-apply those edits.
- Use \`forge_preflight\` for pre-flight gate checks — do NOT shell out to preflight-gate.cjs.
- Use \`forge_banner\` for phase banners — do NOT shell out to banners.cjs.
- Use \`forge_markdown\` to read Markdown STRUCTURE instead of whole files: \`operation:"outline"\`
  maps a long KB doc / brief cheaply (then \`operation:"section"\` pulls one heading's text),
  \`"tables"\`/\`"frontmatter"\` return structured data, \`"ast"\` a compact tree. Prefer it over
  reading or regex-parsing flat markdown.
- \`$FORGE_ROOT\` is already set in your environment. If you must use bash, reference
  \`$FORGE_ROOT\` directly — do NOT resolve it via \`node -e "console.log(require(...)...)"\`.
- Never \`bash node "$FORGE_ROOT/tools/store-cli.cjs" ...\` — use the named MCP tool instead.
  The tool is schema-validated and shorter.
- Workflow text saying \`forge_store write sprint '<json>'\` means: call the MCP tool
  \`forge_store\` with that 2-positional shape. Not a shell command.
`;

// ── Public registration ──────────────────────────────────────────────────────

/**
 * Build all Forge .cjs tool definitions, register them with pi, and return
 * the definitions so callers can inject them into subagent sessions via
 * `customTools`.
 */
export function registerForgeTools(pi: ExtensionAPI, forgeRoot: string, projectRoot: string): ForgeToolDefs {
	const toolDir = resolveToolDir(forgeRoot);
	// Read engineering path from config; default to "engineering".
	let engineeringPath = "engineering";
	try {
		const configPath = path.join(projectRoot, ".forge", "config.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as { paths?: { engineering?: string } };
		if (typeof config.paths?.engineering === "string") engineeringPath = config.paths.engineering;
	} catch {
		/* default */
	}
	const defs: ForgeToolDefs = {
		collate: buildForgeCollate(toolDir, projectRoot),
		store: buildForgeStore(toolDir, projectRoot),
		commit: buildForgeCommit(toolDir, projectRoot),
		validateStore: buildForgeValidateStore(toolDir, projectRoot),
		config: buildForgeConfig(toolDir, projectRoot),
		storeDescribe: buildForgeStoreDescribe(toolDir, projectRoot),
		storeTemplate: buildForgeStoreTemplate(toolDir, projectRoot),
		storeQuery: buildForgeStoreQuery(toolDir, projectRoot),
		verifyApply: buildForgeVerifyApply(toolDir, projectRoot),
		artifact: buildForgeArtifact(projectRoot, engineeringPath, toolDir),
		preflight: buildForgePreflight(toolDir, projectRoot),
		banner: buildForgeBanner(toolDir, projectRoot),
		markdown: buildForgeMarkdown(projectRoot),
	};
	for (const def of Object.values(defs)) {
		pi.registerTool(def);
	}
	registerForgeToolDiscipline(pi, toolDir);
	return defs;
}

/**
 * Append the Forge tool-discipline block to every system prompt.
 *
 * Reads the canonical discipline text from the plugin fragment file at
 * <toolDir>/../meta/fragments/tool-discipline.md. Falls back to the hardcoded
 * FORGE_TOOL_DISCIPLINE constant if the fragment file is missing (graceful
 * degradation during mixed-version states).
 *
 * Why: workflow text often refers to `forge_store ...` colloquially; without
 * this rule, models on some providers shell-bash `forge store ...`, which
 * spawns a fresh pi/agent loop per call — historically 26s+ cold-start vs
 * 50ms direct exec. The bin's fast-path makes shell-out cheap, but the
 * named MCP tools are still preferred (deterministic, schema-validated,
 * no subprocess overhead).
 */
function registerForgeToolDiscipline(pi: ExtensionAPI, toolDir?: string): void {
	// Guard: some test harnesses register a partial pi mock without `on`.
	// Discipline injection is non-critical for unit tests of tool wrappers.
	if (typeof pi.on !== "function") return;
	pi.on("before_agent_start", async (event) => {
		let discipline: string;
		if (toolDir) {
			try {
				const fragmentPath = path.join(toolDir, "..", "meta", "fragments", "tool-discipline.md");
				discipline = "\n" + readFileSync(fragmentPath, "utf8");
			} catch {
				// Fragment not found (mixed-version state) — fall back to hardcoded text
				discipline = FORGE_TOOL_DISCIPLINE;
			}
		} else {
			discipline = FORGE_TOOL_DISCIPLINE;
		}
		const existing = event.systemPrompt ?? "";
		return { systemPrompt: existing + discipline };
	});
}

// ── forge_collate ────────────────────────────────────────────────────────────

function buildForgeCollate(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_collate",
		label: "Forge Collate",
		description: FORGE_COLLATE_DESCRIPTION,
		promptSnippet: "Use forge_collate to refresh the engineering knowledge base.",
		parameters: Type.Object({
			sprintId: Type.Optional(
				Type.String({
					description: "Sprint or bug ID to collate (e.g. FORGE-S16). Omit to collate all.",
				}),
			),
			purgeEvents: Type.Optional(
				Type.Boolean({
					description: "Delete event directory after generating COST_REPORT.md.",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "Preview changes without writing files.",
				}),
			),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { sprintId?: string; purgeEvents?: boolean; dryRun?: boolean };
			const toolPath = path.join(toolDir, "collate.cjs");
			const argv: string[] = [];
			if (params.sprintId) argv.push(params.sprintId);
			if (params.purgeEvents) argv.push("--purge-events");
			if (params.dryRun) argv.push("--dry-run");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 30_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_collate failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_commit ─────────────────────────────────────────────────────────────

function buildForgeCommit(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_commit",
		label: "Forge Commit",
		description: FORGE_COMMIT_DESCRIPTION,
		promptSnippet:
			"Commit phase: inspect once (git diff --stat), craft the message, then call forge_commit " +
			"ONCE. Typed args — never pass the commit message through a bash string. " +
			"committed:false with reason nothing-to-commit is SUCCESS.",
		parameters: Type.Object(
			{
				entity: Type.Union([Type.Literal("task"), Type.Literal("bug")], {
					description: "Record kind to seal.",
				}),
				id: Type.String({ description: "Record id, e.g. FORGE-S01-T01 or FORGE-BUG-001." }),
				message: Type.String({
					description: "Commit message (subject [+ body]). Include the record id; follow project conventions.",
				}),
				trailer: Type.Optional(Type.String({ description: "Optional Co-authored-by trailer line." })),
				also: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Extra repo-relative paths to stage — used when the implementation summary lacks files_changed provenance.",
					}),
				),
				dryRun: Type.Optional(Type.Boolean({ description: "Print the staging plan without writing." })),
				skipGate: Type.Optional(
					Type.Boolean({ description: "Skip the embedded preflight gate (orchestrator already ran it)." }),
				),
				// NOTE: no `force` parameter by design — --force is operator-gated
				// (FORGE_ALLOW_FORCE) and must never be reachable from a subagent.
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, _params, signal) {
			const params = _params as {
				entity: "task" | "bug";
				id: string;
				message: string;
				trailer?: string;
				also?: string[];
				dryRun?: boolean;
				skipGate?: boolean;
			};

			// Terminal-status ownership: forge_commit performs the terminal
			// update-status internally — only the commit phase (or the
			// orchestrator) may seal a record. Mirrors the forge_store
			// update-status guard for `fixed`.
			try {
				if (params.entity === "bug" && !params.dryRun) {
					assertBugStatusOwnership("forge_commit", "fixed");
				}
			} catch (err) {
				if (err instanceof PhaseOwnershipError) return errResult(err.message);
				throw err;
			}

			const toolPath = path.join(toolDir, "commit-task.cjs");
			const argv: string[] = [`--${params.entity}`, params.id, "--message", params.message];
			if (params.trailer) argv.push("--trailer", params.trailer);
			for (const p of params.also ?? []) argv.push("--also", p);
			if (params.dryRun) argv.push("--dry-run");
			if (params.skipGate) argv.push("--skip-gate");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 30_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_commit failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_store ──────────────────────────────────────────────────────────────

function buildForgeStore(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_store",
		label: "Forge Store",
		description: FORGE_STORE_DESCRIPTION,
		promptSnippet:
			"Use forge_store for store CRUD. Direct cjs exec — no shell, no bash. " +
			"Canonical write form is 2-positional: {command:'write', args:['<entity>','<json>']}. " +
			"Call forge_store_template first to get the json shape.",
		parameters: Type.Object({
			command: Type.String({
				description:
					"store-cli subcommand: write|read|list|delete|update-status|emit|merge-sidecar|record-usage|purge-events|write-collation-state|validate|set-summary|set-bug-summary|progress|progress-clear|describe|template",
			}),
			args: Type.Array(Type.String(), {
				description:
					"Positional + flag args after the subcommand. Examples: " +
					"write → ['sprint', '{\"sprintId\":\"X-S01\",...}'] (2-arg, id in json). " +
					"read → ['task', 'FORGE-S16-T03', '--json']. " +
					"update-status → ['task', 'FORGE-S16-T03', 'status', 'committed'].",
			}),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "Pass --dry-run flag (validate without writing).",
				}),
			),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { command: string; args: string[]; dryRun?: boolean };

			// FORGE-BUG-040: phase-ownership guards on the bug-mutating verbs.
			// Subagent callers must call only the verb for their own phase;
			// orchestrator callers are unaffected. Status-derived guards
			// (update-status bug X status fixed ↔ commit phase) are encoded
			// in assertBugStatusOwnership; phase-event emits are
			// orchestrator-only via assertOrchestratorOnlyEmit.
			try {
				if (params.command === "set-bug-summary" || params.command === "set-summary") {
					// args shape (set-bug-summary): [<id>, <phase>, <jsonFile>]
					const namedPhase = params.args[1];
					if (namedPhase) assertPhaseOwnership(`forge_store ${params.command}`, namedPhase);
				} else if (params.command === "update-status") {
					// args shape: [<entity>, <id>, <field>, <value>, ...]
					if (params.args[0] === "bug" && params.args[2] === "status" && params.args[3]) {
						assertBugStatusOwnership("forge_store update-status bug", params.args[3]);
					}
				} else if (params.command === "emit") {
					assertOrchestratorOnlyEmit("forge_store emit");
				}
			} catch (err) {
				if (err instanceof PhaseOwnershipError) return errResult(err.message);
				throw err;
			}

			const toolPath = path.join(toolDir, "store-cli.cjs");
			const argv: string[] = [params.command, ...params.args];
			if (params.dryRun) argv.push("--dry-run");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);
				if (params.command === "read") {
					const { text, stats } = compressWithTelemetry(stdout, "store:read", compressEntity);
					return okResult(text, stats);
				}
				if (params.command === "list") {
					const { text, stats } = compressWithTelemetry(stdout, "store:list", compressEntityList);
					return okResult(text, stats);
				}
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_store failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_validate_store ─────────────────────────────────────────────────────

function buildForgeValidateStore(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_validate_store",
		label: "Forge Validate Store",
		description: FORGE_VALIDATE_STORE_DESCRIPTION,
		promptSnippet: "Use forge_validate_store to check the Forge store for integrity issues.",
		parameters: Type.Object({
			fix: Type.Optional(
				Type.Boolean({
					description: "Attempt to auto-fix recoverable issues.",
				}),
			),
			json: Type.Optional(
				Type.Boolean({
					description: "Output results as JSON.",
				}),
			),
			dryRun: Type.Optional(
				Type.Boolean({
					description: "Validate only, no writes.",
				}),
			),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { fix?: boolean; json?: boolean; dryRun?: boolean };
			const toolPath = path.join(toolDir, "validate-store.cjs");
			const argv: string[] = [];
			if (params.fix) argv.push("--fix");
			if (params.json) argv.push("--json");
			if (params.dryRun) argv.push("--dry-run");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);
				const { text, stats } = compressWithTelemetry(stdout, "validate", compressValidateStore);
				return okResult(text, stats);
			} catch (err: unknown) {
				const e = err as {
					code?: number | string;
					stdout?: string;
					stderr?: string;
					message?: string;
				};
				// Exit code 1 is informational: validation found errors.
				// Node sets `.code` to a NUMBER for normal non-zero exits.
				// For spawn errors (ENOENT, ETIMEDOUT), `.code` is a STRING.
				// The numeric check correctly excludes string codes (ENOENT etc.)
				// which must still be treated as hard failures.
				if (typeof e.code === "number" && e.code === 1) {
					const output = [e.stdout, e.stderr].filter(Boolean).join("\n");
					const { text, stats } = compressWithTelemetry(
						output || "Validation errors found.",
						"validate",
						compressValidateStore,
					);
					return okResult(text, stats);
				}
				// Real failure: ENOENT, timeout, SIGKILL, etc.
				return errResult(`forge_validate_store failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_config ─────────────────────────────────────────────────────────────

function buildForgeConfig(toolDir: string, projectRoot: string): ToolDefinition {
	// Subcommand union verified against manage-config.cjs source dispatch
	// (FORGE-S16-T03 PLAN_REVIEW advisory #4, pre-flight grep):
	// handles exactly: get, list-pipelines, pipeline, set, resolve-forge-root.
	return {
		name: "forge_config",
		label: "Forge Config",
		description: FORGE_CONFIG_DESCRIPTION,
		promptSnippet: "Use forge_config to read or update Forge project configuration.",
		parameters: Type.Object({
			subcommand: Type.Union(
				[
					Type.Literal("get"),
					Type.Literal("set"),
					Type.Literal("list-pipelines"),
					Type.Literal("pipeline"),
					Type.Literal("resolve-forge-root"),
				],
				{ description: "manage-config subcommand." },
			),
			args: Type.Array(Type.String(), {
				description:
					"Additional arguments. For 'get': ['paths.forgeRoot']. For 'set': ['project.name', '\"MyProject\"'].",
			}),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { subcommand: string; args: string[] };
			const toolPath = path.join(toolDir, "manage-config.cjs");
			const argv: string[] = [params.subcommand, ...params.args];

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 5_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_config failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_store_describe ─────────────────────────────────────────────────────

const STORE_ENTITIES = Type.Union(
	[Type.Literal("sprint"), Type.Literal("task"), Type.Literal("bug"), Type.Literal("event"), Type.Literal("feature")],
	{ description: "Forge store entity type." },
);

function buildForgeStoreDescribe(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_store_describe",
		label: "Forge Store Describe",
		description: FORGE_STORE_DESCRIBE_DESCRIPTION,
		promptSnippet:
			"Use forge_store_describe to fetch the JSON Schema for sprint/task/bug/event/feature before constructing a record.",
		parameters: Type.Object({
			entity: STORE_ENTITIES,
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { entity: string };
			const toolPath = path.join(toolDir, "store-cli.cjs");
			try {
				const { stdout } = await runCjs(toolPath, ["describe", params.entity], signal, 5_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_store_describe failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_store_template ─────────────────────────────────────────────────────

function buildForgeStoreTemplate(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_store_template",
		label: "Forge Store Template",
		description: FORGE_STORE_TEMPLATE_DESCRIPTION,
		promptSnippet:
			"Use forge_store_template to get a canonical sample for sprint/task/bug/event/feature — copy the shape, replace placeholders.",
		parameters: Type.Object({
			entity: STORE_ENTITIES,
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { entity: string };
			const toolPath = path.join(toolDir, "store-cli.cjs");
			try {
				const { stdout } = await runCjs(toolPath, ["template", params.entity], signal, 5_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_store_template failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_store_query ────────────────────────────────────────────────────────

function buildForgeStoreQuery(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_store_query",
		label: "Forge Store Query",
		description: FORGE_STORE_QUERY_DESCRIPTION,
		promptSnippet:
			'Use forge_store_query to search the store. nlp "<intent>" finds tasks/bugs/sprints/features by natural language; ' +
			"schema returns entity/status/FK reference; query with flags for structured filters.",
		parameters: Type.Object({
			command: Type.Union([Type.Literal("query"), Type.Literal("nlp"), Type.Literal("schema")], {
				description:
					"store-query subcommand: query (flag-based filters), nlp (natural-language intent), schema (project meta reference).",
			}),
			args: Type.Array(Type.String(), {
				description:
					"Positional and flag arguments after the subcommand. " +
					"For 'nlp': a single quoted intent string. " +
					"For 'query': flag pairs e.g. ['--sprint','FORGE-S19','--status','active','--with-blockers']. " +
					"For 'schema': empty array.",
			}),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { command: string; args: string[] };
			const toolPath = path.join(toolDir, "store-cli.cjs");
			const argv: string[] = [params.command, ...params.args];
			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);
				if (params.command === "schema") return okResult(stdout);
				const { text, stats } = compressWithTelemetry(stdout, "query", compressStoreQuery);
				return okResult(text, stats);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_store_query failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_verify_apply (forge-cli#31) ────────────────────────────────────────
//
// Detects hallucinated Edit calls — when the agent claims to have modified a
// file but the actual on-disk content is unchanged.
//
// Thin runCjs shim delegating to plugin verify-apply.cjs (FORGE-S26-T16).
// Previously contained inline spawnSync loop; that logic now lives in the
// plugin as the canonical implementation.
//
// Output schema (JSON string):
//   {
//     "modified":  ["<path>", ...],   // verified — content differs from manifest baseline (exit 1)
//     "unchanged": ["<path>", ...],   // pristine — agent claim was wrong (exit 0)
//     "untracked": ["<path>", ...],   // no manifest entry — ambiguous
//     "missing":   ["<path>", ...]    // file doesn't exist
//   }
//
// Exit semantics from generation-manifest.cjs check:
//   0 = pristine     → file matches recorded hash, NO change → "unchanged"
//   1 = modified     → file differs from recorded hash → "modified" (verified ✓)
//   2 = untracked    → no manifest entry → "untracked"
//   3 = file missing → "missing"
function buildForgeVerifyApply(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_verify_apply",
		label: "Forge Verify Apply",
		description: FORGE_VERIFY_APPLY_DESCRIPTION,
		promptSnippet:
			"After Phase 2 apply, call forge_verify_apply with the list of claimed file paths. " +
			"If `unchanged` is non-empty, re-apply those edits before snapshot.",
		parameters: Type.Object({
			claimed_paths: Type.Array(Type.String(), {
				description:
					"Project-root-relative paths of files you claim to have modified (e.g. " +
					"['.forge/personas/architect.md', '.forge/skills/engineer-skills.md']). Paths " +
					"outside .forge/{personas,skills,workflows,templates}/ are accepted but classified " +
					"according to manifest state regardless.",
			}),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { claimed_paths: string[] };
			const toolPath = path.join(toolDir, "verify-apply.cjs");
			if (!existsSync(toolPath)) {
				return errResult(`forge_verify_apply failed: verify-apply.cjs not found at ${toolPath}`);
			}
			try {
				const { stdout } = await runCjs(toolPath, params.claimed_paths, signal, 30_000, projectRoot);
				return okResult(stdout.trim() || "{}");
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_verify_apply failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}

// ── forge_preflight ─────────────────────────────────────────────────────────

function buildForgePreflight(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_preflight",
		label: "Forge Preflight Gate",
		description: FORGE_PREFLIGHT_DESCRIPTION,
		promptSnippet:
			"Use forge_preflight instead of shelling out to preflight-gate.cjs. " +
			"Do NOT resolve $FORGE_ROOT manually — this tool handles it.",
		parameters: Type.Object({
			phase: Type.String({
				description:
					"Phase name: plan, review-plan, implement, review-code, validate, approve, commit, writeback, triage.",
			}),
			task: Type.Optional(
				Type.String({
					description: "Task ID (e.g. HELLO-S01-T04). Required for task phases.",
				}),
			),
			bug: Type.Optional(
				Type.String({
					description: "Bug ID (e.g. HELLO-B03). Required for bug phases.",
				}),
			),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { phase: string; task?: string; bug?: string };

			// FORGE-BUG-040: phase-ownership guard. From a subagent caller,
			// reject any preflight whose --phase argument does not match the
			// caller's phase tag. Orchestrator callers are unaffected.
			try {
				assertPhaseOwnership("forge_preflight", params.phase);
			} catch (err) {
				if (err instanceof PhaseOwnershipError) return errResult(err.message);
				throw err;
			}

			const toolPath = path.join(toolDir, "preflight-gate.cjs");
			const argv: string[] = ["--phase", params.phase];
			if (params.task) argv.push("--task", params.task);
			if (params.bug) argv.push("--bug", params.bug);

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);
				return okResult(stdout || "Preflight passed.");
			} catch (err: unknown) {
				const e = err as { message?: string; stdout?: string };
				return errResult(e.stdout || e.message || "Preflight gate failed.");
			}
		},
	};
}

// ── forge_banner ────────────────────────────────────────────────────────────

function buildForgeBanner(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_banner",
		label: "Forge Banner",
		description: FORGE_BANNER_DESCRIPTION,
		promptSnippet: "Use forge_banner instead of shelling out to banners.cjs.",
		parameters: Type.Object({
			name: Type.String({
				description: "Banner name (e.g. forge, ember, lumen).",
			}),
		}),
		async execute(_toolCallId, _params, signal) {
			const params = _params as { name: string };
			const toolPath = path.join(toolDir, "banners.cjs");

			try {
				const { stdout } = await runCjs(toolPath, [params.name], signal, 5_000, projectRoot);
				return okResult(stdout);
			} catch (err: unknown) {
				const e = err as { message?: string };
				return errResult(`forge_banner failed: ${e.message ?? "unknown error"}`);
			}
		},
	};
}
