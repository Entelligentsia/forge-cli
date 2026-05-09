// bug-025-no-claude-commands-in-pi.test.ts — FORGE-BUG-025
//
// Under pi runtime, Phase-3 must NOT leave a .claude/commands/<prefix>/ directory
// at the project root after init completes. Programmatic registration via
// registerAllForgeCommands is the sole working path under pi.
//
// Asserts:
//   1. After a full init run (Phase 1–4), .claude/commands/<prefix>/ does NOT exist
//      in the target cwd (pi mode always-true heuristic).
//   2. registerAllForgeCommands registers the expected set of slash command names
//      (plan, implement, run-task, fix-bug, approve, validate, commit, sprint-plan,
//       sprint-intake, run-sprint, review-code, review-plan, collate, quiz-agent,
//       retrospective, enhance — subset that are NOT in REAL_HANDLERS).
//   3. The final Report contains the pi-runtime note about programmatic registration.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Mock setup ────────────────────────────────────────────────────────────────

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
import { registerAllForgeCommands } from "../../../src/extensions/forgecli/forge-commands.js";
import { getBundledPayloadRoot } from "../../../src/extensions/forgecli/forge-init.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildMockPi(registeredCommands: Map<string, unknown> = new Map()): {
	registerCommand: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
} {
	return {
		registerCommand: vi.fn((name: string, def: unknown) => {
			registeredCommands.set(name, def);
		}),
		sendUserMessage: vi.fn(),
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("FORGE-BUG-025: no .claude/commands/ output in pi runtime", () => {
	let tmpDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-init-test-"));
	});

	afterEach(() => {
		// Clean up temp dir
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// non-fatal
		}
	});

	it("registerAllForgeCommands registers expected pi slash commands programmatically", () => {
		const registeredCommands = new Map<string, unknown>();
		const pi = buildMockPi(registeredCommands);

		const bundlePayloadRoot = getBundledPayloadRoot();
		registerAllForgeCommands(pi as unknown as Parameters<typeof registerAllForgeCommands>[0], {
			bundlePayloadRoot,
		});

		// These command names must be registered (they are NOT in EXPLICITLY_REGISTERED_NAMES)
		// Note: forge:sprint-intake was moved to EXPLICITLY_REGISTERED_NAMES in FORGE-S19-T01
		// (native TS handler registered in sprint-intake.ts). It is no longer a stub.
		// Note: forge:sprint-plan was moved to EXPLICITLY_REGISTERED_NAMES in FORGE-S19-T02
		// (native TS handler registered in sprint-plan.ts). It is no longer a stub.
		const expectedStubCommands = [
			"forge:plan",
			"forge:implement",
			"forge:run-task",
			"forge:fix-bug",
			"forge:approve",
			"forge:validate",
			"forge:commit",
			"forge:run-sprint",
		];

		for (const cmd of expectedStubCommands) {
			expect(registeredCommands.has(cmd), `Expected command ${cmd} to be registered`).toBe(true);
		}

		// refresh-kb-links and enhance are also registered by registerAllForgeCommands
		expect(registeredCommands.has("forge:refresh-kb-links")).toBe(true);
		expect(registeredCommands.has("forge:enhance")).toBe(true);
	});

	it("after Phase-4, .claude/commands/ is cleaned up in pi mode (isPiRuntime=true)", async () => {
		// Simulate that substitute-placeholders wrote some .claude/commands/ files
		// (as the real tool would during Phase 3). After Phase 4 in pi mode,
		// these must be removed.

		// Pre-create the .claude/commands/forge/ directory (as if Phase 3 created it)
		const claudeCommandsDir = path.join(tmpDir, ".claude", "commands", "forge");
		fs.mkdirSync(claudeCommandsDir, { recursive: true });
		fs.writeFileSync(path.join(claudeCommandsDir, "plan.md"), "# plan", "utf8");
		fs.writeFileSync(path.join(claudeCommandsDir, "implement.md"), "# implement", "utf8");

		// Verify the directory exists before init
		expect(fs.existsSync(claudeCommandsDir)).toBe(true);

		// We need to run the handler with cwd=tmpDir to test the cleanup
		// Since cwd is process.cwd() in the handler, we temporarily override it.
		const origCwd = process.cwd();
		process.chdir(tmpDir);

		try {
			const pi = buildMockPi();
			registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

			const [, def] = pi.registerCommand.mock.calls[0] as [
				string,
				{ handler: (a: string, ctx: unknown) => Promise<void> },
			];
			const ctx = buildMockCtx();

			// Run Phase 4 only (skip 1-3 to avoid full LLM phases in test)
			await def.handler("4", ctx);

			// After Phase 4, .claude/commands/<prefix>/ must NOT exist (pi mode cleanup)
			expect(fs.existsSync(claudeCommandsDir)).toBe(false);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("the final Report contains the pi-runtime programmatic registration note", async () => {
		const pi = buildMockPi();
		registerForgeInit(pi as unknown as Parameters<typeof registerForgeInit>[0]);

		const [, def] = pi.registerCommand.mock.calls[0] as [
			string,
			{ handler: (a: string, ctx: unknown) => Promise<void> },
		];
		const ctx = buildMockCtx();

		await def.handler("4", ctx); // Phase 4

		// The final report sent via pi.sendUserMessage should contain the pi-runtime note
		const allMessages = (pi.sendUserMessage as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
		const reportCall = allMessages.find((c) => String(c[0]).includes("forge:init complete"));
		expect(reportCall).toBeDefined();
		const reportText = String(reportCall![0]);
		expect(reportText).toMatch(/programmatically.*pi runtime|pi runtime.*programmatically/i);
	});
});
