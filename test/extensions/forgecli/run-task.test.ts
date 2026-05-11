// Unit tests for the /forge:run-task native Orchestrator handler (FORGE-S21-T02).
//
// 12 vitest tests covering:
//   1. Happy path — full chain completes
//   2. Non-review phases advance without verdict read
//   3. Preflight-gate exit 1 halts chain; resume retries same phase (gate-halt semantics)
//   4. Preflight-gate exit 2 escalates (no state written)
//   5. Resume from persisted state ≤7d — successful completion path
//   6. Stale state >7d offers purge (fresh start)
//   7. Audience refusal mid-chain (orchestrator-only sub-workflow refuses in subagent context)
//   8. Materialization-marker missing aborts
//   9. deliverAs:"steer" enforced — sendKickoff wrapper used
//  10. FORGE_YES=1 auto-resumes from gate-halt state
//  11. Verdict "revision" loops to predecessor, capped at 3
//  12. Verdict "missing" escalates immediately
//
// Conventions: tmp-dir fixtures per test via fs.mkdtempSync + afterEach cleanup;
// spawnSync mocked via vi.mock; absolute paths only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	CallerContextStore,
} from "../../../src/extensions/forgecli/audience-gate.js";

import {
	DEFAULT_PHASES,
	checkMaterializationForSubWorkflow,
	findRevisionTarget,
	isStateStale,
	readRunTaskState,
	registerRunTask,
	writeRunTaskState,
	type Phase,
	type RunTaskState,
} from "../../../src/extensions/forgecli/run-task.js";

// ── spawnSync mock ────────────────────────────────────────────────────────
// We intercept spawnSync to control: preflight-gate exit codes and store-cli verdict output.

type SpawnSyncFn = (cmd: string, args: string[], opts?: object) => { status: number | null; stdout: string; stderr: string };

let spawnSyncMock: ReturnType<typeof vi.fn<SpawnSyncFn>>;

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: vi.fn<SpawnSyncFn>(() => ({ status: 0, stdout: "", stderr: "" })),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-run-task-"));
	// Re-import the mock so we get a fresh reference each test.
	const childProcess = await import("node:child_process");
	spawnSyncMock = childProcess.spawnSync as ReturnType<typeof vi.fn<SpawnSyncFn>>;
	spawnSyncMock.mockReset();
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
	CallerContextStore.set("orchestrator");
	delete process.env.FORGE_YES;
	delete process.env.FORGE_NON_INTERACTIVE;
});

// ── Sub-workflow fixture builder ──────────────────────────────────────────

const GOOD_WORKFLOW = [
	"---",
	"requirements:",
	"  reasoning: Medium",
	"deps:",
	"  personas: [engineer]",
	"---",
	"",
	"# Plan Task",
	"",
	"## Iron Laws",
	"",
	"- IL1: dispatch via forge_store only.",
	"",
	"## Store-Write Verification",
	"",
	"After every store write, re-read via forge_store_query to verify.",
	"",
	"## Persona reference",
	"",
	"You are the engineer. See .forge/personas/engineer.md for full identity.",
	"",
	"## Algorithm",
	"",
	"1. Load context via forge_store_query.",
	"2. Write PLAN.md.",
].join("\n");

const ORCHESTRATE_WORKFLOW = [
	"---",
	"audience: orchestrator-only",
	"deps:",
	"  personas: [orchestrator]",
	"---",
	"",
	"# Orchestrate Task",
	"",
	"## Iron Laws",
	"",
	"This is the orchestrator workflow for dispatching sub-workflows.",
	"",
	"## Store-Write Verification",
	"",
	"Re-read after every forge_store write.",
	"",
	"## Persona reference",
	"",
	"See .forge/personas/orchestrator.md",
	"",
	"1. Load context via forge_store_query.",
].join("\n");

interface ScaffoldOpts {
	subWorkflowMd?: string;
	orchestrateMd?: string;
	forgeRootSubdir?: string;
}

