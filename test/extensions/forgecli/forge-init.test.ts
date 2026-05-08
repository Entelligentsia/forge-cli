// forge-init.test.ts — Tests for forge-init.ts (FORGE-S17-T02)
// Covers T06-T24 from PLAN.md test table.

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs");
vi.mock("node:child_process", () => ({
	execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
		if (typeof cb === "function") cb(null, "", "");
		return { pid: 1 };
	}),
	execFileSync: vi.fn(),
}));
vi.mock("node:util", () => ({
	promisify: vi.fn((fn: unknown) => {
		// Return a promisified version that resolves immediately
		return (...args: unknown[]) => new Promise<void>((resolve) => {
			const argsWithCb = [...args, (err: Error | null) => {
				if (err) resolve(); // treat all errors as non-fatal in tests
				else resolve();
			}];
			(fn as Function)(...argsWithCb); // eslint-disable-line
		});
	}),
}));

// Mock the modules used by forge-init
vi.mock("../../../src/extensions/forgecli/init-progress.js", () => ({
	readInitProgress: vi.fn(),
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
	runHealthCheck: vi.fn(() => Promise.resolve({ clean: true, gaps: [], configPresent: true, summary: "〇 /forge:health: clean." })),
}));

vi.mock("../../../src/extensions/forgecli/refresh-kb-links.js", () => ({
	runRefreshKbLinks: vi.fn(() => Promise.resolve({ filesUpdated: 0, filesSkipped: 0, messages: [] })),
	getRefreshKbLinksHandler: vi.fn(() => vi.fn(() => Promise.resolve({ filesUpdated: 0, filesSkipped: 0, messages: [] }))),
}));

const mockFs = vi.mocked(fs);

// Helper: build a mock ExtensionCommandContext
function buildMockCtx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(() => Promise.resolve(false)),
			setStatus: vi.fn(),
		},
		waitForIdle: vi.fn(() => Promise.resolve()),
		...overrides,
	};
}

// Helper: build a mock ExtensionAPI with sendUserMessage
function buildMockPi(): { registerCommand: ReturnType<typeof vi.fn>; sendUserMessage: ReturnType<typeof vi.fn> } {
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }> = {};
	return {
		registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = def;
		}),
		sendUserMessage: vi.fn(),
		_commands: commands as unknown,
	} as ReturnType<typeof buildMockPi>;
}

import { readInitProgress, deleteInitProgress, writeInitProgress } from "../../../src/extensions/forgecli/init-progress.js";
import { registerForgeInit } from "../../../src/extensions/forgecli/forge-init.js";

const mockReadInitProgress = vi.mocked(readInitProgress);
const mockDeleteInitProgress = vi.mocked(deleteInitProgress);
const mockWriteInitProgress = vi.mocked(writeInitProgress);

