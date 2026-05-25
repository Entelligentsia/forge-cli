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
import { buildForgeArtifact } from "./forge-artifact-tool.js";
import { execFileAsync } from "./lib/exec-helpers.js";
// FORGE-S25-T22 (N-C-D): adopt shared resolveToolDir from store-resolver instead of duplicating.
// The private copy was identical to store-resolver.resolveToolDir; deleted per R2 Pass-3 scope-corrected.
import { resolveToolDir } from "./store-resolver.js";

// ── Shared helper ────────────────────────────────────────────────────────────

/**
 * runCjs — shared execFileAsync wrapper for all four .cjs tool invocations.
 *
 * Implements DRY: AbortSignal propagation, timeout, cwd binding, and
 * stdout/stderr capture are applied consistently across all tools.
 *
 * Timeout guidance: collate 30s (large stores); store/validate 10s; config 5s.
 *
 * @param toolPath    Absolute path to the .cjs tool.
 * @param argv        Arguments to pass after "node <toolPath>".
 * @param signal      AbortSignal from tool execute — propagated to subprocess.
 * @param timeoutMs   Subprocess timeout in milliseconds.
 * @param projectRoot Directory containing .forge/ — cwd for the subprocess so
 *                    findProjectRoot() in the .cjs tool resolves correctly.
 */
async function runCjs(
	toolPath: string,
	argv: string[],
	signal: AbortSignal | undefined,
	timeoutMs: number,
	projectRoot: string,
): Promise<{ stdout: string; stderr: string }> {
	const opts: Parameters<typeof execFileAsync>[2] = {
		cwd: projectRoot,
		encoding: "utf8",
		timeout: timeoutMs,
	};
	// AbortSignal is optional — only pass when defined (execFile rejects if
	// signal is undefined and the type expects AbortSignal | undefined).
	if (signal !== undefined) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(opts as any).signal = signal;
	}
	const result = await execFileAsync("node", [toolPath, ...argv], opts);
	return {
		stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8"),
		stderr: typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8"),
	};
}

// ── Result helpers ───────────────────────────────────────────────────────────

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

// ── Tool definition set ─────────────────────────────────────────────────────

export interface ForgeToolDefs {
	store: ToolDefinition;
	collate: ToolDefinition;
	validateStore: ToolDefinition;
	config: ToolDefinition;
	storeDescribe: ToolDefinition;
	storeTemplate: ToolDefinition;
	storeQuery: ToolDefinition;
	verifyApply: ToolDefinition;
	artifact: ToolDefinition;
}

/**
 * Return the subset of forge tool definitions suitable for subagent injection.
 * Core store tools go to every persona; forge_collate only to the collator.
 */
export function getSubagentTools(defs: ForgeToolDefs, personaName?: string): ToolDefinition[] {
	const tools: ToolDefinition[] = [defs.store, defs.storeDescribe, defs.storeTemplate, defs.storeQuery, defs.artifact];
	if (personaName === "collator") tools.push(defs.collate);
	return tools;
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
		validateStore: buildForgeValidateStore(toolDir, projectRoot),
		config: buildForgeConfig(toolDir, projectRoot),
		storeDescribe: buildForgeStoreDescribe(toolDir, projectRoot),
		storeTemplate: buildForgeStoreTemplate(toolDir, projectRoot),
		storeQuery: buildForgeStoreQuery(toolDir, projectRoot),
		verifyApply: buildForgeVerifyApply(toolDir, projectRoot),
		artifact: buildForgeArtifact(projectRoot, engineeringPath, toolDir),
	};
	for (const def of Object.values(defs)) {
		pi.registerTool(def);
	}
	registerForgeToolDiscipline(pi);
	return defs;
}

