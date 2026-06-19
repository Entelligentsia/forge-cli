// mcp-server-native-tools.test.ts — unit tests for the two native MCP tools
// (forge_markdown and forge_ask_user) — FORGE-S34-T04.
//
// Tests:
//   1. forge_markdown — in-process AST operations against fixture markdown
//   2. forge_ask_user — elicitation paths (accept/decline/cancel/unsupported)
//   3. all-14 listTools assertion after T04 additions
//
// Pattern: creates real TS modules via createForgeServer(); spies on
// server.elicitInput for ask_user paths. No child_process mock needed for
// native tools (they are pure in-process).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need the child_process mock to be present since server.ts imports
// cjs-handlers.ts which calls runCjsMcp which uses execFile. But the
// native tool paths don't go through it, so we mock it as a no-op.
vi.mock("node:child_process", () => {
	const { promisify } = require("node:util") as typeof import("node:util");
	const execFileMock = vi.fn();
	(execFileMock as unknown as Record<symbol, unknown>)[promisify.custom] = () =>
		Promise.resolve({ stdout: "", stderr: "" });
	return { execFile: execFileMock };
});

import {
	createForgeServer,
	NATIVE_TOOL_NAMES,
} from "../../../src/extensions/forgecli/mcp/server.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_TOOL_DIR = "/fake/project/.forge/tools";

// ── Fixture markdown ──────────────────────────────────────────────────────────

const FIXTURE_MD = `---
title: Test Document
version: "1.0"
---

# Section A

This is the first section with some content.

## Sub-section A1

Content under A1.

# Section B

Content in section B.

| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| row1-c1  | row1-c2  | row1-c3  |
| row2-c1  | row2-c2  | row2-c3  |
`;

// ── Setup: write fixture to temp dir ─────────────────────────────────────────

let tmpDir: string;
let fixturePath: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-mcp-native-test-"));
	fixturePath = path.join(tmpDir, "fixture.md");
	fs.writeFileSync(fixturePath, FIXTURE_MD, "utf8");
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.clearAllMocks();
	delete process.env["FORGE_YES"];
	delete process.env["FORGE_NON_INTERACTIVE"];
});

// ── forge_markdown tests ──────────────────────────────────────────────────────

describe("forge_markdown — outline", () => {
	it("returns heading tree with correct depths, text, and line ranges", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "outline",
			path: fixturePath,
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("# Section A");
		expect(text).toContain("## Sub-section A1");
		expect(text).toContain("# Section B");
	});
});

describe("forge_markdown — section", () => {
	it("returns exact source of the requested section", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "section",
			path: fixturePath,
			heading: "Section A",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("# Section A");
		expect(text).toContain("first section with some content");
	});

	it("returns isError when heading not found", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "section",
			path: fixturePath,
			heading: "Nonexistent Heading",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("heading not found");
	});

	it("returns isError when heading param missing", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "section",
			path: fixturePath,
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBe(true);
	});
});

describe("forge_markdown — tables", () => {
	it("returns GFM table with header and rows", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "tables",
			path: fixturePath,
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(result.content[0].text) as Array<{
			header: string[];
			rows: string[][];
		}>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].header).toEqual(["Header 1", "Header 2", "Header 3"]);
		expect(parsed[0].rows).toHaveLength(2);
		expect(parsed[0].rows[0]).toEqual(["row1-c1", "row1-c2", "row1-c3"]);
	});
});

describe("forge_markdown — frontmatter", () => {
	it("returns parsed YAML frontmatter as JSON", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "frontmatter",
			path: fixturePath,
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
		expect(parsed["title"]).toBe("Test Document");
		expect(parsed["version"]).toBe("1.0");
	});

	it("returns (no frontmatter) for docs without YAML block", async () => {
		const noFmPath = path.join(tmpDir, "no-fm.md");
		fs.writeFileSync(noFmPath, "# Just a heading\n\nNo frontmatter here.\n", "utf8");
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "frontmatter",
			path: noFmPath,
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("no frontmatter");
	});
});

describe("forge_markdown — ast", () => {
	it("returns compact tree JSON", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "ast",
			path: fixturePath,
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		const parsed = JSON.parse(result.content[0].text) as { type: string };
		expect(parsed.type).toBe("root");
	});
});

describe("forge_markdown — error paths", () => {
	it("returns isError when file does not exist", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "outline",
			path: path.join(tmpDir, "does-not-exist.md"),
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("file not found");
	});

	it("resolves relative path against projectRoot", async () => {
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = (await callTool("markdown", {
			operation: "outline",
			path: "fixture.md", // relative
		})) as { content: Array<{ text: string }>; isError?: boolean };

		// Should resolve against tmpDir (projectRoot) and succeed
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("Section A");
	});
});

