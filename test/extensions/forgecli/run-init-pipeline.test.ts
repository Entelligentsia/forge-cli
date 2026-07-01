// run-init-pipeline.test.ts — unit tests for the /forge:init step-machine
// orchestrator pipeline (FORGE-S33-T03, rewritten for the wave/step model by
// FORGE-S35-T02 Slice 1).
//
// Mock strategy: mock createAgentSession at module load via vi.hoisted + vi.mock.
// CRITICAL: waves now dispatch their steps CONCURRENTLY (runWave → Promise.all),
// so the session mock returns a FRESH session per createAgentSession call, each
// with its own subscriber. A per-test "exit decider" inspects the dispatched
// task prompt (which carries the `<!-- AGENT PARAMS -->` role/domain/docId) to
// decide each agent's exit code — order-independent, concurrency-safe.
//
// Wave layout (topoSortWaves on INIT_STEPS):
//   0 discovery×5 · 1 config-writer · 2 enforce-config     → phase 1 (collect)
//   3 kb-doc×10 · 4 index · 5 context · 6 verify-discover  → phase 2 (discover)
//   7 materialize                                          → phase 3
//   8 register                                             → phase 4
// Collect dispatches 6 subagents; discover dispatches 12 (gate deleted).
//
// IL10: orchestrator emits phase events; subagents never emit.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoist concurrency-safe session mock ───────────────────────────────────────

