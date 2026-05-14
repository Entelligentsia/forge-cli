// Unit tests for usage-hook module (FORGE-S19-T03).
//
// Coverage:
//   registerUsageHook:
//     1. Mount — pi.on("message_end") called exactly once after registerUsageHook
//     2. AssistantMessage turn — accumulator updated with correct tokens
//     3. Multiple turns — totals accumulated correctly across turns
//     4. Non-assistant message (UserMessage) — accumulator unchanged
//     5. Phase key change — two separate accumulator entries maintained
//     6. Missing/absent usage field on assistant message — treated as zero, no throw
//
//   flushPhaseUsage:
//     7. record-usage subprocess called with correct argv (all token fields)
//     8. subprocess failure → stderr warn emitted, no throw

import * as childProcess from "node:child_process";
import type { ExtensionAPI } from "@entelligentsia/pi-coding-agent";

// MessageEndEvent is not re-exported from the pi-coding-agent main index.
// Define a local structural type matching the shape from types.d.ts.
interface MessageEndEvent {
	type: "message_end";
	message: unknown;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPhaseUsage, registerUsageHook } from "../../../src/extensions/forgecli/usage-hook.js";

// ── Mock node:child_process ───────────────────────────────────────────────────
// Capture spawnSync calls without executing real subprocesses.

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

const mockSpawnSync = vi.mocked(childProcess.spawnSync);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a minimal ExtensionAPI stub that captures pi.on() registrations. */
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

/** Fire the message_end handler with a synthetic AssistantMessage. */
function fireAssistantMessage(
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
	opts: {
		model?: string;
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		costTotal?: number;
	},
): void {
	const handler = handlers.get("message_end");
	if (!handler) throw new Error("message_end handler not registered");
	const event: MessageEndEvent = {
		type: "message_end",
		message: {
			role: "assistant",
			model: opts.model ?? "claude-sonnet-4-6",
			usage: {
				input: opts.input ?? 100,
				output: opts.output ?? 50,
				cacheRead: opts.cacheRead ?? 10,
				cacheWrite: opts.cacheWrite ?? 5,
				totalTokens: (opts.input ?? 100) + (opts.output ?? 50),
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: opts.costTotal ?? 0.001,
				},
			},
			content: [],
			api: "anthropic",
			provider: "anthropic",
			responseId: "resp_123",
			stopReason: "stop",
			timestamp: Date.now(),
		} as unknown,
	};
	handler(event, {});
}

