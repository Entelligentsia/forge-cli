// MCP semantics over a JSON-RPC stdio transport (FORGE-S34 — grove bridge).
//
// Layers the three MCP methods the bridge needs — initialize, tools/list,
// tools/call — on top of JsonRpcStdioClient. Newline-delimited JSON-RPC, the
// framing grove's `serve` mode speaks. Deliberately tiny: discovery + call,
// nothing else. The `McpSession` interface is what synthesizeTools() depends on,
// so tests can inject a fake without spawning a process.

import { JsonRpcStdioClient, type JsonRpcStdioOptions } from "./json-rpc-stdio.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

/** One tool as advertised by an MCP server's tools/list. */
export interface McpToolDescriptor {
	name: string;
	description?: string;
	/** Plain JSON Schema — passed through verbatim as a pi tool's parameters. */
	inputSchema: unknown;
	annotations?: { title?: string; readOnlyHint?: boolean; [k: string]: unknown };
}

/** The shape of an MCP tools/call result. */
export interface McpCallResult {
	content: Array<{ type: string; text?: string; [k: string]: unknown }>;
	isError?: boolean;
}

/** Server identity from the initialize handshake. */
export interface McpServerInfo {
	name?: string;
	title?: string;
	version?: string;
}

/** The minimal MCP surface synthesizeTools() consumes. Injectable for tests. */
export interface McpSession {
	/** Server identity captured during initialize (undefined before handshake). */
	readonly serverInfo?: McpServerInfo;
	initialize(): Promise<void>;
	listTools(): Promise<McpToolDescriptor[]>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult>;
	close(): Promise<void>;
}

/** McpSession backed by a spawned stdio child (e.g. `grove serve`). */
export class StdioMcpSession implements McpSession {
	private readonly client: JsonRpcStdioClient;
	private initialized = false;
	serverInfo?: McpServerInfo;

	constructor(opts: JsonRpcStdioOptions) {
		this.client = new JsonRpcStdioClient(opts);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		this.client.start();
		const init = (await this.client.request("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "forge-cli", version: "1" },
		})) as { serverInfo?: McpServerInfo };
		this.serverInfo = init?.serverInfo;
		// Per the MCP handshake, signal readiness before issuing calls.
		this.client.notify("notifications/initialized");
		this.initialized = true;
	}

	async listTools(): Promise<McpToolDescriptor[]> {
		const result = (await this.client.request("tools/list", {})) as {
			tools?: McpToolDescriptor[];
		};
		return Array.isArray(result?.tools) ? result.tools : [];
	}

	async callTool(
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallResult> {
		if (signal?.aborted) throw new Error("aborted");
		const result = (await this.client.request("tools/call", {
			name,
			arguments: args ?? {},
		})) as McpCallResult;
		return {
			content: Array.isArray(result?.content) ? result.content : [],
			isError: result?.isError === true,
		};
	}

	close(): Promise<void> {
		this.initialized = false;
		return this.client.close();
	}
}