function scaffoldProject(opts: ScaffoldOpts = {}): { projectDir: string; forgeRoot: string } {
	const projectDir = path.join(tmpRoot, "proj");
	const forgeRootSubdir = opts.forgeRootSubdir ?? "forge/forge";
	const forgeRoot = path.join(projectDir, forgeRootSubdir);

	// Create directory structure
	fs.mkdirSync(path.join(projectDir, ".forge", "workflows"), { recursive: true });
	fs.mkdirSync(path.join(projectDir, ".forge", "cache"), { recursive: true });
	fs.mkdirSync(path.join(forgeRoot, "tools"), { recursive: true });

	// Write config.json pointing at our fake forgeRoot
	fs.writeFileSync(
		path.join(projectDir, ".forge", "config.json"),
		JSON.stringify({ paths: { forgeRoot: `./${forgeRootSubdir}` } }),
		"utf8",
	);

	// Write orchestrate_task.md
	fs.writeFileSync(
		path.join(projectDir, ".forge", "workflows", "orchestrate_task.md"),
		opts.orchestrateMd ?? ORCHESTRATE_WORKFLOW,
		"utf8",
	);

	// Write sub-workflow files for all default phases
	const subMd = opts.subWorkflowMd ?? GOOD_WORKFLOW;
	for (const phase of DEFAULT_PHASES) {
		fs.writeFileSync(
			path.join(projectDir, ".forge", "workflows", phase.workflow),
			subMd,
			"utf8",
		);
	}

	// Write a stub preflight-gate.cjs that exits 0 by default
	fs.writeFileSync(
		path.join(forgeRoot, "tools", "preflight-gate.cjs"),
		'#!/usr/bin/env node\nprocess.exit(0);',
		"utf8",
	);

	// Write a stub store-cli.cjs that outputs empty task record
	const storeCliStub = [
		'#!/usr/bin/env node',
		'console.log(JSON.stringify({ id: "FORGE-TEST", summaries: {} }));',
		'process.exit(0);',
	].join("\n");
	fs.writeFileSync(path.join(forgeRoot, "tools", "store-cli.cjs"), storeCliStub, "utf8");

	return { projectDir, forgeRoot };
}

// ── Stub `pi` + `ctx` ────────────────────────────────────────────────────

interface StubPi {
	sendUserMessage: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
}

interface StubCtx {
	ui: {
		notify: ReturnType<typeof vi.fn>;
		confirm: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
	};
	waitForIdle: ReturnType<typeof vi.fn>;
}

function makeStubPi(): StubPi {
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const pi: StubPi = {
		sendUserMessage: vi.fn(),
		registerCommand: vi.fn((name: string, def: { handler: (a: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def.handler);
		}),
		commands,
	};
	return pi;
}

function makeStubCtx(opts: { confirmReturn?: boolean } = {}): StubCtx {
	return {
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(() => Promise.resolve(opts.confirmReturn ?? false)),
			setStatus: vi.fn(),
		},
		waitForIdle: vi.fn(() => Promise.resolve()),
	};
}

async function invokeHandler(pi: StubPi, ctx: StubCtx, taskId: string): Promise<void> {
	const handler = pi.commands.get("forge:run-task");
	if (!handler) throw new Error("forge:run-task not registered");
	await handler(taskId, ctx);
}

// ── Helper: configure spawnSync mock ─────────────────────────────────────

function mockGateExit(exitCode: number, stderr = ""): void {
	spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
		// Match preflight-gate calls only
		const joinedArgs = args.join(" ");
		if (joinedArgs.includes("preflight-gate")) {
			return { status: exitCode, stdout: "", stderr };
		}
		// store-cli: return empty summaries
		return {
			status: 0,
			stdout: JSON.stringify({ id: "FORGE-TEST", summaries: {} }),
			stderr: "",
		};
	});
}