describe("registerForgeInit", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default fs mocks
		mockFs.existsSync.mockReturnValue(false);
		mockFs.readFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		mockFs.mkdirSync.mockImplementation(() => undefined);
		mockFs.writeFileSync.mockImplementation(() => undefined);
		mockFs.copyFileSync.mockImplementation(() => undefined);
		mockFs.readdirSync.mockReturnValue([]);
		mockFs.appendFileSync.mockImplementation(() => undefined);
		// Default: no init-progress file
		mockReadInitProgress.mockReturnValue({ kind: "none" });
	});

	it("registers forge:init command", () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"forge:init",
			expect.objectContaining({ description: expect.any(String), handler: expect.any(Function) }),
		);
	});

	// T06: --fast --full conflict → early return with error, no phase executed
	it("T06: --fast --full conflict notifies error and returns early", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("--fast --full", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Conflicting flags"),
			"error",
		);
		expect(mockWriteInitProgress).not.toHaveBeenCalled();
	});

	// T07: --fast only → flag acknowledgement emitted
	it("T07: --fast flag emits acknowledgement", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("--fast", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("--fast"),
			"info",
		);
	});

	// T08: --full only → flag acknowledgement emitted
	it("T08: --full flag emits acknowledgement", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("--full", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("--full"),
			"info",
		);
	});

	// T09: --fast 3 → skip to Phase 3 (no flag ack, no pre-flight table)
	it("T09: --fast 3 skips to phase 3", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("--fast 3", ctx);

		// Phase 1 progress should NOT be written when starting at phase 3
		// (startPhase = 3 so phase 1 block is skipped)
		const phase1Calls = (mockWriteInitProgress as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c: unknown[]) => c[1] === 1
		);
		expect(phase1Calls.length).toBe(0);
	});

	// T10: --fast foo → invalid phase, falls through to pre-flight
	it("T10: --fast foo with invalid phase triggers pre-flight", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("--fast foo", ctx);

		// sendUserMessage should be called for the pre-flight table
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("4 phases will run"),
		);
	});

	// T01: Resume detection — no file → shows pre-flight (no malformed/stale warning)
	it("T01: no init-progress file → shows pre-flight without malformed/stale warning", async () => {
		mockReadInitProgress.mockReturnValue({ kind: "none" });

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("", ctx);

		// Pre-flight should be sent (project name in pre-flight text)
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Forge Init"),
		);

		// No malformed/stale warning — should not have been called for cleanup at the start
		const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
		const hasStaleWarning = notifyCalls.some(([msg]) => msg.toLowerCase().includes("stale") || msg.toLowerCase().includes("malformed"));
		expect(hasStaleWarning).toBe(false);
	});

	// T02: Resume detection — malformed JSON
	it("T02: malformed init-progress → triangle warning, delete, continue", async () => {
		mockReadInitProgress.mockReturnValue({ kind: "malformed" });

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("malformed"),
			"warning",
		);
		expect(mockDeleteInitProgress).toHaveBeenCalled();
	});

	// T03: Resume detection — stale lastPhase=7
	it("T03: stale init-progress (lastPhase=7) → silently delete, continue", async () => {
		mockReadInitProgress.mockReturnValue({ kind: "stale", reason: "lastPhase=7 > 4" });

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("", ctx);

		expect(mockDeleteInitProgress).toHaveBeenCalled();
	});

	// T04: Resume detection — stale (mode key present)
	it("T04: stale init-progress (mode key) → delete and continue", async () => {
		mockReadInitProgress.mockReturnValue({ kind: "stale", reason: 'contains "mode" field' });

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("", ctx);

		expect(mockDeleteInitProgress).toHaveBeenCalled();
	});

	// T05: Resume detection — valid phase 2 → resume banner + confirm
	it("T05: valid phase 2 checkpoint → resume banner shown, confirm presented", async () => {
		mockReadInitProgress.mockReturnValue({
			kind: "valid",
			progress: { lastPhase: 2, timestamp: "2026-05-09T00:00:00Z" },
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx({
			ui: {
				notify: vi.fn(),
				confirm: vi.fn(() => Promise.resolve(false)), // user says no → start over
				setStatus: vi.fn(),
			},
		});

		await def.handler("", ctx);

		expect(ctx.ui.confirm).toHaveBeenCalledWith(
			"Resume /forge:init?",
			expect.stringContaining("Phase 3"),
		);
	});

	// T21: /forge:health post-Phase-4 — clean result
	it("T21: health check clean result → 〇 message emitted", async () => {
		const { runHealthCheck } = await import("../../../src/extensions/forgecli/health-check.js");
		const mockHealth = vi.mocked(runHealthCheck);
		mockHealth.mockResolvedValue({ clean: true, gaps: [], configPresent: true, summary: "〇 /forge:health: clean." });

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("〇 /forge:health: clean.", "info");
	});

	// T22: /forge:health post-Phase-4 — gaps result
	it("T22: health check with gaps → gap count in notification", async () => {
		const { runHealthCheck } = await import("../../../src/extensions/forgecli/health-check.js");
		const mockHealth = vi.mocked(runHealthCheck);
		mockHealth.mockResolvedValue({
			clean: false,
			gaps: [{ check: "config", severity: "warning", message: "missing field" }],
			configPresent: true,
			summary: "△ /forge:health: 1 gap(s) detected.",
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("1 gap(s) detected"),
			"warning",
		);
	});

	// T23: post-init sentinel written
	it("T23: post-init sentinel file is written when absent", async () => {
		mockFs.existsSync.mockImplementation((p: unknown) => {
			const pathStr = String(p);
			// Sentinel does not exist
			return !pathStr.includes("post-init-enhancement-triggered");
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx();

		await def.handler("", ctx);

		// writeFileSync called for the sentinel
		const sentinelCalls = (mockFs.writeFileSync as ReturnType<typeof vi.fn>).mock.calls.filter(
			(c: unknown[]) => String(c[0]).includes("post-init-enhancement-triggered")
		);
		expect(sentinelCalls.length).toBeGreaterThan(0);

		// Advisory notice emitted
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("/forge:enhance"),
			"info",
		);
	});

	// T24: Idempotency — re-run on initialised project
	it("T24: re-run with valid phase-4 checkpoint shows resume prompt", async () => {
		mockReadInitProgress.mockReturnValue({
			kind: "valid",
			progress: { lastPhase: 3, timestamp: "2026-05-09T00:00:00Z" },
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx({
			ui: {
				notify: vi.fn(),
				confirm: vi.fn(() => Promise.resolve(false)),
				setStatus: vi.fn(),
			},
		});

		await def.handler("", ctx);

		// Should show resume prompt at Phase 4
		expect(ctx.ui.confirm).toHaveBeenCalledWith(
			"Resume /forge:init?",
			expect.stringContaining("Phase 4"),
		);
	});
});
