// init-phase-dispatch.test.ts — unit tests for the /forge:init single-subagent
// runner (FORGE-S33-T02, rewritten for the step machine by FORGE-S35-T02
// Slice 1).
//
// The fat `dispatchInitPhase` phase router was deleted: intra-phase routing
// (fan-out, gate, index/context ordering, retries) now lives in the step table
// (init-steps.ts + run-init-pipeline.ts). This module is now a leaf that
// dispatches ONE subagent, so these tests exercise `dispatchSingleAgent` and the
// `readInitPhasePrompt` helper directly. Retry/gate/fan-out coverage moved to
// run-init-pipeline.test.ts (wave model) and init-steps.test.ts (primitives).
//
// Mock strategy: mock createAgentSession at module load via vi.hoisted + vi.mock.
// A single dispatch is sequential, so one shared session is sufficient here.

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

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { AskBroker } from "../../../src/extensions/forgecli/ask-broker.js";
import {
	dispatchSingleAgent,
	readInitPhasePrompt,
	readInitSharedProcedure,
	readInitPhase2Fragment,
	resolveInitModel,
	type InitDispatchParams,
} from "../../../src/extensions/forgecli/orchestrators/init/init-phase-dispatch.js";
import type { PhaseRole } from "../../../src/extensions/forgecli/subagent/caller-context.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

let tmpRoot: string;
let proj: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-init-dispatch-"));
	proj = path.join(tmpRoot, "project");

	// Intentionally NO proj/.forge/personas — init loads its dispatch persona from
	// the bundle's .base-pack/personas/, never from cwd/.forge (FORGE-BUG: ENOENT).
	fs.mkdirSync(path.join(proj, ".forge", "cache"), { recursive: true });

	const bundlePersonasDir = path.join(tmpRoot, "bundle", ".base-pack", "personas");
	fs.mkdirSync(bundlePersonasDir, { recursive: true });
	fs.writeFileSync(
		path.join(bundlePersonasDir, "engineer.md"),
		["---", "name: engineer", "description: Forge engineer persona for testing", "---", "", "# Engineer", "", "I am the test engineer persona."].join("\n"),
		"utf8",
	);

	const phasesDir = path.join(tmpRoot, "bundle", "init", "phases");
	fs.mkdirSync(phasesDir, { recursive: true });
	fs.writeFileSync(path.join(phasesDir, "phase-1-collect.md"), "# Phase 1: Collect\nDiscover the tech stack.", "utf8");
	fs.writeFileSync(path.join(phasesDir, "phase-2-discover.md"), "# Phase 2: Discover\nWrite KB docs.", "utf8");

	// Slice 2: shared procedure + per-step substance fragments.
	const generationDir = path.join(tmpRoot, "bundle", "init", "generation");
	fs.mkdirSync(generationDir, { recursive: true });
	fs.writeFileSync(
		path.join(generationDir, "generate-kb-doc.md"),
		"# Knowledge Base Doc Generation\nShared procedure: write EXACTLY ONE file.",
		"utf8",
	);
	const phase2Dir = path.join(phasesDir, "phase-2");
	fs.mkdirSync(phase2Dir, { recursive: true });
	for (const name of ["stack", "routing", "index", "context"]) {
		fs.writeFileSync(
			path.join(phase2Dir, `${name}.md`),
			`<!-- kb-doc-fragment: ${name} -->\n# Substance — ${name}`,
			"utf8",
		);
	}

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

function makeParams(ctxOverride?: ReturnType<typeof makeCtx>): InitDispatchParams {
	return {
		opts: {
			forgeRoot: path.join(proj, ".forge"),
			kbFolder: "engineering",
			isoTimestamp: "2026-06-18T00:00:00.000Z",
		},
		cwd: proj,
		ctx: (ctxOverride ?? makeCtx()) as unknown as InitDispatchParams["ctx"],
		bundleRoot: path.join(tmpRoot, "bundle"),
		modelRoutingConfig: {
			"persona-models": {},
			pipelines: {},
			_global: null,
			_project: null,
		},
		dispatchCounts: {},
		orderHint: 0,
	};
}

function mockSuccessfulSession(exitCode: 0 | 1 = 0) {
	mockSession.prompt.mockImplementation(async () => {
		emitTurnEnd("claude-sonnet-4-5", "anthropic", exitCode);
	});
}

/** Dispatch a discovery-style subagent with the given prompt. */
function dispatch(prompt: string, p: InitDispatchParams, modelRole = "discovery") {
	return dispatchSingleAgent("discovery:stack", "plan" as PhaseRole, modelRole, prompt, undefined, "engineer", p);
}

// ── dispatchSingleAgent ────────────────────────────────────────────────────────