function mockGateExitAndVerdict(verdict: "approved" | "revision" | "missing"): void {
	spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
		const joinedArgs = args.join(" ");
		if (joinedArgs.includes("preflight-gate")) {
			return { status: 0, stdout: "", stderr: "" };
		}
		// store-cli: return summaries with the given verdict for any role
		if (verdict === "missing") {
			return { status: 0, stdout: JSON.stringify({ id: "FORGE-TEST", summaries: {} }), stderr: "" };
		}
		// Return verdict for all phases
		const summaries: Record<string, { verdict: string }> = {};
		for (const phase of DEFAULT_PHASES) {
			summaries[phase.role] = { verdict };
		}
		return { status: 0, stdout: JSON.stringify({ id: "FORGE-TEST", summaries }), stderr: "" };
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────

// ── Test 1: Happy path — full chain completes ─────────────────────────────

describe("Test 1: happy path — full chain completes", () => {
	it("notifies pipeline complete; dispatches once per non-review phase + sets/clears status", async () => {
		const { projectDir } = scaffoldProject();

		mockGateExitAndVerdict("approved");

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// Pipeline complete notification
		expect(
			ctx.ui.notify.mock.calls.some(
				(c: unknown[]) =>
					typeof c[0] === "string" &&
					c[0].includes("pipeline complete") &&
					c[1] === "info",
			),
		).toBe(true);

		// sendUserMessage called once per phase (8 total)
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(DEFAULT_PHASES.length);

		// All calls use deliverAs: "steer"
		for (const call of pi.sendUserMessage.mock.calls) {
			expect(call[1]).toEqual({ deliverAs: "steer" });
		}

		// setStatus was called with "forge:run-task" (set) and then undefined (clear)
		const setStatusCalls = ctx.ui.setStatus.mock.calls as [string, string | undefined][];
		expect(setStatusCalls.some(([name, val]) => name === "forge:run-task" && val === undefined)).toBe(true);
	});
});

// ── Test 2: Non-review phases advance without verdict read ────────────────

describe("Test 2: non-review phases do not call store-cli for verdict", () => {
	it("plan, implement, writeback, commit do not trigger verdict reads", async () => {
		const { projectDir } = scaffoldProject();

		// Track spawnSync calls
		const calls: string[][] = [];
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			calls.push([cmd, ...args]);
			if (args.join(" ").includes("preflight-gate")) {
				return { status: 0, stdout: "", stderr: "" };
			}
			// store-cli for review phases: approved verdict
			const summaries: Record<string, { verdict: string }> = {};
			for (const phase of DEFAULT_PHASES) {
				summaries[phase.role] = { verdict: "approved" };
			}
			return { status: 0, stdout: JSON.stringify({ id: "FORGE-TEST", summaries }), stderr: "" };
		});

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// Count store-cli calls — only review phases should trigger them
		const reviewPhaseRoles = DEFAULT_PHASES.filter(
			(p) => p.role === "review-plan" || p.role === "review-code" || p.role === "validate" || p.role === "approve",
		);
		const storeCalls = calls.filter((c) => c.some((a) => a.includes("store-cli")));
		// Each review phase triggers one store-cli call
		expect(storeCalls.length).toBe(reviewPhaseRoles.length);
	});
});

// ── Test 3: Preflight-gate exit 1 halts chain; resume retries same phase ──

describe("Test 3: preflight-gate exit 1 halts; resume retries same phase", () => {
	it("stops at phase N, writes state with gateHalted=true; second invocation retries phase N", async () => {
		const { projectDir } = scaffoldProject();

		// Gate fails at phase index 1 (review-plan) on first invocation
		let firstCall = true;
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (args.join(" ").includes("preflight-gate")) {
				// First invocation: fail at any phase call number >= 2
				if (firstCall) {
					// Let phase 0 (plan) pass, fail phase 1 (review-plan)
					const phaseArg = args[args.indexOf("--phase") + 1];
					if (phaseArg === "review-plan") {
						return { status: 1, stdout: "", stderr: "task not in correct state" };
					}
				}
				return { status: 0, stdout: "", stderr: "" };
			}
			const summaries: Record<string, { verdict: string }> = {};
			for (const p of DEFAULT_PHASES) { summaries[p.role] = { verdict: "approved" }; }
			return { status: 0, stdout: JSON.stringify({ id: "FORGE-TEST", summaries }), stderr: "" };
		});

		const pi = makeStubPi();
		// confirm: false (don't resume interactively in first run)
		const ctx = makeStubCtx({ confirmReturn: false });
		registerRunTask(pi as never, { cwd: projectDir });

		// First invocation
		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// Chain stopped — only 1 sendUserMessage call (for phase 0 = plan)
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

		// Error notification emitted
		expect(
			ctx.ui.notify.mock.calls.some((c: unknown[]) => c[1] === "error" && String(c[0]).includes("preflight gate failed")),
		).toBe(true);

		// State file written with gateHalted=true at index 1
		const savedState = readRunTaskState("FORGE-S21-T02", projectDir);
		expect(savedState).not.toBeNull();
		expect(savedState!.gateHalted).toBe(true);
		expect(savedState!.currentPhaseIndex).toBe(1); // review-plan = index 1

		// Now: second invocation — gate passes for review-plan this time
		firstCall = false;
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (args.join(" ").includes("preflight-gate")) {
				return { status: 0, stdout: "", stderr: "" };
			}
			const summaries: Record<string, { verdict: string }> = {};
			for (const p of DEFAULT_PHASES) { summaries[p.role] = { verdict: "approved" }; }
			return { status: 0, stdout: JSON.stringify({ id: "FORGE-TEST", summaries }), stderr: "" };
		});

		const pi2 = makeStubPi();
		const ctx2 = makeStubCtx({ confirmReturn: true }); // confirm=true → resume
		registerRunTask(pi2 as never, { cwd: projectDir });

		await invokeHandler(pi2, ctx2, "FORGE-S21-T02");

		// Should have dispatched phases starting from index 1 (retry same phase), not 2
		// That means 7 calls (phases 1..7)
		const calls2 = pi2.sendUserMessage.mock.calls.length;
		expect(calls2).toBe(DEFAULT_PHASES.length - 1); // phases 1 through 7 = 7 calls
	});
});

