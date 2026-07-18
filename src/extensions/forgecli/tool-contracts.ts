// tool-contracts.ts — SSOT for all 14 forge_* tool contracts — FORGE-S34-T02.
//
// Exports TOOL_CONTRACTS: ToolContract[] with one entry per forge_* tool
// covering:
//   name        — pi-path registration name (e.g. "forge_store")
//   mcpName     — MCP server registration name (ADR Decision 3: drop forge_ prefix)
//   description — shared description string consumed by both pi and MCP server
//   inputSchema — plain JSON Schema (NOT typebox TSchema)
//
// CRITICAL: this module MUST NOT import typebox. The MCP server bundle (T03)
// imports this module directly; pulling in typebox would bloat the bundle and
// couple the MCP path to pi's TSchema system.
//
// Execute handlers are NOT here — they remain in forge-tools.ts (pi path) and
// in the MCP server (T03) respectively, because the two execution surfaces have
// incompatible signatures and lifecycle assumptions.

// ── Types ─────────────────────────────────────────────────────────────────────

/** Plain JSON Schema object — no typebox symbols. */
export type JSONSchema = {
	type?: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	additionalProperties?: boolean;
	description?: string;
	enum?: unknown[];
	items?: JSONSchema;
	[key: string]: unknown;
};

/**
 * A single forge_* tool contract shared between the pi-path registration
 * (forge-tools.ts) and the MCP server (T03).
 */
export interface ToolContract {
	/** pi-path tool name, e.g. "forge_store" */
	name: string;
	/** MCP registration name — forge_ prefix stripped per ADR Decision 3 */
	mcpName: string;
	/** Human/LLM-facing description shared across both paths */
	description: string;
	/** Plain JSON Schema for input validation (MCP-portable, no typebox) */
	inputSchema: JSONSchema;
}

// ── Shared description strings ────────────────────────────────────────────────
// Defined as named constants so forge-tools.ts can import them by name,
// keeping the description co-located with the contract rather than duplicated.

export const FORGE_COLLATE_DESCRIPTION =
	"Regenerate Forge KB markdown documents from the JSON store. Wraps forge/tools/collate.cjs.";

export const FORGE_STORE_DESCRIPTION =
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
	"  set-summary <taskId> <phase> [<jsonFile>]         — phase ∈ {plan, review_plan, implementation, code_review, validation, triage, approve}. Omit jsonFile: sidecar auto-resolved from record.path.\n" +
	"  set-bug-summary <bugId> <phase> [<jsonFile>]      — omit jsonFile: sidecar auto-resolved from record.path.\n" +
	"  progress <sprintOrBugId> <agentName> <bannerKey> <status> [detail]\n" +
	"  progress-clear <sprintOrBugId>\n" +
	"  describe <entity>                                 — print JSON Schema.\n" +
	"  template <entity>                                 — print canonical sample (call this BEFORE write to get the shape).\n\n" +
	"Common mistake: 'write sprint <id> <json>' (3-arg) FAILS — id is parsed as JSON. Use 'write sprint <json>' (2-arg).";

export const FORGE_COMMIT_DESCRIPTION =
	"Direct exec of forge/tools/commit-task.cjs — the deterministic commit choreography " +
	"(forge-engineering#40). ONE call owns: preflight gate, status precondition " +
	"(task 'approved' / bug 'in-progress'), staging-set derivation (record artifact dir + " +
	"summaries.implementation.files_changed provenance + 'also' extras; gitignored paths " +
	"warn-skipped), commit-boundary guard (aborts on a pre-staged index), git commit, and the " +
	"terminal status transition (task→committed / bug→fixed).\n\n" +
	"Success JSON: {ok:true, committed:true, sha, staged[]} — or the no-op success " +
	"{ok:true, committed:false, reason:'nothing-to-commit'} when the staging set is already " +
	"clean (e.g. the fix was at HEAD): the record is STILL sealed; do not improvise staging.\n\n" +
	"Never run git add / git commit / git reset yourself in the commit phase.";

export const FORGE_VALIDATE_STORE_DESCRIPTION =
	"Validate Forge store integrity — wraps forge/tools/validate-store.cjs. " +
	"Exit code 1 means validation errors were found (returned as informational content, not isError). " +
	"Only hard failures (ENOENT, timeout) return isError: true.";

