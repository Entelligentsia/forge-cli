// mcp-all14-parity.test.ts — Integration parity test for all 14 Forge MCP tools.
// FORGE-S34-T08.
//
// Verification pillars:
//   1. Spawns dist/mcp/server.cjs as a subprocess via stdio JSON-RPC.
//   2. Sends tools/list and asserts exactly 14 tools are returned with required
//      fields (name, description, inputSchema).
//   3. Calls each of the 14 tools with a representative fixture input and
//      asserts the MCP response has the required shape (content array with text).
//   4. forge_ask_user non-interactive path tested via FORGE_NON_INTERACTIVE=1.
//   5. forge_markdown outline tested against a fixture markdown file.
//
// MCP JSON-RPC protocol over stdio:
//   - Messages are newline-delimited JSON (JSON-RPC 2.0).
//   - Handshake: initialize → initialized → then tools/list and tools/call.
//   - Server writes to stdout; client writes to stdin.
//
// Skip strategy:
//   - If dist/mcp/server.cjs is absent (no build), all tests are skipped
//     gracefully (same pattern as parity-gate.test.ts dist-directory check).

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ── Path resolution ───────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SERVER_BUNDLE = path.join(REPO_ROOT, "dist/mcp/server.cjs");

const SERVER_BUNDLE_AVAILABLE = fs.existsSync(SERVER_BUNDLE);

// ── Expected 14 tool names ─────────────────────────────────────────────────────

const ALL_14_MCP_NAMES = [
	// 12 cjs-wrapper tools
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
	// 2 native tools (T04)
	"markdown",
	"ask_user",
];

// ── Fixture markdown ──────────────────────────────────────────────────────────

const FIXTURE_MD = `---
title: Integration Test Fixture
version: "1.0"
---

# Introduction

This is a fixture file for MCP all-14 parity testing.

## Background

Context about the integration test.

# Implementation

Details of the implementation approach.

## Architecture

Architecture notes.

| Component | Role |
|-----------|------|
| MCP Server | stdio JSON-RPC endpoint |
| Tool Contracts | SSOT for all 14 tools |
`;

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: number;
	result?: unknown;
	error?: { code: number; message: string };
}

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	isError?: boolean;
};

/**
 * Minimal stdio JSON-RPC client for testing the MCP server.
 *
 * Spawns the server, performs the initialize handshake, then exposes
 * send() for request/response cycles. Cleanup kills the subprocess.
 */
class StdioMcpClient {
	private proc: child_process.ChildProcess;
	private buffer = "";
	private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
	private nextId = 1;
	private ready: Promise<void>;

