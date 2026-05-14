// Unit tests for ask-user-tool module (FORGE-S18-T04).
//
// Coverage:
//   registerAskUserTool:
//     1. Mount test — pi.registerTool called with name "forge_ask_user"
//
//   confirm type — interactive:
//     2. User answers true → returns "Y"
//     3. User answers false → returns "N"
//     4. User cancels (undefined) → isError: true
//
//   choice type — interactive:
//     5. User selects "optionA" → returns "optionA"
//     6. User cancels (undefined) → isError: true
//     7. Missing options array → isError: true immediately
//
//   text type — interactive:
//     8. User enters "hello" → returns "hello"
//     9. User cancels (undefined) → isError: true
//
//   non-interactive bypass (FORGE_YES=1):
//    10. confirm, explicit default "N" → returns "N" without calling ctx.ui
//    11. confirm, no default → returns "Y"
//    12. choice, no default → returns options[0]
//    13. text, no default → returns ""
//
//   headless mode (ctx.hasUI = false):
//    14. confirm, no default → returns "Y" without calling ctx.ui

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@entelligentsia/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAskUserTool } from "../../../src/extensions/forgecli/ask-user-tool.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal ExtensionAPI stub that captures registerTool calls. */
function makeStubApi(): { pi: ExtensionAPI; tools: Map<string, ToolDefinition<unknown>> } {
	const tools = new Map<string, ToolDefinition<unknown>>();
	const pi = {
		registerTool(def: ToolDefinition<unknown>) {
			tools.set(def.name, def);
		},
	} as unknown as ExtensionAPI;
	return { pi, tools };
}

/** Build a minimal ExtensionContext stub with controllable ui methods. */
function makeStubCtx(overrides?: {
	hasUI?: boolean;
	confirm?: (title: string, message: string, opts?: unknown) => Promise<boolean | undefined>;
	select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
	input?: (title: string, placeholder?: string, opts?: unknown) => Promise<string | undefined>;
}): ExtensionContext {
	return {
		hasUI: overrides?.hasUI ?? true,
		ui: {
			confirm: overrides?.confirm ?? vi.fn().mockResolvedValue(undefined),
			select: overrides?.select ?? vi.fn().mockResolvedValue(undefined),
			input: overrides?.input ?? vi.fn().mockResolvedValue(undefined),
			notify: vi.fn(),
			// Provide no-op stubs for other ExtensionUIContext methods
		},
	} as unknown as ExtensionContext;
}