describe("dispatchSingleAgent", () => {
	it("dispatches one subagent and returns exitCode 0 on success", async () => {
		mockSuccessfulSession(0);
		const result = await dispatch("do the thing", makeParams());
		expect(result.exitCode).toBe(0);
		expect(vi.mocked(createAgentSession)).toHaveBeenCalledTimes(1);
	});

	it("returns exitCode 1 when the subagent errors", async () => {
		mockSuccessfulSession(1);
		const result = await dispatch("do the thing", makeParams());
		expect(result.exitCode).toBe(1);
	});

	it("loads its dispatch persona from the bundle, not cwd/.forge (regression: ENOENT)", async () => {
		mockSuccessfulSession(0);
		const p = makeParams();
		expect(fs.existsSync(path.join(proj, ".forge", "personas"))).toBe(false);
		const result = await dispatch("do the thing", p);
		expect(result.exitCode).toBe(0);
	});

	it("passes the built prompt straight through to session.prompt", async () => {
		mockSuccessfulSession(0);
		await dispatch("PROMPT-BODY\n<!-- AGENT PARAMS -->\ndomain: stack\n", makeParams());
		const sent = mockSession.prompt.mock.calls.map((c) => String((c as unknown[])[0]));
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("PROMPT-BODY");
		expect(sent[0]).toContain("domain: stack");
	});

	it("sets a stable cacheSessionId so each subagent's prefix caches across turns", async () => {
		mockSuccessfulSession(0);
		await dispatch("do the thing", makeParams());
		expect(mockSession.agent.sessionId).toBe("forge:forge-init");
	});

	it("wraps the dispatch in AskBroker.withUI exactly once", async () => {
		mockSuccessfulSession(0);
		const withUISpy = vi.spyOn(AskBroker, "withUI");
		await dispatch("do the thing", makeParams());
		expect(withUISpy).toHaveBeenCalledTimes(1);
	});

	it("resolves the model via the role key, not a display label (config role)", async () => {
		mockSuccessfulSession(0);
		const ctx = makeCtx();
		const findSpy = ctx.modelRegistry.find;
		const p = makeParams(ctx);
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
		await dispatchSingleAgent("config-writer", "plan" as PhaseRole, "config", "prompt", undefined, "engineer", p);
		expect(findSpy).toHaveBeenCalledTimes(1);
		expect(findSpy).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
	});
});

// ── resolveInitModel ───────────────────────────────────────────────────────────

describe("resolveInitModel", () => {
	it("reports the sonnet tier for a generation role", () => {
		const res = resolveInitModel("discovery", "engineer", {
			"persona-models": {},
			pipelines: {},
			_global: null,
			_project: null,
		});
		expect(res.tier).toBe("sonnet");
	});

	it("reports undefined tier for the deleted 'gate' role", () => {
		const res = resolveInitModel("gate", "engineer", {
			"persona-models": {},
			pipelines: {},
			_global: null,
			_project: null,
		});
		expect(res.tier).toBeUndefined();
	});
});

// ── readInitPhasePrompt ────────────────────────────────────────────────────────

describe("readInitPhasePrompt", () => {
	it("reads the Phase 1 collect prompt from the bundle", () => {
		const prompt = readInitPhasePrompt(path.join(tmpRoot, "bundle"), 1);
		expect(prompt).toContain("Phase 1: Collect");
	});

	it("reads the Phase 2 discover prompt from the bundle", () => {
		const prompt = readInitPhasePrompt(path.join(tmpRoot, "bundle"), 2);
		expect(prompt).toContain("Phase 2: Discover");
	});

	it("throws when the phase prompt file is missing", () => {
		fs.rmSync(path.join(tmpRoot, "bundle", "init", "phases", "phase-2-discover.md"));
		expect(() => readInitPhasePrompt(path.join(tmpRoot, "bundle"), 2)).toThrow(/not found/);
	});
});

// ── readInitSharedProcedure (Slice 2) ──────────────────────────────────────────

describe("readInitSharedProcedure", () => {
	it("reads the shared generate-kb-doc.md procedure from the bundle", () => {
		const proc = readInitSharedProcedure(path.join(tmpRoot, "bundle"));
		expect(proc).toContain("Shared procedure");
		expect(proc).toContain("EXACTLY ONE file");
	});

	it("throws when the shared procedure file is missing", () => {
		fs.rmSync(path.join(tmpRoot, "bundle", "init", "generation", "generate-kb-doc.md"));
		expect(() => readInitSharedProcedure(path.join(tmpRoot, "bundle"))).toThrow(/generate-kb-doc/);
	});
});

// ── readInitPhase2Fragment (Slice 2) ───────────────────────────────────────────

describe("readInitPhase2Fragment", () => {
	it("reads a per-step substance fragment standalone with its own marker", () => {
		for (const name of ["stack", "routing", "index", "context"]) {
			const frag = readInitPhase2Fragment(path.join(tmpRoot, "bundle"), name);
			expect(frag).toContain(`<!-- kb-doc-fragment: ${name} -->`);
		}
	});

	it("a fragment does not contain a sibling's substance", () => {
		const stack = readInitPhase2Fragment(path.join(tmpRoot, "bundle"), "stack");
		expect(stack).not.toContain("kb-doc-fragment: routing");
	});

	it("throws a descriptive error when the fragment is missing", () => {
		expect(() => readInitPhase2Fragment(path.join(tmpRoot, "bundle"), "does-not-exist")).toThrow(
			/does-not-exist/,
		);
	});
});