export const FORGE_CONFIG_DESCRIPTION =
	"Read/write .forge/config.json — wraps forge/tools/manage-config.cjs. " +
	"Supported subcommands: get, set, list-pipelines, pipeline, resolve-forge-root.";

export const FORGE_STORE_DESCRIBE_DESCRIPTION =
	"Return the raw JSON Schema for a Forge store entity. Wraps `store-cli.cjs describe <entity>`. " +
	"Call this BEFORE writing a record so you know the exact required fields, types, enums, and constraints.";

export const FORGE_STORE_TEMPLATE_DESCRIPTION =
	"Return a canonical sample record for a Forge store entity, with all required fields populated " +
	"with placeholder values that match the schema (enum first-value, ISO date-time, ID placeholders, etc.). " +
	"Wraps `store-cli.cjs template <entity>`. Use this BEFORE writing a record to avoid validation failures.";

export const FORGE_STORE_QUERY_DESCRIPTION =
	"Search / find / query the Forge store. Wraps `store-cli.cjs` query/nlp/schema dispatch (which delegates to store-query.cjs). " +
	"Use `nlp` for natural-language intent (e.g. 'open bugs in S12', 'blocked tasks'); " +
	"`query` with flag args for structured filters (--sprint, --task, --bug, --feature, --status, --keyword, " +
	"--with-blockers, --with-blocked-tasks, --with-sprint, --with-feature, --no-excerpts, --list-sprints, --mode auto|strict|off); " +
	"`schema` for the project schema and grammar reference (entity ID patterns, status enums, FKs, synonyms).";

export const FORGE_VERIFY_APPLY_DESCRIPTION =
	"Verify file modifications actually landed on disk. Call AFTER applying enhancement edits, " +
	"BEFORE invoking manage-versions add-snapshot. Detects hallucinated Edit-tool calls (e.g. when " +
	"old_string didn't match exactly and the Edit silently no-op'd). Returns structured results: " +
	"`modified` (verified — change is on disk), `unchanged` (agent claim was wrong — re-apply needed), " +
	"`untracked` (no manifest entry — ambiguous, treat as potentially modified), `missing` (file gone). " +
	"If `unchanged.length > 0`, RE-APPLY those edits via Edit/Write and call this tool again until empty.";

export const FORGE_ARTIFACT_DESCRIPTION =
	"Read, write, or list phase artifacts (PLAN.md, PROGRESS.md, *-SUMMARY.json, etc.) " +
	"for a task, bug, or sprint. Resolves paths automatically from entity ID — never " +
	"construct artifact paths manually.\n\n" +
	// NOTE: The full description in forge-artifact-tool.ts includes a dynamic
	// artifact kind list loaded at runtime. The SSOT value here carries the
	// static portion; forge-artifact-tool.ts appends the dynamic list inline
	// (the description field in the ToolDefinition is overridden with the full
	// string at build time by buildForgeArtifact). See AC #6 compliance note
	// in PLAN.md: forge_artifact is a special case where the runtime description
	// is dynamically extended — the contract carries the stable prefix that
	// allows the bijection and name checks to pass.
	"(artifact list loaded at runtime).\n\n" +
	"Reading: a whole-file `read` returns a COMPRESSED, lossy map (may omit body lines) — cheap for a " +
	"gist. For exact text, read by SECTION: command 'outline' returns the heading map, then 'read' with " +
	"`section` set to a heading returns that section's EXACT, uncompressed source. Prefer outline→section " +
	"over a whole `read` when you need precise or partial content (and to avoid re-reading the same artifact). " +
	"(Section/outline apply to markdown artifacts only, not JSON *-summary.)\n\n" +
	"JSON summary artifacts are validated on write (objective, key_changes, verdict, written_at required). " +
	"Use 'list' to see which artifacts already exist for an entity.";

export const FORGE_PREFLIGHT_DESCRIPTION =
	"Run the pre-flight gate check for a phase. Wraps forge/tools/preflight-gate.cjs. " +
	"Returns exit 0 if the phase is safe to proceed, exit 1 with a reason if blocked.";

