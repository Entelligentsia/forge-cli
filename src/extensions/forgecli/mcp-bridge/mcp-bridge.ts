// Dynamic MCP→pi tool synthesis (FORGE-S34 — grove bridge).
//
// Turns an MCP server's advertised tools (tools/list) into native pi
// ToolDefinitions whose execute() proxies tools/call back over the same
// session. Discovery is dynamic: whatever the server advertises this run is what
// gets registered — 6 grove tools today, N tomorrow, with zero code change.
//
// Why the schema passes through verbatim: pi-ai's validateToolArguments accepts
// a plain JSON Schema object as a tool's `parameters` (it detects the absence of
// TypeBox metadata and falls back to coerceWithJsonSchema). So an MCP
// inputSchema maps 1:1 onto a pi tool's parameters with no conversion and full
// fidelity to the model.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import {
	StdioMcpSession,
	type McpServerInfo,
	type McpSession,
	type McpToolDescriptor,
} from "./mcp-session.js";
import type { JsonRpcStdioOptions } from "./json-rpc-stdio.js";

export interface SynthesizeOptions {
	/** Prefix applied to every tool name (e.g. "grove_"). */
	namePrefix: string;
	/** Optional steering bullets appended to the system prompt while active. */
	promptGuidelines?: string[];
}

/** Wrap an MCP server's content array into a pi AgentToolResult content array. */
function toToolContent(
	content: Array<{ type: string; text?: string }>,
	fallback: string,
): Array<{ type: "text"; text: string }> {
	const items = content
		.filter((c) => typeof c.text === "string")
		.map((c) => ({ type: "text" as const, text: c.text as string }));
	return items.length > 0 ? items : [{ type: "text" as const, text: fallback }];
}

/**
 * Build a pi ToolDefinition for one MCP tool descriptor. The execute() handler
 * proxies to session.callTool and maps the MCP result onto pi's result shape;
 * any transport failure is surfaced as an isError result (never thrown into the
 * agent loop).
 */
export function buildToolDefinition(
	session: McpSession,
	descriptor: McpToolDescriptor,
	opts: SynthesizeOptions,
): ToolDefinition {
	const toolName = `${opts.namePrefix}${descriptor.name}`;
	return {
		name: toolName,
		label: descriptor.annotations?.title ?? toolName,
		description: descriptor.description ?? toolName,
		// Pass the MCP JSON Schema straight through — see header note.
		parameters: (descriptor.inputSchema ?? { type: "object", properties: {} }) as TSchema,
		promptGuidelines: opts.promptGuidelines,
		async execute(_toolCallId, params, signal, onUpdate) {
			try {
				// Surface the server's progress notifications as live tool updates so
				// the user sees liveness during a long call (e.g. grove's delegated
				// explore, which reports "turn 2/7 · …" per inner-loop turn) instead
				// of a silent wait. Partial updates carry text only; the final result
				// still comes from the resolved call below.
				const onProgress = onUpdate
					? (p: { progress?: number; total?: number; message?: string }) => {
							const text = p.message ?? `working (${p.progress ?? "?"}/${p.total ?? "?"})`;
							onUpdate({ content: [{ type: "text", text }], details: {} as unknown });
						}
					: undefined;
				const result = await session.callTool(
					descriptor.name,
					(params ?? {}) as Record<string, unknown>,
					signal,
					onProgress,
				);
				return {
					content: toToolContent(result.content, result.isError ? "tool error" : "OK"),
					details: {} as unknown,
					isError: result.isError === true,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `${toolName} failed: ${message}` }],
					details: {} as unknown,
					isError: true as const,
				};
			}
		},
	};
}

/** Synthesize a pi ToolDefinition for every descriptor the server advertised. */
export function synthesizeTools(
	session: McpSession,
	descriptors: McpToolDescriptor[],
	opts: SynthesizeOptions,
): ToolDefinition[] {
	return descriptors.map((d) => buildToolDefinition(session, d, opts));
}

export interface McpAttachment {
	/** The synthesized pi tools, ready for pi.registerTool / subagent injection. */
	tools: ToolDefinition[];
	/** Prefixed tool names (for logging / orientation). */
	toolNames: string[];
	/** Server identity (name/version) from the handshake, when advertised. */
	serverInfo?: McpServerInfo;
	/** The live session (kept open for the duration of the pi session). */
	session: McpSession;
	/** Tear down the underlying child process. */
	dispose: () => Promise<void>;
}

export interface AttachMcpServerOptions extends JsonRpcStdioOptions, SynthesizeOptions {}

/**
 * Spawn an MCP stdio server, perform the handshake, discover its tools, and
 * synthesize pi ToolDefinitions. Throws if the handshake or discovery fails (the
 * caller decides whether that is fatal — for grove it is a graceful no-op).
 */
export async function attachMcpServer(opts: AttachMcpServerOptions): Promise<McpAttachment> {
	const { namePrefix, promptGuidelines, ...transport } = opts;
	const session = new StdioMcpSession(transport);
	try {
		await session.initialize();
		const descriptors = await session.listTools();
		const tools = synthesizeTools(session, descriptors, { namePrefix, promptGuidelines });
		return {
			tools,
			toolNames: tools.map((t) => t.name),
			serverInfo: session.serverInfo,
			session,
			dispose: () => session.close(),
		};
	} catch (err) {
		await session.close().catch(() => undefined);
		throw err;
	}
}
