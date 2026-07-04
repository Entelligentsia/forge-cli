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
  } else if (method === "slowprogress") {
    // Emit N progress notifications spaced by \`gap\` ms (each carrying the
    // caller's progressToken), then reply. Total time > the request timeout, so
    // this only succeeds if progress resets the inactivity timer.
    const token = params && params._meta && params._meta.progressToken;
    const n = (params && params.n) || 4;
    const gap = (params && params.gap) || 120;
    let i = 0;
    const tick = () => {
      if (i < n) {
        i++;
        send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: i, total: n } });
        setTimeout(tick, gap);
      } else {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "done" }], isError: false } });
      }
    };
    setTimeout(tick, gap);
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

	it("progress notifications reset the inactivity timer past the flat deadline", async () => {
		const client = new JsonRpcStdioClient({
			command: process.execPath,
			args: [serverPath],
			requestTimeoutMs: 200,
		});
		client.start();
		// 4 progress ticks, 120ms apart → ~600ms total, well past the 200ms
		// timeout. Each tick must reset the timer for this to resolve.
		const result = (await client.request("slowprogress", { n: 4, gap: 120 })) as {
			content: Array<{ text: string }>;
		};
		expect(result.content[0].text).toBe("done");
		await client.close();
	});

	it("surfaces each progress notification to the onProgress callback", async () => {
		const client = new JsonRpcStdioClient({
			command: process.execPath,
			args: [serverPath],
			requestTimeoutMs: 500,
		});
		client.start();
		const seen: Array<{ progress?: number; total?: number }> = [];
		const result = (await client.request("slowprogress", { n: 3, gap: 60 }, (p) => {
			seen.push({ progress: p.progress, total: p.total });
		})) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toBe("done");
		// All three ticks delivered, in order, carrying grove-style progress/total.
		expect(seen).toEqual([
			{ progress: 1, total: 3 },
			{ progress: 2, total: 3 },
			{ progress: 3, total: 3 },
		]);
		await client.close();
	});

	it("still times out when progress stops flowing", async () => {
		const client = new JsonRpcStdioClient({
			command: process.execPath,
			args: [serverPath],
			requestTimeoutMs: 200,
		});
		client.start();
		// First progress tick isn't until 500ms, but the idle window is 200ms — no
		// activity arrives to reset it, so the request times out as it should.
		await expect(client.request("slowprogress", { n: 3, gap: 500 })).rejects.toThrow(
			/timed out/,
		);
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
