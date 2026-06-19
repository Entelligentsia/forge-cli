// run-init-pipeline.test.ts — unit tests for the /forge:init FSM orchestrator
// pipeline (FORGE-S33-T03).
//
// Mock strategy (playbook §2.1): mock createAgentSession at module load time via
// vi.hoisted + vi.mock. Mock runPhase3/runPhase4 from forge-init/ modules to return
// controlled results without real disk IO.
//
// IL10 compliance: orchestrator emits phase events; no store-cli emit inside
// dispatchInitPhase (subagents never call store-cli emit for phase events).
//
// Coverage (8 tests):
//   1. startPhase=2 skips Phase 1 dispatch
//   2. startPhase=1 runs all 4 phases
//   3. Phase 1 failure returns ok=false
//   4. Phase 3 hard-halt: runPhase3 returns "abort" → ok=false, no retry
//   5. Phase 3 abort → ok=false
//   6. Checkpoint writeInitProgress called with correct phase after each phase
//   7. InitReport shape: lastPhase populated correctly
//   8. startPhase=3 skips Phases 1 and 2

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoist shared mocks ────────────────────────────────────────────────────────

const { mockSession, emitTurnEnd } = vi.hoisted(() => {
	let capturedSubscriber: ((e: { type: string; message?: unknown }) => void) | null = null;

	function emitTurnEnd(model = "claude-sonnet-4-5", provider = "anthropic", exitCode = 0): void {
		if (!capturedSubscriber) return;
		const stopReason = exitCode !== 0 ? "error" : "stop";
		capturedSubscriber({
			type: "turn_end",
			message: {
				role: "assistant",
				model,
				provider,
				content: [{ type: "text", text: exitCode === 0 ? "✓" : "✗" }],
				stopReason,
				errorMessage: exitCode !== 0 ? "subagent error" : undefined,
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			},
		});
	}

	const mockSession = {
		subscribe: vi.fn((listener: (e: { type: string; message?: unknown }) => void) => {
			capturedSubscriber = listener;
			return () => {
				capturedSubscriber = null;
			};
		}),
		prompt: vi.fn(() => Promise.resolve()),
		abort: vi.fn(),
		dispose: vi.fn(),
		agent: { sessionId: undefined as string | undefined },
	};

	return { mockSession, emitTurnEnd };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	class MockDefaultResourceLoader {
		reload() {
			return Promise.resolve();
		}
	}
	return {
		...actual,
		createAgentSession: vi.fn(async () => ({ session: mockSession })),
		DefaultResourceLoader: MockDefaultResourceLoader,
		AuthStorage: { create: vi.fn(() => ({})) },
		ModelRegistry: { create: vi.fn(() => ({ find: vi.fn(() => undefined) })) },
		SessionManager: { inMemory: vi.fn(() => ({})) },
		parseFrontmatter: vi.fn((raw: string) => ({ frontmatter: {}, body: raw })),
		getAgentDir: vi.fn(() => "/fake/agent-dir"),
	};
});

// Mock forge-init/run-phases.ts:runPhase3 and forge-init/phase4-register.ts:runPhase4.
const mockRunPhase3 = vi.fn<() => Promise<"ok" | "abort">>(async () => "ok");
const mockRunPhase4 = vi.fn<() => Promise<{ kbPathFinal: string } | "abort">>(
	async () => ({ kbPathFinal: "engineering" }),
);

vi.mock(
	"../../../src/extensions/forgecli/forge-init/run-phases.js",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			runPhase3: (..._args: unknown[]) => mockRunPhase3(),
		};
	},
);

vi.mock(
	"../../../src/extensions/forgecli/forge-init/phase4-register.js",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			runPhase4: (..._args: unknown[]) => mockRunPhase4(),
		};
	},
);

// Mock writeInitProgress so we can spy on it without touching the filesystem.
const mockWriteInitProgress = vi.fn<(cwd: string, lastPhase: 1 | 2 | 3 | 4) => void>(() => undefined);

vi.mock(
	"../../../src/extensions/forgecli/forge-init/init-progress.js",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			writeInitProgress: (cwd: string, lastPhase: 1 | 2 | 3 | 4) => mockWriteInitProgress(cwd, lastPhase),
		};
	},
);

// Mock verifyPhase2 to return ok=true by default.
const mockVerifyPhase2 = vi.fn(async () => ({ ok: true, missing: [] as string[] }));

vi.mock(
	"../../../src/extensions/forgecli/forge-init/verifiers.js",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			verifyPhase2: (..._args: unknown[]) => mockVerifyPhase2(),
		};
	},
);