// ── Test 4: Preflight-gate exit 2 escalates (no state file) ──────────────

describe("Test 4: preflight-gate exit 2 escalates without state persistence", () => {
	it("emits error notify for exit-2; does NOT write state file", async () => {
		const { projectDir } = scaffoldProject();

		mockGateExit(2, "configuration error");

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T04");

		expect(
			ctx.ui.notify.mock.calls.some(
				(c: unknown[]) =>
					c[1] === "error" &&
					String(c[0]).includes("misconfigured") &&
					String(c[0]).includes("exit 2"),
			),
		).toBe(true);

		// No sendUserMessage — chain did not dispatch
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		// No state file for exit-2 (escalation, not resumable)
		const state = readRunTaskState("FORGE-S21-T04", projectDir);
		expect(state).toBeNull();
	});
});

// ── Test 5: Resume from persisted state ≤7d — successful completion path ──

describe("Test 5: resume from persisted state ≤7d — successful completion", () => {
	it("skips phases 0..currentPhaseIndex, starts at currentPhaseIndex+1 when gateHalted=false", async () => {
		const { projectDir } = scaffoldProject();

		// Write a state showing phase 2 (implement) completed successfully
		const existingState: RunTaskState = {
			taskId: "FORGE-S21-T02",
			currentPhaseIndex: 2, // implement = index 2
			iterationCounts: {},
			lastGateFailureStderr: "",
			gateHalted: false,
			timestamp: new Date().toISOString(),
		};
		writeRunTaskState(existingState, projectDir);

		mockGateExitAndVerdict("approved");

		const pi = makeStubPi();
		const ctx = makeStubCtx({ confirmReturn: true }); // confirm=true → resume
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// Should dispatch phases 3..7 (5 phases: review-code, validate, approve, writeback, commit)
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(DEFAULT_PHASES.length - 3); // phases 3..7 = 5
	});
});

// ── Test 6: Stale state >7d offers purge ────────────────────────────────

describe("Test 6: stale state >7d offers purge and triggers fresh start", () => {
	it("emits age warning, offers purge, starts from phase 0 regardless", async () => {
		const { projectDir } = scaffoldProject();

		// Write a stale state (>7 days old)
		const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		const staleState: RunTaskState = {
			taskId: "FORGE-S21-T02",
			currentPhaseIndex: 5,
			iterationCounts: {},
			lastGateFailureStderr: "",
			gateHalted: false,
			timestamp: oldDate,
		};
		writeRunTaskState(staleState, projectDir);

		mockGateExitAndVerdict("approved");

		const pi = makeStubPi();
		const ctx = makeStubCtx({ confirmReturn: false });
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// Age warning emitted
		expect(
			ctx.ui.notify.mock.calls.some(
				(c: unknown[]) =>
					(c[1] === "warning" || c[1] === "info") &&
					String(c[0]).includes(">7 days"),
			),
		).toBe(true);

		// Full chain dispatched (fresh start from 0 = 8 phases)
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(DEFAULT_PHASES.length);
	});
});

