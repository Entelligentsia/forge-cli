// forge-init.test.ts — Tests for forge-init.ts (FORGE-S17-T02)
// Covers T06-T24 from PLAN.md test table.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
			input: vi.fn(() => Promise.resolve(undefined)),
			setStatus: vi.fn(),
		},
		waitForIdle: vi.fn(() => Promise.resolve()),
		...overrides,
	};
}

/**
 * Like buildMockCtx but with confirm always resolving true.
 * Use for tests that need the full phase pipeline to run (G2 pre-flight confirm proceeds).
 */
function buildMockCtxProceed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(() => Promise.resolve(true)),
			input: vi.fn(() => Promise.resolve(undefined)),
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
		const ctx = buildMockCtx({
			ui: {
				notify: vi.fn(),
				confirm: vi.fn(() => Promise.resolve(true)), // user confirms pre-flight
				input: vi.fn(() => Promise.resolve(undefined)),
				setStatus: vi.fn(),
			},
		});

		await def.handler("--fast foo", ctx);

		// ctx.ui.confirm should be called for the pre-flight gate (G2)
		const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
		expect(confirmLabels.some((l) => l.includes("Start /forge:init?"))).toBe(true);
	});

	// T01: Resume detection — no file → shows pre-flight (no malformed/stale warning)
	it("T01: no init-progress file → shows pre-flight without malformed/stale warning", async () => {
		mockReadInitProgress.mockReturnValue({ kind: "none" });

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtx({
			ui: {
				notify: vi.fn(),
				confirm: vi.fn(() => Promise.resolve(true)), // user confirms pre-flight
				input: vi.fn(() => Promise.resolve(undefined)),
				setStatus: vi.fn(),
			},
		});

		await def.handler("", ctx);

		// Pre-flight confirm (G2) must have been shown with project name context
		const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
		expect(confirmLabels.some((l) => l.includes("Start /forge:init?"))).toBe(true);

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
		const ctx = buildMockCtxProceed();

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
		const ctx = buildMockCtxProceed();

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
		const ctx = buildMockCtxProceed();

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

	// ── Bug fix tests ───────────────────────────────────────────────────────

	// BUG-017: no sendUserMessage calls during banner or Phase-1 prompt rendering
	// (hero-banner and KB folder prompt must NOT use pi.sendUserMessage synchronously
	// during an already-active agent turn without deliverAs option)
	it("bug-017-no-active-turn-conflict: all pi.sendUserMessage calls carry deliverAs option", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtxProceed();

		await def.handler("", ctx);

		// Every call to pi.sendUserMessage must include a second argument with deliverAs
		const calls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
		for (const call of calls) {
			expect(call.length).toBeGreaterThanOrEqual(2);
			const opts = call[1] as Record<string, unknown>;
			expect(opts).toBeDefined();
			expect(["steer", "followUp"]).toContain(opts.deliverAs);
		}
	});

	// BUG-018: all 4 phase-complete markers fire in order
	it("bug-018-phase3-marker: all 4 phase-complete markers emitted in order", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtxProceed();

		await def.handler("", ctx);

		const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
		const completionMessages = notifyCalls
			.filter(([msg]) => msg.includes("Phase") && msg.includes("complete"))
			.map(([msg]) => msg);

		// Must include all 4 phase-complete markers
		expect(completionMessages.some((m) => m.includes("Phase 1"))).toBe(true);
		expect(completionMessages.some((m) => m.includes("Phase 2"))).toBe(true);
		expect(completionMessages.some((m) => m.includes("Phase 3"))).toBe(true);
		expect(completionMessages.some((m) => m.includes("Phase 4"))).toBe(true);

		// Check ordering: phase 1 before 2 before 3 before 4
		const idx1 = notifyCalls.findIndex(([m]) => m.includes("Phase 1") && m.includes("complete"));
		const idx2 = notifyCalls.findIndex(([m]) => m.includes("Phase 2") && m.includes("complete"));
		const idx3 = notifyCalls.findIndex(([m]) => m.includes("Phase 3") && m.includes("complete"));
		const idx4 = notifyCalls.findIndex(([m]) => m.includes("Phase 4") && m.includes("complete"));
		expect(idx1).toBeLessThan(idx2);
		expect(idx2).toBeLessThan(idx3);
		expect(idx3).toBeLessThan(idx4);
	});

	// BUG-019: manifest.forge_version must equal bundledVersion, not a hardcoded stale value
	it("bug-019-manifest-version: Report prints bundledVersion not stale constant", async () => {
		// Simulate plugin.json returning a specific version
		mockFs.readFileSync.mockImplementation((p: unknown) => {
			const pathStr = String(p);
			if (pathStr.includes("plugin.json")) {
				return JSON.stringify({ version: "0.40.3" });
			}
			if (pathStr.includes("config.json")) {
				return JSON.stringify({
					version: "1",
					project: { name: "test-project", prefix: "TP" },
					paths: { engineering: "engineering" },
				});
			}
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtxProceed();

		await def.handler("", ctx);

		// The final report sent via sendUserMessage should contain bundledVersion (0.40.3)
		const reportCalls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
		const reportCall = reportCalls.find((c) => String(c[0]).includes("forge:init complete"));
		expect(reportCall).toBeDefined();
		const reportText = String(reportCall![0]);
		expect(reportText).toContain("0.40.3");
		// Must NOT contain the stale hardcoded version
		expect(reportText).not.toContain("0.24.1");
	});

	// BUG-020: Report shows actual chosen KB folder, not hardcoded "engineering/"
	it("bug-020-report-kb-folder: Report KB folder reflects config not default", async () => {
		mockFs.readFileSync.mockImplementation((p: unknown) => {
			const pathStr = String(p);
			if (pathStr.includes("config.json")) {
				return JSON.stringify({
					version: "1",
					project: { name: "test-project", prefix: "TP" },
					paths: { engineering: "ai-docs" },
				});
			}
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtxProceed();

		await def.handler("", ctx);

		const reportCalls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
		const reportCall = reportCalls.find((c) => String(c[0]).includes("forge:init complete"));
		expect(reportCall).toBeDefined();
		const reportText = String(reportCall![0]);
		// Must show "ai-docs/" not "engineering/"
		expect(reportText).toContain("ai-docs/");
	});

	// BUG-021: build-overlay smoke exits cleanly on fresh init (task not found is expected)
	it("bug-021-smoke-seed: smoke gate advisory does not block Phase 3 completion", async () => {
		// build-overlay.cjs exists but INIT-SMOKE-TEST task is not seeded
		mockFs.existsSync.mockImplementation((p: unknown) => {
			const pathStr = String(p);
			// Report build-overlay.cjs as existing
			return pathStr.includes("build-overlay.cjs");
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtxProceed();

		// Should NOT throw even though INIT-SMOKE-TEST task is absent
		await expect(def.handler("", ctx)).resolves.not.toThrow();

		// Phase 3 should still be marked complete
		expect(mockWriteInitProgress).toHaveBeenCalledWith(expect.any(String), 3);
	});

	// BUG-022: health gaps surfaced in Report; blocking exit only for critical ("error") gaps
	it("bug-022-health-gap-surfaced: warning-severity gaps surface in Report without blocking exit", async () => {
		const { runHealthCheck } = await import("../../../src/extensions/forgecli/health-check.js");
		const mockHealth = vi.mocked(runHealthCheck);
		mockHealth.mockResolvedValue({
			clean: false,
			gaps: [
				{ check: "kb-freshness", severity: "warning", message: "MASTER_INDEX.md not found" },
			],
			configPresent: true,
			summary: "△ /forge:health: 1 gap(s) detected.",
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtxProceed();

		// Warning-severity gaps must not cause an exception (handler resolves cleanly)
		await expect(def.handler("", ctx)).resolves.not.toThrow();

		// Gap detail must appear in the final Report
		const reportCalls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
		const reportCall = reportCalls.find((c) => String(c[0]).includes("forge:init complete"));
		expect(reportCall).toBeDefined();
		const reportText = String(reportCall![0]);
		expect(reportText).toContain("kb-freshness");
	});

	// BUG-022 (error path): critical gaps (severity "error") cause non-zero signal in Report
	it("bug-022-health-gap-critical: error-severity gaps surfaced in Report text", async () => {
		const { runHealthCheck } = await import("../../../src/extensions/forgecli/health-check.js");
		const mockHealth = vi.mocked(runHealthCheck);
		mockHealth.mockResolvedValue({
			clean: false,
			gaps: [
				{ check: "config-completeness", severity: "error", message: ".forge/config.json missing" },
			],
			configPresent: false,
			summary: "△ /forge:health: 1 gap(s) detected.",
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		const ctx = buildMockCtxProceed();

		await def.handler("", ctx);

		// Gap detail and severity must appear in Report
		const reportCalls = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
		const reportCall = reportCalls.find((c) => String(c[0]).includes("forge:init complete"));
		expect(reportCall).toBeDefined();
		const reportText = String(reportCall![0]);
		expect(reportText).toContain("config-completeness");
	});

	// BUG-023: KB folder prompt blocks until user answers (uses ctx.ui.confirm, not sendUserMessage)
	it("bug-023-prompt-blocking: KB folder prompt uses ctx.ui.confirm, not fire-and-forget sendUserMessage", async () => {
		// Track whether confirm was called before Phase 1 completes
		let phase1WriteProgressCalled = false;

		mockWriteInitProgress.mockImplementation((_cwd: unknown, phase: unknown) => {
			if (phase === 1) {
				phase1WriteProgressCalled = true;
			}
		});

		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];

		// Build a ctx where:
		//   - G2 pre-flight confirm returns true (proceed)
		//   - G3 KB folder confirm returns false (no conflict — default "engineering")
		let confirmCallCount = 0;
		const ctx = buildMockCtx({
			ui: {
				notify: vi.fn(),
				setStatus: vi.fn(),
				input: vi.fn(() => Promise.resolve(undefined)),
				confirm: vi.fn(() => {
					confirmCallCount++;
					// First call = G2 pre-flight (return true to proceed into Phase 1)
					// Subsequent calls = G3 KB folder (return false = no conflict)
					return Promise.resolve(confirmCallCount === 1);
				}),
			},
		});

		await def.handler("", ctx);

		// At least two confirms must have been called: G2 (pre-flight) and G3 (KB folder)
		// This proves the KB folder confirm blocks Phase 1 (not fire-and-forget)
		expect(confirmCallCount).toBeGreaterThanOrEqual(2);
		// The KB folder confirm must have been awaited before Phase 1 completes
		// (writeInitProgress(1) is called after G3 in Phase 1)
		expect(phase1WriteProgressCalled).toBe(true);
		// ctx.ui.confirm was called for both G2 and G3
		const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
		expect(confirmLabels.some((l) => l.includes("Engineering folder name?"))).toBe(true);
	});
});

// ── FORGE-S18-T01: Non-interactive mode gate bypass ────────────────────────
//
// Verifies that FORGE_YES=1 and FORGE_NON_INTERACTIVE=1 both bypass every
// Y/N gate in /forge:init. Three arms per gate:
//   (a) interactive-default — gate emits prompt / calls confirm
//   (b) FORGE_NON_INTERACTIVE=1 — gate bypassed
//   (c) FORGE_YES=1 — gate bypassed

describe("non-interactive mode (FORGE-S18-T01)", () => {
	// Reset mocks and env after each test
	beforeEach(() => {
		vi.clearAllMocks();
		// Default fs mocks (mirror the outer describe setup)
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
		mockReadInitProgress.mockReturnValue({ kind: "none" });
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// Helper: register forge:init and return the captured handler + sendUserMessage spy
	function setupNonInteractiveInit(): {
		handler: (args: string, ctx: unknown) => Promise<void>;
		sendUserMessage: ReturnType<typeof vi.fn>;
	} {
		const sendUserMessage = vi.fn(() => undefined);
		const pi = buildMockPi();
		// Replace auto-generated sendUserMessage with our spy
		(pi as unknown as { sendUserMessage: unknown }).sendUserMessage = sendUserMessage;
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);
		const [, def] = pi.registerCommand.mock.calls[0] as [string, { handler: (a: string, ctx: unknown) => Promise<void> }];
		return { handler: def.handler, sendUserMessage };
	}

	// ── G1: Resume confirm ──────────────────────────────────────────────────

	describe("G1 — resume confirm", () => {
		it("(a) interactive-default: ctx.ui.confirm called when progress found", async () => {
			mockReadInitProgress.mockReturnValue({ kind: "valid", progress: { lastPhase: 2 } });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			expect(ctx.ui.confirm).toHaveBeenCalled();
		});

		it("(b) FORGE_NON_INTERACTIVE=1: ctx.ui.confirm NOT called for resume", async () => {
			vi.stubEnv("FORGE_NON_INTERACTIVE", "1");
			mockReadInitProgress.mockReturnValue({ kind: "valid", progress: { lastPhase: 2 } });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Resume"))).toBe(false);
		});

		it("(c) FORGE_YES=1: ctx.ui.confirm NOT called for resume", async () => {
			vi.stubEnv("FORGE_YES", "1");
			mockReadInitProgress.mockReturnValue({ kind: "valid", progress: { lastPhase: 2 } });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Resume"))).toBe(false);
		});
	});

	// ── G2: Pre-flight confirm ─────────────────────────────────────────────

	describe("G2 — pre-flight confirm", () => {
		it("(a) interactive-default: ctx.ui.confirm called with 'Start /forge:init?'", async () => {
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(true)), input: vi.fn(() => Promise.resolve(undefined)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Start /forge:init?"))).toBe(true);
		});

		it("(b) FORGE_NON_INTERACTIVE=1: ctx.ui.confirm NOT called for pre-flight", async () => {
			vi.stubEnv("FORGE_NON_INTERACTIVE", "1");
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), input: vi.fn(() => Promise.resolve(undefined)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Start /forge:init?"))).toBe(false);
		});

		it("(c) FORGE_YES=1: ctx.ui.confirm NOT called for pre-flight", async () => {
			vi.stubEnv("FORGE_YES", "1");
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), input: vi.fn(() => Promise.resolve(undefined)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Start /forge:init?"))).toBe(false);
		});

		it("G2-cancel: handler exits early when user cancels pre-flight confirm", async () => {
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: {
					notify: vi.fn(),
					confirm: vi.fn(() => Promise.resolve(false)), // user cancels
					input: vi.fn(() => Promise.resolve(undefined)),
					setStatus: vi.fn(),
				},
			});
			await handler("", ctx);
			// Handler exited early — writeInitProgress must NOT have been called
			expect(mockWriteInitProgress).not.toHaveBeenCalled();
		});
	});

	// ── G3: KB folder confirm + input ─────────────────────────────────────

	describe("G3 — KB folder confirm", () => {
		it("(a) interactive-default: ctx.ui.confirm called for KB folder conflict check", async () => {
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: {
					notify: vi.fn(),
					confirm: vi.fn(() => Promise.resolve(true)), // confirm pre-flight + KB check
					input: vi.fn(() => Promise.resolve(undefined)),
					setStatus: vi.fn(),
				},
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Engineering folder name?"))).toBe(true);
		});

		it("(b) FORGE_NON_INTERACTIVE=1: ctx.ui.confirm NOT called for KB folder gate", async () => {
			vi.stubEnv("FORGE_NON_INTERACTIVE", "1");
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), input: vi.fn(() => Promise.resolve(undefined)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Engineering folder name?"))).toBe(false);
		});

		it("(c) FORGE_YES=1: ctx.ui.confirm NOT called for KB folder gate", async () => {
			vi.stubEnv("FORGE_YES", "1");
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), input: vi.fn(() => Promise.resolve(undefined)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("Engineering folder name?"))).toBe(false);
		});

		it("G3-custom-folder: ctx.ui.input called when conflict confirmed, manage-config set for custom name", async () => {
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			// Both pre-flight and KB folder confirms return true; input returns "ai-docs"
			let confirmCallCount = 0;
			const ctx = buildMockCtx({
				ui: {
					notify: vi.fn(),
					confirm: vi.fn(() => {
						confirmCallCount++;
						return Promise.resolve(true); // pre-flight → proceed; KB → has conflict
					}),
					input: vi.fn(() => Promise.resolve("ai-docs")),
					setStatus: vi.fn(),
				},
			});
			// manageConfigTool: existsSync must return true for the early manage-config call
			mockFs.existsSync.mockReturnValue(true);
			await handler("", ctx);
			// ctx.ui.input must have been called (KB folder free-text)
			expect(ctx.ui.input).toHaveBeenCalled();
			const inputCalls = vi.mocked(ctx.ui.input).mock.calls;
			expect(inputCalls.some((c) => (c[0] as string).includes("Engineering folder name?"))).toBe(true);
		});

		it("G3-no-conflict: ctx.ui.input NOT called when user reports no conflict", async () => {
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			const { handler } = setupNonInteractiveInit();
			// Pre-flight confirm → true (proceed); KB folder confirm → false (no conflict)
			let confirmCallCount = 0;
			const ctx = buildMockCtx({
				ui: {
					notify: vi.fn(),
					confirm: vi.fn(() => {
						confirmCallCount++;
						// First call = pre-flight (return true); subsequent calls = KB folder (return false)
						return Promise.resolve(confirmCallCount === 1);
					}),
					input: vi.fn(() => Promise.resolve("ai-docs")),
					setStatus: vi.fn(),
				},
			});
			await handler("", ctx);
			// No conflict → ctx.ui.input NOT called for KB folder
			const inputTitles = vi.mocked(ctx.ui.input).mock.calls.map((c) => c[0] as string);
			expect(inputTitles.some((t) => t.includes("Engineering folder name?"))).toBe(false);
		});
	});

	// ── G4: linkAgentInstructionFile confirm ────────────────────────────────

	describe("G4 — CLAUDE.md confirm", () => {
		it("(a) interactive-default: ctx.ui.confirm called for CLAUDE.md creation when no instruction file exists", async () => {
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			// Make instruction files not exist so the confirm gate is reached
			mockFs.existsSync.mockImplementation((p: unknown) => {
				const ps = String(p);
				if (["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".cursorrules"].some((f) => ps.endsWith(f))) return false;
				return true; // payload dirs etc. exist
			});
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			expect(ctx.ui.confirm).toHaveBeenCalled();
		});

		it("(b) FORGE_NON_INTERACTIVE=1: ctx.ui.confirm NOT called for CLAUDE.md gate", async () => {
			vi.stubEnv("FORGE_NON_INTERACTIVE", "1");
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			mockFs.existsSync.mockImplementation((p: unknown) => {
				const ps = String(p);
				if (["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".cursorrules"].some((f) => ps.endsWith(f))) return false;
				return true;
			});
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: { notify: vi.fn(), confirm: vi.fn(() => Promise.resolve(false)), setStatus: vi.fn() },
			});
			await handler("", ctx);
			const confirmLabels = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmLabels.some((l) => l.includes("CLAUDE.md"))).toBe(false);
		});

		it("(c) FORGE_YES=1: ctx.ui.confirm NOT called for CLAUDE.md gate", async () => {
			vi.stubEnv("FORGE_YES", "1");
			mockReadInitProgress.mockReturnValue({ kind: "none" });
			mockFs.existsSync.mockImplementation((p: unknown) => {
				const ps = String(p);
				if (["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md", ".cursorrules"].some((f) => ps.endsWith(f))) return false;
				return true;
			});
			const { handler } = setupNonInteractiveInit();
			const ctx = buildMockCtx({
				ui: {
					notify: vi.fn(),
					confirm: vi.fn(() => Promise.resolve(false)),
					setStatus: vi.fn(),
				},
			});
			await handler("", ctx);
			const confirmCalls = vi.mocked(ctx.ui.confirm).mock.calls.map((c) => c[0] as string);
			expect(confirmCalls.some((label) => label.includes("CLAUDE.md"))).toBe(false);
		});
	});
});
