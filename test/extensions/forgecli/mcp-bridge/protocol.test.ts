// Protocol round-trip tests for the MCP stdio bridge transport (FORGE-S34).
//
// Spawns a tiny mock JSON-RPC stdio server (written to an OS tmpdir, run under
// Node) and drives it through JsonRpcStdioClient + StdioMcpSession. No grove
// dependency — these assertions are deterministic everywhere.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonRpcStdioClient } from "../../../../src/extensions/forgecli/mcp-bridge/json-rpc-stdio.js";
import { StdioMcpSession } from "../../../../src/extensions/forgecli/mcp-bridge/mcp-session.js";

// A CJS mock MCP server: newline-delimited JSON-RPC, handles initialize /
// tools/list / tools/call plus "hang" (never replies) and "crash" (exits).
const MOCK_SERVER = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }
function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "0" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [
      { name: "echo", description: "Echo args", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] }, annotations: { title: "Echo" } },
      { name: "boom", description: "Always errors", inputSchema: { type: "object", properties: {} } }
    ] } });
  } else if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "echo") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(args) }], isError: false } });
    else if (name === "boom") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "kaboom" }], isError: true } });
    else send({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool " + name } });
  } else if (method === "hang") {
    // intentionally never reply
  } else if (method === "crash") {
    process.exit(1);
  } else {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
}
`;

let tmp: string;
let serverPath: string;

beforeAll(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "mcp-bridge-test-"));
	serverPath = path.join(tmp, "mock-server.cjs");
	writeFileSync(serverPath, MOCK_SERVER, "utf8");
});

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("JsonRpcStdioClient", () => {
	it("performs an initialize request and resolves the result", async () => {
		const client = new JsonRpcStdioClient({ command: process.execPath, args: [serverPath] });
		client.start();
		const result = (await client.request("initialize", {})) as { serverInfo?: { name?: string } };
		expect(result.serverInfo?.name).toBe("mock");
		await client.close();
	});

	it("times out a request that never gets a response", async () => {
		const client = new JsonRpcStdioClient({
			command: process.execPath,
			args: [serverPath],
			requestTimeoutMs: 200,
		});
		client.start();
		await expect(client.request("hang", {})).rejects.toThrow(/timed out/);
		await client.close();
	});

	it("rejects in-flight requests when the child crashes", async () => {
		const client = new JsonRpcStdioClient({ command: process.execPath, args: [serverPath] });
		client.start();
		await expect(client.request("crash", {})).rejects.toThrow(/exited|closed/);
		await client.close();
	});

	it("rejects a request to an unstarted client", async () => {
		const client = new JsonRpcStdioClient({ command: process.execPath, args: [serverPath] });
		await expect(client.request("initialize", {})).rejects.toThrow(/not started/);
	});
});

describe("StdioMcpSession", () => {
	it("initializes, lists tools, and calls a tool", async () => {
		const session = new StdioMcpSession({ command: process.execPath, args: [serverPath] });
		await session.initialize();

		const tools = await session.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["boom", "echo"]);
		expect(tools.find((t) => t.name === "echo")?.inputSchema).toMatchObject({
			type: "object",
			required: ["msg"],
		});

		const ok = await session.callTool("echo", { msg: "hi" });
		expect(ok.isError).toBe(false);
		expect(JSON.parse(ok.content[0].text as string)).toEqual({ msg: "hi" });

		const bad = await session.callTool("boom", {});
		expect(bad.isError).toBe(true);

		await session.close();
	});

	it("is safe to call initialize twice (idempotent)", async () => {
		const session = new StdioMcpSession({ command: process.execPath, args: [serverPath] });
		await session.initialize();
		await session.initialize();
		const tools = await session.listTools();
		expect(tools.length).toBe(2);
		await session.close();
	});
});
