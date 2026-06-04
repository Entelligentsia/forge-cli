// Unit tests for Mechanism B — context budget meter + checkpoint steer — FORGE-S30-T05.
// Coverage:
//   Budget meter (ctx.ui.setStatus):
//     Test 1: setStatus called with formatted string when getContextUsage() returns valid data
//     Test 2: setStatus called with undefined when getContextUsage() returns undefined
//     Test 3: setStatus called with undefined when getContextUsage() returns tokens: null
//   Steer single-fire invariant:
//     Test 4: steer fires exactly once when fraction >= steerThreshold
//     Test 5: steer does NOT re-fire on subsequent calls above threshold
//     Test 6: steer does NOT fire below threshold
//   Budget math (provider-neutral; usage.contextWindow is source of truth):
//     Test 7: budget math correct for usage.contextWindow = 200_000
//     Test 8: budget math correct for usage.contextWindow = 128_000
//   Graceful omission:
//     Test 9: no steer fires when steerFn is not provided
//   Steer message content (via phaseSummaryName):
//     Test 10: steer message contains "PLAN-SUMMARY.json" for "architect/plan" phase;
//              "{PHASE}-SUMMARY.json" for unknown key

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createGovernor,
	loadDefaultPolicyTable,
} from "../../../src/extensions/forgecli/context-governor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolResultEvent(
	toolName: string,
	content: string,
	toolCallId = "tc-mech-b-001",
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName,
		toolCallId,
		content: [{ type: "text", text: content }],
		input: {},
		isError: false,
	} as unknown as ToolResultEvent;
}

interface FakeCtxOptions {
	tokens?: number | null;
	contextWindow?: number;
	percent?: number | null;
	usageUndefined?: boolean;
	/** Model contextWindow — intentionally different from usage.contextWindow in tests 7/8 */
	modelContextWindow?: number;
	persona?: string;
	phase?: string;
}

function makeFakeCtx(opts: FakeCtxOptions = {}): ExtensionContext {
	const setStatus = vi.fn<[string, string | undefined], void>();
	const fakeRegistry: ModelRegistry = {
		find: vi.fn(() => undefined),
	} as unknown as ModelRegistry;

	const modelContextWindow = opts.modelContextWindow ?? 999_999; // different from usage values

	// Use explicit null check: if opts.tokens is provided (even as null), use that value;
	// otherwise default to 100_000. The ?? operator treats null as nullish so we need
	// a ternary here.
	const resolvedTokens = "tokens" in opts ? opts.tokens : 100_000;
	const usage =
		opts.usageUndefined
			? undefined
			: {
					tokens: resolvedTokens !== undefined ? resolvedTokens : 100_000,
					contextWindow: opts.contextWindow ?? 200_000,
					percent: opts.percent !== undefined ? opts.percent : 50,
				};

	return {
		persona: opts.persona ?? "",
		phase: opts.phase ?? "",
		model: {
			provider: "fake-provider",
			id: "fake-model",
			contextWindow: modelContextWindow,
		},
		modelRegistry: fakeRegistry,
		ui: { setStatus },
		getContextUsage: () => usage,
	} as unknown as ExtensionContext;
}

/** Retrieve the vi.fn() setStatus mock from a fake ctx */
function getSetStatus(ctx: ExtensionContext): ReturnType<typeof vi.fn> {
	return (ctx as unknown as { ui: { setStatus: ReturnType<typeof vi.fn> } }).ui.setStatus;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Mechanism B: budget meter (ctx.ui.setStatus)", () => {
	it("Test 1: setStatus called with formatted string when getContextUsage() returns valid data", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);

		// tokens=158_000, contextWindow=200_000, percent=79
		const ctx = makeFakeCtx({ tokens: 158_000, contextWindow: 200_000, percent: 79 });
		const event = makeToolResultEvent("bash", "some output");
		gov.applyToolResult(event, ctx);

		const setStatus = getSetStatus(ctx);
		expect(setStatus).toHaveBeenCalledWith("forge:ctx-budget", "ctx: 158k / 200k (79%)");
	});

	it("Test 2: setStatus called with undefined when getContextUsage() returns undefined", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);

		const ctx = makeFakeCtx({ usageUndefined: true });
		const event = makeToolResultEvent("bash", "some output", "tc-mech-b-t2");
		gov.applyToolResult(event, ctx);

		const setStatus = getSetStatus(ctx);
		expect(setStatus).toHaveBeenCalledWith("forge:ctx-budget", undefined);
	});

	it("Test 3: setStatus called with undefined when getContextUsage() returns tokens: null", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);

		const ctx = makeFakeCtx({ tokens: null, contextWindow: 200_000, percent: null });
		const event = makeToolResultEvent("bash", "some output", "tc-mech-b-t3");
		gov.applyToolResult(event, ctx);

		const setStatus = getSetStatus(ctx);
		expect(setStatus).toHaveBeenCalledWith("forge:ctx-budget", undefined);
	});
});