// Mock init-context helpers (post-verify hooks) — non-fatal, always succeed.
vi.mock(
	"../../../src/extensions/forgecli/forge-init/init-context.js",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			buildProjectContext: vi.fn(() => ({ project: { name: "test", prefix: "TST" } })),
			validateProjectContext: vi.fn(),
			writeProjectContext: vi.fn(),
			computeCalibrationBaseline: vi.fn(() => ({ fileCount: 0 })),
		};
	},
);

// Mock exec-helpers:runToolAdvisory (used by post-verify hooks) — non-fatal.
vi.mock(
	"../../../src/extensions/forgecli/lib/exec-helpers.js",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			runToolAdvisory: vi.fn(async () => undefined),
		};
	},
);

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import {
	runInitPipeline,
	type RunInitPipelineOptions,
} from "../../../src/extensions/forgecli/orchestrators/init/run-init-pipeline.js";
import { INIT_PHASES, INIT_SESSION_ID } from "../../../src/extensions/forgecli/orchestrators/init/init-phases.js";
import { getSessionRegistry } from "../../../src/extensions/forgecli/session-registry.js";
import { getOrchestratorTree } from "../../../src/extensions/forgecli/orchestrator-tree.js";
import { runToolAdvisory } from "../../../src/extensions/forgecli/lib/exec-helpers.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpRoot: string;
let proj: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-init-pipeline-"));
	proj = path.join(tmpRoot, "project");

	// Create minimum project structure. NOTE: no .forge/personas — init loads its
	// dispatch persona from the bundle (Phase 1 runs before Phase 3 materializes
	// .forge/personas, and .forge may be absent entirely on a fresh project).
	fs.mkdirSync(path.join(proj, ".forge", "cache"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "store"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "workflows"), { recursive: true });

	// Write a minimal engineer persona file into the BUNDLE base-pack — the source
	// init reads dispatch personas from.
	const bundlePersonasDir = path.join(tmpRoot, "bundle", ".base-pack", "personas");
	fs.mkdirSync(bundlePersonasDir, { recursive: true });
	fs.writeFileSync(
		path.join(bundlePersonasDir, "engineer.md"),
		[
			"---",
			"name: engineer",
			"description: Forge engineer persona for testing",
			"---",
			"",
			"# Engineer",
			"",
			"I am the test engineer persona.",
		].join("\n"),
		"utf8",
	);

	// Write a minimal config.json so loadLayeredConfig succeeds.
	fs.writeFileSync(
		path.join(proj, ".forge", "config.json"),
		JSON.stringify({
			project: { name: "test-project", prefix: "TST", stack: "TypeScript/Node" },
			paths: { engineering: "engineering", forgeRoot: path.join(tmpRoot, "bundle") },
			installedSkills: ["typescript"],
		}),
		"utf8",
	);

	// Create bundleRoot/init/phases/ with stub phase prompts.
	const phasesDir = path.join(tmpRoot, "bundle", "init", "phases");
	fs.mkdirSync(phasesDir, { recursive: true });
	fs.writeFileSync(
		path.join(phasesDir, "phase-1-collect.md"),
		"# Phase 1: Collect\nDiscover the tech stack.",
		"utf8",
	);
	fs.writeFileSync(
		path.join(phasesDir, "phase-2-discover.md"),
		"# Phase 2: Discover\nWrite KB docs.",
		"utf8",
	);

	// Stub manage-config.cjs so the deterministic paths.engineering write
	// (orchestrator-owned KB-folder decision) is exercised; runToolAdvisory is
	// mocked, so the stub only needs to exist for the fs.existsSync guard.
	const toolsDir = path.join(tmpRoot, "bundle", "tools");
	fs.mkdirSync(toolsDir, { recursive: true });
	fs.writeFileSync(path.join(toolsDir, "manage-config.cjs"), "// stub", "utf8");

	// Stub config layer for preflight (layered-config.json not required by loadLayeredConfig).
	// Reset all mocks.
	vi.mocked(createAgentSession).mockClear();
	mockSession.subscribe.mockClear();
	mockSession.prompt.mockClear();
	mockSession.dispose.mockClear();
	mockSession.agent.sessionId = undefined;
	mockRunPhase3.mockClear();
	mockRunPhase4.mockClear();
	mockWriteInitProgress.mockClear();
	mockVerifyPhase2.mockClear();

	// Default mock implementations.
	mockRunPhase3.mockResolvedValue("ok");
	mockRunPhase4.mockResolvedValue({ kbPathFinal: "engineering" });
	mockVerifyPhase2.mockResolvedValue({ ok: true, missing: [] });
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

/** Make a minimal ExtensionCommandContext for testing. */
function makeCtx() {
	return {
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(() => Promise.resolve(true)),
			setStatus: vi.fn(),
		},
		hasUI: true,
		modelRegistry: { find: vi.fn(() => undefined) },
	};
}

