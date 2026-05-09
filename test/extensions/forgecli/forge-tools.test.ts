// Unit tests for forge-tools module (FORGE-S16-T03).
//
// Coverage:
//   forge_collate:
//     1. Happy path (no opts)   → execFile resolves with stdout → content[0].text
//     2. With sprintId + purgeEvents → argv contains sprint ID and --purge-events
//     3. Schema-violation (sprintId: number) → TypeBox Value.Check rejects
//   forge_store:
//     4. Happy path list  → execFile called with correct argv
//     5. dryRun=true      → argv includes --dry-run
//     6. Write subcommand → positional args preserved in order
//   forge_validate_store:
//     7. Happy path exit-0   → stdout returned as content
//     8. Exit-1 (info errors) → returned as non-error content
//     9. ENOENT (code:"ENOENT") → isError: true
//   forge_config:
//    10. get subcommand → execFile called with correct argv
//
// Note on test 3 (schema-violation via TypeBox Value.Check):
//   pi validates params before calling `execute`. We therefore test the schema
//   directly via Value.Check rather than simulating pi's dispatch path —
//   this is the correct unit-test surrogate for pi's built-in validation.
//
// Mock design note:
//   `util.promisify(execFile)` uses execFile's `util.promisify.custom` symbol to
//   resolve with { stdout, stderr } (not just stdout). When execFile is mocked
//   with vi.fn(), that custom symbol is absent. We use vi.hoisted() to create
//   a shared `_impl` object that both the factory mock and test helpers can
//   reference safely (vi.mock factories are hoisted above all imports, so top-level
//   `let` variables defined after the factory would be uninitialized at factory time).
//   The promisify.custom function reads from `_impl` at call time, not at mock
//   setup time, so the indirection works correctly.

import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock state ───────────────────────────────────────────────────────
// vi.hoisted() runs before the vi.mock factory and before module imports.
// The returned object is available in both the factory and the test body.

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

const { state } = vi.hoisted(() => {
	const state = {
		impl: (_cmd: string, _args: string[], _opts: Record<string, unknown>, cb: ExecCallback) => {
			// Default: no-op — tests must set impl before calling execute.
			// If called without setup, the promise will hang (caught as timeout).
			void _cmd;
			void _args;
			void _opts;
			void cb;
		},
	};
	return { state };
});

vi.mock("node:child_process", () => {
	// This factory runs before all imports. `state` is safe because vi.hoisted runs first.
	const { promisify } = require("node:util") as typeof import("node:util");
	const execFileMock = vi.fn((cmd: string, args: string[], opts: Record<string, unknown>, cb: ExecCallback) => {
		state.impl(cmd, args, opts, cb);
	});
	// Install promisify.custom so that promisify(execFile) in forge-tools.ts resolves
	// with { stdout, stderr } just like the real execFile — without this, promisify
	// would fall back to single-arg resolution and the { stdout, stderr } object wouldn't exist.
	(execFileMock as unknown as Record<symbol, unknown>)[promisify.custom] = (
		cmd: string,
		args: string[],
		opts: Record<string, unknown>,
	): Promise<{ stdout: string; stderr: string }> => {
		return new Promise((resolve, reject) => {
			state.impl(cmd, args, opts, (err, stdout, stderr) => {
				if (err) {
					// Attach stdout/stderr to error so forge_validate_store can read them from the rejection.
					reject(Object.assign(err, { stdout, stderr }));
				} else {
					resolve({ stdout, stderr });
				}
			});
		});
	};
	return { execFile: execFileMock };
});

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerForgeTools } from "../../../src/extensions/forgecli/forge-tools.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

const FAKE_FORGE_ROOT = "/fake/forge";
const FAKE_PROJECT_ROOT = "/fake/project";