// ── forge_ask_user tests ──────────────────────────────────────────────────────

describe("forge_ask_user — non-interactive env flag", () => {
	it("FORGE_YES=1 returns declared default without calling elicitInput", async () => {
		process.env["FORGE_YES"] = "1";
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const elicitSpy = vi.spyOn(server, "elicitInput" as never);

		const result = (await callTool("ask_user", {
			question: "Proceed?",
			type: "confirm",
			default: "N",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("N");
		expect(elicitSpy).not.toHaveBeenCalled();
	});

	it("FORGE_NON_INTERACTIVE=1 returns type-specific default (confirm → Y)", async () => {
		process.env["FORGE_NON_INTERACTIVE"] = "1";
		const { callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);

		const result = (await callTool("ask_user", {
			question: "Are you sure?",
			type: "confirm",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("Y");
	});
});

describe("forge_ask_user — elicitation accept", () => {
	it("confirm accept: elicitInput resolves with accept/Y → returns Y", async () => {
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		vi.spyOn(server, "elicitInput" as never).mockResolvedValue({
			action: "accept",
			content: { answer: "Y" },
		} as never);

		const result = (await callTool("ask_user", {
			question: "Proceed?",
			type: "confirm",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("Y");
	});

	it("choice accept: elicitInput resolves with accept/option-B → returns option-B", async () => {
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		vi.spyOn(server, "elicitInput" as never).mockResolvedValue({
			action: "accept",
			content: { answer: "option-B" },
		} as never);

		const result = (await callTool("ask_user", {
			question: "Pick one",
			type: "choice",
			options: ["option-A", "option-B", "option-C"],
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("option-B");
	});
});

describe("forge_ask_user — elicitation decline", () => {
	it("decline: returns isError with user-declined message", async () => {
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		vi.spyOn(server, "elicitInput" as never).mockResolvedValue({
			action: "decline",
			content: {},
		} as never);

		const result = (await callTool("ask_user", {
			question: "Delete everything?",
			type: "confirm",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("declined");
	});
});

describe("forge_ask_user — elicitation cancel", () => {
	it("cancel: returns declared default (treated as non-interactive fallback)", async () => {
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		vi.spyOn(server, "elicitInput" as never).mockResolvedValue({
			action: "cancel",
			content: {},
		} as never);

		const result = (await callTool("ask_user", {
			question: "Proceed?",
			type: "confirm",
			default: "N",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("N");
	});

	it("cancel without default: returns type-specific fallback (confirm → Y)", async () => {
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		vi.spyOn(server, "elicitInput" as never).mockResolvedValue({
			action: "cancel",
			content: {},
		} as never);

		const result = (await callTool("ask_user", {
			question: "Are you sure?",
			type: "confirm",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("Y");
	});
});

describe("forge_ask_user — elicitation unsupported (throws)", () => {
	it("when elicitInput throws, falls back to declared default", async () => {
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		vi.spyOn(server, "elicitInput" as never).mockRejectedValue(
			new Error("Client does not support form elicitation"),
		);

		const result = (await callTool("ask_user", {
			question: "Proceed?",
			type: "confirm",
			default: "N",
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("N");
	});

	it("when elicitInput throws, falls back to type-specific default (choice → options[0])", async () => {
		const { server, callTool } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		vi.spyOn(server, "elicitInput" as never).mockRejectedValue(
			new Error("Client does not support form elicitation"),
		);

		const result = (await callTool("ask_user", {
			question: "Pick one",
			type: "choice",
			options: ["alpha", "beta"],
		})) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("alpha");
	});
});

// ── all-14 listTools assertion ────────────────────────────────────────────────

describe("listTools — all 14 tools after T04", () => {
	it("createForgeServer().listTools() returns 14 tools", () => {
		const { listTools } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = listTools();
		expect(result.tools).toHaveLength(14);
	});

	it("listed tools include markdown and ask_user", () => {
		const { listTools } = createForgeServer(tmpDir, FAKE_TOOL_DIR);
		const result = listTools();
		const names = result.tools.map((t: { name: string }) => t.name);
		expect(names).toContain("markdown");
		expect(names).toContain("ask_user");
	});
});

// ── NATIVE_TOOL_NAMES export ──────────────────────────────────────────────────

describe("NATIVE_TOOL_NAMES", () => {
	it("exports exactly the 2 native tool mcpNames", () => {
		expect(NATIVE_TOOL_NAMES.sort()).toEqual(["ask_user", "markdown"].sort());
	});
});
