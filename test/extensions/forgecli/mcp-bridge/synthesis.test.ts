// Tool-synthesis tests for the MCP bridge (FORGE-S34).
//
// Verifies descriptor → pi ToolDefinition mapping with an injected fake session
// (no process spawned): name prefixing, verbatim JSON-Schema passthrough,
// content/isError mapping, and that a transport throw becomes an isError result
// rather than escaping into the agent loop.

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	buildToolDefinition,
	synthesizeTools,
} from "../../../../src/extensions/forgecli/mcp-bridge/mcp-bridge.js";
import type {
	McpSession,
	McpToolDescriptor,
} from "../../../../src/extensions/forgecli/mcp-bridge/mcp-session.js";

const DESCRIPTORS: McpToolDescriptor[] = [
	{
		name: "outline",
		description: "Outline a file",
		inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
		annotations: { title: "Outline a file" },
	},
	{
		name: "boom",
		description: "Errors",
		inputSchema: { type: "object", properties: {} },
	},
];

function fakeSession(overrides: Partial<McpSession> = {}): McpSession {
	return {
		initialize: vi.fn(async () => {}),
		listTools: vi.fn(async () => DESCRIPTORS),
		callTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({
			content: [{ type: "text", text: `called ${name} with ${JSON.stringify(args)}` }],
			isError: name === "boom",
		})),
		close: vi.fn(async () => {}),
		...overrides,
	};
}

// Minimal ctx — execute ignores it.
const CTX = {} as unknown as ExtensionContext;

// pi's AgentToolResult type does not surface the runtime `isError` flag /
// text field (it is read by the runtime — see forge-tools.ts result helpers).
type ExecResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

describe("synthesizeTools", () => {
	it("prefixes names and registers one tool per descriptor", () => {
		const tools = synthesizeTools(fakeSession(), DESCRIPTORS, { namePrefix: "grove_" });
		expect(tools.map((t) => t.name)).toEqual(["grove_outline", "grove_boom"]);
	});

	it("passes the MCP inputSchema through verbatim as parameters", () => {
		const tool = buildToolDefinition(fakeSession(), DESCRIPTORS[0], { namePrefix: "grove_" });
		// Identity: the exact schema object grove advertised reaches pi unchanged.
		expect(tool.parameters).toBe(DESCRIPTORS[0].inputSchema);
	});

	it("uses the annotation title as label, falling back to the prefixed name", () => {
		const tools = synthesizeTools(fakeSession(), DESCRIPTORS, { namePrefix: "grove_" });
		expect(tools[0].label).toBe("Outline a file");
		expect(tools[1].label).toBe("grove_boom"); // no annotation → prefixed name
	});

	it("attaches prompt guidelines when provided", () => {
		const tools = synthesizeTools(fakeSession(), DESCRIPTORS, {
			namePrefix: "grove_",
			promptGuidelines: ["prefer grove"],
		});
		expect(tools[0].promptGuidelines).toEqual(["prefer grove"]);
	});

	it("proxies execute to callTool with the UNPREFIXED name and maps content", async () => {
		const session = fakeSession();
		const tool = buildToolDefinition(session, DESCRIPTORS[0], { namePrefix: "grove_" });
		const result = (await tool.execute("call-1", { file: "x.ts" }, undefined, undefined, CTX)) as ExecResult;
		// 4th arg is the progress forwarder — undefined here since no onUpdate was passed.
		expect(session.callTool).toHaveBeenCalledWith("outline", { file: "x.ts" }, undefined, undefined);
		expect(result.isError).toBe(false);
		expect(result.content[0]).toMatchObject({ type: "text", text: "called outline with {\"file\":\"x.ts\"}" });
	});

	it("forwards server progress notifications to the onUpdate callback", async () => {
		// A session whose call reports two progress ticks (grove-style messages)
		// before resolving — exactly what `grove serve --explore` emits per turn.
		const session = fakeSession({
			callTool: vi.fn(
				async (
					name: string,
					_args: Record<string, unknown>,
					_signal?: AbortSignal,
					onProgress?: (p: { progress?: number; total?: number; message?: string }) => void,
				) => {
					onProgress?.({ progress: 1, total: 7, message: "turn 1/7 · Grep" });
					onProgress?.({ progress: 2, total: 7, message: "turn 2/7 · Read" });
					return { content: [{ type: "text", text: `called ${name}` }], isError: false };
				},
			),
		});
		const tool = buildToolDefinition(session, DESCRIPTORS[0], { namePrefix: "grove_" });
		const updates: string[] = [];
		const onUpdate = (r: { content: Array<{ text?: string }> }) => {
			updates.push(r.content[0]?.text ?? "");
		};
		await tool.execute("call-p", { file: "x.ts" }, undefined, onUpdate as never, CTX);
		expect(updates).toEqual(["turn 1/7 · Grep", "turn 2/7 · Read"]);
	});

	it("maps an MCP isError result onto a pi isError result", async () => {
		const tool = buildToolDefinition(fakeSession(), DESCRIPTORS[1], { namePrefix: "grove_" });
		const result = (await tool.execute("call-2", {}, undefined, undefined, CTX)) as ExecResult;
		expect(result.isError).toBe(true);
	});

	it("turns a transport throw into an isError result (never throws into the loop)", async () => {
		const session = fakeSession({
			callTool: vi.fn(async () => {
				throw new Error("pipe broken");
			}),
		});
		const tool = buildToolDefinition(session, DESCRIPTORS[0], { namePrefix: "grove_" });
		const result = (await tool.execute("call-3", { file: "x.ts" }, undefined, undefined, CTX)) as ExecResult;
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("grove_outline failed: pipe broken");
	});

	it("falls back to an empty-object schema when a descriptor omits inputSchema", () => {
		const tool = buildToolDefinition(
			fakeSession(),
			{ name: "noschema", inputSchema: undefined },
			{ namePrefix: "grove_" },
		);
		expect(tool.parameters).toMatchObject({ type: "object", properties: {} });
	});
});
