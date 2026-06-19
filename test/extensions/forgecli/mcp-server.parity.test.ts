// mcp-server.parity.test.ts — parity harness for the MCP server core (FORGE-S34-T03).
//
// Verifies the MCP server registering and dispatching for the 12 cjs-wrapper tools:
//   store, store_query, store_describe, store_template, validate_store,
//   config, collate, commit, preflight, verify_apply, banner, artifact.
//
// Also tests:
//   - forge_validate_store exit-1-is-informational path
//   - forge_validate_store ENOENT hard-failure path
//   - forge_artifact large-content (>=64KB) @<tmpfile> convention
//
// Mock design: vi.hoisted() + vi.mock("node:child_process") — same pattern as
// forge-tools.test.ts. The promisify.custom symbol is installed so that
// util.promisify(execFile) resolves with {stdout, stderr}.

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock state ─────────────────────────────────────────────────────────

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

const { state } = vi.hoisted(() => {
	const state = {
		impl: (_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: ExecCallback) => {
			void _cmd;
			void _args;
			void _opts;
			void cb;
		},
	};
	return { state };
});

vi.mock("node:child_process", () => {
	const { promisify } = require("node:util") as typeof import("node:util");
	const execFileMock = vi.fn((cmd: string, args: string[], opts: Record<string, unknown>, cb: ExecCallback) => {
		state.impl(cmd, args, opts, cb);
	});
	(execFileMock as unknown as Record<symbol, unknown>)[promisify.custom] = (
		cmd: string,
		args: string[],
		opts: Record<string, unknown>,
	): Promise<{ stdout: string; stderr: string }> => {
		return new Promise((resolve, reject) => {
			state.impl(cmd, args, opts, (err, stdout, stderr) => {
				if (err) {
					reject(Object.assign(err, { stdout, stderr }));
				} else {
					resolve({ stdout, stderr });
				}
			});
		});
	};
	return { execFile: execFileMock };
});

import { TOOL_CONTRACTS } from "../../../src/extensions/forgecli/tool-contracts.js";
import {
	createForgeServer,
	CJS_TOOL_NAMES,
} from "../../../src/extensions/forgecli/mcp/server.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_PROJECT_ROOT = "/fake/project";
const FAKE_TOOL_DIR = "/fake/project/.forge/tools";

// The 12 cjs-wrapper tools (not forge_markdown or forge_ask_user which are T04)
const CJS_WRAPPER_MCPNAMES = [
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

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Make execFile succeed with given stdout. */
function mockExecFileSuccess(stdout: string): void {
	state.impl = (_cmd, _args, _opts, cb) => cb(null, stdout, "");
}

/** Make execFile fail with given error. */
function mockExecFileFailure(err: Error & { code?: number | string; stdout?: string; stderr?: string }): void {
	state.impl = (_cmd, _args, _opts, cb) => cb(err, err.stdout ?? "", err.stderr ?? "");
}

/** Capture the execFile argv array while succeeding. */
function mockExecFileCaptureArgs(capturedCmd: string[], capturedArgs: string[], stdout = "ok"): void {
	state.impl = (cmd, args, _opts, cb) => {
		capturedCmd.splice(0, capturedCmd.length, cmd);
		capturedArgs.splice(0, capturedArgs.length, ...args);
		cb(null, stdout, "");
	};
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => {
	state.impl = () => {
		/* reset to no-op */
	};
	const { callTool: ct } = createForgeServer(FAKE_PROJECT_ROOT, FAKE_TOOL_DIR);
	callTool = ct;
});

afterEach(() => {
	vi.clearAllMocks();
});

// ── CJS_TOOL_NAMES export ─────────────────────────────────────────────────────

describe("CJS_TOOL_NAMES", () => {
	it("exports exactly the 12 cjs-wrapper tool mcpNames", () => {
		expect(CJS_TOOL_NAMES.sort()).toEqual(CJS_WRAPPER_MCPNAMES.sort());
	});
});

// ── TOOL_CONTRACTS parity ─────────────────────────────────────────────────────

describe("tool registration parity", () => {
	for (const mcpName of CJS_WRAPPER_MCPNAMES) {
		it(`contract exists for mcpName="${mcpName}"`, () => {
			const contract = TOOL_CONTRACTS.find((c) => c.mcpName === mcpName);
			expect(contract, `No contract found for mcpName="${mcpName}"`).toBeDefined();
		});
	}
});

// ── ListTools ─────────────────────────────────────────────────────────────────

describe("ListTools handler", () => {
	it("returns all 14 tools (12 cjs-wrapper + 2 native added by T04)", async () => {
		const { listTools } = createForgeServer(FAKE_PROJECT_ROOT, FAKE_TOOL_DIR);
		const result = listTools();
		// T04 adds markdown and ask_user — total is now 14
		expect(result.tools).toHaveLength(14);
		const names = result.tools.map((t: { name: string }) => t.name);
		// All 12 CJS_TOOL_NAMES must be present
		for (const name of CJS_WRAPPER_MCPNAMES) {
			expect(names).toContain(name);
		}
		// Native tools (T04) also present
		expect(names).toContain("markdown");
		expect(names).toContain("ask_user");
	});

	it("each listed tool has name, description, inputSchema", async () => {
		const { listTools } = createForgeServer(FAKE_PROJECT_ROOT, FAKE_TOOL_DIR);
		const result = listTools();
		for (const tool of result.tools) {
			const t = tool as { name: string; description: string; inputSchema: unknown };
			expect(typeof t.name).toBe("string");
			expect(typeof t.description).toBe("string");
			expect(t.inputSchema).toBeDefined();
		}
	});

	it("each listed tool's description matches TOOL_CONTRACTS", async () => {
		const { listTools } = createForgeServer(FAKE_PROJECT_ROOT, FAKE_TOOL_DIR);
		const result = listTools();
		for (const tool of result.tools) {
			const t = tool as { name: string; description: string };
			const contract = TOOL_CONTRACTS.find((c) => c.mcpName === t.name);
			expect(contract, `No contract for ${t.name}`).toBeDefined();
			// description should contain the contract description prefix
			expect(t.description).toContain(contract!.description.substring(0, 50));
		}
	});
});

// ── CallTool dispatch — argv-array checks ─────────────────────────────────────

describe("collate dispatch", () => {
	it("calls store-cli.cjs or collate.cjs with correct argv, returns stdout", async () => {
		const cmd: string[] = [];
		const args: string[] = [];
		mockExecFileCaptureArgs(cmd, args, "collate done");
		const result = (await callTool("collate", {})) as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.content[0].text).toBe("collate done");
		expect(result.isError).toBeFalsy();
		// collate.cjs must be invoked via "node"
		expect(cmd[0]).toBe("node");
		expect(args[0]).toMatch(/collate\.cjs$/);
	});

	it("passes sprintId arg when provided", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "ok");
		await callTool("collate", { sprintId: "FORGE-S34" });
		expect(args).toContain("FORGE-S34");
	});
});