	constructor(env: Record<string, string | undefined> = {}) {
		this.proc = child_process.spawn("node", [SERVER_BUNDLE], {
			env: {
				...process.env,
				// Default project root to cwd for the test (tools not actually invoked)
				CLAUDE_PROJECT_DIR: os.tmpdir(),
				...env,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Collect stdout line-by-line
		this.proc.stdout!.setEncoding("utf8");
		this.proc.stdout!.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl: number;
			while ((nl = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (!line) continue;
				let msg: JsonRpcResponse;
				try {
					msg = JSON.parse(line) as JsonRpcResponse;
				} catch {
					continue; // malformed — skip
				}
				const handler = this.pending.get(msg.id);
				if (handler) {
					this.pending.delete(msg.id);
					handler.resolve(msg);
				}
			}
		});

		this.proc.stderr!.setEncoding("utf8");
		// Drain stderr silently — server writes boot messages there

		// Perform MCP initialize handshake
		this.ready = this.handshake();
	}

	private write(msg: JsonRpcRequest): void {
		this.proc.stdin!.write(JSON.stringify(msg) + "\n");
	}

	private send(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
		return new Promise((resolve, reject) => {
			const id = this.nextId++;
			this.pending.set(id, { resolve, reject });
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private async handshake(): Promise<void> {
		// MCP 2024-11 initialize handshake
		await this.send("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "forge-test-client", version: "1.0.0" },
		});
		// Send initialized notification (no response expected)
		const notif = { jsonrpc: "2.0" as const, id: this.nextId++, method: "notifications/initialized" };
		this.proc.stdin!.write(JSON.stringify(notif) + "\n");
	}

	async listTools(): Promise<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }> {
		await this.ready;
		const resp = await this.send("tools/list");
		if (resp.error) throw new Error("tools/list error: " + resp.error.message);
		return resp.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
	}

	async callTool(name: string, toolArgs: Record<string, unknown>): Promise<ToolResult> {
		await this.ready;
		const resp = await this.send("tools/call", { name, arguments: toolArgs });
		if (resp.error) throw new Error(`tools/call ${name} error: ${resp.error.message}`);
		return resp.result as ToolResult;
	}

	kill(): void {
		this.proc.kill("SIGTERM");
	}
}

// ── Fixture setup ─────────────────────────────────────────────────────────────

let tmpDir: string;
let fixtureMdPath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-all14-test-"));
	fixtureMdPath = path.join(tmpDir, "fixture.md");
	fs.writeFileSync(fixtureMdPath, FIXTURE_MD, "utf8");
	// Create minimal .forge/tools structure so the server doesn't fail on toolDir
	const toolDir = path.join(tmpDir, ".forge", "tools");
	fs.mkdirSync(toolDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Integration describe (skip if no build) ───────────────────────────────────

describe.skipIf(!SERVER_BUNDLE_AVAILABLE)("all-14 MCP parity integration", () => {
	let client: StdioMcpClient;

	afterEach(() => {
		if (client) client.kill();
	});

	// ── tools/list assertions ─────────────────────────────────────────────────

	describe("tools/list", () => {
		it("returns exactly 14 tools", async () => {
			client = new StdioMcpClient({ CLAUDE_PROJECT_DIR: tmpDir });
			const result = await client.listTools();
			expect(result.tools).toHaveLength(14);
		});

		it("all 14 expected tool names are present", async () => {
			client = new StdioMcpClient({ CLAUDE_PROJECT_DIR: tmpDir });
			const result = await client.listTools();
			const names = result.tools.map((t) => t.name);
			for (const expected of ALL_14_MCP_NAMES) {
				expect(names, `Tool "${expected}" missing from tools/list`).toContain(expected);
			}
		});

		it("each tool has name, description, and inputSchema", async () => {
			client = new StdioMcpClient({ CLAUDE_PROJECT_DIR: tmpDir });
			const result = await client.listTools();
			for (const tool of result.tools) {
				expect(typeof tool.name, `name should be string for tool ${tool.name}`).toBe("string");
				expect(tool.name.length, `name should be non-empty for tool`).toBeGreaterThan(0);
				expect(typeof tool.description, `description should be string for tool ${tool.name}`).toBe("string");
				expect(tool.description.length, `description should be non-empty for tool ${tool.name}`).toBeGreaterThan(0);
				expect(tool.inputSchema, `inputSchema should be defined for tool ${tool.name}`).toBeDefined();
			}
		});
	});

	// ── forge_markdown tool ───────────────────────────────────────────────────

	describe("forge_markdown — outline operation", () => {
		it("returns heading tree with correct headings from fixture file", async () => {
			client = new StdioMcpClient({ CLAUDE_PROJECT_DIR: tmpDir });
			const result = await client.callTool("markdown", {
				operation: "outline",
				path: fixtureMdPath,
			});
			expect(result.isError).toBeFalsy();
			expect(result.content).toHaveLength(1);
			const text = result.content[0].text;
			expect(text).toContain("# Introduction");
			expect(text).toContain("## Background");
			expect(text).toContain("# Implementation");
			expect(text).toContain("## Architecture");
		});

		it("returns correct content type", async () => {
			client = new StdioMcpClient({ CLAUDE_PROJECT_DIR: tmpDir });
			const result = await client.callTool("markdown", {
				operation: "outline",
				path: fixtureMdPath,
			});
			expect(result.content[0].type).toBe("text");
		});
	});

	// ── forge_ask_user — non-interactive fallback ─────────────────────────────

	describe("forge_ask_user — non-interactive fallback path (FORGE_NON_INTERACTIVE=1)", () => {
		it("confirm type returns Y when no default set", async () => {
			client = new StdioMcpClient({
				CLAUDE_PROJECT_DIR: tmpDir,
				FORGE_NON_INTERACTIVE: "1",
			});
			const result = await client.callTool("ask_user", {
				question: "Do you want to proceed?",
				type: "confirm",
			});
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("Y");
		});

		it("confirm type returns declared default", async () => {
			client = new StdioMcpClient({
				CLAUDE_PROJECT_DIR: tmpDir,
				FORGE_NON_INTERACTIVE: "1",
			});
			const result = await client.callTool("ask_user", {
				question: "Proceed with destructive action?",
				type: "confirm",
				default: "N",
			});
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("N");
		});

		it("choice type returns first option when no default set", async () => {
			client = new StdioMcpClient({
				CLAUDE_PROJECT_DIR: tmpDir,
				FORGE_NON_INTERACTIVE: "1",
			});
			const result = await client.callTool("ask_user", {
				question: "Pick a value?",
				type: "choice",
				options: ["alpha", "beta", "gamma"],
			});
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("alpha");
		});

		it("text type returns declared default", async () => {
			client = new StdioMcpClient({
				CLAUDE_PROJECT_DIR: tmpDir,
				FORGE_NON_INTERACTIVE: "1",
			});
			const result = await client.callTool("ask_user", {
				question: "Enter a value?",
				type: "text",
				default: "my-default",
			});
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("my-default");
		});

		it("FORGE_YES=1 also triggers non-interactive fallback", async () => {
			client = new StdioMcpClient({
				CLAUDE_PROJECT_DIR: tmpDir,
				FORGE_YES: "1",
			});
			const result = await client.callTool("ask_user", {
				question: "Are you sure?",
				type: "confirm",
			});
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("Y");
		});
	});

	// ── All-14 structural dispatch (response shape check) ─────────────────────
	//
	// For the 12 cjs-wrapper tools, a real subprocess invocation would require
	// actual .cjs tools at toolDir. Instead we verify:
	//   1. The tool is dispatched (not "unknown tool" error).
	//   2. The response has the required { content: [{ type, text }] } shape.
	//
	// We do this by attempting a call; if the tool fails due to missing toolDir
	// binary (ENOENT), the cjs-wrapper tools still return { content, isError:true }
	// rather than an unhandled rejection — confirming dispatch is wired.

	describe("all-14 tools dispatch with correct response shape", () => {
		for (const toolName of ALL_14_MCP_NAMES) {
			it(`${toolName}: response has content array with type+text`, async () => {
				// Use separate clients with non-interactive env so ask_user doesn't hang
				const c = new StdioMcpClient({
					CLAUDE_PROJECT_DIR: tmpDir,
					FORGE_NON_INTERACTIVE: "1",
				});

				let result: ToolResult;
				try {
					result = await c.callTool(toolName, buildRepresentativeArgs(toolName, fixtureMdPath));
				} finally {
					c.kill();
				}

				// Response must be an object with a content array
				expect(result).toBeDefined();
				expect(Array.isArray(result.content), `${toolName}: content should be array`).toBe(true);
				expect(result.content.length, `${toolName}: content should be non-empty`).toBeGreaterThan(0);
				// Each content item must have type and text
				for (const item of result.content) {
					expect(typeof item.type, `${toolName}: content[].type should be string`).toBe("string");
					expect(typeof item.text, `${toolName}: content[].text should be string`).toBe("string");
				}
			});
		}
	});
});

// ── Helper: representative args per tool ──────────────────────────────────────

function buildRepresentativeArgs(toolName: string, mdFixturePath: string): Record<string, unknown> {
	switch (toolName) {
		case "collate":
			return {};
		case "store":
			return { command: "list", args: ["task"] };
		case "commit":
			return { entity: "task", id: "FORGE-S34-T08", message: "test parity call" };
		case "validate_store":
			return {};
		case "config":
			return { subcommand: "get", args: ["paths.forgeRoot"] };
		case "store_describe":
			return { entity: "task" };
		case "store_template":
			return { entity: "task" };
		case "store_query":
			return { command: "nlp", args: ["open tasks"] };
		case "verify_apply":
			return { claimed_paths: [".forge/config.json"] };
		case "artifact":
			return { command: "list", entity: "task", entityId: "FORGE-S34-T08", artifact: "plan" };
		case "preflight":
			return { phase: "implement", task: "FORGE-S34-T08" };
		case "banner":
			return { name: "forge" };
		case "markdown":
			return { operation: "outline", path: mdFixturePath };
		case "ask_user":
			return { question: "Test question?", type: "confirm" };
		default:
			return {};
	}
}
