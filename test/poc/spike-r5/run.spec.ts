/**
 * Spike R5 — vitest spec.
 *
 * FORGE-S15-T08 — Discharges architectural-review.md §R5 (BeforeAgentStartEventResult
 * field semantics). Two handler variants, three describe blocks:
 *
 *   AC1 Handler A (auth-free, MUST PASS) — direct invocation of the captured
 *   `before_agent_start` handler against a synthetic BeforeAgentStartEvent.
 *   Asserts result has `{ systemPrompt: "BASE\nTEST_SP_MARKER:R5A" }`, no `message`.
 *
 *   AC1 Handler B (auth-free, MUST PASS) — direct invocation of the captured
 *   `before_agent_start` handler B. Asserts result has a `message` matching the
 *   `forge.kb_context` shape, no `systemPrompt`.
 *
 *   Live (auth-gated, `describe.skipIf(SKIP)`) — drives two real AgentSessions,
 *   one per handler variant. Asserts that markers land where expected.
 */

import { getModel } from "@entelligentsia/pi-ai";
import {
	type AgentSession,
	type BeforeAgentStartEvent,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
} from "@entelligentsia/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type CapturedCustomMessage,
	getCaptured,
	getEvidence,
	registerSpikeR5A,
	registerSpikeR5B,
	resetEvidence,
} from "./spike.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Stub ExtensionAPI — captures (event, handler) registrations.
// Only fields actually consumed by registerSpikeR5A / registerSpikeR5B are
// implemented. Cast-through scoped to this stub.
// ---------------------------------------------------------------------------

interface StubAPIRecord {
	on: Array<{ event: string; handler: unknown }>;
}

function makeStubPi(record: StubAPIRecord): ExtensionAPI {
	return {
		on(event: string, handler: unknown) {
			record.on.push({ event, handler });
		},
	} as unknown as ExtensionAPI;
}

// ---------------------------------------------------------------------------
// Synthetic event builders.
// ---------------------------------------------------------------------------

function makeBeforeAgentStartEvent(systemPrompt: string): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "test prompt",
		systemPrompt,
		systemPromptOptions: {} as BeforeAgentStartEvent["systemPromptOptions"],
	} as unknown as BeforeAgentStartEvent;
}