// ── Test 7: Audience refusal mid-chain ───────────────────────────────────

describe("Test 7: audience refusal — orchestrator-only sub-workflow refuses in subagent context", () => {
	it("CallerContextStore.asSubagent causes assertAudience to refuse; no sendKickoff call", async () => {
		const { projectDir } = scaffoldProject({
			subWorkflowMd: [
				"---",
				"audience: orchestrator-only",
				"deps:",
				"  personas: [engineer]",
				"---",
				"",
				"# Plan Task",
				"",
				"## Iron Laws",
				"",
				"See .forge/personas/engineer.md",
				"",
				"## Store-Write Verification",
				"",
				"Re-read after every forge_store write.",
				"",
				"1. Load context via forge_store_query.",
			].join("\n"),
		});

		mockGateExit(0);

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// No sendKickoff should have been called (audience refusal on phase 0)
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		// Error notification emitted (either from assertAudience or our handler)
		const hasError = ctx.ui.notify.mock.calls.some((c: unknown[]) => c[1] === "error");
		expect(hasError).toBe(true);

		// State file persisted with gateHalted=true
		const state = readRunTaskState("FORGE-S21-T02", projectDir);
		expect(state).not.toBeNull();
		expect(state!.gateHalted).toBe(true);
	});
});

// ── Test 8: Materialization-marker missing aborts ────────────────────────

describe("Test 8: materialization-marker missing aborts dispatch", () => {
	it("sub-workflow missing Store-Write Verification → notify error + no sendKickoff", async () => {
		const { projectDir } = scaffoldProject({
			subWorkflowMd: GOOD_WORKFLOW.replace(/Store-Write Verification/g, "Store-Write XXX"),
		});

		mockGateExit(0);

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		const hasMarkerError = ctx.ui.notify.mock.calls.some(
			(c: unknown[]) =>
				c[1] === "error" &&
				String(c[0]).includes("Store-Write Verification"),
		);
		expect(hasMarkerError).toBe(true);
	});
});

// ── Test 9: deliverAs:"steer" enforced ───────────────────────────────────

describe("Test 9: deliverAs:steer enforced — sendKickoff wrapper used", () => {
	it("pi.sendUserMessage ALWAYS called with { deliverAs: 'steer' }", async () => {
		const { projectDir } = scaffoldProject();

		mockGateExitAndVerdict("approved");

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		expect(pi.sendUserMessage.mock.calls.length).toBeGreaterThan(0);
		for (const call of pi.sendUserMessage.mock.calls) {
			expect(call[1]).toEqual({ deliverAs: "steer" });
		}
	});
});

// ── Test 10: FORGE_YES=1 auto-resumes from gate-halt state ───────────────

describe("Test 10: FORGE_YES=1 auto-resumes from gate-halt state", () => {
	it("no ctx.ui.confirm call; retries from gateHalted phase index", async () => {
		const { projectDir } = scaffoldProject();
		process.env.FORGE_YES = "1";

		// Write gate-halt state at phase 3 (validate)
		const haltedState: RunTaskState = {
			taskId: "FORGE-S21-T02",
			currentPhaseIndex: 3,
			iterationCounts: {},
			lastGateFailureStderr: "previous failure",
			gateHalted: true,
			timestamp: new Date().toISOString(),
		};
		writeRunTaskState(haltedState, projectDir);

		mockGateExitAndVerdict("approved");

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// confirm should NOT be called (non-interactive auto-resume)
		expect(ctx.ui.confirm).not.toHaveBeenCalled();

		// Should dispatch from phase 3 (gateHalted=true → retry same phase = 3)
		// Phases 3..7 = 5 phases
		expect(pi.sendUserMessage).toHaveBeenCalledTimes(DEFAULT_PHASES.length - 3);
	});
});

// ── Test 11: Verdict "revision" loops to predecessor, capped at 3 ────────