describe("store dispatch", () => {
	it("calls store-cli.cjs with command and args", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "task list output");
		const result = (await callTool("store", {
			command: "list",
			args: ["task"],
		})) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toBe("task list output");
		expect(args[0]).toMatch(/store-cli\.cjs$/);
		expect(args).toContain("list");
		expect(args).toContain("task");
	});

	it("passes --dry-run when dryRun=true", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "ok");
		await callTool("store", { command: "validate", args: [], dryRun: true });
		expect(args).toContain("--dry-run");
	});
});

describe("commit dispatch", () => {
	it("calls commit-task.cjs with --task, id, --message", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "committed");
		const result = (await callTool("commit", {
			entity: "task",
			id: "FORGE-S34-T03",
			message: "test: commit",
		})) as { content: Array<{ text: string }> };
		expect(result.content[0].text).toBe("committed");
		expect(args[0]).toMatch(/commit-task\.cjs$/);
		expect(args).toContain("--task");
		expect(args).toContain("FORGE-S34-T03");
		expect(args).toContain("--message");
		expect(args).toContain("test: commit");
	});
});

describe("config dispatch", () => {
	it("calls manage-config.cjs with subcommand and args", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "config output");
		await callTool("config", { subcommand: "get", args: ["paths.forgeRoot"] });
		expect(args[0]).toMatch(/manage-config\.cjs$/);
		expect(args).toContain("get");
		expect(args).toContain("paths.forgeRoot");
	});
});

describe("store_describe dispatch", () => {
	it("calls store-cli.cjs describe <entity>", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "{}");
		await callTool("store_describe", { entity: "task" });
		expect(args[0]).toMatch(/store-cli\.cjs$/);
		expect(args).toContain("describe");
		expect(args).toContain("task");
	});
});

describe("store_template dispatch", () => {
	it("calls store-cli.cjs template <entity>", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "{}");
		await callTool("store_template", { entity: "sprint" });
		expect(args[0]).toMatch(/store-cli\.cjs$/);
		expect(args).toContain("template");
		expect(args).toContain("sprint");
	});
});

describe("store_query dispatch", () => {
	it("calls store-cli.cjs with nlp and intent string", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "results");
		await callTool("store_query", { command: "nlp", args: ["open tasks in S34"] });
		expect(args[0]).toMatch(/store-cli\.cjs$/);
		expect(args).toContain("nlp");
		expect(args).toContain("open tasks in S34");
	});
});