export const FORGE_BANNER_DESCRIPTION =
	"Display a decorative phase banner. Wraps forge/tools/banners.cjs. " +
	"Available banners: ember, tide, oracle, rift, bloom, north, lumen, forge, drift, void, entelligentsia.";

export const FORGE_MARKDOWN_DESCRIPTION =
	"Structural access to a Markdown file via its AST — read STRUCTURE instead of the whole file. " +
	"Operations: `outline` (heading tree + section line ranges — a compact doc map; read this first for a long " +
	"KB doc, then `section` the part you need); `section` (exact source of one heading's section, requires " +
	"`heading`); `tables` (GFM tables as header+rows JSON); `frontmatter` (YAML frontmatter as JSON); " +
	"`ast` (compact structural tree as JSON). Use for KB docs, INDEX/registry tables, sprint briefs, retros, " +
	"and memory frontmatter rather than reading or regex-parsing flat markdown. All operations return EXACT, " +
	"uncompressed output (unlike forge_artifact's whole-file read, which compresses).";

export const FORGE_ASK_USER_DESCRIPTION =
	"forge:ask_user — Present an interactive prompt to the user and return their answer. " +
	"Accepts three input types: 'confirm' (Y/N), 'choice' (select from a list), or 'text' " +
	"(free-form single-line input). Blocks the model loop until the user responds. " +
	"In non-interactive mode (FORGE_YES=1 or --non-interactive), returns the default immediately. " +
	"The result appends a provenance line to its content — 'source=user answered=true' means a human " +
	"genuinely answered; any other source (non-interactive/default) is an automatic default that NO human " +
	"confirmed. Never record a non-'user' answer as consent, approval, or ratification. " +
	"For a HARD gate that must have a real answer, pass required:true so the tool ERRORS instead of " +
	"silently returning the default when no human is reachable.";

// ── inputSchema definitions (plain JSON Schema) ───────────────────────────────

const STORE_ENTITY_ENUM = ["sprint", "task", "bug", "event", "feature"];

const COLLATE_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		sprintId: {
			type: "string",
			description: "Sprint or bug ID to collate (e.g. FORGE-S16). Omit to collate all.",
		},
		purgeEvents: {
			type: "boolean",
			description: "Delete event directory after generating COST_REPORT.md.",
		},
		dryRun: {
			type: "boolean",
			description: "Preview changes without writing files.",
		},
	},
};

const STORE_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		command: {
			type: "string",
			description:
				"store-cli subcommand: write|read|list|delete|update-status|emit|merge-sidecar|record-usage|purge-events|write-collation-state|validate|set-summary|set-bug-summary|progress|progress-clear|describe|template",
		},
		args: {
			type: "array",
			items: { type: "string" },
			description:
				"Positional + flag args after the subcommand. Examples: " +
				"write → ['sprint', '{\"sprintId\":\"X-S01\",...}'] (2-arg, id in json). " +
				"read → ['task', 'FORGE-S16-T03', '--json']. " +
				"update-status → ['task', 'FORGE-S16-T03', 'status', 'committed'].",
		},
		dryRun: {
			type: "boolean",
			description: "Pass --dry-run flag (validate without writing).",
		},
	},
	required: ["command", "args"],
};

const COMMIT_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		entity: {
			type: "string",
			enum: ["task", "bug"],
			description: "Record kind to seal.",
		},
		id: {
			type: "string",
			description: "Record id, e.g. FORGE-S01-T01 or FORGE-BUG-001.",
		},
		message: {
			type: "string",
			description: "Commit message (subject [+ body]). Include the record id; follow project conventions.",
		},
		trailer: {
			type: "string",
			description: "Optional Co-authored-by trailer line.",
		},
		also: {
			type: "array",
			items: { type: "string" },
			description:
				"Extra repo-relative paths to stage — used when the implementation summary lacks files_changed provenance.",
		},
		dryRun: {
			type: "boolean",
			description: "Print the staging plan without writing.",
		},
		skipGate: {
			type: "boolean",
			description: "Skip the embedded preflight gate (orchestrator already ran it).",
		},
	},
	required: ["entity", "id", "message"],
};