const { makeSession, setExitDecider, createAgentSessionMock } = vi.hoisted(() => {
	// Per-test decision: given the dispatched task text, return 0 (success) or 1.
	let decide: (task: string) => 0 | 1 = () => 0;
	function setExitDecider(fn: (task: string) => 0 | 1): void {
		decide = fn;
	}

	function makeSession() {
		let subscriber: ((e: { type: string; message?: unknown }) => void) | null = null;
		return {
			subscribe: vi.fn((listener: (e: { type: string; message?: unknown }) => void) => {
				subscriber = listener;
				return () => {
					subscriber = null;
				};
			}),
			prompt: vi.fn(async (task: string) => {
				const exitCode = decide(String(task));
				const stopReason = exitCode !== 0 ? "error" : "stop";
				subscriber?.({
					type: "turn_end",
					message: {
						role: "assistant",
						model: "claude-sonnet-4-5",
						provider: "anthropic",
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
			}),
			abort: vi.fn(),
			dispose: vi.fn(),
			agent: { sessionId: undefined as string | undefined },
		};
	}

	const createAgentSessionMock = vi.fn(async () => ({ session: makeSession() }));
	return { makeSession, setExitDecider, createAgentSessionMock };
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
		createAgentSession: createAgentSessionMock,
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

// Mock exec-helpers:runToolAdvisory (used by enforce-config + post-verify hooks).
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

// Mock task-events:emitEvent so the IL10 emission loop can be inspected without
// shelling out to store-cli. Captures every phase event the orchestrator emits.
const mockEmitEvent = vi.fn<
	(storeCli: string, cwd: string, sprintId: string, event: Record<string, unknown>) => {
		ok: boolean;
		stderr: string;
	}
>(() => ({ ok: true, stderr: "" }));

vi.mock(
	"../../../src/extensions/forgecli/orchestrators/task/task-events.js",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			emitEvent: (storeCli: string, cwd: string, sprintId: string, event: Record<string, unknown>) =>
				mockEmitEvent(storeCli, cwd, sprintId, event),
		};
	},
);

import {
	runInitPipeline,
	type RunInitPipelineOptions,
} from "../../../src/extensions/forgecli/orchestrators/init/run-init-pipeline.js";
import { INIT_SESSION_ID } from "../../../src/extensions/forgecli/orchestrators/init/init-phases.js";
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

	const bundlePersonasDir = path.join(tmpRoot, "bundle", ".base-pack", "personas");
	fs.mkdirSync(bundlePersonasDir, { recursive: true });
	fs.writeFileSync(
		path.join(bundlePersonasDir, "engineer.md"),
		["---", "name: engineer", "description: Forge engineer persona for testing", "---", "", "# Engineer", "", "I am the test engineer persona."].join("\n"),
		"utf8",
	);

	fs.writeFileSync(
		path.join(proj, ".forge", "config.json"),
		JSON.stringify({
			project: { name: "test-project", prefix: "TST", stack: "TypeScript/Node" },
			paths: { engineering: "engineering", forgeRoot: path.join(tmpRoot, "bundle") },
			installedSkills: ["typescript"],
		}),
		"utf8",
	);

	const phasesDir = path.join(tmpRoot, "bundle", "init", "phases");
	fs.mkdirSync(phasesDir, { recursive: true });
	fs.writeFileSync(path.join(phasesDir, "phase-1-collect.md"), "# Phase 1: Collect\nDiscover the tech stack.", "utf8");
	fs.writeFileSync(path.join(phasesDir, "phase-2-discover.md"), "# Phase 2: Discover\nWrite KB docs.", "utf8");

	// Slice 2: shared procedure + per-step substance fragments. Phase-2 subagents
	// compose their prompt as shared procedure + their own fragment + AGENT PARAMS;
	// phase-2-discover.md is no longer injected into subagents.
	const generationDir = path.join(tmpRoot, "bundle", "init", "generation");
	fs.mkdirSync(generationDir, { recursive: true });
	fs.writeFileSync(
		path.join(generationDir, "generate-kb-doc.md"),
		"# Knowledge Base Doc Generation\nSHARED-PROCEDURE: write EXACTLY ONE file.",
		"utf8",
	);
	const phase2Dir = path.join(phasesDir, "phase-2");
	fs.mkdirSync(phase2Dir, { recursive: true });
	const FRAGMENT_NAMES = [
		"stack",
		"processes",
		"routing",
		"database",
		"testing",
		"deployment",
		"entity-model",
		"stack-checklist",
		"domain-model",
		"domain-concepts",
		"index",
		"context",
	];
	for (const name of FRAGMENT_NAMES) {
		fs.writeFileSync(
			path.join(phase2Dir, `${name}.md`),
			`<!-- kb-doc-fragment: ${name} -->\n# Substance — ${name}\nSUBSTANCE-${name.toUpperCase()}`,
			"utf8",
		);
	}

	const toolsDir = path.join(tmpRoot, "bundle", "tools");
	fs.mkdirSync(toolsDir, { recursive: true });
	fs.writeFileSync(path.join(toolsDir, "manage-config.cjs"), "// stub", "utf8");

	// Reset mock state.
	createAgentSessionMock.mockClear();
	mockRunPhase3.mockClear();
	mockRunPhase4.mockClear();
	mockWriteInitProgress.mockClear();
	mockVerifyPhase2.mockClear();
	mockEmitEvent.mockClear();
	mockEmitEvent.mockReturnValue({ ok: true, stderr: "" });
	vi.mocked(runToolAdvisory).mockClear();

	mockRunPhase3.mockResolvedValue("ok");
	mockRunPhase4.mockResolvedValue({ kbPathFinal: "engineering" });
	mockVerifyPhase2.mockResolvedValue({ ok: true, missing: [] });
	// Default: every dispatched agent succeeds.
	setExitDecider(() => 0);
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

function makeOpts(overrides?: Partial<RunInitPipelineOptions>): RunInitPipelineOptions {
	const ctx = makeCtx();
	return {
		forgeRoot: path.join(proj, ".forge"),
		kbFolder: "engineering",
		startPhase: 1,
		isoTimestamp: "2026-06-18T00:00:00.000Z",
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

/** Total createAgentSession dispatches so far. */
function dispatchCount(): number {
	return createAgentSessionMock.mock.calls.length;
}

// ── startPhase routing ────────────────────────────────────────────────────────

describe("runInitPipeline — startPhase routing", () => {
	it("startPhase=2 skips the collect waves (only discover's 12 subagents dispatch)", async () => {
		const report = await runInitPipeline(makeOpts({ startPhase: 2 }));

		// Discover dispatches 10 kb-doc + index + context = 12 subagents (no gate).
		expect(dispatchCount()).toBe(12);
		// Fewer than a full run (18); Phase-1 collect agents were skipped.
		expect(dispatchCount()).toBeLessThan(16);
		expect(report.ok).toBe(true);
	});

	it("startPhase=3 skips collect + discover: no subagents dispatched, Phase 3 runs", async () => {
		const report = await runInitPipeline(makeOpts({ startPhase: 3 }));

		expect(createAgentSessionMock).not.toHaveBeenCalled();
		expect(mockRunPhase3).toHaveBeenCalledTimes(1);
		expect(report.ok).toBe(true);
	});
});

// ── Phase-2 prompt composition (Slice 2) ──────────────────────────────────────
// Each kb-doc/index/context subagent must see ONLY its own docId's substance:
// shared procedure + its own fragment + AGENT PARAMS — never a sibling's
// fragment and never the whole phase-2-discover.md rulebook.

describe("runInitPipeline — Phase-2 prompt composition (per-step substance)", () => {
	function capturePrompts(): string[] {
		const prompts: string[] = [];
		setExitDecider((task) => {
			prompts.push(task);
			return 0;
		});
		return prompts;
	}

	it("a kb-doc prompt carries the shared procedure + its own fragment + params", async () => {
		const prompts = capturePrompts();
		await runInitPipeline(makeOpts({ startPhase: 2 }));

		const stackPrompt = prompts.find((p) => p.includes("docId: architecture/stack"));
		expect(stackPrompt).toBeDefined();
		// Shared procedure present.
		expect(stackPrompt).toContain("SHARED-PROCEDURE");
		// Its own substance fragment present.
		expect(stackPrompt).toContain("<!-- kb-doc-fragment: stack -->");
		expect(stackPrompt).toContain("SUBSTANCE-STACK");
		// AGENT PARAMS block present.
		expect(stackPrompt).toContain("role: kb-doc");
	});

	it("a kb-doc prompt contains ONLY its own docId substance — no sibling fragments", async () => {
		const prompts = capturePrompts();
		await runInitPipeline(makeOpts({ startPhase: 2 }));

		const stackPrompt = prompts.find((p) => p.includes("docId: architecture/stack"));
		expect(stackPrompt).toBeDefined();
		// No sibling fragment markers or substance leak into this prompt.
		for (const sibling of ["routing", "database", "domain-model", "testing"]) {
			expect(stackPrompt).not.toContain(`<!-- kb-doc-fragment: ${sibling} -->`);
			expect(stackPrompt).not.toContain(`SUBSTANCE-${sibling.toUpperCase()}`);
		}
	});

	it("no Phase-2 subagent prompt injects the whole phase-2-discover.md rulebook", async () => {
		const prompts = capturePrompts();
		await runInitPipeline(makeOpts({ startPhase: 2 }));

		// phase-2-discover.md stub content ("Write KB docs.") must not appear in any
		// subagent prompt — the fat rulebook is no longer injected.
		for (const p of prompts) {
			expect(p).not.toContain("Write KB docs.");
		}
	});

	it("the index and context steps each get their own fragment", async () => {
		const prompts = capturePrompts();
		await runInitPipeline(makeOpts({ startPhase: 2 }));

		const indexPrompt = prompts.find((p) => p.includes("role: index"));
		const contextPrompt = prompts.find((p) => p.includes("role: context"));
		expect(indexPrompt).toContain("<!-- kb-doc-fragment: index -->");
		expect(contextPrompt).toContain("<!-- kb-doc-fragment: context -->");
		// The index prompt must not carry the context fragment and vice-versa.
		expect(indexPrompt).not.toContain("<!-- kb-doc-fragment: context -->");
		expect(contextPrompt).not.toContain("<!-- kb-doc-fragment: index -->");
	});
});

// ── Full run ──────────────────────────────────────────────────────────────────

describe("runInitPipeline — full run", () => {
	it("startPhase=1 runs all waves (18 subagents + runPhase3 + runPhase4)", async () => {
		const report = await runInitPipeline(makeOpts({ startPhase: 1 }));

		// collect 6 (5 discovery + config-writer) + discover 12 = 18 subagents.
		expect(dispatchCount()).toBe(18);
		expect(mockRunPhase3).toHaveBeenCalledTimes(1);
		expect(mockRunPhase4).toHaveBeenCalledTimes(1);
		expect(report.ok).toBe(true);
	});

	it("does NOT dispatch a 'gate' subagent (gate deleted; readiness is a precondition)", async () => {
		await runInitPipeline(makeOpts({ startPhase: 2 }));
		// Every dispatched prompt carries an AGENT PARAMS role; none is the gate.
		const promptCalls = createAgentSessionMock.mock.results;
		// Assert the deleted gate role never appears by checking the total count is
		// exactly the non-gate discover fan-out (12). A surviving gate would be 13.
		expect(dispatchCount()).toBe(12);
		expect(promptCalls.length).toBe(12);
	});
});

// ── Deterministic KB-folder / prefix decision (enforce-config step) ───────────

describe("runInitPipeline — orchestrator-owned config enforcement", () => {
	it("writes paths.engineering itself after collect (not an LLM-routed decision)", async () => {
		await runInitPipeline(makeOpts({ startPhase: 1, kbFolder: "ai-docs" }));

		const calls = vi.mocked(runToolAdvisory).mock.calls;
		const setPathCall = calls.find(
			(c) => Array.isArray(c[1]) && c[1][0] === "set" && c[1][1] === "paths.engineering",
		);
		expect(setPathCall).toBeDefined();
		expect(setPathCall?.[1]).toEqual(["set", "paths.engineering", "ai-docs"]);
	});

	it("writes project.prefix itself after collect (handler-resolved value wins)", async () => {
		await runInitPipeline(makeOpts({ startPhase: 1, projectPrefix: "ACME" }));

		const setPrefixCall = vi.mocked(runToolAdvisory).mock.calls.find(
			(c) => Array.isArray(c[1]) && c[1][0] === "set" && c[1][1] === "project.prefix",
		);
		expect(setPrefixCall?.[1]).toEqual(["set", "project.prefix", "ACME"]);
	});

	it("derives project.prefix from projectName when caller omits it (never LLM-routed)", async () => {
		const opts = makeOpts({ startPhase: 1 });
		delete (opts as { projectPrefix?: string }).projectPrefix;
		await runInitPipeline(opts);

		const setPrefixCall = vi.mocked(runToolAdvisory).mock.calls.find(
			(c) => Array.isArray(c[1]) && c[1][0] === "set" && c[1][1] === "project.prefix",
		);
		expect(setPrefixCall?.[1]).toEqual(["set", "project.prefix", "TEST"]);
	});
});

// ── Orchestrator TUI wiring ────────────────────────────────────────────────────

describe("runInitPipeline — orchestrator TUI wiring (chip strip + dashboard)", () => {
	it("opens a 'forge-init' orchestrator session + tree node and completes it on success", async () => {
		await runInitPipeline(makeOpts({ startPhase: 1 }));

		const root = getOrchestratorTree().getNode(INIT_SESSION_ID);
		expect(root).toBeDefined();
		expect(root?.kind).toBe("orchestrator");
		expect(root?.status).toBe("completed");
		expect(root && root.children.length).toBeGreaterThan(0);

		const session = getSessionRegistry().listSessions().find((s) => s.taskId === INIT_SESSION_ID);
		expect(session).toBeDefined();
		expect(session?.status).toBe("completed");
		expect(session && session.phases.length).toBeGreaterThan(0);
	});

	it("completes the session as 'failed' when a wave fails (no leaked running session)", async () => {
		// Every agent fails → wave 0 (discovery) fails → pipeline halts.
		setExitDecider(() => 1);

		const report = await runInitPipeline(makeOpts({ startPhase: 1 }));
		expect(report.ok).toBe(false);

		const root = getOrchestratorTree().getNode(INIT_SESSION_ID);
		expect(root?.status).toBe("failed");
		const session = getSessionRegistry().listSessions().find((s) => s.taskId === INIT_SESSION_ID);
		expect(session?.status).toBe("failed");
	});
});

// ── Failure propagation ────────────────────────────────────────────────────────

describe("runInitPipeline — failure propagation", () => {
	it("config-writer failing on both attempts → ok=false (retryPolicy exhausted)", async () => {
		// Domains succeed; config-writer fails on initial + rerun (maxReruns:1).
		setExitDecider((task) => (task.includes("role: config-writer") ? 1 : 0));

		const report = await runInitPipeline(makeOpts({ startPhase: 1 }));

		expect(report.ok).toBe(false);
		expect(typeof report.failure).toBe("string");
		// 5 domains + config-writer dispatched TWICE (retry) = 7, then halt before discover.
		expect(dispatchCount()).toBe(7);
	});

	it("a discovery-wave failure halts after the whole wave (concurrent), before config-writer", async () => {
		// One domain fails; the wave still dispatches all 5 concurrently, then halts.
		setExitDecider((task) => (task.includes("domain: routing") ? 1 : 0));

		const report = await runInitPipeline(makeOpts({ startPhase: 1 }));

		expect(report.ok).toBe(false);
		// All 5 discovery agents dispatched (Promise.all), config-writer NOT reached.
		expect(dispatchCount()).toBe(5);
	});

	it("Phase 3 abort → ok=false, lastPhase=3, no retry (hard-halt)", async () => {
		mockRunPhase3.mockResolvedValue("abort");

		const report = await runInitPipeline(makeOpts({ startPhase: 3 }));

		expect(report.ok).toBe(false);
		expect(report.lastPhase).toBe(3);
		expect(report.failure).toBe("Phase 3 abort (verify failed or tools missing)");
		expect(mockRunPhase3).toHaveBeenCalledTimes(1);
	});

	it("Phase 2 verify failure → ok=false at the verify-discover step", async () => {
		mockVerifyPhase2.mockResolvedValue({ ok: false, missing: ["architecture/stack.md"] });

		const report = await runInitPipeline(makeOpts({ startPhase: 2 }));

		expect(report.ok).toBe(false);
		expect(report.failure).toContain("Phase 2 verify failed");
		expect(report.lastPhase).toBe(2);
	});
});

// ── Checkpoint writes ──────────────────────────────────────────────────────────

describe("runInitPipeline — checkpoint writes", () => {
	it("writeInitProgress called with 1 (enforce-config), 2 (verify), 3 (materialize); never 4", async () => {
		await runInitPipeline(makeOpts({ startPhase: 1 }));

		const phases = mockWriteInitProgress.mock.calls.map(([, p]) => p);
		expect(phases).toContain(1);
		expect(phases).toContain(2);
		expect(phases).toContain(3);
		expect(phases).not.toContain(4);
	});
});

// ── IL10 phase event emission (AC6) ────────────────────────────────────────────

describe("runInitPipeline — IL10 phase event emission", () => {
	it("emits ONE phase event per successful subagent step, each with a DISTINCT eventId", async () => {
		await runInitPipeline(makeOpts({ startPhase: 1, sprintId: "FORGE-S35" }));

		// 18 subagent steps (6 collect + 12 discover) → 18 emit calls.
		expect(mockEmitEvent).toHaveBeenCalledTimes(18);

		// Every emitted eventId must be unique — a collision means store.writeEvent
		// overwrites <eventId>.json and silently drops token-accounting records.
		const eventIds = mockEmitEvent.mock.calls.map(([, , , ev]) => ev.eventId as string);
		expect(eventIds).toHaveLength(18);
		expect(new Set(eventIds).size).toBe(18);
	});

	it("emits distinct eventIds within a single fan-out wave (5 discovery, same phaseGroup)", async () => {
		await runInitPipeline(makeOpts({ startPhase: 1, sprintId: "FORGE-S35" }));

		// The 5 discovery steps share phaseGroup 'collect' and the same wave — the
		// old waveStartMs+phaseGroup eventId collapsed them to a single file.
		const discoveryIds = mockEmitEvent.mock.calls
			.map(([, , , ev]) => ev.eventId as string)
			.filter((id) => id.includes("discovery"));
		expect(discoveryIds.length).toBe(5);
		expect(new Set(discoveryIds).size).toBe(5);
	});

	it("skips emission entirely when sprintId is absent", async () => {
		await runInitPipeline(makeOpts({ startPhase: 1 }));
		expect(mockEmitEvent).not.toHaveBeenCalled();
	});
});

// ── InitReport shape ───────────────────────────────────────────────────────────

describe("runInitPipeline — InitReport shape", () => {
	it("lastPhase is the coarse phase 4 after a full successful run", async () => {
		const report = await runInitPipeline(makeOpts({ startPhase: 1 }));

		expect(report.ok).toBe(true);
		expect(report.lastPhase).toBe(4);
	});
});