describe("preflight dispatch", () => {
	it("calls preflight-gate.cjs with --phase and --task", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "preflight passed");
		await callTool("preflight", { phase: "implement", task: "FORGE-S34-T03" });
		expect(args[0]).toMatch(/preflight-gate\.cjs$/);
		expect(args).toContain("--phase");
		expect(args).toContain("implement");
		expect(args).toContain("--task");
		expect(args).toContain("FORGE-S34-T03");
	});
});

describe("verify_apply dispatch", () => {
	it("calls verify-apply.cjs with claimed paths", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "{}");
		await callTool("verify_apply", { claimed_paths: [".forge/personas/engineer.md"] });
		expect(args[0]).toMatch(/verify-apply\.cjs$/);
		expect(args).toContain(".forge/personas/engineer.md");
	});
});

describe("banner dispatch", () => {
	it("calls banners.cjs with banner name", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "banner output");
		await callTool("banner", { name: "forge" });
		expect(args[0]).toMatch(/banners\.cjs$/);
		expect(args).toContain("forge");
	});
});

describe("artifact dispatch", () => {
	it("calls artifact.cjs with command entity entityId artifact", async () => {
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "content");
		await callTool("artifact", {
			command: "read",
			entity: "task",
			entityId: "FORGE-S34-T03",
			artifact: "plan",
		});
		expect(args[0]).toMatch(/artifact\.cjs$/);
		expect(args).toContain("read");
		expect(args).toContain("task");
		expect(args).toContain("FORGE-S34-T03");
		expect(args).toContain("plan");
	});

	it("large-content (>=64KB) uses @<tmpfile> convention", async () => {
		const largeContent = "x".repeat(65 * 1024);
		const args: string[] = [];
		let capturedTmpContent: string | null = null;

		// Intercept the execFile call to read the tmpfile BEFORE the handler's
		// finally-block cleanup removes it.
		state.impl = (_cmd, capturedArgs, _opts, cb) => {
			args.splice(0, args.length, ...capturedArgs);
			// Read the tmpfile while it's still open (during the mock execution)
			const lastArg = capturedArgs[capturedArgs.length - 1];
			if (lastArg && lastArg.startsWith("@")) {
				const { readFileSync } = require("node:fs") as typeof import("node:fs");
				try {
					capturedTmpContent = readFileSync(lastArg.slice(1), "utf8");
				} catch {
					capturedTmpContent = null;
				}
			}
			cb(null, "written", "");
		};

		await callTool("artifact", {
			command: "write",
			entity: "task",
			entityId: "FORGE-S34-T03",
			artifact: "progress",
			content: largeContent,
		});
		expect(args[0]).toMatch(/artifact\.cjs$/);
		// The last argv should be @<path> for large content
		const lastArg = args[args.length - 1];
		expect(lastArg).toMatch(/^@/);
		// The content was correctly written to the tmpfile (captured during mock execution)
		expect(capturedTmpContent).toBe(largeContent);
	});

	it("small content is passed inline (not via @tmpfile)", async () => {
		const smallContent = "small content here";
		const args: string[] = [];
		mockExecFileCaptureArgs([], args, "written");
		await callTool("artifact", {
			command: "write",
			entity: "task",
			entityId: "FORGE-S34-T03",
			artifact: "progress",
			content: smallContent,
		});
		const lastArg = args[args.length - 1];
		expect(lastArg).toBe(smallContent);
		expect(lastArg).not.toMatch(/^@/);
	});
});

// ── validate_store — exit-code semantics ───────────────────────────────────────

describe("validate_store exit-code semantics", () => {
	it("exit-1 (informational): returns content without isError:true", async () => {
		const err = Object.assign(new Error("exit code 1"), {
			code: 1,
			stdout: "WARN: 3 issues found",
			stderr: "",
		});
		mockExecFileFailure(err);
		const result = (await callTool("validate_store", {})) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("3 issues");
	});

	it("ENOENT (string code): returns isError:true", async () => {
		const err = Object.assign(new Error("spawn error"), {
			code: "ENOENT",
			stdout: "",
			stderr: "ENOENT: no such file",
		});
		mockExecFileFailure(err);
		const result = (await callTool("validate_store", {})) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBe(true);
	});

	it("happy path exit-0: stdout returned as content", async () => {
		mockExecFileSuccess("All checks passed.");
		const result = (await callTool("validate_store", {})) as {
			content: Array<{ text: string }>;
			isError?: boolean;
		};
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toBe("All checks passed.");
	});
});

// ── cwd binding ────────────────────────────────────────────────────────────────

describe("cwd binding", () => {
	it("passes projectRoot as cwd to execFile", async () => {
		let capturedOpts: Record<string, unknown> = {};
		state.impl = (_cmd, _args, opts, cb) => {
			capturedOpts = opts;
			cb(null, "ok", "");
		};
		await callTool("store", { command: "list", args: ["task"] });
		expect(capturedOpts["cwd"]).toBe(FAKE_PROJECT_ROOT);
	});
});