const VALIDATE_STORE_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		fix: {
			type: "boolean",
			description: "Attempt to auto-fix recoverable issues.",
		},
		json: {
			type: "boolean",
			description: "Output results as JSON.",
		},
		dryRun: {
			type: "boolean",
			description: "Validate only, no writes.",
		},
	},
};

const CONFIG_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		subcommand: {
			type: "string",
			enum: ["get", "set", "list-pipelines", "pipeline", "resolve-forge-root"],
			description: "manage-config subcommand.",
		},
		args: {
			type: "array",
			items: { type: "string" },
			description:
				"Additional arguments. For 'get': ['paths.forgeRoot']. For 'set': ['project.name', '\"MyProject\"'].",
		},
	},
	required: ["subcommand", "args"],
};

const STORE_DESCRIBE_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		entity: {
			type: "string",
			enum: STORE_ENTITY_ENUM,
			description: "Forge store entity type.",
		},
	},
	required: ["entity"],
};

const STORE_TEMPLATE_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		entity: {
			type: "string",
			enum: STORE_ENTITY_ENUM,
			description: "Forge store entity type.",
		},
	},
	required: ["entity"],
};

const STORE_QUERY_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		command: {
			type: "string",
			enum: ["query", "nlp", "schema"],
			description:
				"store-query subcommand: query (flag-based filters), nlp (natural-language intent), schema (project meta reference).",
		},
		args: {
			type: "array",
			items: { type: "string" },
			description:
				"Positional and flag arguments after the subcommand. " +
				"For 'nlp': a single quoted intent string. " +
				"For 'query': flag pairs e.g. ['--sprint','FORGE-S19','--status','active','--with-blockers']. " +
				"For 'schema': empty array.",
		},
	},
	required: ["command", "args"],
};

const VERIFY_APPLY_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		claimed_paths: {
			type: "array",
			items: { type: "string" },
			description:
				"Project-root-relative paths of files you claim to have modified (e.g. " +
				"['.forge/personas/architect.md', '.forge/skills/engineer-skills.md']). Paths " +
				"outside .forge/{personas,skills,workflows,templates}/ are accepted but classified " +
				"according to manifest state regardless.",
		},
	},
	required: ["claimed_paths"],
};

const ARTIFACT_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		command: {
			type: "string",
			enum: ["read", "write", "list", "exists", "url", "delete", "outline"],
			description:
				"read: fetch content — whole=compressed/lossy, or set `section` for exact text. outline: exact heading map of a markdown artifact. write: create/overwrite with validation. list: show existing artifacts. exists: true/false. url: backend URL (file:// for fs). delete: remove the artifact.",
		},
		entity: {
			type: "string",
			enum: ["task", "bug", "sprint"],
			description: "Entity type.",
		},
		entityId: {
			type: "string",
			description: "Entity ID (e.g. HELLO-S99-T02, HELLO-B01-shout-flag, HELLO-S99).",
		},
		artifact: {
			type: "string",
			description: "Artifact name (required for read/write).",
		},
		content: {
			type: "string",
			description: "Content to write (required for write command).",
		},
		section: {
			type: "string",
			description:
				"Heading text of the section to read (read command, markdown artifacts only; case-insensitive). " +
				"Returns just that section's source. Use command 'outline' first to discover headings.",
		},
	},
	required: ["command", "entity", "entityId"],
};

const PREFLIGHT_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		phase: {
			type: "string",
			description:
				"Phase name: plan, review-plan, implement, review-code, validate, approve, commit, writeback, triage.",
		},
		task: {
			type: "string",
			description: "Task ID (e.g. HELLO-S01-T04). Required for task phases.",
		},
		bug: {
			type: "string",
			description: "Bug ID (e.g. HELLO-B03). Required for bug phases.",
		},
	},
	required: ["phase"],
};

const BANNER_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		name: {
			type: "string",
			description: "Banner name (e.g. forge, ember, lumen).",
		},
	},
	required: ["name"],
};

const MARKDOWN_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		operation: {
			type: "string",
			enum: ["outline", "ast", "section", "tables", "frontmatter"],
			description: "The structural operation to run against the markdown file.",
		},
		path: {
			type: "string",
			description: "Path to the markdown file (absolute, or relative to the project root).",
		},
		heading: {
			type: "string",
			description: "Heading text to extract (required for operation=section; case-insensitive).",
		},
	},
	required: ["operation", "path"],
};