describe("Mechanism B: steer single-fire invariant", () => {
	it("Test 4: steer fires exactly once when fraction >= steerThreshold", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const steerFn = vi.fn<[string], void>();
		const gov = createGovernor(table, registry, steerFn);

		// architect/plan: steerThreshold = 0.8
		// tokens = 0.8 * 200_000 = 160_000 → fraction = 0.8 >= 0.8 → should fire
		const ctx = makeFakeCtx({
			tokens: 160_000,
			contextWindow: 200_000,
			percent: 80,
			persona: "architect",
			phase: "plan",
		});
		const event = makeToolResultEvent("bash", "output", "tc-mech-b-t4");
		gov.applyToolResult(event, ctx);

		expect(steerFn).toHaveBeenCalledTimes(1);
	});

	it("Test 5: steer does NOT re-fire on subsequent calls above threshold", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const steerFn = vi.fn<[string], void>();
		const gov = createGovernor(table, registry, steerFn);

		// architect/plan: steerThreshold = 0.8
		const ctx = makeFakeCtx({
			tokens: 180_000,
			contextWindow: 200_000,
			percent: 90,
			persona: "architect",
			phase: "plan",
		});

		// Call three times above threshold
		const event1 = makeToolResultEvent("bash", "output1", "tc-mech-b-t5a");
		const event2 = makeToolResultEvent("bash", "output2", "tc-mech-b-t5b");
		const event3 = makeToolResultEvent("bash", "output3", "tc-mech-b-t5c");
		gov.applyToolResult(event1, ctx);
		gov.applyToolResult(event2, ctx);
		gov.applyToolResult(event3, ctx);

		// Must fire exactly once despite 3 calls above threshold
		expect(steerFn).toHaveBeenCalledTimes(1);
	});

	it("Test 6: steer does NOT fire below threshold", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const steerFn = vi.fn<[string], void>();
		const gov = createGovernor(table, registry, steerFn);

		// architect/plan: steerThreshold = 0.8
		// tokens = 0.5 * 200_000 = 100_000 → fraction = 0.5 < 0.8 → must NOT fire
		const ctx = makeFakeCtx({
			tokens: 100_000,
			contextWindow: 200_000,
			percent: 50,
			persona: "architect",
			phase: "plan",
		});
		const event = makeToolResultEvent("bash", "output", "tc-mech-b-t6");
		gov.applyToolResult(event, ctx);

		expect(steerFn).not.toHaveBeenCalled();
	});
});

describe("Mechanism B: budget math (usage.contextWindow is source of truth)", () => {
	it("Test 7: budget math correct for usage.contextWindow = 200_000", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);

		// usage.contextWindow = 200_000; ctx.model.contextWindow = 999_999 (different — not used)
		const ctx = makeFakeCtx({
			tokens: 100_000,
			contextWindow: 200_000,
			percent: 50,
			modelContextWindow: 999_999,
		});
		const event = makeToolResultEvent("bash", "output", "tc-mech-b-t7");
		gov.applyToolResult(event, ctx);

		const setStatus = getSetStatus(ctx);
		// N = round(100_000/1000) = 100; W = round(200_000/1000) = 200; P = 50
		expect(setStatus).toHaveBeenCalledWith("forge:ctx-budget", "ctx: 100k / 200k (50%)");
	});

	it("Test 8: budget math correct for usage.contextWindow = 128_000", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);

		// usage.contextWindow = 128_000; ctx.model.contextWindow = 999_999 (different — not used)
		const ctx = makeFakeCtx({
			tokens: 64_000,
			contextWindow: 128_000,
			percent: 50,
			modelContextWindow: 999_999,
		});
		const event = makeToolResultEvent("bash", "output", "tc-mech-b-t8");
		gov.applyToolResult(event, ctx);

		const setStatus = getSetStatus(ctx);
		// N = round(64_000/1000) = 64; W = round(128_000/1000) = 128; P = 50
		expect(setStatus).toHaveBeenCalledWith("forge:ctx-budget", "ctx: 64k / 128k (50%)");
	});
});

