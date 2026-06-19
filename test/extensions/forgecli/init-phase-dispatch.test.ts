// init-phase-dispatch.test.ts — unit tests for the /forge:init per-phase
// dispatcher (FORGE-S33-T02).
//
// Mock strategy (playbook §2.1): mock createAgentSession at module load time via
// vi.hoisted + vi.mock, NOT sendKickoff. IL10 compliance: no store-cli emit
// inside dispatchInitPhase.
//
// Coverage:
//   1. deterministic phase returns { kind: "skip" }
//   2. Phase 1 model resolution: discovery agents use resolved model
//   3. AskBroker.withUI called once per dispatched agent (Phase 1: 6 agents)
//   4. Phase 1 config-writer failure triggers retry
//   5. Phase 1 retry exhausted: residual failure returns { kind: "return", status: "failed" }
//   6. Phase 2 gate failure halts immediately (no KB-doc agents)
//   7. Phase 2 KB-doc retry: failed doc retried once
//   8. Phase 2 sequential cap notified via ctx.ui.notify
//   9. Phase 1 success returns { kind: "ok" }

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoist shared mocks ────────────────────────────────────────────────────────

const { mockSession, emitTurnEnd } = vi.hoisted(() => {
	let capturedSubscriber: ((e: { type: string; message?: unknown }) => void) | null = null;

	function emitTurnEnd(model = "claude-sonnet-4-5", provider = "anthropic", exitCode = 0): void {
		if (!capturedSubscriber) return;
		// Use stopReason="error" to trigger exitCode=1 in forge-subagent.ts (line ~498).
		// forge-subagent sets result.exitCode = 1 when stopReason === "error".
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

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { AskBroker } from "../../../src/extensions/forgecli/ask-broker.js";
import {
	dispatchInitPhase,
	type InitPhaseDispatchParams,
} from "../../../src/extensions/forgecli/orchestrators/init/init-phase-dispatch.js";
import { INIT_PHASES } from "../../../src/extensions/forgecli/orchestrators/init/init-phases.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpRoot: string;
let proj: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-init-dispatch-"));
	proj = path.join(tmpRoot, "project");

	// NOTE: intentionally do NOT create proj/.forge/personas. Real /forge:init runs
	// Phase 1 dispatch *before* Phase 3 materializes .forge/, and on a fresh or reset
	// project .forge/ does not exist at all. Init must load its dispatch persona from
	// the bundle's .base-pack/personas/, never from cwd/.forge (FORGE-BUG: ENOENT on
	// .forge/personas/engineer.md). The bundle persona is written below.
	fs.mkdirSync(path.join(proj, ".forge", "cache"), { recursive: true });

	// Write a minimal engineer persona file into the BUNDLE base-pack — the only
	// source init reads dispatch personas from.
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

	// Create bundleRoot/init/phases/ with stub phase prompts.
	const phasesDir = path.join(tmpRoot, "bundle", "init", "phases");
	fs.mkdirSync(phasesDir, { recursive: true });
	fs.writeFileSync(path.join(phasesDir, "phase-1-collect.md"), "# Phase 1: Collect\nDiscover the tech stack.", "utf8");
	fs.writeFileSync(path.join(phasesDir, "phase-2-discover.md"), "# Phase 2: Discover\nWrite KB docs.", "utf8");

	// Reset mock state.
	vi.mocked(createAgentSession).mockClear();
	mockSession.subscribe.mockClear();
	mockSession.prompt.mockClear();
	mockSession.dispose.mockClear();
	mockSession.agent.sessionId = undefined;
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

/** Build base dispatch params for a given phase index. */
function makeParams(
	phaseIndex: number,
	ctxOverride?: ReturnType<typeof makeCtx>,
): InitPhaseDispatchParams {
	return {
		opts: {
			forgeRoot: path.join(proj, ".forge"),
			kbFolder: "engineering",
			isoTimestamp: "2026-06-18T00:00:00.000Z",
		},
		phase: INIT_PHASES[phaseIndex],
		phaseIndex,
		cwd: proj,
		ctx: (ctxOverride ?? makeCtx()) as unknown as InitPhaseDispatchParams["ctx"],
		bundleRoot: path.join(tmpRoot, "bundle"),
		kbFolder: "engineering",
		isoTimestamp: "2026-06-18T00:00:00.000Z",
		modelRoutingConfig: {
			"persona-models": {},
			pipelines: {},
			_global: null,
			_project: null,
		},
	};
}

/**
 * Make createAgentSession fire a successful turn_end after each prompt() call.
 * Captures call count for assertions.
 */
function mockSuccessfulSession(exitCode: 0 | 1 = 0) {
	mockSession.prompt.mockImplementation(async () => {
		emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dispatchInitPhase — deterministic phase", () => {
	it("returns { kind: 'skip' } for Phase 2 materialize (deterministic)", async () => {
		// INIT_PHASES[2] = "materialize", kind="deterministic"
		const p = makeParams(2);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("skip");
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
	});

	it("returns { kind: 'skip' } for Phase 3 register (deterministic)", async () => {
		// INIT_PHASES[3] = "register", kind="deterministic"
		const p = makeParams(3);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("skip");
		expect(vi.mocked(createAgentSession)).not.toHaveBeenCalled();
	});
});

describe("dispatchInitPhase — Phase 1 (collect)", () => {
	it("Phase 1 success: returns { kind: 'ok' }", async () => {
		mockSuccessfulSession(0);
		const p = makeParams(0);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("ok");
	});

	it("Phase 1 loads its dispatch persona from the bundle, not cwd/.forge (regression: ENOENT on .forge/personas/engineer.md when .forge absent)", async () => {
		mockSuccessfulSession(0);
		// Hard-guarantee the project has NO .forge/personas — the fresh-init / deleted-.forge
		// scenario. Before the fix, dispatch called loadForgePersona(cwd) and threw
		// ENOENT here; now it reads from bundleRoot/.base-pack/personas/.
		const p = makeParams(0);
		expect(fs.existsSync(path.join(proj, ".forge", "personas"))).toBe(false);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("ok");
		// 5 domains + 1 config-writer dispatched without any persona-read failure.
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(6);
	});

	it("Phase 1 dispatches 5 domain agents + 1 config-writer = 6 total createAgentSession calls", async () => {
		mockSuccessfulSession(0);
		const p = makeParams(0);
		await dispatchInitPhase(p);
		// 5 domains + 1 config-writer = 6
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(6);
	});

	it("Phase 1: AskBroker.withUI called once per dispatched agent (6 calls)", async () => {
		mockSuccessfulSession(0);
		const withUISpy = vi.spyOn(AskBroker, "withUI");
		const p = makeParams(0);
		await dispatchInitPhase(p);
		expect(withUISpy).toHaveBeenCalledTimes(6);
	});

	it("Phase 1 model resolution: config-writer resolves via the 'config' role key (regression — not the display label)", async () => {
		mockSuccessfulSession(0);
		const ctx = makeCtx();
		const findSpy = ctx.modelRegistry.find;
		const p = makeParams(0, ctx);
		// A model configured under the "config" ROLE_TIER key must resolve for the
		// config-writer dispatch. Before the fix the dispatcher passed the display
		// label ("config-writer") as the phase key, so config never matched and every
		// init agent silently inherited. The 5 discovery agents have no config entry,
		// so they inherit (no find call); only config-writer resolves.
		p.modelRoutingConfig = {
			"persona-models": {},
			pipelines: {
				default: {
					phases: {
						config: { "model-override": { provider: "anthropic", model: "claude-haiku-4-5" } },
					},
				},
			},
			_global: null,
			_project: null,
		};
		await dispatchInitPhase(p);
		expect(findSpy).toHaveBeenCalledTimes(1);
		expect(findSpy).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
	});

	it("Phase 1 config-writer failure triggers retry (7 createAgentSession calls total)", async () => {
		let callCount = 0;
		mockSession.prompt.mockImplementation(async () => {
			callCount++;
			// First 5 domain agents succeed, config-writer (call 6) fails, retry (call 7) succeeds.
			const exitCode = callCount === 6 ? 1 : 0;
			emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
		});
		const ctx = makeCtx();
		const p = makeParams(0, ctx);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("ok");
		// 5 domain + 1 failed config-writer + 1 retry = 7
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(7);
	});

	it("Phase 1 retry exhausted: both config-writer and retry fail → { kind: 'return', status: 'failed' }", async () => {
		let callCount = 0;
		mockSession.prompt.mockImplementation(async () => {
			callCount++;
			// First 5 domain agents succeed; config-writer (call 6) and retry (call 7) both fail.
			const exitCode = callCount >= 6 ? 1 : 0;
			emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
		});
		const p = makeParams(0);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("return");
		if (outcome.kind === "return") {
			expect(outcome.result.status).toBe("failed");
			expect(outcome.result.failure).toContain("config-writer");
		}
	});

	it("Phase 1 domain agent failure halts immediately (fewer than 6 createAgentSession calls)", async () => {
		let callCount = 0;
		mockSession.prompt.mockImplementation(async () => {
			callCount++;
			// Second domain agent (call 2) fails.
			const exitCode = callCount === 2 ? 1 : 0;
			emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
		});
		const p = makeParams(0);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("return");
		if (outcome.kind === "return") {
			expect(outcome.result.status).toBe("failed");
		}
		// Should have stopped after 2 calls (not 6+).
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(2);
	});
});

describe("dispatchInitPhase — Phase 2 (discover)", () => {
	it("Phase 2 gate failure halts immediately: no KB-doc agents dispatched", async () => {
		mockSession.prompt.mockImplementation(async () => {
			// Gate agent (call 1) fails.
			emitTurnEnd("claude-sonnet-4-5", "anthropic", 1);
		});
		const p = makeParams(1);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("return");
		if (outcome.kind === "return") {
			expect(outcome.result.status).toBe("failed");
			expect(outcome.result.failure).toContain("gate");
		}
		// Only 1 call for the gate agent.
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(1);
	});

	it("Phase 2 KB-doc retry: one failed doc retried once, then success → { kind: 'ok' }", async () => {
		let callCount = 0;
		mockSession.prompt.mockImplementation(async () => {
			callCount++;
			// Call 1: gate succeeds.
			// Call 3: second KB-doc fails (one retry expected on call 4, which succeeds).
			// All other calls succeed.
			const exitCode = callCount === 3 ? 1 : 0;
			emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
		});
		const p = makeParams(1);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("ok");
		// 1 gate + 7 KB-docs (1 retry) + 1 index + 1 context = 1+8+1+1 = 11
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(11);
	});

	it("Phase 2 KB-doc retry exhausted: second failure returns { kind: 'return', status: 'failed' }", async () => {
		let callCount = 0;
		mockSession.prompt.mockImplementation(async () => {
			callCount++;
			// Call 1: gate succeeds.
			// Calls 2 and 3: first KB-doc fails + retry both fail.
			const exitCode = callCount === 2 || callCount === 3 ? 1 : 0;
			emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
		});
		const p = makeParams(1);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("return");
		if (outcome.kind === "return") {
			expect(outcome.result.status).toBe("failed");
			expect(outcome.result.failure).toContain("kb-doc");
		}
	});

	it("Phase 2 sequential cap notified via ctx.ui.notify", async () => {
		mockSuccessfulSession(0);
		const ctx = makeCtx();
		const p = makeParams(1, ctx);
		await dispatchInitPhase(p);
		const notifyCalls = vi.mocked(ctx.ui.notify).mock.calls.map(([msg]) => msg);
		const capNotify = notifyCalls.find(
			(m) => m.includes("sequential") && m.includes("fan-out"),
		);
		expect(capNotify).toBeTruthy();
		expect(capNotify).toContain("sequential");
	});

	it("Phase 2 full success: gate + 7 KB-docs + index + context = 10 agents", async () => {
		mockSuccessfulSession(0);
		const p = makeParams(1);
		const outcome = await dispatchInitPhase(p);
		expect(outcome.kind).toBe("ok");
		// 1 gate + 7 KB-docs + 1 index + 1 context = 10
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(10);
	});
});