/**
 * Append the Forge tool-discipline block to every system prompt.
 *
 * Why: workflow text often refers to `forge_store ...` colloquially; without
 * this rule, models on some providers shell-bash `forge store ...`, which
 * spawns a fresh pi/agent loop per call — historically 26s+ cold-start vs
 * 50ms direct exec. The bin's fast-path makes shell-out cheap, but the
 * named MCP tools are still preferred (deterministic, schema-validated,
 * no subprocess overhead).
 */
function registerForgeToolDiscipline(pi: ExtensionAPI): void {
	// Guard: some test harnesses register a partial pi mock without `on`.
	// Discipline injection is non-critical for unit tests of tool wrappers.
	if (typeof pi.on !== "function") return;
	pi.on("before_agent_start", async (event) => {
		const discipline = `

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
- Never \`bash forge store ...\`. The bin has a fast-path that exec's store-cli.cjs
  directly (~50ms), but the named MCP tool is shorter, validated, and preferred.
- Workflow text saying \`forge_store write sprint '<json>'\` means: call the MCP tool
  \`forge_store\` with that 2-positional shape. Not a shell command.
`;
		const existing = event.systemPrompt ?? "";
		return { systemPrompt: existing + discipline };
	});
}

// ── forge_collate ────────────────────────────────────────────────────────────

