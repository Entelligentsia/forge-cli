// Unit tests for context-governor module (FORGE-S30-T03).
//
// Coverage:
//   loadDefaultPolicyTable:
//     1. Returns entry for "architect/plan"
//     2. Returns entry for "engineer/review"
//     3. Returns "default" entry for unknown key
//
//   createNoOpGovernor:
//     4. applyToolResult returns undefined for any event
//     5. applyToolCall returns undefined/void for any event
//
//   createGovernor (contextWindow resolution):
//     6. Uses ctx.model.contextWindow when model is present
//     7. Tolerates ctx.model being undefined (fallback chain removed in
//        FORGE-BUG-043 PR 1 — Mechanism B reads usage.contextWindow directly)
//
//   registerHookDispatcher governor wiring (via hook-dispatcher):
//     8. Governor wired into registerHookDispatcher is called on tool_result
//     9. Governor wired into registerHookDispatcher is called on tool_call
//    10. registerHookDispatcher with no governor arg is a no-op pass-through
//        (regression: all existing hook-dispatcher paths unchanged)

import type {
	BashToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ContextGovernor,
	type PhasePolicyTable,
	createGovernor,
	createNoOpGovernor,
	loadDefaultPolicyTable,
} from "../../../src/extensions/forgecli/context-governor.js";
import { registerHookDispatcher } from "../../../src/extensions/forgecli/hook-dispatcher.js";

// ---------------------------------------------------------------------------
// Minimal mocks needed for hook-dispatcher wiring tests
// ---------------------------------------------------------------------------

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		mkdirSync: vi.fn(),
		appendFileSync: vi.fn(),
	};
});

vi.mock("../../../src/extensions/forgecli/store-validator.js", async () => ({
	validateStoreCLIPayload: vi.fn(() => ({ ok: true, reason: "" })),
}));

vi.mock("../../../src/extensions/forgecli/transition-guard.js", async () => ({
	checkTransition: vi.fn(() => ({ allowed: true, reason: "" })),
}));

vi.mock("../../../src/extensions/forgecli/hooks/write-guard.js", async () => ({
	checkWriteGuard: vi.fn(() => ({ block: false, reason: "" })),
	applyPiEdits: vi.fn(() => ""),
	matchWriteRegistry: vi.fn(() => null),
	WRITE_REGISTRY: [],
}));

vi.mock("../../../src/extensions/forgecli/hooks/triage-error.js", async () => ({
	isForgeRelated: vi.fn(() => false),
	buildTriageMessage: vi.fn(() => ""),
	FORGE_PATTERNS: [],
}));

vi.mock("../../../src/extensions/forgecli/hooks/two-layer-guard.js", async () => ({
	checkTwoLayerBoundary: vi.fn(() => ({ allowed: true, resolvedPath: "/fake", reason: "" })),
}));

vi.mock("../../../src/extensions/forgecli/hooks/forge-permissions.js", async () => ({
	matchForgePermission: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const FAKE_FORGE_ROOT = "/fake/forge-root";

function makeStubApi(): {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

function callToolCallHandler(
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
	event: ToolCallEvent,
	ctx: unknown = {},
): ToolCallEventResult | void {
	const handler = handlers.get("tool_call");
	if (!handler) throw new Error("tool_call handler not registered");
	return handler(event, ctx) as ToolCallEventResult | void;
}

function callToolResultHandler(
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
	event: ToolResultEvent,
	ctx: unknown = {},
): void {
	const handler = handlers.get("tool_result");
	if (!handler) throw new Error("tool_result handler not registered");
	handler(event, ctx);
}

function makeReadEvent(): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "read",
		toolCallId: "tc-read-001",
		input: { file_path: "/some/path" },
	} as unknown as ToolCallEvent;
}

function makeToolResultEvent(): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "tc-tr-001",
		content: [{ type: "text", text: "ok" }],
	} as unknown as ToolResultEvent;
}

function makeBashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "tc-bash-001",
		input: { command },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadDefaultPolicyTable", () => {
	it("Test 1: returns entry for architect/plan", () => {
		const table = loadDefaultPolicyTable();
		const entry = table["architect/plan"];
		expect(entry).toBeDefined();
		expect(entry.residentFields).toContain("status");
		expect(entry.residentFields).toContain("title");
		expect(entry.toolBudgets).toHaveProperty("forge_store");
		expect(entry.steerThreshold).toBeGreaterThan(0);
		expect(entry.steerThreshold).toBeLessThanOrEqual(1);
	});

	it("Test 2: returns entry for engineer/review", () => {
		const table = loadDefaultPolicyTable();
		const entry = table["engineer/review"];
		expect(entry).toBeDefined();
		expect(entry.residentFields).toContain("status");
		expect(entry.toolBudgets).toHaveProperty("forge_store");
		expect(entry.steerThreshold).toBeGreaterThan(0);
		expect(entry.steerThreshold).toBeLessThanOrEqual(1);
	});

	it("Test 3: returns default entry for unknown persona/phase key", () => {
		const table = loadDefaultPolicyTable();
		const entry = table["default"];
		expect(entry).toBeDefined();
		// Safe defaults: empty resident fields, no tool budgets, conservative threshold
		expect(entry.residentFields).toEqual([]);
		expect(entry.toolBudgets).toEqual({});
		expect(entry.steerThreshold).toBeGreaterThan(0);

		// Accessing a missing key falls through to the default (consumer pattern)
		const missing = table["unknown/phase"] ?? table["default"];
		expect(missing).toBeDefined();
		expect(missing.steerThreshold).toBe(entry.steerThreshold);
	});
});