describe("Mechanism B: graceful omission", () => {
	it("Test 9: no steer fires when steerFn is not provided", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;
		// createGovernor called without steerFn — must not throw
		const gov = createGovernor(table, registry);

		// Above threshold for architect/plan
		const ctx = makeFakeCtx({
			tokens: 180_000,
			contextWindow: 200_000,
			percent: 90,
			persona: "architect",
			phase: "plan",
		});
		const event = makeToolResultEvent("bash", "output", "tc-mech-b-t9");

		// Should not throw and should not attempt to call any steer
		expect(() => gov.applyToolResult(event, ctx)).not.toThrow();
	});
});

describe("Mechanism B: steer message content (phaseSummaryName)", () => {
	it("Test 10: steer message contains correct summary file for known and unknown phase keys", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;

		// --- Part A: architect/plan → "PLAN-SUMMARY.json" ---
		const steerFnA = vi.fn<[string], void>();
		const govA = createGovernor(table, registry, steerFnA);
		const ctxA = makeFakeCtx({
			tokens: 180_000,
			contextWindow: 200_000,
			percent: 90,
			persona: "architect",
			phase: "plan",
		});
		const eventA = makeToolResultEvent("bash", "output", "tc-mech-b-t10a");
		govA.applyToolResult(eventA, ctxA);

		expect(steerFnA).toHaveBeenCalledTimes(1);
		const msgA = steerFnA.mock.calls[0]?.[0] ?? "";
		expect(msgA).toContain("PLAN-SUMMARY.json");
		expect(msgA).toContain("architect/plan");
		expect(msgA).toContain("This note will not re-fire");

		// --- Part B: unknown phase → generic checkpoint wording, NO placeholder ---
		// FORGE-BUG-043: previously the steer named the literal "{PHASE}-SUMMARY.json"
		// placeholder for unknown keys (e.g. custom config.pipelines phases),
		// instructing the agent to write to a file literally named that.
		// "default" policy has steerThreshold = 0.9; use 95% to trigger
		const steerFnB = vi.fn<[string], void>();
		const govB = createGovernor(table, registry, steerFnB);
		const ctxB = makeFakeCtx({
			tokens: 190_000,
			contextWindow: 200_000,
			percent: 95,
			persona: "unknown-persona",
			phase: "unknown-phase",
		});
		const eventB = makeToolResultEvent("bash", "output2", "tc-mech-b-t10b");
		govB.applyToolResult(eventB, ctxB);

		expect(steerFnB).toHaveBeenCalledTimes(1);
		const msgB = steerFnB.mock.calls[0]?.[0] ?? "";
		expect(msgB).not.toContain("{PHASE}-SUMMARY.json");
		expect(msgB).toContain("Checkpoint your findings");
		expect(msgB).toContain("This note will not re-fire");
	});

	it("Test 11: steer message names the CATALOG summary filename for review phases (FORGE-BUG-043)", () => {
		// The plugin catalog (forge/tools/lib/artifact-kinds.cjs) names these
		// REVIEW-PLAN-SUMMARY.json / REVIEW-CODE-SUMMARY.json. The governor
		// previously steered agents toward REVIEW_PLAN-SUMMARY.json /
		// CODE_REVIEW-SUMMARY.json — files that never exist on disk.
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: vi.fn(() => undefined) } as unknown as ModelRegistry;

		const steerFnPlan = vi.fn<[string], void>();
		const govPlan = createGovernor(table, registry, steerFnPlan);
		const ctxPlan = makeFakeCtx({
			tokens: 160_000,
			contextWindow: 200_000,
			percent: 80,
			persona: "supervisor",
			phase: "review-plan",
		});
		govPlan.applyToolResult(makeToolResultEvent("bash", "out", "tc-mech-b-t11a"), ctxPlan);
		expect(steerFnPlan).toHaveBeenCalledTimes(1);
		const msgPlan = steerFnPlan.mock.calls[0]?.[0] ?? "";
		expect(msgPlan).toContain("REVIEW-PLAN-SUMMARY.json");
		expect(msgPlan).not.toContain("REVIEW_PLAN-SUMMARY.json");

		const steerFnCode = vi.fn<[string], void>();
		const govCode = createGovernor(table, registry, steerFnCode);
		const ctxCode = makeFakeCtx({
			tokens: 160_000,
			contextWindow: 200_000,
			percent: 80,
			persona: "supervisor",
			phase: "review-code",
		});
		govCode.applyToolResult(makeToolResultEvent("bash", "out", "tc-mech-b-t11b"), ctxCode);
		expect(steerFnCode).toHaveBeenCalledTimes(1);
		const msgCode = steerFnCode.mock.calls[0]?.[0] ?? "";
		expect(msgCode).toContain("REVIEW-CODE-SUMMARY.json");
		expect(msgCode).not.toContain("CODE_REVIEW-SUMMARY.json");
	});
});