function buildForgeCollate(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_collate",
		label: "Forge Collate",
		description: "Regenerate Forge KB markdown documents from the JSON store. Wraps forge/tools/collate.cjs.",
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

// ── forge_store ──────────────────────────────────────────────────────────────

function buildForgeStore(toolDir: string, projectRoot: string): ToolDefinition {
	return {
		name: "forge_store",
		label: "Forge Store",
		description:
			"Direct exec of forge/tools/store-cli.cjs. Deterministic CLI, no LLM, no agent loop. " +
			"store-cli enforces schema validation, status transitions, and path-traversal guards.\n\n" +
			"Canonical arg shapes (entity ∈ {sprint, task, bug, feature, event}):\n" +
			"  write <entity> '<json>'                          — 2 args. ID lives inside json. Do NOT pass id as a separate arg.\n" +
			"  read <entity> <id> [--json]                       — 2-3 args.\n" +
			"  list <entity> [key=value ...]                     — variadic filters.\n" +
			"  delete <entity> <id>                              — 2 args.\n" +
			"  update-status <entity> <id> <field> <value> [--force]\n" +
			"  emit <sprintId> '<json>' [--sidecar]              — 2-3 args. event json embeds eventId, taskId, sprintId.\n" +
			"  validate <entity> '<json>'                        — schema check, no write.\n" +
			"  set-summary <taskId> <phase> <jsonFile>           — phase ∈ {plan, review_plan, implementation, code_review, validation}.\n" +
			"  set-bug-summary <bugId> <phase> <jsonFile>\n" +
			"  progress <sprintOrBugId> <agentName> <bannerKey> <status> [detail]\n" +
			"  progress-clear <sprintOrBugId>\n" +
			"  describe <entity>                                 — print JSON Schema.\n" +
			"  template <entity>                                 — print canonical sample (call this BEFORE write to get the shape).\n\n" +
			"Common mistake: 'write sprint <id> <json>' (3-arg) FAILS — id is parsed as JSON. Use 'write sprint <json>' (2-arg).",
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
			const toolPath = path.join(toolDir, "store-cli.cjs");
			const argv: string[] = [params.command, ...params.args];
			if (params.dryRun) argv.push("--dry-run");

			try {
				const { stdout } = await runCjs(toolPath, argv, signal, 10_000, projectRoot);
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
		description:
			"Validate Forge store integrity — wraps forge/tools/validate-store.cjs. " +
			"Exit code 1 means validation errors were found (returned as informational content, not isError). " +
			"Only hard failures (ENOENT, timeout) return isError: true.",
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
				return okResult(stdout);
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
					return okResult(output || "Validation errors found.");
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
		description:
			"Read/write .forge/config.json — wraps forge/tools/manage-config.cjs. " +
			"Supported subcommands: get, set, list-pipelines, pipeline, resolve-forge-root.",
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
		description:
			"Return the raw JSON Schema for a Forge store entity. Wraps `store-cli.cjs describe <entity>`. " +
			"Call this BEFORE writing a record so you know the exact required fields, types, enums, and constraints.",
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
		description:
			"Return a canonical sample record for a Forge store entity, with all required fields populated " +
			"with placeholder values that match the schema (enum first-value, ISO date-time, ID placeholders, etc.). " +
			"Wraps `store-cli.cjs template <entity>`. Use this BEFORE writing a record to avoid validation failures.",
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
		description:
			"Query the Forge store. Wraps `store-cli.cjs` query/nlp/schema dispatch (which delegates to store-query.cjs). " +
			"Use `nlp` for natural-language intent (e.g. 'open bugs in S12', 'blocked tasks'); " +
			"`query` with flag args for structured filters (--sprint, --task, --bug, --feature, --status, --keyword, " +
			"--with-blockers, --with-blocked-tasks, --with-sprint, --with-feature, --no-excerpts, --list-sprints, --mode auto|strict|off); " +
			"`schema` for the project schema and grammar reference (entity ID patterns, status enums, FKs, synonyms).",
		promptSnippet:
			'Use forge_store_query nlp "<intent>" to find tasks/bugs/sprints/features by natural language, ' +
			"or forge_store_query schema for entity/status/FK reference, before constructing query args.",
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
				return okResult(stdout);
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
// file but the actual on-disk content is unchanged. Background: hello testbench
// 17:48 session showed the agent's "Files Modified" UI report claimed 5 edits
// applied; the snap-4 archive captured by add-snapshot afterwards showed only
// 1 of 5 files actually changed on disk. The other 4 were silent Edit-tool
// failures (typically old_string whitespace mismatches) the agent didn't notice.
//
// Contract: agent calls this tool AFTER applying edits, BEFORE calling
// manage-versions add-snapshot. Tool runs generation-manifest check on each
// claimed file and returns structured results. Agent uses the output to detect
// its own failures, re-apply hallucinated edits, then re-verify.
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
		description:
			"Verify file modifications actually landed on disk. Call AFTER applying enhancement edits, " +
			"BEFORE invoking manage-versions add-snapshot. Detects hallucinated Edit-tool calls (e.g. when " +
			"old_string didn't match exactly and the Edit silently no-op'd). Returns structured results: " +
			"`modified` (verified — change is on disk), `unchanged` (agent claim was wrong — re-apply needed), " +
			"`untracked` (no manifest entry — ambiguous, treat as potentially modified), `missing` (file gone). " +
			"If `unchanged.length > 0`, RE-APPLY those edits via Edit/Write and call this tool again until empty.",
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
			void signal;
			const manifestTool = path.join(toolDir, "generation-manifest.cjs");
			if (!existsSync(manifestTool)) {
				return errResult(`forge_verify_apply failed: generation-manifest.cjs not found at ${manifestTool}`);
			}

			const result: {
				modified: string[];
				unchanged: string[];
				untracked: string[];
				missing: string[];
			} = { modified: [], unchanged: [], untracked: [], missing: [] };

			const { spawnSync } = await import("node:child_process");
			for (const claimedPath of params.claimed_paths) {
				const r = spawnSync("node", [manifestTool, "check", claimedPath], {
					cwd: projectRoot,
					encoding: "utf8",
					timeout: 5_000,
				});
				switch (r.status) {
					case 0:
						result.unchanged.push(claimedPath);
						break;
					case 1:
						result.modified.push(claimedPath);
						break;
					case 2:
						result.untracked.push(claimedPath);
						break;
					case 3:
						result.missing.push(claimedPath);
						break;
					default:
						// Tool error — surface as missing for safety; the agent should investigate
						result.missing.push(claimedPath);
				}
			}

			return okResult(JSON.stringify(result, null, 2));
		},
	};
}
