/**
 * Spike R-CG1 — vitest spec.
 *
 * FORGE-S30-T01 — Auth-free spec proving that `tool_result` extension handler
 * mutations are reflected in the next provider request (turn-2 streamFn call).
 *
 * ACs:
 *   AC1 — handler registration and shape (auth-free, MUST PASS)
 *     - tool_result handler registers correctly via stub ExtensionAPI
 *     - handler returns { content: SHRUNK_CONTENT } for fat payload
 *     - handler returns undefined for non-fat payload (pass-through)
 *
 *   AC2 — turn-2 provider request carries shrunk content (auth-free, MUST PASS)
 *     - Drives a real AgentSession through ≥2 turns via scripted streamFn
 *     - Turn 1: streamFn returns an assistant message with a toolCall for
 *       mock_fat_tool, triggering the agent loop to execute the tool and run
 *       the extension handler.
 *     - Turn 2: streamFn captures llmContext.messages, locates the toolResult
 *       entry, reads its content, stores it in evidence.
 *     - Assertion: evidence.capturedToolResultContent equals SHRUNK_CONTENT
 *     - Assertion: fat sentinel is absent in turn-2 context messages
 *
 * No `describe.skipIf`. No `it.skip`. The scripted streamFn replaces the
 * real LLM provider — no ANTHROPIC_API_KEY required.
 *
 * Run command:
 *   cd forge-cli && npx vitest run test/poc/spike-r-cg1/run.spec.ts
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Provider } from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	type ExtensionAPI,
	type ExtensionFactory,
	type TextContent,
	type ToolResultEvent,
	type ToolResultEventResult,
	SessionManager,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	FAT_PAYLOAD_SENTINEL,
	getCaptured,
	getEvidence,
	registerSpikeCG1,
	resetEvidence,
	SHRUNK_CONTENT,
} from "./spike.js";

// ---------------------------------------------------------------------------
// Stub ExtensionAPI for unit-test invocation of the handler registration
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

// Synthetic ToolResultEvent builders — match ToolResultEventBase shape.

function makeFatToolResultEvent(): ToolResultEvent {
	const fatLines = Array.from(
		{ length: 50 },
		(_, i) => `${FAT_PAYLOAD_SENTINEL}${i}: lorem ipsum store output row`,
	).join("\n");
	return {
		type: "tool_result",
		toolName: "mock_fat_tool",
		toolCallId: "test-cg1-fat-1",
		input: {},
		content: [{ type: "text", text: fatLines }] as TextContent[],
		isError: false,
		details: undefined,
	} as unknown as ToolResultEvent;
}

function makeLeanToolResultEvent(): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "mock_lean_tool",
		toolCallId: "test-cg1-lean-1",
		input: {},
		content: [{ type: "text", text: "lean output" }] as TextContent[],
		isError: false,
		details: undefined,
	} as unknown as ToolResultEvent;
}

// ---------------------------------------------------------------------------
// AC1 — Handler registration and shape (auth-free, MUST PASS)
// ---------------------------------------------------------------------------

describe("spike-r-cg1 AC1 — handler returns shrunk content (auth-free, MUST PASS)", () => {
	let stubRecord: StubAPIRecord;

	beforeEach(() => {
		resetEvidence();
		stubRecord = { on: [] };
		const pi = makeStubPi(stubRecord);
		registerSpikeCG1(pi);
	});

	it("extension factory registers exactly one tool_result handler", () => {
		const handlers = stubRecord.on.filter((r) => r.event === "tool_result");
		expect(handlers).toHaveLength(1);
		expect(getCaptured().toolResultHandler).toBeTypeOf("function");
	});

	it("handler returns { content: SHRUNK_CONTENT } for fat payload", () => {
		const handler = getCaptured().toolResultHandler!;
		const event = makeFatToolResultEvent();
		const result = handler(event);
		expect(result).toEqual({ content: SHRUNK_CONTENT });
	});

	it("handler returns undefined (pass-through) for lean payload", () => {
		const handler = getCaptured().toolResultHandler!;
		const event = makeLeanToolResultEvent();
		const result = handler(event);
		expect(result).toBeUndefined();
	});

	it("handler increments handlerFireCount on each invocation", () => {
		const handler = getCaptured().toolResultHandler!;
		handler(makeFatToolResultEvent());
		handler(makeLeanToolResultEvent());
		expect(getEvidence().handlerFireCount).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// AC2 — Turn-2 provider request carries shrunk content (auth-free, MUST PASS)
//
// Uses a real AgentSession with a scripted streamFn to drive 2 turns without
// a real LLM. The mock_fat_tool registered as a customTool returns a fat
// payload. The extension handler mutates it to SHRUNK. On turn 2, the
// scripted streamFn captures context.messages and we assert the toolResult
// entry carries only the shrunk content.
// ---------------------------------------------------------------------------

/**
 * Scripted streamFn that drives the 2-turn agent loop:
 *
 * Turn 1 (no toolResult in context yet): returns an assistant message with
 *   a single toolCall for mock_fat_tool. Triggers the agent to execute the
 *   tool, run the extension handler (which fires SHRUNK), and push the
 *   toolResultMessage to context.messages.
 *
 * Turn 2 (toolResult in context): captures context.messages into evidence,
 *   returns a final stop message.
 */
