// init-steps.test.ts — unit tests for the /forge:init step machine primitives
// (FORGE-S35-T02, Slice 1, AC7).
//
// These tests exercise the reusable machine (runStep / runWave / topoSortWaves)
// with small synthetic step graphs and a spy subagent dispatcher — no real
// createAgentSession, no forge-init imports. They pin the load-bearing
// contracts:
//   1. precondition-fail halts BEFORE any dispatch (zero dispatches);
//   2. requiredOutput-fail → exactly one rerun then halt (maxReruns:1), or
//      exactly one dispatch then halt (maxReruns:0);
//   3. independent steps in one wave run concurrently (Promise.all overlap);
//   4. a deterministic step spawns no subagent;
//   5. topoSortWaves layers a cross-ref edge into the expected partition.

import { describe, expect, it, vi } from "vitest";

import {
	runStep,
	runWave,
	topoSortWaves,
	type Step,
	type StepRuntimeCtx,
	type SubagentDispatcher,
	type SubagentRun,
} from "../../../src/extensions/forgecli/orchestrators/init/init-steps.js";
import type { SubagentResult } from "../../../src/extensions/forgecli/forge-subagent.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a SubagentResult with the given exit code. */
function makeResult(exitCode: 0 | 1): SubagentResult {
	return {
		exitCode,
		model: "claude-sonnet-4-5",
		provider: "anthropic",
		messages: [],
		usage: {
			turns: 1,
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 15,
		},
	} as unknown as SubagentResult;
}

/** A minimal subagent Step. */
function subagentStep(id: string, overrides?: Partial<Step>): Step {
	const run: SubagentRun = {
		kind: "subagent",
		promptPhase: 1,
		subLabel: id,
		subRole: "plan",
		modelRole: "discovery",
		persona: "engineer",
		phaseGroup: "collect",
		buildPrompt: (base) => base,
	};
	return {
		id,
		dependsOn: [],
		run,
		retryPolicy: { maxReruns: 0 },
		...overrides,
	};
}

// ── Test 1: precondition-fail halts before any dispatch ───────────────────────

