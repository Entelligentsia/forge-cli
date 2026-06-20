// mcp/server.ts — stdio MCP server core for Forge (FORGE-S34-T03, T04).
//
// Registers all 14 forge_* tools from TOOL_CONTRACTS:
//   12 cjs-wrapper tools from cjs-handlers.ts
//   2 native tools: markdown (in-process remark AST) and ask_user (elicitation)
//
// ADR Decisions applied:
//   Decision 3: MCP names drop the forge_ prefix (collate, store, commit, …)
//   Decision 4: serverInstructions describe the Forge tool surface
//   Decision 5: forge_ask_user uses server.elicitInput() (form mode)
//   Decision 6: projectRoot resolved from CLAUDE_PROJECT_DIR with cwd fallback
//
// This module exports createForgeServer() for unit-test injection so the test
// harness can exercise registration + dispatch without a real subprocess.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOL_CONTRACTS } from "../tool-contracts.js";
import { CJS_HANDLERS, type McpToolResult } from "./cjs-handlers.js";
import { createMarkdownHandler } from "./markdown-handler.js";
import { createAskUserHandler } from "./ask-user-handler.js";
import { resolveProjectRoot } from "./project-root.js";
import { resolveForgeToolDir } from "./tool-dir.js";

// ── CJS_TOOL_NAMES — the 12 cjs-wrapper tool mcpNames (not forge_markdown / forge_ask_user)
// Exported for use in parity tests.
export const CJS_TOOL_NAMES: string[] = [
	"collate",
	"store",
	"commit",
	"validate_store",
	"config",
	"store_describe",
	"store_template",
	"store_query",
	"verify_apply",
	"artifact",
	"preflight",
	"banner",
];

// ── NATIVE_TOOL_NAMES — the 2 native (in-process) tool mcpNames
// Exported for parity tests.
export const NATIVE_TOOL_NAMES: string[] = ["markdown", "ask_user"];

// ── Server instructions (ADR Decision 4) ──────────────────────────────────────

const SERVER_INSTRUCTIONS = `
Forge MCP Server — Forge engineering workflow tools for Claude Code projects.

Available tools (14 total):

Native tools (in-process, no subprocess):
- markdown — structural access to a Markdown file via remark/mdast AST (outline/section/tables/frontmatter/ast)
- ask_user — present an interactive prompt to the user (confirm/choice/text); uses MCP elicitation form mode with non-interactive fallback

CJS-wrapper tools (12, invoke .forge/tools/*.cjs via node subprocess):
- store / store_query / store_describe / store_template — Forge JSON store CRUD, search, schema, templates
- validate_store — store integrity check (exit-1 is informational, not an error)
- config — read/write .forge/config.json
- collate — regenerate KB markdown from JSON store
- commit — deterministic commit choreography for tasks and bugs
- preflight — pre-flight gate checks for workflow phases
- verify_apply — verify file edits actually landed on disk
- artifact — read/write/list phase artifacts (PLAN.md, PROGRESS.md, *-SUMMARY.json)
- banner — display decorative phase banners

CJS tools invoke vendored .forge/tools/*.cjs via node subprocess (no shell interpolation).
`.trim();

// ── createForgeServer — testable factory ──────────────────────────────────────

/**
 * Create the MCP server + tool dispatch wiring.
 *
 * Exposed for unit testing: returns callTool and listTools helpers in addition
 * to the MCP Server instance.
 */
export function createForgeServer(
	projectRoot: string,
	toolDir: string,
): {
	server: Server;
	callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult>;
	listTools: () => { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
} {
	const server = new Server(
		{ name: "forge", version: "1.0.42" },
		{
			capabilities: { tools: {} },
			instructions: SERVER_INSTRUCTIONS,
		},
	);

	// All 14 contracts from SSOT (TOOL_CONTRACTS)
	const allContracts = TOOL_CONTRACTS;

	// Native handlers (in-process, no subprocess)
	const markdownHandler = createMarkdownHandler(projectRoot);
	const askUserHandler = createAskUserHandler(server);

	function listTools() {
		return {
			tools: allContracts.map((c) => ({
				name: c.mcpName,
				description: c.description,
				inputSchema: c.inputSchema,
			})),
		};
	}

	async function callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
		// Native tool dispatch (in-process)
		if (name === "markdown") {
			return markdownHandler(args);
		}
		if (name === "ask_user") {
			return askUserHandler(args);
		}

		// CJS-wrapper tool dispatch
		const handler = CJS_HANDLERS[name];
		if (!handler) {
			return {
				content: [{ type: "text", text: `Unknown tool: ${name}` }],
				isError: true,
			};
		}
		return handler(args, projectRoot, toolDir);
	}

	// ── MCP request handlers ───────────────────────────────────────────────────

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		return listTools();
	});

	server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
		const name = request.params.name;
		const args = (request.params.arguments ?? {}) as Record<string, unknown>;
		return callTool(name, args) as Promise<CallToolResult>;
	});

	return { server, callTool, listTools };
}

// ── main — stdio transport entry point ────────────────────────────────────────

export async function main(): Promise<void> {
	const projectRoot = resolveProjectRoot();
	const toolDir = resolveForgeToolDir(projectRoot);
	const { server } = createForgeServer(projectRoot, toolDir);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	process.stderr.write("[forge-mcp] MCP server started (stdio transport)\n");
}
