// Unit tests for the runForgeSubagent usage accumulator — zero-usage husk handling.
//
// Bug (found auditing the CART-S02-T03 benchmark transcripts): failed/retry
// turns emit assistant messages whose usage is all zeros ("husks", e.g. the
// provider-500 retry at t14 of the 174133Z implement transcript). The
// accumulator counted them as turns AND overwrote the running contextTokens
// with 0 because `usage.totalTokens ?? prev` treats 0 as non-nullish — every
// aborted phase therefore reported contextTokens: 0 despite real prior turns.
//
// Coverage:
//   Test 1: mid-run husk — excluded from turns; sums unchanged; context survives
//   Test 2: trailing husk — contextTokens keeps the last non-zero total
//   Test 3: all-husk run — turns 0, contextTokens 0 (degenerate, no crash)

import type { AgentSessionEvent, Message } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted session mock (same pattern as model-routing-dispatch.test.ts) ──

const { mockSession, queueTurns } = vi.hoisted(() => {
	let capturedSubscriber: ((e: AgentSessionEvent) => void) | null = null;
	let pending: Array<Partial<Message>> = [];

	function queueTurns(msgs: Array<Partial<Message>>): void {
		pending = msgs;
	}

	const mockSession = {
		subscribe: vi.fn((listener: (e: AgentSessionEvent) => void) => {
			capturedSubscriber = listener;
			return () => {
				capturedSubscriber = null;
			};
		}),
		prompt: vi.fn(async () => {
			for (const msg of pending) {
				capturedSubscriber?.({ type: "turn_end", message: msg as Message } as AgentSessionEvent);
			}
		}),
		abort: vi.fn(),
		dispose: vi.fn(),
		setModel: vi.fn(() => Promise.resolve()),
		agent: { sessionId: undefined as string | undefined, streamFn: undefined as unknown },
	};
	return { mockSession, queueTurns };
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

import { runForgeSubagent } from "../../../src/extensions/forgecli/forge-subagent.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function assistantTurn(input: number, output: number, totalTokens: number): Partial<Message> {
	return {
		role: "assistant",
		model: "fake-model",
		provider: "fake" as Message["provider"],
		content: [{ type: "text", text: "…" }],
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as Partial<Message>;
}

/** A failed/retry turn: assistant message whose usage is entirely zero. */
function huskTurn(): Partial<Message> {
	return assistantTurn(0, 0, 0);
}

const PERSONA = {
	name: "engineer",
	description: "test persona",
	systemPrompt: "You are a test persona.",
	tools: undefined,
	model: undefined,
};

async function run(): Promise<Awaited<ReturnType<typeof runForgeSubagent>>> {
	return runForgeSubagent({
		persona: PERSONA,
		task: "do the thing",
		cwd: process.cwd(),
		noExtensions: true,
	});
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("runForgeSubagent usage accumulator — husk turns", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("Test 1: mid-run husk is excluded from turns; sums and context unaffected", async () => {
		queueTurns([assistantTurn(100, 10, 110), huskTurn(), assistantTurn(200, 20, 230)]);
		const result = await run();
		expect(result.usage.turns).toBe(2);
		expect(result.usage.input).toBe(300);
		expect(result.usage.output).toBe(30);
		expect(result.usage.contextTokens).toBe(230);
	});

	it("Test 2: trailing husk does not clobber contextTokens to 0", async () => {
		queueTurns([assistantTurn(100, 10, 110), huskTurn()]);
		const result = await run();
		expect(result.usage.turns).toBe(1);
		expect(result.usage.contextTokens).toBe(110);
	});

	it("Test 3: all-husk run reports zero turns and zero context without crashing", async () => {
		queueTurns([huskTurn(), huskTurn()]);
		const result = await run();
		expect(result.usage.turns).toBe(0);
		expect(result.usage.input).toBe(0);
		expect(result.usage.contextTokens).toBe(0);
	});
});