function makeStubCtx(): ExtensionContext {
	return {
		getSystemPrompt: () => "",
		hasUI: false,
	} as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// AC1 Handler A — auth-free shape test. MUST PASS.
// ---------------------------------------------------------------------------

describe("spike-r5 AC1 Handler A — systemPrompt variant shape", () => {
	let stubRecord: StubAPIRecord;

	beforeEach(() => {
		resetEvidence();
		stubRecord = { on: [] };
		const pi = makeStubPi(stubRecord);
		registerSpikeR5A(pi);
	});

	it("registers a before_agent_start handler and an agent_start handler", () => {
		const baHandlers = stubRecord.on.filter((r) => r.event === "before_agent_start");
		const asHandlers = stubRecord.on.filter((r) => r.event === "agent_start");
		expect(baHandlers).toHaveLength(1);
		expect(asHandlers).toHaveLength(1);
		expect(getCaptured().beforeAgentStartHandlerA).toBeTypeOf("function");
		expect(getCaptured().agentStartHandlerA).toBeTypeOf("function");
	});

	it("returns { systemPrompt: 'BASE\\nTEST_SP_MARKER:R5A' } when base is 'BASE'", async () => {
		const handler = getCaptured().beforeAgentStartHandlerA!;
		const event = makeBeforeAgentStartEvent("BASE");
		const result = await handler(event, makeStubCtx());
		expect(result).toEqual({ systemPrompt: "BASE\nTEST_SP_MARKER:R5A" });
	});

	it("result has no `message` field", async () => {
		const handler = getCaptured().beforeAgentStartHandlerA!;
		const event = makeBeforeAgentStartEvent("BASE");
		const result = await handler(event, makeStubCtx());
		// Must not inject a message — systemPrompt only.
		expect((result as Record<string, unknown> | undefined)?.message).toBeUndefined();
	});

	it("appends the marker to the existing system prompt", async () => {
		const handler = getCaptured().beforeAgentStartHandlerA!;
		const event = makeBeforeAgentStartEvent("You are a helpful assistant.");
		const result = await handler(event, makeStubCtx());
		expect((result as { systemPrompt?: string }).systemPrompt).toContain("You are a helpful assistant.");
		expect((result as { systemPrompt?: string }).systemPrompt).toContain("TEST_SP_MARKER:R5A");
	});
});

// ---------------------------------------------------------------------------
// AC1 Handler B — auth-free shape test. MUST PASS.
// ---------------------------------------------------------------------------

describe("spike-r5 AC1 Handler B — message variant shape", () => {
	let stubRecord: StubAPIRecord;

	beforeEach(() => {
		resetEvidence();
		stubRecord = { on: [] };
		const pi = makeStubPi(stubRecord);
		registerSpikeR5B(pi);
	});

	it("registers a before_agent_start handler and an agent_end handler", () => {
		const baHandlers = stubRecord.on.filter((r) => r.event === "before_agent_start");
		const aeHandlers = stubRecord.on.filter((r) => r.event === "agent_end");
		expect(baHandlers).toHaveLength(1);
		expect(aeHandlers).toHaveLength(1);
		expect(getCaptured().beforeAgentStartHandlerB).toBeTypeOf("function");
		expect(getCaptured().agentEndHandlerB).toBeTypeOf("function");
	});

	it("returns message with customType 'forge.kb_context'", async () => {
		const handler = getCaptured().beforeAgentStartHandlerB!;
		const event = makeBeforeAgentStartEvent("BASE");
		const result = await handler(event, makeStubCtx());
		const msg = (result as { message?: { customType?: string } }).message;
		expect(msg?.customType).toBe("forge.kb_context");
	});

	it("content array contains an entry with text 'TEST_MSG_MARKER:R5B'", async () => {
		const handler = getCaptured().beforeAgentStartHandlerB!;
		const event = makeBeforeAgentStartEvent("BASE");
		const result = await handler(event, makeStubCtx());
		const content = (result as { message?: { content?: unknown } }).message?.content;
		expect(Array.isArray(content)).toBe(true);
		const items = content as Array<{ type: string; text?: string }>;
		const textItem = items.find((c): c is { type: "text"; text: string } => c.type === "text");
		expect(textItem?.text).toContain("TEST_MSG_MARKER:R5B");
	});

	it("message.display is true", async () => {
		const handler = getCaptured().beforeAgentStartHandlerB!;
		const event = makeBeforeAgentStartEvent("BASE");
		const result = await handler(event, makeStubCtx());
		const msg = (result as { message?: { display?: boolean } }).message;
		expect(msg?.display).toBe(true);
	});

	it("message.details equals { kb: 'engineering' }", async () => {
		const handler = getCaptured().beforeAgentStartHandlerB!;
		const event = makeBeforeAgentStartEvent("BASE");
		const result = await handler(event, makeStubCtx());
		const msg = (result as { message?: { details?: unknown } }).message;
		expect(msg?.details).toEqual({ kb: "engineering" });
	});

	it("result has no `systemPrompt` field", async () => {
		const handler = getCaptured().beforeAgentStartHandlerB!;
		const event = makeBeforeAgentStartEvent("BASE");
		const result = await handler(event, makeStubCtx());
		// Must not replace the system prompt — message only.
		expect((result as Record<string, unknown> | undefined)?.systemPrompt).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Live — auth-gated. Two independent sessions, one per handler variant.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("spike-r5 live — real AgentSession, auth-gated", () => {
	// Sub-test A: systemPrompt variant.
	describe("Handler A — systemPrompt marker lands in effective system prompt", () => {
		let session: AgentSession;
		const cwd = process.cwd();

		beforeAll(async () => {
			resetEvidence();
			const factories: ExtensionFactory[] = [(pi) => registerSpikeR5A(pi, { cwd })];
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				extensionFactories: factories,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			// Mandatory per SPIKE-LESSONS §2 — caller must reload custom loaders.
			await resourceLoader.reload();
			const created = await createAgentSession({
				model: getModel("anthropic", "claude-haiku-4-5"),
				thinkingLevel: "minimal",
				// Explicit allowlist (SPIKE-LESSONS §3); never noTools.
				tools: ["bash"],
				sessionManager: SessionManager.inMemory(),
				cwd,
				resourceLoader,
			});
			session = created.session;
		}, 60_000);

		afterAll(async () => {
			if (session) await session.dispose();
		});

		it("agent_start captures a system prompt containing TEST_SP_MARKER:R5A", async () => {
			await session.sendUserMessage("Say the word OK and nothing else.");

			const captured = getEvidence().handlerASystemPrompts;
			expect(
				captured.length,
				`expected at least one agent_start capture; got ${JSON.stringify(captured)}`,
			).toBeGreaterThan(0);
			expect(
				captured[0],
				`expected TEST_SP_MARKER:R5A in system prompt; got ${captured[0]?.slice(0, 200)}`,
			).toContain("TEST_SP_MARKER:R5A");
		}, 120_000);
	});

	// Sub-test B: message variant.
	describe("Handler B — message marker lands in agent transcript", () => {
		let session: AgentSession;
		const cwd = process.cwd();

		beforeAll(async () => {
			resetEvidence();
			const factories: ExtensionFactory[] = [(pi) => registerSpikeR5B(pi, { cwd })];
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				extensionFactories: factories,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			const created = await createAgentSession({
				model: getModel("anthropic", "claude-haiku-4-5"),
				thinkingLevel: "minimal",
				tools: ["bash"],
				sessionManager: SessionManager.inMemory(),
				cwd,
				resourceLoader,
			});
			session = created.session;
		}, 60_000);

		afterAll(async () => {
			if (session) await session.dispose();
		});

		it("agent_end captures a forge.kb_context custom message with TEST_MSG_MARKER:R5B", async () => {
			await session.sendUserMessage("Say the word OK and nothing else.");

			const msgs = getEvidence().handlerBMessages;
			expect(
				msgs.length,
				`expected at least one custom message capture; got ${JSON.stringify(msgs)}`,
			).toBeGreaterThan(0);

			const kbMsg = msgs.find((m: CapturedCustomMessage) => m.customType === "forge.kb_context");
			expect(kbMsg, `expected a forge.kb_context message; got ${JSON.stringify(msgs)}`).toBeDefined();

			// Content may be string or array. Handle both.
			const content = kbMsg?.content;
			if (typeof content === "string") {
				expect(content).toContain("TEST_MSG_MARKER:R5B");
			} else if (Array.isArray(content)) {
				const textItem = (content as Array<{ type: string; text?: string }>).find(
					(c): c is { type: "text"; text: string } => c.type === "text",
				);
				expect(
					textItem?.text,
					`expected text item with TEST_MSG_MARKER:R5B; got ${JSON.stringify(content)}`,
				).toContain("TEST_MSG_MARKER:R5B");
			} else {
				expect.fail(`unexpected content type: ${typeof content}`);
			}
		}, 120_000);
	});
});