describe("Test 11: verdict 'revision' loops to predecessor, capped at 3", () => {
	it("revision from review-plan loops to plan; at 3 iterations escalates", async () => {
		const { projectDir } = scaffoldProject();

		let reviewPlanCallCount = 0;
		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			const joinedArgs = args.join(" ");
			if (joinedArgs.includes("preflight-gate")) {
				return { status: 0, stdout: "", stderr: "" };
			}
			// store-cli: return "revision" for review-plan, "approved" for others
			if (joinedArgs.includes("store-cli") && joinedArgs.includes("--json")) {
				reviewPlanCallCount++;
				const summaries: Record<string, { verdict: string }> = {
					"review-plan": { verdict: "revision" },
				};
				for (const p of DEFAULT_PHASES) {
					if (p.role !== "review-plan") summaries[p.role] = { verdict: "approved" };
				}
				return { status: 0, stdout: JSON.stringify({ id: "FORGE-TEST", summaries }), stderr: "" };
			}
			return { status: 0, stdout: "", stderr: "" };
		});

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// Should escalate with max iterations error
		expect(
			ctx.ui.notify.mock.calls.some(
				(c: unknown[]) =>
					c[1] === "error" &&
					String(c[0]).includes("max iterations") &&
					String(c[0]).includes("review-plan"),
			),
		).toBe(true);

		// State written with gateHalted=true
		const state = readRunTaskState("FORGE-S21-T02", projectDir);
		expect(state).not.toBeNull();
		expect(state!.gateHalted).toBe(true);

		// The revision loop should have run exactly maxIterations (3) times
		// before escalating. Each iteration calls plan (dispatch) then review-plan (dispatch)
		// Total review-plan store-cli verdict reads = 3 (capped)
		expect(reviewPlanCallCount).toBe(3);
	});
});

// ── Test 12: Verdict "missing" escalates immediately ─────────────────────

describe("Test 12: verdict 'missing' escalates immediately", () => {
	it("review-plan returns state with no summaries.review-plan → escalate", async () => {
		const { projectDir } = scaffoldProject();

		spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
			if (args.join(" ").includes("preflight-gate")) {
				return { status: 0, stdout: "", stderr: "" };
			}
			// store-cli: return no summaries at all
			return { status: 0, stdout: JSON.stringify({ id: "FORGE-TEST", summaries: {} }), stderr: "" };
		});

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });

		await invokeHandler(pi, ctx, "FORGE-S21-T02");

		// Verdict missing escalation notification
		expect(
			ctx.ui.notify.mock.calls.some(
				(c: unknown[]) =>
					c[1] === "error" &&
					String(c[0]).includes("verdict missing"),
			),
		).toBe(true);

		// State persisted with gateHalted=true
		const state = readRunTaskState("FORGE-S21-T02", projectDir);
		expect(state).not.toBeNull();
		expect(state!.gateHalted).toBe(true);
	});
});

// ── Pure function tests ───────────────────────────────────────────────────

describe("findRevisionTarget", () => {
	it("returns nearest non-review predecessor", () => {
		// review-plan (index 1) → plan (index 0)
		expect(findRevisionTarget(DEFAULT_PHASES, 1)).toBe(0);
	});

	it("review-code (index 3) → implement (index 2)", () => {
		expect(findRevisionTarget(DEFAULT_PHASES, 3)).toBe(2);
	});

	it("validate (index 4) → implement (index 2, skipping review-code)", () => {
		// validate = index 4; review-code = index 3 (review phase); implement = index 2
		expect(findRevisionTarget(DEFAULT_PHASES, 4)).toBe(2);
	});

	it("approve (index 5) → implement (index 2, skipping validate+review-code)", () => {
		expect(findRevisionTarget(DEFAULT_PHASES, 5)).toBe(2);
	});

	it("returns 0 when no non-review predecessor found", () => {
		const phases: Phase[] = [
			{ role: "review-plan", workflow: "review_plan.md" },
			{ role: "review-code", workflow: "review_code.md" },
		];
		expect(findRevisionTarget(phases, 1)).toBe(0);
	});
});