describe("runStep — precondition gate", () => {
	it("test 1: a failing precondition halts before any dispatch (zero dispatches)", async () => {
		const dispatch = vi.fn<SubagentDispatcher>(async () => makeResult(0));
		const step = subagentStep("gated", {
			precondition: async () => ({ ok: false, reason: "not ready" }),
		});

		const outcome = await runStep(step, { ctx: {}, dispatchSubagent: dispatch });

		expect(outcome.ok).toBe(false);
		expect(outcome.dispatched).toBe(false);
		expect(outcome.attempts).toBe(0);
		expect(outcome.reason).toContain("not ready");
		// The gate is checked BEFORE run — no subagent spawned.
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("a passing precondition proceeds to dispatch", async () => {
		const dispatch = vi.fn<SubagentDispatcher>(async () => makeResult(0));
		const step = subagentStep("ok", {
			precondition: async () => ({ ok: true }),
		});

		const outcome = await runStep(step, { ctx: {}, dispatchSubagent: dispatch });

		expect(outcome.ok).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});

// ── Test 2: requiredOutput-fail → rerun then halt ─────────────────────────────

describe("runStep — requiredOutput + retryPolicy", () => {
	it("test 2a: requiredOutput-fail under maxReruns:1 dispatches exactly twice then halts", async () => {
		const dispatch = vi.fn<SubagentDispatcher>(async () => makeResult(1));
		const step = subagentStep("retryable", {
			retryPolicy: { maxReruns: 1 },
			requiredOutput: async (_ctx, lastResult) => ({
				ok: (lastResult?.exitCode ?? 1) === 0,
				reason: "exit non-zero",
			}),
		});

		const outcome = await runStep(step, { ctx: {}, dispatchSubagent: dispatch });

		expect(outcome.ok).toBe(false);
		expect(outcome.attempts).toBe(2); // initial + one rerun
		expect(dispatch).toHaveBeenCalledTimes(2);
	});

	it("test 2b: requiredOutput-fail under maxReruns:0 dispatches exactly once then halts", async () => {
		const dispatch = vi.fn<SubagentDispatcher>(async () => makeResult(1));
		const step = subagentStep("hardhalt", {
			retryPolicy: { maxReruns: 0 },
			requiredOutput: async (_ctx, lastResult) => ({
				ok: (lastResult?.exitCode ?? 1) === 0,
				reason: "exit non-zero",
			}),
		});

		const outcome = await runStep(step, { ctx: {}, dispatchSubagent: dispatch });

		expect(outcome.ok).toBe(false);
		expect(outcome.attempts).toBe(1);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("a rerun that succeeds returns ok after exactly two dispatches", async () => {
		let call = 0;
		const dispatch = vi.fn<SubagentDispatcher>(async () => makeResult(call++ === 0 ? 1 : 0));
		const step = subagentStep("recovers", {
			retryPolicy: { maxReruns: 1 },
			requiredOutput: async (_ctx, lastResult) => ({
				ok: (lastResult?.exitCode ?? 1) === 0,
			}),
		});

		const outcome = await runStep(step, { ctx: {}, dispatchSubagent: dispatch });

		expect(outcome.ok).toBe(true);
		expect(outcome.attempts).toBe(2);
		expect(dispatch).toHaveBeenCalledTimes(2);
	});
});

// ── Test 3: independent steps run concurrently ────────────────────────────────

describe("runWave — concurrency", () => {
	it("test 3: two independent steps in one wave overlap (Promise.all)", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		function makeConcurrentStep(id: string): Step {
			return {
				id,
				dependsOn: [],
				retryPolicy: { maxReruns: 0 },
				run: {
					kind: "deterministic",
					thunk: async () => {
						inFlight++;
						maxInFlight = Math.max(maxInFlight, inFlight);
						await gate; // both steps park here before either resolves
						inFlight--;
					},
				},
			};
		}

		const steps = [makeConcurrentStep("a"), makeConcurrentStep("b")];
		const ctx: StepRuntimeCtx = {};
		const dispatch: SubagentDispatcher = async () => makeResult(0);

		const wavePromise = runWave(steps, (s) => runStep(s, { ctx, dispatchSubagent: dispatch }));
		// Yield so both thunks enter and increment the counter before release.
		await new Promise((r) => setTimeout(r, 5));
		expect(maxInFlight).toBe(2); // both entered before either resolved → concurrent

		release();
		const outcomes = await wavePromise;
		expect(outcomes.every((o) => o.ok)).toBe(true);
	});
});

// ── Test 4: deterministic step spawns no subagent ─────────────────────────────

describe("runStep — deterministic step", () => {
	it("test 4: a deterministic step runs its thunk and dispatches no subagent", async () => {
		const dispatch = vi.fn<SubagentDispatcher>(async () => makeResult(0));
		let ran = false;
		const step: Step = {
			id: "det",
			dependsOn: [],
			retryPolicy: { maxReruns: 0 },
			run: {
				kind: "deterministic",
				thunk: async () => {
					ran = true;
				},
			},
		};

		const outcome = await runStep(step, { ctx: {}, dispatchSubagent: dispatch });

		expect(outcome.ok).toBe(true);
		expect(outcome.dispatched).toBe(false);
		expect(ran).toBe(true);
		expect(dispatch).not.toHaveBeenCalled();
	});
});

// ── Test 5: topoSortWaves layering ────────────────────────────────────────────

describe("topoSortWaves", () => {
	it("test 5: a cross-ref edge places the dependency in an earlier wave", () => {
		// Graph: a, b independent; c depends on a and b; d depends on c.
		const steps: Step[] = [
			subagentStep("a"),
			subagentStep("b"),
			subagentStep("c", { dependsOn: ["a", "b"] }),
			subagentStep("d", { dependsOn: ["c"] }),
		];

		const waves = topoSortWaves(steps).map((w) => w.map((s) => s.id));

		expect(waves).toEqual([["a", "b"], ["c"], ["d"]]);
	});

	it("co-locates independent nodes in the same wave", () => {
		const steps: Step[] = [subagentStep("x"), subagentStep("y"), subagentStep("z")];
		const waves = topoSortWaves(steps);
		expect(waves).toHaveLength(1);
		expect(waves[0].map((s) => s.id)).toEqual(["x", "y", "z"]);
	});

	it("throws on a dependency cycle", () => {
		const steps: Step[] = [
			subagentStep("p", { dependsOn: ["q"] }),
			subagentStep("q", { dependsOn: ["p"] }),
		];
		expect(() => topoSortWaves(steps)).toThrow(/cyclic|unsatisfiable/);
	});

	it("ignores edges to unknown step ids", () => {
		const steps: Step[] = [subagentStep("solo", { dependsOn: ["ghost"] })];
		const waves = topoSortWaves(steps);
		expect(waves).toEqual([[steps[0]]]);
	});
});
