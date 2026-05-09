// bug-024-forgeroot-piaware.test.ts — FORGE-BUG-024
//
// Phase-4 must stamp paths.forgeRoot to the bundled payload tools path
// (dist/forge-payload/) under pi runtime, NOT to a Claude-Code-only cache path.
//
// Asserts:
//   1. resolveBundleToolsRoot() returns a path that exists on disk
//   2. That path contains store-cli.cjs
//   3. isPiRuntime() returns true by default (forge-init.ts runs under pi only)
//   4. The value stamped as paths.forgeRoot in Phase-4 is the bundled payload root
//      (getBundledPayloadRoot()), NOT a Claude-Code cache path

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// We test the exported helpers directly.
// They are exported from forge-init.ts for test access.
import {
	resolveBundleToolsRoot,
	isPiRuntime,
} from "../../../src/extensions/forgecli/forge-init.js";

// ── Direct helper tests ───────────────────────────────────────────────────────

describe("FORGE-BUG-024: resolveBundleToolsRoot() and isPiRuntime()", () => {
	it("resolveBundleToolsRoot() returns a path that exists on disk", () => {
		const toolsRoot = resolveBundleToolsRoot();
		expect(typeof toolsRoot).toBe("string");
		expect(toolsRoot.length).toBeGreaterThan(0);
		expect(fs.existsSync(toolsRoot)).toBe(true);
	});

	it("resolveBundleToolsRoot() returns a directory containing store-cli.cjs", () => {
		const toolsRoot = resolveBundleToolsRoot();
		const storeCli = path.join(toolsRoot, "store-cli.cjs");
		expect(fs.existsSync(storeCli)).toBe(true);
	});

	it("isPiRuntime() returns true (forge-init.ts always runs under pi runtime)", () => {
		expect(isPiRuntime()).toBe(true);
	});
});

// ── Phase-4 integration: paths.forgeRoot stamp ───────────────────────────────

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return { ...original };
});

vi.mock("node:child_process", () => ({
	execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
		if (typeof cb === "function") cb(null, "", "");
		return { pid: 1 };
	}),
	execFileSync: vi.fn(),
}));

vi.mock("node:util", () => ({
	promisify: vi.fn((fn: unknown) => {
		return (...args: unknown[]) =>
			new Promise<void>((resolve) => {
				const argsWithCb = [
					...args,
					(err: Error | null) => {
						void err;
						resolve();
					},
				];
				(fn as (...a: unknown[]) => void)(...argsWithCb);
			});
	}),
}));

vi.mock("../../../src/extensions/forgecli/init-progress.js", () => ({
	readInitProgress: vi.fn(() => ({ kind: "none" })),
	writeInitProgress: vi.fn(),
	deleteInitProgress: vi.fn(),
}));

vi.mock("../../../src/extensions/forgecli/init-context.js", () => ({
	discoverProjectName: vi.fn(() => "test-project"),
	buildProjectContext: vi.fn(() => ({
		project: { name: "test-project", prefix: "TP" },
		knowledgeBase: { path: "engineering" },
	})),
	validateProjectContext: vi.fn(),
	writeProjectContext: vi.fn(),
	computeCalibrationBaseline: vi.fn(() => ({
		lastCalibrated: "2026-05-09T00:00:00Z",
		version: "0.40.3",
		masterIndexHash: null,
		sprintsCovered: 0,
	})),
}));

vi.mock("../../../src/extensions/forgecli/health-check.js", () => ({
	runHealthCheck: vi.fn(() =>
		Promise.resolve({ clean: true, gaps: [], configPresent: true, summary: "〇 /forge:health: clean." }),
	),
}));

vi.mock("../../../src/extensions/forgecli/refresh-kb-links.js", () => ({
	runRefreshKbLinks: vi.fn(() => Promise.resolve({ filesUpdated: 0, filesSkipped: 0, messages: [] })),
	getRefreshKbLinksHandler: vi.fn(() =>
		vi.fn(() => Promise.resolve({ filesUpdated: 0, filesSkipped: 0, messages: [] })),
	),
}));

import { registerForgeInit } from "../../../src/extensions/forgecli/forge-init.js";

function buildMockPi(): {
	registerCommand: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
} {
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	return {
		registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = def;
		}),
		sendUserMessage: vi.fn(),
		_commands: commands as unknown,
	} as ReturnType<typeof buildMockPi>;
}

function buildMockCtx(): Record<string, unknown> {
	return {
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(() => Promise.resolve(false)),
			setStatus: vi.fn(),
		},
		waitForIdle: vi.fn(() => Promise.resolve()),
	};
}

describe("FORGE-BUG-024: Phase-4 stamps pi-aware paths.forgeRoot", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("Phase-4 stamps paths.forgeRoot to bundled payload root (not Claude-Code cache path)", async () => {
		// Spy on fs.readFileSync / manage-config calls to track what value is written.
		// The manage-config tool is called with ["set", "paths.forgeRoot", <value>].
		// We track execFile calls to verify the value stamped is the bundled tools root.

		const execFileCalls: string[][] = [];
		const execFileMod = await import("node:child_process");
		vi.mocked(execFileMod.execFile).mockImplementation(
			(cmd: string, args: string[], _opts: unknown, cb: unknown) => {
				execFileCalls.push([cmd, ...(args as string[])]);
				if (typeof cb === "function") (cb as (err: null, stdout: string, stderr: string) => void)(null, "", "");
				return { pid: 1 } as ReturnType<typeof import("node:child_process").execFile>;
			},
		);

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [
			string,
			{ handler: (a: string, ctx: unknown) => Promise<void> },
		];
		const ctx = buildMockCtx();

		await def.handler("4", ctx); // jump to Phase 4 directly

		// Find the manage-config call for paths.forgeRoot
		const forgeRootCall = execFileCalls.find(
			(c) => c.some((a) => a.includes("manage-config.cjs")) && c.includes("paths.forgeRoot"),
		);

		expect(forgeRootCall).toBeDefined();

		// The value stamped must NOT be a Claude-Code plugin cache path
		const stampedValue = forgeRootCall![forgeRootCall!.length - 1];
		expect(stampedValue).not.toMatch(/\.claude\/plugins\/cache/);
		expect(stampedValue).not.toMatch(/\.claude[/\\]plugins[/\\]cache/);

		// The value stamped must point to dist/forge-payload/.tools
		// (per FORGE-BUG-024 fix spec: stamp to bundled tools path = .tools dir)
		const expectedToolsRoot = resolveBundleToolsRoot();
		expect(stampedValue).toBe(expectedToolsRoot);
	});

	it("the stamped forgeRoot path's .tools/ subdir contains store-cli.cjs", () => {
		// Verify that resolveBundleToolsRoot() returns a .tools/ dir with store-cli.cjs
		const toolsRoot = resolveBundleToolsRoot();
		const storeCli = path.join(toolsRoot, "store-cli.cjs");
		expect(fs.existsSync(storeCli)).toBe(true);
	});
});