describe("createNoOpGovernor", () => {
	it("Test 4: applyToolResult returns undefined for any event", () => {
		const gov = createNoOpGovernor();
		const event = makeToolResultEvent();
		const result = gov.applyToolResult(event, {} as ExtensionContext);
		expect(result).toBeUndefined();
	});

	it("Test 5: applyToolCall returns undefined/void for any event", () => {
		const gov = createNoOpGovernor();
		const event = makeReadEvent();
		const result = gov.applyToolCall(event, {} as ExtensionContext);
		// The no-op must not block — undefined or void both acceptable
		expect(result == null).toBe(true);
	});
});

describe("createGovernor — contextWindow resolution", () => {
	it("Test 6: uses ctx.model.contextWindow when model is present", () => {
		const table = loadDefaultPolicyTable();
		const fakeRegistry = { find: vi.fn(() => undefined) } as unknown as Parameters<typeof createGovernor>[1];
		const gov = createGovernor(table, fakeRegistry);

		const ctxWithModel = {
			model: { contextWindow: 128_000, provider: "anthropic", id: "claude-3" },
			modelRegistry: fakeRegistry,
		} as unknown as ExtensionContext;

		// The governor returns undefined in T03 (no-op body) — we verify it doesn't
		// throw and that registry.find was NOT called (ctx.model satisfied first).
		const result = gov.applyToolResult(makeToolResultEvent(), ctxWithModel);
		expect(result).toBeUndefined();
		expect(fakeRegistry.find).not.toHaveBeenCalled();
	});

	it("Test 7: tolerates ctx.model being undefined (no fallback lookup needed)", () => {
		// DEFAULT_CONTEXT_WINDOW and the applyToolCall fallback chain were removed
		// in FORGE-BUG-043 PR 1 — Mechanism B reads usage.contextWindow directly
		// and skips the meter when usage is unavailable. This test keeps the
		// no-model robustness assertion.
		const table = loadDefaultPolicyTable();
		const fakeRegistry = { find: vi.fn(() => undefined) } as unknown as Parameters<typeof createGovernor>[1];
		const gov = createGovernor(table, fakeRegistry);

		const ctxNoModel = {
			model: undefined,
			modelRegistry: fakeRegistry,
		} as unknown as ExtensionContext;

		// Should not throw; returns undefined (no-op body in T03).
		const result = gov.applyToolResult(makeToolResultEvent(), ctxNoModel);
		expect(result).toBeUndefined();
	});
});

describe("registerHookDispatcher — governor wiring (FORGE-S30-T03)", () => {
	let applyToolResultSpy: ReturnType<typeof vi.fn>;
	let applyToolCallSpy: ReturnType<typeof vi.fn>;
	let spyGovernor: ContextGovernor;

	beforeEach(() => {
		applyToolResultSpy = vi.fn(() => undefined);
		applyToolCallSpy = vi.fn(() => undefined);
		spyGovernor = {
			applyToolResult: applyToolResultSpy,
			applyToolCall: applyToolCallSpy,
		};
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("Test 8: governor wired into registerHookDispatcher is called on tool_result", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT, spyGovernor);

		const event = makeToolResultEvent();
		callToolResultHandler(handlers, event);

		expect(applyToolResultSpy).toHaveBeenCalledTimes(1);
		expect(applyToolResultSpy).toHaveBeenCalledWith(event, expect.anything());
	});

	it("Test 9: governor wired into registerHookDispatcher is called on tool_call", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT, spyGovernor);

		const event = makeReadEvent();
		callToolCallHandler(handlers, event);

		expect(applyToolCallSpy).toHaveBeenCalledTimes(1);
		expect(applyToolCallSpy).toHaveBeenCalledWith(event, expect.anything());
	});

	it("Test 10: registerHookDispatcher with no governor is a no-op pass-through (regression)", () => {
		// Passes no governor — should behave identically to pre-T03 callers.
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		// tool_call with a non-store-cli bash command → should return undefined (not blocked)
		const bashEvent = makeBashEvent("ls -la");
		const tcResult = callToolCallHandler(handlers, bashEvent);
		expect(tcResult).toBeUndefined();

		// tool_result → should not throw and return undefined
		const trEvent = makeToolResultEvent();
		const trResult = callToolResultHandler(handlers, trEvent);
		expect(trResult).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Table shape validation
// ---------------------------------------------------------------------------

describe("PhasePolicyTable shape", () => {
	it("all entries have required fields with valid types", () => {
		const table: PhasePolicyTable = loadDefaultPolicyTable();
		for (const [key, policy] of Object.entries(table)) {
			expect(Array.isArray(policy.residentFields), `${key}.residentFields must be array`).toBe(true);
			expect(typeof policy.toolBudgets, `${key}.toolBudgets must be object`).toBe("object");
			expect(
				typeof policy.steerThreshold === "number" &&
					policy.steerThreshold >= 0 &&
					policy.steerThreshold <= 1,
				`${key}.steerThreshold must be 0–1 number`,
			).toBe(true);
		}
	});
});