/** Minimal ExtensionAPI stub that captures registerTool calls. */
function makeStubApi(): { pi: ExtensionAPI; tools: Map<string, ToolDefinition<unknown>> } {
	const tools = new Map<string, ToolDefinition<unknown>>();
	const pi = {
		// registerTool takes a single ToolDefinition object (name is inside).
		registerTool(def: ToolDefinition<unknown>) {
			tools.set(def.name, def);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

/** Resolve and call the execute function of a registered tool. */
async function callTool(
	tools: Map<string, ToolDefinition<unknown>>,
	name: string,
	params: unknown,
	signal?: AbortSignal,
) {
	const def = tools.get(name);
	if (!def) throw new Error(`Tool not registered: ${name}`);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (def as any).execute("fake-tool-call-id", params, signal ?? new AbortController().signal, () => {}, {});
}

/** Make execFile succeed with given stdout. */
function mockExecFileSuccess(stdout: string): void {
	state.impl = (_cmd, _args, _opts, cb) => cb(null, stdout, "");
}

/** Make execFile fail with given error (with optional stdout/stderr attached). */
function mockExecFileFailure(err: Error & { code?: number | string; stdout?: string; stderr?: string }): void {
	state.impl = (_cmd, _args, _opts, cb) => cb(err, err.stdout ?? "", err.stderr ?? "");
}

/** Capture the argv array while succeeding. */
function mockExecFileCaptureArgs(capturedArgs: string[], stdout = "ok"): void {
	state.impl = (_cmd, args, _opts, cb) => {
		capturedArgs.splice(0, capturedArgs.length, ...args);
		cb(null, stdout, "");
	};
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

let tools: Map<string, ToolDefinition<unknown>>;

beforeEach(() => {
	state.impl = () => {
		/* reset to no-op */
	};
	const stub = makeStubApi();
	registerForgeTools(stub.pi, FAKE_FORGE_ROOT, FAKE_PROJECT_ROOT);
	tools = stub.tools;
});

afterEach(() => {
	vi.clearAllMocks();
});

// ── forge_collate ─────────────────────────────────────────────────────────────

describe("forge_collate", () => {
	it("test 1 — happy path (no opts): stdout returned as content[0].text", async () => {
		mockExecFileSuccess("collate done");
		const result = await callTool(tools, "forge_collate", {});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const r = result as any;
		expect(r.content[0].text).toBe("collate done");
		expect(r.isError).toBeFalsy();
	});

	it("test 2 — sprintId + purgeEvents: argv includes sprint ID and --purge-events", async () => {
		const capturedArgs: string[] = [];
		mockExecFileCaptureArgs(capturedArgs);

		await callTool(tools, "forge_collate", { sprintId: "FORGE-S16", purgeEvents: true });
		expect(capturedArgs).toContain("FORGE-S16");
		expect(capturedArgs).toContain("--purge-events");
	});

	it("test 3 — schema rejects sprintId: number (TypeBox Value.Check)", () => {
		// Retrieve the TypeBox schema directly from the registered tool definition.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const def = tools.get("forge_collate") as any;
		const schema = def.parameters;
		// pi validates before execute; Value.Check is the correct surrogate for pi's validation.
		const valid = Value.Check(schema, { sprintId: 42 });
		expect(valid).toBe(false);
	});
});

// ── forge_store ───────────────────────────────────────────────────────────────

describe("forge_store", () => {
	it("test 4 — happy path list: correct argv passed to execFile", async () => {
		const capturedArgs: string[] = [];
		mockExecFileCaptureArgs(capturedArgs, "task list output");

		const result = await callTool(tools, "forge_store", { command: "list", args: ["task"] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const r = result as any;
		expect(r.content[0].text).toBe("task list output");
		expect(capturedArgs).toContain(`${FAKE_FORGE_ROOT}/store-cli.cjs`);
		expect(capturedArgs).toContain("list");
		expect(capturedArgs).toContain("task");
	});

	it("test 5 — dryRun=true: argv includes --dry-run", async () => {
		const capturedArgs: string[] = [];
		mockExecFileCaptureArgs(capturedArgs);

		await callTool(tools, "forge_store", { command: "validate", args: [], dryRun: true });
		expect(capturedArgs).toContain("--dry-run");
	});

	it("test 6 — write subcommand: positional args preserved in order", async () => {
		const capturedArgs: string[] = [];
		mockExecFileCaptureArgs(capturedArgs, "written");

		await callTool(tools, "forge_store", {
			command: "write",
			args: ["task", "--json", '{"id":"FORGE-S16-T03"}'],
		});

		// Verify subcommand and args appear in correct order after the .cjs path
		const cjsIdx = capturedArgs.indexOf(`${FAKE_FORGE_ROOT}/store-cli.cjs`);
		expect(cjsIdx).toBeGreaterThanOrEqual(0);
		const afterCjs = capturedArgs.slice(cjsIdx + 1);
		expect(afterCjs).toEqual(["write", "task", "--json", '{"id":"FORGE-S16-T03"}']);
	});
});

// ── forge_validate_store ──────────────────────────────────────────────────────

describe("forge_validate_store", () => {
	it("test 7 — happy path exit-0: stdout returned as content", async () => {
		mockExecFileSuccess("All checks passed.");
		const result = await callTool(tools, "forge_validate_store", {});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const r = result as any;
		expect(r.content[0].text).toBe("All checks passed.");
		expect(r.isError).toBeFalsy();
	});

	it("test 8 — exit-1 (informational errors): returned as non-error content", async () => {
		const err = Object.assign(new Error("exit code 1"), {
			code: 1, // numeric exit code — informational
			stdout: "WARN: 3 issues found",
			stderr: "",
		});
		mockExecFileFailure(err);

		const result = await callTool(tools, "forge_validate_store", {});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const r = result as any;
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("WARN: 3 issues found");
	});

	it("test 9 — ENOENT (code:'ENOENT' string): isError: true", async () => {
		// Node sets `.code` to a STRING for spawn errors (ENOENT, ETIMEDOUT, etc.)
		// — distinct from numeric exit codes. The string type guard ensures ENOENT
		// is treated as a hard failure even though the number check (code === 1) is false.
		const err = Object.assign(new Error("spawn ENOENT"), {
			code: "ENOENT" as const, // string code
		});
		mockExecFileFailure(err);

		const result = await callTool(tools, "forge_validate_store", {});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const r = result as any;
		expect(r.isError).toBe(true);
	});
});

// ── forge_config ──────────────────────────────────────────────────────────────

describe("forge_config", () => {
	it("test 10 — get subcommand: correct argv passed to execFile", async () => {
		const capturedArgs: string[] = [];
		mockExecFileCaptureArgs(capturedArgs, "./forge/forge");

		const result = await callTool(tools, "forge_config", {
			subcommand: "get",
			args: ["paths.forgeRoot"],
		});
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const r = result as any;
		expect(r.content[0].text).toBe("./forge/forge");
		expect(capturedArgs).toEqual([`${FAKE_FORGE_ROOT}/manage-config.cjs`, "get", "paths.forgeRoot"]);
	});
});

// ── Layout detection (FORGE-BUG-029 regression) ──────────────────────────────

describe("layout detection", () => {
	it("test 11 — flat layout (no tools/ subdir): toolPath = forgeRoot/<x>.cjs", async () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const os = require("node:os") as typeof import("node:os");
		const pathMod = require("node:path") as typeof import("node:path");
		const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), "forge-flat-"));
		try {
			fs.writeFileSync(pathMod.join(tmp, "store-cli.cjs"), "");

			const stub = makeStubApi();
			registerForgeTools(stub.pi, tmp, FAKE_PROJECT_ROOT);

			const capturedArgs: string[] = [];
			mockExecFileCaptureArgs(capturedArgs, "ok");
			await (stub.tools.get("forge_store") as ToolDefinition<unknown>).execute(
				"id",
				{ command: "list", args: ["task"] },
				new AbortController().signal,
				() => {},
				{},
			);
			expect(capturedArgs[0]).toBe(pathMod.join(tmp, "store-cli.cjs"));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("test 12 — nested layout (tools/ subdir present): toolPath = forgeRoot/tools/<x>.cjs", async () => {
		const fs = require("node:fs") as typeof import("node:fs");
		const os = require("node:os") as typeof import("node:os");
		const pathMod = require("node:path") as typeof import("node:path");
		const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), "forge-nested-"));
		try {
			const toolsDir = pathMod.join(tmp, "tools");
			fs.mkdirSync(toolsDir);
			fs.writeFileSync(pathMod.join(toolsDir, "store-cli.cjs"), "");

			const stub = makeStubApi();
			registerForgeTools(stub.pi, tmp, FAKE_PROJECT_ROOT);

			const capturedArgs: string[] = [];
			mockExecFileCaptureArgs(capturedArgs, "ok");
			await (stub.tools.get("forge_store") as ToolDefinition<unknown>).execute(
				"id",
				{ command: "list", args: ["task"] },
				new AbortController().signal,
				() => {},
				{},
			);
			expect(capturedArgs[0]).toBe(pathMod.join(toolsDir, "store-cli.cjs"));
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