describe("isStateStale", () => {
	it("returns true for state >7 days old", () => {
		const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		expect(isStateStale({ taskId: "X", currentPhaseIndex: 0, iterationCounts: {}, lastGateFailureStderr: "", timestamp: oldDate })).toBe(true);
	});

	it("returns false for state ≤7 days old", () => {
		const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
		expect(isStateStale({ taskId: "X", currentPhaseIndex: 0, iterationCounts: {}, lastGateFailureStderr: "", timestamp: recentDate })).toBe(false);
	});

	it("returns true for unparseable timestamp", () => {
		expect(isStateStale({ taskId: "X", currentPhaseIndex: 0, iterationCounts: {}, lastGateFailureStderr: "", timestamp: "NOT A DATE" })).toBe(true);
	});
});

describe("checkMaterializationForSubWorkflow", () => {
	it("wraps checkMaterialization from plan.ts — all markers present returns ok=true", () => {
		const result = checkMaterializationForSubWorkflow("/tmp/plan_task.md", GOOD_WORKFLOW);
		expect(result.ok).toBe(true);
		expect(result.missing).toHaveLength(0);
	});

	it("missing markers propagated correctly", () => {
		const md = GOOD_WORKFLOW.replace(/Store-Write Verification/g, "XXX");
		const result = checkMaterializationForSubWorkflow("/tmp/plan_task.md", md);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("Store-Write Verification");
	});
});

// ── Regression: flat-layout tool resolution (forge-cli payload) ───────────
// forge-cli packages tools at <forgeRoot>/<tool>.cjs (no `tools/` subdir).
// Handler must NOT double-append `tools/`. Mirrors forge_tools.resolveToolDir.
describe("flat-layout tool resolution (FORGE-BUG: doubled tools/)", () => {
	it("preflight-gate + store-cli resolved at forgeRoot root, not forgeRoot/tools", async () => {
		const projectDir = path.join(tmpRoot, "flat-proj");
		const forgeRoot = path.join(projectDir, "flat-root");
		fs.mkdirSync(path.join(projectDir, ".forge", "workflows"), { recursive: true });
		fs.mkdirSync(path.join(projectDir, ".forge", "cache"), { recursive: true });
		fs.mkdirSync(forgeRoot, { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, ".forge", "config.json"),
			JSON.stringify({ paths: { forgeRoot: "./flat-root" } }),
			"utf8",
		);
		fs.writeFileSync(
			path.join(projectDir, ".forge", "workflows", "orchestrate_task.md"),
			ORCHESTRATE_WORKFLOW,
			"utf8",
		);
		for (const phase of DEFAULT_PHASES) {
			fs.writeFileSync(
				path.join(projectDir, ".forge", "workflows", phase.workflow),
				GOOD_WORKFLOW,
				"utf8",
			);
		}
		// Tools at root, NOT under tools/
		fs.writeFileSync(
			path.join(forgeRoot, "preflight-gate.cjs"),
			"#!/usr/bin/env node\nprocess.exit(0);",
			"utf8",
		);
		fs.writeFileSync(
			path.join(forgeRoot, "store-cli.cjs"),
			'#!/usr/bin/env node\nconsole.log(JSON.stringify({ id: "FORGE-TEST", summaries: {} }));process.exit(0);',
			"utf8",
		);

		mockGateExitAndVerdict("approved");

		const pi = makeStubPi();
		const ctx = makeStubCtx();
		registerRunTask(pi as never, { cwd: projectDir });
		await invokeHandler(pi, ctx, "FORGE-S21-T99");

		const preflightCall = spawnSyncMock.mock.calls.find((c: unknown[]) => {
			const args = c[1] as string[] | undefined;
			return Array.isArray(args) && args.some((a) => a.includes("preflight-gate.cjs"));
		});
		expect(preflightCall).toBeDefined();
		const preflightPath = (preflightCall![1] as string[])[0];
		expect(preflightPath).toBe(path.join(forgeRoot, "preflight-gate.cjs"));
		expect(preflightPath).not.toContain(path.join("flat-root", "tools"));

		const storeCliCall = spawnSyncMock.mock.calls.find((c: unknown[]) => {
			const args = c[1] as string[] | undefined;
			return Array.isArray(args) && args.some((a) => a.includes("store-cli.cjs"));
		});
		expect(storeCliCall).toBeDefined();
		const storeCliPath = (storeCliCall![1] as string[])[0];
		expect(storeCliPath).toBe(path.join(forgeRoot, "store-cli.cjs"));
	});
});