/** Fire the message_end handler with a synthetic UserMessage. */
function fireUserMessage(handlers: Map<string, (event: unknown, ctx: unknown) => unknown>): void {
	const handler = handlers.get("message_end");
	if (!handler) throw new Error("message_end handler not registered");
	const event: MessageEndEvent = {
		type: "message_end",
		message: {
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		} as unknown,
	};
	handler(event, {});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("registerUsageHook", () => {
	let currentPhaseKey = "phase-1";

	beforeEach(() => {
		currentPhaseKey = "phase-1";
		mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", pid: 1, output: [] } as ReturnType<
			typeof childProcess.spawnSync
		>);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("1. mounts message_end handler on registration", () => {
		const { pi, handlers } = makeStubApi();
		registerUsageHook(pi, { getPhaseKey: () => currentPhaseKey });
		expect(handlers.has("message_end")).toBe(true);
		// Only one message_end handler registered
		let count = 0;
		for (const key of handlers.keys()) {
			if (key === "message_end") count++;
		}
		expect(count).toBe(1);
	});

	it("2. updates accumulator with correct tokens on AssistantMessage", () => {
		const { pi, handlers } = makeStubApi();
		const acc = registerUsageHook(pi, { getPhaseKey: () => currentPhaseKey });

		fireAssistantMessage(handlers, {
			model: "claude-sonnet-4-6",
			input: 200,
			output: 80,
			cacheRead: 20,
			cacheWrite: 10,
			costTotal: 0.002,
		});

		const entry = acc.get("phase-1");
		expect(entry).toBeDefined();
		expect(entry!.inputTokens).toBe(200);
		expect(entry!.outputTokens).toBe(80);
		expect(entry!.cacheReadTokens).toBe(20);
		expect(entry!.cacheWriteTokens).toBe(10);
		expect(entry!.estimatedCostUSD).toBeCloseTo(0.002);
		expect(entry!.model).toBe("claude-sonnet-4-6");
		expect(entry!.turnCount).toBe(1);
	});

	it("3. accumulates totals across multiple turns", () => {
		const { pi, handlers } = makeStubApi();
		const acc = registerUsageHook(pi, { getPhaseKey: () => currentPhaseKey });

		fireAssistantMessage(handlers, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, costTotal: 0.001 });
		fireAssistantMessage(handlers, { input: 200, output: 100, cacheRead: 20, cacheWrite: 0, costTotal: 0.002 });

		const entry = acc.get("phase-1");
		expect(entry!.inputTokens).toBe(300);
		expect(entry!.outputTokens).toBe(150);
		expect(entry!.cacheReadTokens).toBe(30);
		expect(entry!.cacheWriteTokens).toBe(5);
		expect(entry!.estimatedCostUSD).toBeCloseTo(0.003);
		expect(entry!.turnCount).toBe(2);
	});

	it("4. ignores UserMessage — accumulator unchanged", () => {
		const { pi, handlers } = makeStubApi();
		const acc = registerUsageHook(pi, { getPhaseKey: () => currentPhaseKey });

		fireUserMessage(handlers);

		expect(acc.has("phase-1")).toBe(false);
	});

	it("5. maintains separate entries per phase key", () => {
		const { pi, handlers } = makeStubApi();
		const acc = registerUsageHook(pi, { getPhaseKey: () => currentPhaseKey });

		fireAssistantMessage(handlers, { input: 100, output: 50, costTotal: 0.001 });
		currentPhaseKey = "phase-2";
		fireAssistantMessage(handlers, { input: 200, output: 80, costTotal: 0.002 });

		expect(acc.has("phase-1")).toBe(true);
		expect(acc.has("phase-2")).toBe(true);
		expect(acc.get("phase-1")!.inputTokens).toBe(100);
		expect(acc.get("phase-2")!.inputTokens).toBe(200);
	});

	it("6. treats missing/malformed usage field as zero — no throw", () => {
		const { pi, handlers } = makeStubApi();
		const acc = registerUsageHook(pi, { getPhaseKey: () => currentPhaseKey });

		const handler = handlers.get("message_end")!;
		// Fire with assistant message that has no usage field
		expect(() =>
			handler(
				{
					type: "message_end",
					message: { role: "assistant", model: "test-model" } as unknown,
				},
				{},
			),
		).not.toThrow();

		// Accumulator entry should exist with zero values
		const entry = acc.get("phase-1");
		expect(entry).toBeDefined();
		expect(entry!.inputTokens).toBe(0);
		expect(entry!.outputTokens).toBe(0);
	});
});

describe("flushPhaseUsage", () => {
	beforeEach(() => {
		mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "", pid: 1, output: [] } as ReturnType<
			typeof childProcess.spawnSync
		>);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("7. calls record-usage subprocess with correct argv", () => {
		const acc = new Map([
			[
				"phase-plan",
				{
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadTokens: 200,
					cacheWriteTokens: 100,
					estimatedCostUSD: 0.0123,
					model: "claude-sonnet-4-6",
					turnCount: 3,
				},
			],
		]);

		flushPhaseUsage({
			sprintId: "FORGE-S19",
			eventId: "20260509T080000000Z_FORGE-S19-T03_engineer_plan",
			phaseKey: "phase-plan",
			forgeRoot: "/fake/forge-root",
			accumulator: acc,
		});

		expect(mockSpawnSync).toHaveBeenCalledOnce();
		const [cmd, argv] = mockSpawnSync.mock.calls[0] as [string, string[]];
		expect(cmd).toBe(process.execPath);
		expect(argv).toContain("/fake/forge-root/tools/store-cli.cjs");
		expect(argv).toContain("record-usage");
		expect(argv).toContain("FORGE-S19");
		expect(argv).toContain("20260509T080000000Z_FORGE-S19-T03_engineer_plan");
		expect(argv).toContain("--input-tokens");
		expect(argv).toContain("1000");
		expect(argv).toContain("--output-tokens");
		expect(argv).toContain("500");
		expect(argv).toContain("--cache-read-tokens");
		expect(argv).toContain("200");
		expect(argv).toContain("--cache-write-tokens");
		expect(argv).toContain("100");
		expect(argv).toContain("--token-source");
		expect(argv).toContain("reported");
		expect(argv).toContain("--model");
		expect(argv).toContain("claude-sonnet-4-6");
	});

	it("8. subprocess failure emits warn to stderr — no throw", () => {
		mockSpawnSync.mockReturnValue({ status: 1, stdout: "", stderr: "error", pid: 1, output: [] } as ReturnType<
			typeof childProcess.spawnSync
		>);
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const acc = new Map([
			[
				"phase-plan",
				{
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					estimatedCostUSD: 0.001,
					model: "claude-haiku-4-5",
					turnCount: 1,
				},
			],
		]);

		expect(() =>
			flushPhaseUsage({
				sprintId: "FORGE-S19",
				eventId: "test-event-id",
				phaseKey: "phase-plan",
				forgeRoot: "/fake/forge-root",
				accumulator: acc,
			}),
		).not.toThrow();

		// A warn line should have been written to stderr
		const calls = stderrSpy.mock.calls.map(([s]) => String(s));
		expect(calls.some((s) => s.includes("[warn]") && s.includes("usage hook"))).toBe(true);

		stderrSpy.mockRestore();
	});
});