/** Build base RunInitPipelineOptions. */
function makeOpts(overrides?: Partial<RunInitPipelineOptions>): RunInitPipelineOptions {
	const ctx = makeCtx();
	return {
		// RunInitOptions fields
		forgeRoot: path.join(proj, ".forge"),
		kbFolder: "engineering",
		startPhase: 1,
		isoTimestamp: "2026-06-18T00:00:00.000Z",
		// RunInitPipelineOptions extensions
		ctx: ctx as unknown as RunInitPipelineOptions["ctx"],
		cwd: proj,
		bundleRoot: path.join(tmpRoot, "bundle"),
		toolsRoot: path.join(tmpRoot, "bundle", "tools"),
		projectName: "test-project",
		storeCli: path.join(tmpRoot, "bundle", "tools", "store-cli.cjs"),
		modelRoutingConfig: {
			"persona-models": {},
			pipelines: {},
			_global: null,
			_project: null,
		},
		isPiRuntime: () => false,
		getBundledToolsRoot: () => path.join(tmpRoot, "bundle", "tools"),
		...overrides,
	};
}

/**
 * Configure mockSession to fire a successful turn_end after each prompt() call.
 */
function mockSuccessfulAgentSession(exitCode: 0 | 1 = 0): void {
	mockSession.prompt.mockImplementation(async () => {
		emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
	});
}

// ── Tests ────────────────────────────────────────────────────────────────────────

describe("runInitPipeline — startPhase routing", () => {
	it("test 1: startPhase=2 skips Phase 1 dispatch", async () => {
		mockSuccessfulAgentSession(0);

		// Phase 2 (discover) dispatches: gate + 7 kb-docs + index + context = 10 agents.
		// Phase 1 (collect) dispatches: 5 domains + 1 config-writer = 6 agents.
		// If startPhase=2, Phase 1 agents should NOT be dispatched.
		const opts = makeOpts({ startPhase: 2 });
		await runInitPipeline(opts);

		// createAgentSession call count should be Phase 2 agents only (10), NOT 16.
		const callCount = vi.mocked(createAgentSession).mock.calls.length;
		// Phase 1 would add 6 calls — with startPhase=2 it should be < 16.
		expect(callCount).toBeLessThan(16);
		// Verify Phase 2 agents were dispatched (call count > 0).
		expect(callCount).toBeGreaterThan(0);
	});

	it("test 8: startPhase=3 skips Phases 1 and 2", async () => {
		mockSuccessfulAgentSession(0);

		const opts = makeOpts({ startPhase: 3 });
		await runInitPipeline(opts);

		// With startPhase=3, no LLM agents dispatched (Phase 3 is deterministic).
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
		// runPhase3 was called.
		expect(mockRunPhase3).toHaveBeenCalledTimes(1);
	});
});

describe("runInitPipeline — full 4-phase run", () => {
	it("test 2: startPhase=1 runs all 4 phases (dispatchInitPhase x2 + runPhase3 + runPhase4)", async () => {
		mockSuccessfulAgentSession(0);

		const opts = makeOpts({ startPhase: 1 });
		const report = await runInitPipeline(opts);

		// Phase 3 and Phase 4 run.
		expect(mockRunPhase3).toHaveBeenCalledTimes(1);
		expect(mockRunPhase4).toHaveBeenCalledTimes(1);

		// LLM phases dispatched: Phase 1 (6) + Phase 2 (10) = 16.
		expect(vi.mocked(createAgentSession).mock.calls.length).toBeGreaterThanOrEqual(2);

		expect(report.ok).toBe(true);
	});
});

describe("runInitPipeline — deterministic KB-folder decision", () => {
	it("orchestrator writes paths.engineering itself after Phase 1 (not an LLM-routed decision)", async () => {
		mockSuccessfulAgentSession(0);

		const opts = makeOpts({ startPhase: 1, kbFolder: "ai-docs" });
		await runInitPipeline(opts);

		// The orchestrator must set paths.engineering deterministically via
		// manage-config — the LLM config-writer does not own this field.
		const calls = vi.mocked(runToolAdvisory).mock.calls;
		const setPathCall = calls.find(
			(c) => Array.isArray(c[1]) && c[1][0] === "set" && c[1][1] === "paths.engineering",
		);
		expect(setPathCall).toBeDefined();
		expect(setPathCall?.[1]).toEqual(["set", "paths.engineering", "ai-docs"]);
	});
});