/** Call the forge_ask_user tool's execute function. */
async function callAskUser(
	tools: Map<string, ToolDefinition<unknown>>,
	params: {
		question: string;
		type: "confirm" | "choice" | "text";
		options?: string[];
		default?: string;
	},
	ctx: ExtensionContext,
) {
	const def = tools.get("forge_ask_user");
	if (!def) throw new Error("forge_ask_user tool not registered");
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (def as any).execute("fake-id", params, undefined, undefined, ctx);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerAskUserTool", () => {
	let tools: Map<string, ToolDefinition<unknown>>;
	let pi: ExtensionAPI;

	beforeEach(() => {
		const stub = makeStubApi();
		pi = stub.pi;
		tools = stub.tools;
		// Ensure env flags are clean before each test.
		delete process.env.FORGE_YES;
		delete process.env.FORGE_NON_INTERACTIVE;
	});

	afterEach(() => {
		delete process.env.FORGE_YES;
		delete process.env.FORGE_NON_INTERACTIVE;
	});

	// ── Test 1: mount ─────────────────────────────────────────────────────────

	it("registers tool with name forge_ask_user", () => {
		registerAskUserTool(pi);
		expect(tools.has("forge_ask_user")).toBe(true);
	});

	// ── Tests 2-4: confirm / interactive ────────────────────────────────────

	describe("confirm type — interactive", () => {
		beforeEach(() => {
			registerAskUserTool(pi);
		});

		it("returns Y when user confirms true (test 2)", async () => {
			const ctx = makeStubCtx({ confirm: vi.fn().mockResolvedValue(true) });
			const result = await callAskUser(tools, { question: "Continue?", type: "confirm" }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("Y");
			expect(ctx.ui.confirm).toHaveBeenCalledOnce();
		});

		it("returns N when user answers false (test 3)", async () => {
			const ctx = makeStubCtx({ confirm: vi.fn().mockResolvedValue(false) });
			const result = await callAskUser(tools, { question: "Continue?", type: "confirm" }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("N");
		});

		it("returns isError when user cancels (test 4)", async () => {
			const ctx = makeStubCtx({ confirm: vi.fn().mockResolvedValue(undefined) });
			const result = await callAskUser(tools, { question: "Continue?", type: "confirm" }, ctx);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("cancelled");
		});
	});

	// ── Tests 5-7: choice / interactive ─────────────────────────────────────

	describe("choice type — interactive", () => {
		beforeEach(() => {
			registerAskUserTool(pi);
		});

		it("returns selected option when user picks one (test 5)", async () => {
			const ctx = makeStubCtx({ select: vi.fn().mockResolvedValue("optionA") });
			const result = await callAskUser(
				tools,
				{ question: "Pick one:", type: "choice", options: ["optionA", "optionB"] },
				ctx,
			);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("optionA");
			expect(ctx.ui.select).toHaveBeenCalledWith("Pick one:", ["optionA", "optionB"], expect.anything());
		});

		it("returns isError when user cancels (test 6)", async () => {
			const ctx = makeStubCtx({ select: vi.fn().mockResolvedValue(undefined) });
			const result = await callAskUser(tools, { question: "Pick one:", type: "choice", options: ["a", "b"] }, ctx);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("cancelled");
		});

		it("returns isError immediately when options array is missing (test 7)", async () => {
			const ctx = makeStubCtx({ select: vi.fn() });
			const result = await callAskUser(tools, { question: "Pick one:", type: "choice" }, ctx);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("'choice' requires");
			// ui.select must NOT have been called
			expect(ctx.ui.select).not.toHaveBeenCalled();
		});
	});

	// ── Tests 8-9: text / interactive ────────────────────────────────────────

	describe("text type — interactive", () => {
		beforeEach(() => {
			registerAskUserTool(pi);
		});

		it("returns entered text (test 8)", async () => {
			const ctx = makeStubCtx({ input: vi.fn().mockResolvedValue("hello world") });
			const result = await callAskUser(tools, { question: "Enter value:", type: "text" }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("hello world");
			expect(ctx.ui.input).toHaveBeenCalledWith("Enter value:", "", expect.anything());
		});

		it("returns isError when user cancels (test 9)", async () => {
			const ctx = makeStubCtx({ input: vi.fn().mockResolvedValue(undefined) });
			const result = await callAskUser(tools, { question: "Enter value:", type: "text" }, ctx);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("cancelled");
		});
	});

	// ── Tests 10-13: non-interactive bypass (FORGE_YES=1) ───────────────────

	describe("non-interactive bypass — FORGE_YES=1", () => {
		beforeEach(() => {
			registerAskUserTool(pi);
			process.env.FORGE_YES = "1";
		});

		it("returns explicit default when provided — confirm (test 10)", async () => {
			const confirmFn = vi.fn();
			const ctx = makeStubCtx({ confirm: confirmFn });
			const result = await callAskUser(tools, { question: "Continue?", type: "confirm", default: "N" }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("N");
			// ui.confirm must NOT have been called
			expect(confirmFn).not.toHaveBeenCalled();
		});

		it("returns 'Y' fallback when no default — confirm (test 11)", async () => {
			const ctx = makeStubCtx({ confirm: vi.fn() });
			const result = await callAskUser(tools, { question: "Continue?", type: "confirm" }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("Y");
			expect(ctx.ui.confirm).not.toHaveBeenCalled();
		});

		it("returns options[0] fallback when no default — choice (test 12)", async () => {
			const ctx = makeStubCtx({ select: vi.fn() });
			const result = await callAskUser(
				tools,
				{ question: "Pick:", type: "choice", options: ["alpha", "beta"] },
				ctx,
			);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("alpha");
			expect(ctx.ui.select).not.toHaveBeenCalled();
		});

		it("returns '' fallback when no default — text (test 13)", async () => {
			const ctx = makeStubCtx({ input: vi.fn() });
			const result = await callAskUser(tools, { question: "Enter:", type: "text" }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("");
			expect(ctx.ui.input).not.toHaveBeenCalled();
		});
	});

	// ── Test 14: headless mode (ctx.hasUI=false) ─────────────────────────────

	describe("headless mode — ctx.hasUI=false", () => {
		beforeEach(() => {
			registerAskUserTool(pi);
		});

		it("returns fallback without calling ctx.ui when hasUI is false (test 14)", async () => {
			const confirmFn = vi.fn();
			const ctx = makeStubCtx({ hasUI: false, confirm: confirmFn });
			const result = await callAskUser(tools, { question: "Continue?", type: "confirm" }, ctx);
			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).toBe("Y");
			expect(confirmFn).not.toHaveBeenCalled();
		});
	});
});
