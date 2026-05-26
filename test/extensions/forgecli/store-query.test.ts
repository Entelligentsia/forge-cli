// Unit tests for /forge:search handler (FORGE-S23-T10, renamed FORGE-S26-T10)
//
// Tests:
//   - runStoreQuery: "--" prefix dispatches to store-cli query branch
//   - runStoreQuery: no "--" prefix dispatches to store-cli nlp branch
//   - registerStoreQuery: empty args emits usage message without calling store-cli
//   - registerStoreQuery: outside-project guard (null forgeRoot)
//   - EXPLICITLY_REGISTERED_NAMES: "forge:search" present (renamed from forge:store-query)

import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock state (ESM-compatible, runs before imports) ─────────────────

const execFileMock = vi.hoisted(() => ({
	lastArgs: null as string[] | null,
	shouldFail: false,
	capturedArgv: [] as string[],
}));

// Mock store-resolver to control resolveToolDir
vi.mock("../../../src/extensions/forgecli/store-resolver.js", () => ({
	resolveToolDir: vi.fn((forgeRoot: string) => path.join(forgeRoot, "tools")),
	ENTITY_TYPES: new Set(["task", "sprint", "bug", "feature"]),
	ID_PATTERNS: {},
	isDebug: vi.fn(() => false),
	runStoreCli: vi.fn(),
}));

// Mock node:child_process with callback-compatible execFile
// Note: store-query.ts uses promisify(execFile) — the mock must be in place
// before the module is imported (vi.mock is hoisted).
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(
			(
				_cmd: string,
				args: string[],
				_opts: unknown,
				cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
			) => {
				// promisify uses the last argument as callback
				// Capture argv for inspection
				execFileMock.capturedArgv = args;
				if (execFileMock.shouldFail) {
					cb(new Error("store-cli failed"), { stdout: "", stderr: "failed" });
				} else {
					cb(null, { stdout: `mock-output-for:${args.join(",")}`, stderr: "" });
				}
			},
		),
	};
});

import { __test__ as forgeCommandsTest } from "../../../src/extensions/forgecli/forge-commands.js";
import { registerStoreQuery } from "../../../src/extensions/forgecli/store-query.js";

const FAKE_FORGE_ROOT = "/fake/forge";

beforeEach(() => {
	execFileMock.shouldFail = false;
	execFileMock.capturedArgv = [];
	vi.clearAllMocks();
});

afterEach(() => {
	vi.clearAllMocks();
});

// ── registerStoreQuery dispatch ───────────────────────────────────────────────

describe("registerStoreQuery dispatch", () => {
	function buildPi(handlers: Map<string, (args: string, ctx: unknown) => Promise<void>>) {
		return {
			registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				handlers.set(name, def.handler);
			}),
		};
	}

	function buildCtx(messages: Array<{ msg: string; severity: string }>) {
		return {
			ui: {
				notify: vi.fn((msg: string, severity: string) => {
					messages.push({ msg, severity });
				}),
				setStatus: vi.fn(),
			},
		};
	}

	it("-- prefix dispatches to store-cli query branch (argv starts with 'query')", async () => {
		const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const pi = buildPi(handlers);
		const messages: Array<{ msg: string; severity: string }> = [];
		const ctx = buildCtx(messages);

		registerStoreQuery(pi as any, { forgeRoot: FAKE_FORGE_ROOT });
		const handler = handlers.get("forge:search");
		expect(handler).toBeDefined();

		await handler!("--sprint FORGE-S12 --status in-progress", ctx as any);

		// Should emit the mock output (not an error)
		expect(messages.some((m) => m.severity !== "error")).toBe(true);
		// args = [storeCliPath, "query", "--sprint", "FORGE-S12", ...]
		// args[0] is the store-cli.cjs path; args[1] onwards are the argv
		expect(execFileMock.capturedArgv[1]).toBe("query");
		expect(execFileMock.capturedArgv).toContain("--sprint");
		expect(execFileMock.capturedArgv).toContain("FORGE-S12");
	});

	it("no -- prefix dispatches to store-cli nlp branch (argv starts with 'nlp')", async () => {
		const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const pi = buildPi(handlers);
		const messages: Array<{ msg: string; severity: string }> = [];
		const ctx = buildCtx(messages);

		registerStoreQuery(pi as any, { forgeRoot: FAKE_FORGE_ROOT });
		const handler = handlers.get("forge:search");
		expect(handler).toBeDefined();

		await handler!("open bugs in S12", ctx as any);

		// args = [storeCliPath, "nlp", "open bugs in S12"]
		expect(execFileMock.capturedArgv[1]).toBe("nlp");
		expect(execFileMock.capturedArgv[2]).toBe("open bugs in S12");
	});

	it("empty args emits usage message without calling store-cli", async () => {
		const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const pi = buildPi(handlers);
		const messages: Array<{ msg: string; severity: string }> = [];
		const ctx = buildCtx(messages);

		registerStoreQuery(pi as any, { forgeRoot: FAKE_FORGE_ROOT });
		const handler = handlers.get("forge:search");
		expect(handler).toBeDefined();

		await handler!("", ctx as any);

		// Usage message emitted
		expect(messages.some((m) => m.msg.includes("Usage:"))).toBe(true);
		// store-cli not called
		expect(execFileMock.capturedArgv).toHaveLength(0);
	});

	it("emits error notify when forgeRoot is null (outside-project guard)", async () => {
		const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const pi = buildPi(handlers);
		const messages: Array<{ msg: string; severity: string }> = [];
		const ctx = buildCtx(messages);

		registerStoreQuery(pi as any, { forgeRoot: null });
		const handler = handlers.get("forge:search");
		expect(handler).toBeDefined();
		await handler!("open tasks", ctx as any);
		expect(messages.some((m) => m.severity === "error" && m.msg.includes("forge:init"))).toBe(true);
	});
});

// ── EXPLICITLY_REGISTERED_NAMES ──────────────────────────────────────────────

describe("EXPLICITLY_REGISTERED_NAMES", () => {
	it("contains forge:search (renamed from forge:store-query in v1.0)", () => {
		const { EXPLICITLY_REGISTERED_NAMES } = forgeCommandsTest;
		expect(EXPLICITLY_REGISTERED_NAMES.has("forge:search")).toBe(true);
		// Old name should also be present as a deprecated redirect stub
		expect(EXPLICITLY_REGISTERED_NAMES.has("forge:store-query")).toBe(true);
	});
});