describe("runInitPipeline — orchestrator TUI wiring (chip strip + dashboard)", () => {
	it("opens a 'forge-init' orchestrator session + tree node and completes it on success", async () => {
		mockSuccessfulAgentSession(0);

		const opts = makeOpts({ startPhase: 1 });
		await runInitPipeline(opts);

		// Root orchestrator node exists and is completed (chip strip would have
		// shown a live 'forge:init' session; the dashboard renders this tree).
		const root = getOrchestratorTree().getNode(INIT_SESSION_ID);
		expect(root).toBeDefined();
		expect(root?.kind).toBe("orchestrator");
		expect(root?.status).toBe("completed");
		// Per-dispatch leaf nodes were attached under the root (one per subagent).
		expect(root && root.children.length).toBeGreaterThan(0);

		// SessionRegistry session is completed, not left 'running' (no stuck spinner).
		const session = getSessionRegistry().listSessions().find((s) => s.taskId === INIT_SESSION_ID);
		expect(session).toBeDefined();
		expect(session?.status).toBe("completed");
		expect(session && session.phases.length).toBeGreaterThan(0);
	});

	it("completes the session as 'failed' when a phase fails (no leaked running session)", async () => {
		// First dispatched agent fails → Phase 1 returns failure.
		mockSuccessfulAgentSession(1);

		const opts = makeOpts({ startPhase: 1 });
		const report = await runInitPipeline(opts);
		expect(report.ok).toBe(false);

		const root = getOrchestratorTree().getNode(INIT_SESSION_ID);
		expect(root?.status).toBe("failed");
		const session = getSessionRegistry().listSessions().find((s) => s.taskId === INIT_SESSION_ID);
		expect(session?.status).toBe("failed");
	});
});

describe("runInitPipeline — failure propagation", () => {
	it("test 3: Phase 1 failure returns ok=false", async () => {
		// Make Phase 1 config-writer fail on first AND retry attempt.
		mockSession.prompt.mockImplementation(async () => {
			emitTurnEnd("claude-sonnet-4-5", "anthropic", 0); // domain agents succeed
		});
		// Override: first 5 calls (domain agents) succeed, then config-writer fails.
		let callIdx = 0;
		mockSession.prompt.mockImplementation(async () => {
			callIdx++;
			// Calls 1–5: domain agents → success; call 6: config-writer → fail; call 7: retry → fail
			const exitCode = callIdx <= 5 ? 0 : 1;
			emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
		});

		const opts = makeOpts({ startPhase: 1 });
		const report = await runInitPipeline(opts);

		expect(report.ok).toBe(false);
		expect(report.failure).toBeDefined();
		expect(typeof report.failure).toBe("string");
	});

	it("test 5: Phase 3 abort → ok=false, lastPhase=3", async () => {
		mockSuccessfulAgentSession(0);
		mockRunPhase3.mockResolvedValue("abort");

		const opts = makeOpts({ startPhase: 3 });
		const report = await runInitPipeline(opts);

		expect(report.ok).toBe(false);
		expect(report.lastPhase).toBe(3);
		expect(report.failure).toBe("Phase 3 abort (verify failed or tools missing)");
		// No retry — runPhase3 called exactly once.
		expect(mockRunPhase3).toHaveBeenCalledTimes(1);
	});

	it("test 4: Phase 3 abort → no retry (hard-halt)", async () => {
		mockSuccessfulAgentSession(0);
		mockRunPhase3.mockResolvedValue("abort");

		const opts = makeOpts({ startPhase: 3 });
		await runInitPipeline(opts);

		// runPhase3 should be called exactly once — hard-halt means no retry.
		expect(mockRunPhase3).toHaveBeenCalledTimes(1);
	});
});

describe("runInitPipeline — checkpoint writes", () => {
	it("test 6: writeInitProgress called with correct phase after each phase", async () => {
		mockSuccessfulAgentSession(0);

		const opts = makeOpts({ startPhase: 1 });
		await runInitPipeline(opts);

		// Phase 1 → writeInitProgress(cwd, 1)
		// Phase 2 → writeInitProgress(cwd, 2)
		// Phase 3 → writeInitProgress(cwd, 3)
		// Phase 4 → no writeInitProgress call from pipeline (runPhase4 handles it internally)
		const calls = mockWriteInitProgress.mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(3);

		const phases = calls.map(([, p]) => p);
		expect(phases).toContain(1);
		expect(phases).toContain(2);
		expect(phases).toContain(3);

		// Phase 4 should not produce a writeInitProgress call from the FSM.
		expect(phases).not.toContain(4);
	});
});

describe("runInitPipeline — InitReport shape", () => {
	it("test 7: InitReport.lastPhase populated correctly on success", async () => {
		mockSuccessfulAgentSession(0);

		const opts = makeOpts({ startPhase: 1 });
		const report = await runInitPipeline(opts);

		expect(report.ok).toBe(true);
		// 4 phases ran successfully (index 0-3), lastPhase should be 4.
		expect(report.lastPhase).toBe(INIT_PHASES.length);
	});
});