function buildScriptedStreamFn(
	evidence: ReturnType<typeof getEvidence>,
): StreamFn {
	let turnCount = 0;

	return (_model, context, _options) => {
		turnCount++;
		const stream = createAssistantMessageEventStream();

		if (turnCount === 1) {
			// First call: return an assistant message with a toolCall.
			const toolCallMsg: AssistantMessage = {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "cg1-tool-call-1",
						name: "mock_fat_tool",
						arguments: {},
					},
				],
				api: "anthropic" as Api,
				provider: "test-provider" as Provider,
				model: "test-model",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: toolCallMsg });
				stream.push({
					type: "toolCall",
					toolCall: {
						type: "toolCall",
						id: "cg1-tool-call-1",
						name: "mock_fat_tool",
						arguments: {},
					},
					partial: toolCallMsg,
				});
				stream.push({ type: "done", reason: "toolUse", message: toolCallMsg });
			});
		} else {
			// Turn 2+: capture context.messages; find the toolResult entry.
			evidence.capturedTurn2Messages = [...context.messages];
			const toolResultMsg = context.messages.find(
				(m: Message) => m.role === "toolResult",
			);
			if (toolResultMsg && toolResultMsg.role === "toolResult") {
				evidence.capturedToolResultContent = toolResultMsg.content;
			}

			// Return a final stop message.
			const finalMsg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				api: "anthropic" as Api,
				provider: "test-provider" as Provider,
				model: "test-model",
				usage: {
					input: 200,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 210,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			queueMicrotask(() => {
				stream.push({ type: "start", partial: finalMsg });
				stream.push({ type: "done", reason: "stop", message: finalMsg });
			});
		}

		return stream;
	};
}

// Mock fat tool — registered as customTool. Returns a fat payload with the
// FAT_PAYLOAD_SENTINEL. The extension handler fires after execute() and
// replaces the content with SHRUNK_CONTENT.
const mockFatTool = defineTool({
	name: "mock_fat_tool",
	label: "Mock Fat Tool (R-CG1 spike)",
	description: "Spike R-CG1 stub. Returns a fat payload containing FAT_PAYLOAD_SENTINEL lines.",
	parameters: Type.Object({}),
	async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
		const fatLines = Array.from(
			{ length: 50 },
			(_, i) => `${FAT_PAYLOAD_SENTINEL}${i}: lorem ipsum store output row`,
		).join("\n");
		return {
			content: [{ type: "text" as const, text: fatLines }],
			details: {},
		};
	},
});

describe("spike-r-cg1 AC2 — turn-2 provider request carries shrunk content (auth-free, MUST PASS)", () => {
	let session: AgentSession;
	const cwd = process.cwd();

	beforeAll(async () => {
		resetEvidence();

		const factories: ExtensionFactory[] = [(pi: ExtensionAPI) => registerSpikeCG1(pi)];
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			extensionFactories: factories,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		// Mandatory: caller must reload custom loaders before createAgentSession.
		await resourceLoader.reload();

		const created = await createAgentSession({
			// No model required — streamFn replaces the real provider.
			customTools: [mockFatTool],
			// Only enable mock_fat_tool — no built-in tools needed.
			tools: ["mock_fat_tool"],
			noTools: "builtin",
			sessionManager: SessionManager.inMemory(),
			cwd,
			resourceLoader,
		});

		session = created.session;

		// Inject scripted streamFn — replaces real LLM provider. This is the
		// same seam used by forge-subagent.ts:299 for test-only injection.
		const evidence = getEvidence();
		session.agent.streamFn = buildScriptedStreamFn(evidence);

		// Drive the 2-turn loop: turn 1 → toolCall, turn 2 → capture + stop.
		await session.sendUserMessage("Run mock_fat_tool.");
	}, 30_000);

	afterAll(async () => {
		if (session) await session.dispose();
	});

	it("tool_result handler fired at least once during the session", () => {
		const ev = getEvidence();
		expect(
			ev.handlerFireCount,
			`expected handlerFireCount >= 1; got ${ev.handlerFireCount}`,
		).toBeGreaterThanOrEqual(1);
	});

	it("evidence.capturedToolResultContent equals SHRUNK_CONTENT", () => {
		const ev = getEvidence();
		expect(
			ev.capturedToolResultContent,
			`expected SHRUNK_CONTENT in turn-2 messages; capturedToolResultContent=${JSON.stringify(ev.capturedToolResultContent)}; turn2Messages=${JSON.stringify(ev.capturedTurn2Messages)}`,
		).toEqual(SHRUNK_CONTENT);
	});

	it("turn-2 context does NOT contain the fat sentinel string", () => {
		const ev = getEvidence();
		const messagesStr = JSON.stringify(ev.capturedTurn2Messages ?? []);
		expect(
			messagesStr,
			`expected fat sentinel to be absent in turn-2 messages; got ${messagesStr.slice(0, 300)}`,
		).not.toContain(FAT_PAYLOAD_SENTINEL);
	});
});