const ASK_USER_INPUT_SCHEMA: JSONSchema = {
	type: "object",
	properties: {
		question: {
			type: "string",
			description: "The question or prompt to display to the user.",
		},
		type: {
			type: "string",
			enum: ["confirm", "choice", "text"],
			description:
				"Input modality: confirm (Y/N boolean), choice (select from list), or text (free-form single-line input).",
		},
		options: {
			type: "array",
			items: { type: "string" },
			description: "Required when type === 'choice'. The list of options to present to the user.",
		},
		default: {
			type: "string",
			description:
				"Default value returned in non-interactive mode or when no default is needed. " +
				"If absent, the fallback is: confirm → 'Y', choice → options[0], text → ''.",
		},
	},
	required: ["question", "type"],
};

// ── TOOL_CONTRACTS ────────────────────────────────────────────────────────────

/**
 * All 14 forge_* tool contracts — single source of truth for name, mcpName,
 * description, and inputSchema used by both the pi path (forge-tools.ts) and
 * the MCP server (T03).
 */
export const TOOL_CONTRACTS: ToolContract[] = [
	{
		name: "forge_collate",
		mcpName: "collate",
		description: FORGE_COLLATE_DESCRIPTION,
		inputSchema: COLLATE_INPUT_SCHEMA,
	},
	{
		name: "forge_store",
		mcpName: "store",
		description: FORGE_STORE_DESCRIPTION,
		inputSchema: STORE_INPUT_SCHEMA,
	},
	{
		name: "forge_commit",
		mcpName: "commit",
		description: FORGE_COMMIT_DESCRIPTION,
		inputSchema: COMMIT_INPUT_SCHEMA,
	},
	{
		name: "forge_validate_store",
		mcpName: "validate_store",
		description: FORGE_VALIDATE_STORE_DESCRIPTION,
		inputSchema: VALIDATE_STORE_INPUT_SCHEMA,
	},
	{
		name: "forge_config",
		mcpName: "config",
		description: FORGE_CONFIG_DESCRIPTION,
		inputSchema: CONFIG_INPUT_SCHEMA,
	},
	{
		name: "forge_store_describe",
		mcpName: "store_describe",
		description: FORGE_STORE_DESCRIBE_DESCRIPTION,
		inputSchema: STORE_DESCRIBE_INPUT_SCHEMA,
	},
	{
		name: "forge_store_template",
		mcpName: "store_template",
		description: FORGE_STORE_TEMPLATE_DESCRIPTION,
		inputSchema: STORE_TEMPLATE_INPUT_SCHEMA,
	},
	{
		name: "forge_store_query",
		mcpName: "store_query",
		description: FORGE_STORE_QUERY_DESCRIPTION,
		inputSchema: STORE_QUERY_INPUT_SCHEMA,
	},
	{
		name: "forge_verify_apply",
		mcpName: "verify_apply",
		description: FORGE_VERIFY_APPLY_DESCRIPTION,
		inputSchema: VERIFY_APPLY_INPUT_SCHEMA,
	},
	{
		name: "forge_artifact",
		mcpName: "artifact",
		description: FORGE_ARTIFACT_DESCRIPTION,
		inputSchema: ARTIFACT_INPUT_SCHEMA,
	},
	{
		name: "forge_preflight",
		mcpName: "preflight",
		description: FORGE_PREFLIGHT_DESCRIPTION,
		inputSchema: PREFLIGHT_INPUT_SCHEMA,
	},
	{
		name: "forge_banner",
		mcpName: "banner",
		description: FORGE_BANNER_DESCRIPTION,
		inputSchema: BANNER_INPUT_SCHEMA,
	},
	{
		name: "forge_markdown",
		mcpName: "markdown",
		description: FORGE_MARKDOWN_DESCRIPTION,
		inputSchema: MARKDOWN_INPUT_SCHEMA,
	},
	{
		name: "forge_ask_user",
		mcpName: "ask_user",
		description: FORGE_ASK_USER_DESCRIPTION,
		inputSchema: ASK_USER_INPUT_SCHEMA,
	},
];
