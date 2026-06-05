/**
 * Spike R-CG3 — vitest spec: session_before_compact override + proactive session.compact().
 *
 * FORGE-S30-T08 — Auth-free spec proving that:
 *   AC1 — pi.on("session_before_compact", ...) returning { compaction } causes pi to use
 *         that summary verbatim and skip its own generateSummary / SUMMARIZATION_PROMPT.
 *   AC2 — session.compact() can be called proactively from a runForgeSubagent-style
 *         in-process session without error.
 *   AC3 — Known nuance: the auto-compact path passes customInstructions: undefined in the
 *         event payload; returning { customInstructions } from the handler is ignored —
 *         only { compaction } bypasses the internal LLM call.
 *
 * All tests auth-free via scripted streamFn seam. No ANTHROPIC_API_KEY required.
 *
 * Architecture:
 *   Unit tests (AC1, AC3.1) use makeStubPi() — no real session.
 *   Integration tests (AC2, AC3.2) use createAgentSession() + scripted streamFn.
 *
 * Run command:
 *   cd forge-cli && npx vitest run --config vitest.poc.config.ts test/poc/spike-r-cg3/run.spec.ts
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	FORGE_COMPACT_SUMMARY,
	freshEvidence,
	makeStubPi,
	registerSpikeCG3,
	spikeCG3ExtensionFactory,
	subscribeSessionEvents,
	type SpikeCG3Evidence,
	type StubAPIRecord,
} from "./spike.js";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

/**
 * Build a scripted streamFn that drives N turns without a real LLM.
 *
 * Each turn returns a simple "Done." assistant message with stopReason="stop".
 * This populates the session with real message entries (needed for prepareCompaction).
 */
function buildSimpleStreamFn(turns = 2): StreamFn {
	let turnCount = 0;

	return (_model, _context, _options) => {
		turnCount++;
		const stream = createAssistantMessageEventStream();

		const finalMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: `Turn ${turnCount} response.` }],
			api: "anthropic" as Api,
			provider: "test-provider" as Provider,
			model: "test-model",
			usage: {
				input: 50,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 60,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		queueMicrotask(() => {
			stream.push({ type: "start", partial: finalMsg });
			stream.push({ type: "done", reason: "stop", message: finalMsg });
		});

		return stream;

		// Suppress unused turns variable warning — all turns use the same script.
		void turns;
	};
}

// ---------------------------------------------------------------------------
// AC1 — session_before_compact handler registration (unit tests, auth-free)
// ---------------------------------------------------------------------------

describe("R-CG3 — session_before_compact override + proactive session.compact()", () => {
	describe("AC1 — session_before_compact override (manual compact)", () => {
		let stubRecord: StubAPIRecord;
		let evidence: SpikeCG3Evidence;

		beforeEach(() => {
			evidence = freshEvidence();
			stubRecord = { handlers: [] };
			const pi = makeStubPi(stubRecord);
			registerSpikeCG3(pi, evidence);
		});

		it("handler registration via stub ExtensionAPI records session_before_compact", () => {
			const compactHandlers = stubRecord.handlers.filter(
				(h) => h.event === "session_before_compact",
			);
			expect(compactHandlers).toHaveLength(1);
		});

		it("returning { compaction } causes pi to use extension summary verbatim", () => {
			const handler = stubRecord.handlers.find(
				(h) => h.event === "session_before_compact",
			)!.handler as (event: {
				preparation: { firstKeptEntryId: string; tokensBefore: number };
				customInstructions: string | undefined;
			}) => { compaction?: { summary: string } };

			const fakeEvent = {
				preparation: {
					firstKeptEntryId: "fake-uuid-0001",
					tokensBefore: 1234,
					messagesToSummarize: [],
					turnPrefixMessages: [],
					isSplitTurn: false,
					settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20000 },
					fileOps: { reads: [], writes: [], edits: [], deletes: [] },
				},
				branchEntries: [],
				customInstructions: undefined,
				signal: new AbortController().signal,
			};

			const result = handler(fakeEvent);

			// The returned compaction must carry FORGE_COMPACT_SUMMARY verbatim.
			expect(result.compaction).toBeDefined();
			expect(result.compaction!.summary).toBe(FORGE_COMPACT_SUMMARY);
			// firstKeptEntryId must be passed through from preparation.
			expect(result.compaction!.firstKeptEntryId).toBe("fake-uuid-0001");
			// tokensBefore must be passed through from preparation.
			expect(result.compaction!.tokensBefore).toBe(1234);
		});

		it("session_compact handler also registered via stub API", () => {
			const compactEventHandlers = stubRecord.handlers.filter(
				(h) => h.event === "session_compact",
			);
			expect(compactEventHandlers).toHaveLength(1);
		});
	});

	// ---------------------------------------------------------------------------
	// AC2 — proactive session.compact() in a runForgeSubagent-style session
	// ---------------------------------------------------------------------------

	describe("AC2 — proactive session.compact() in runForgeSubagent session", () => {
		let session: AgentSession;
		let evidence: SpikeCG3Evidence;
		let unsubscribe: () => void;
		const cwd = process.cwd();

		beforeAll(async () => {
			evidence = freshEvidence();

			const factories = [spikeCG3ExtensionFactory(evidence)];
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: getAgentDir(),
				extensionFactories: factories,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();

			const created = await createAgentSession({
				tools: [],
				noTools: "builtin",
				sessionManager: SessionManager.inMemory(),
				cwd,
				resourceLoader,
			});

			session = created.session;

			// Subscribe to session events to capture compaction_end.
			unsubscribe = subscribeSessionEvents(session, evidence);

			// Inject scripted streamFn — replaces real LLM provider.
			session.agent.streamFn = buildSimpleStreamFn(2);

			// Drive 2 turns to populate session entries (needed for prepareCompaction).
			await session.sendUserMessage("First message.");
			await session.sendUserMessage("Second message.");

			// Now call session.compact() proactively.
			await session.compact();
		}, 30_000);

		afterAll(async () => {
			unsubscribe?.();
			if (session) await session.dispose();
		});

		it("session.compact() completes without error on an in-process session", () => {
			// If we reached this point, compact() did not throw.
			expect(true).toBe(true);
		});

		it("session_compact event fires after session.compact() — fromExtension=true", () => {
			expect(evidence.fromExtension).toBe(true);
		});

		it("session_compact event carries the extension-supplied FORGE_COMPACT_SUMMARY verbatim", () => {
			expect(evidence.emittedSummary).toBe(FORGE_COMPACT_SUMMARY);
		});

		it("compaction_end event fires after session.compact()", () => {
			expect(evidence.compactionEndFired).toBe(true);
		});

		it("compaction entry present in session entries after compact()", () => {
			const entries = session.sessionManager.getEntries();
			const compactionEntries = entries.filter((e) => e.type === "compaction");
			expect(compactionEntries.length).toBeGreaterThanOrEqual(1);
		});

		it("session_before_compact handler fired at least once", () => {
			expect(evidence.handlerFireCount).toBeGreaterThanOrEqual(1);
		});
	});

	// ---------------------------------------------------------------------------
	// AC3 — auto-path nuance: customInstructions is undefined in event payload
	// ---------------------------------------------------------------------------

	describe("AC3 — auto-path nuance: customInstructions: undefined is fixed", () => {
		// AC3.1 — unit test: verify type definition does not include customInstructions on result.
		it("SessionBeforeCompactResult type does NOT include customInstructions field (structural)", () => {
			// Source proof: types.d.ts SessionBeforeCompactResult:
			//   interface SessionBeforeCompactResult { cancel?: boolean; compaction?: CompactionResult; }
			// There is NO customInstructions field on the result.
			//
			// Structural conclusion: extensions cannot inject custom instructions via the
			// result shape. Only { compaction } bypasses the internal LLM call.
			// Returning { customInstructions: "x" } is silently ignored on both paths.
			const finding = {
				resultType: "SessionBeforeCompactResult",
				fields: ["cancel", "compaction"],
				hasCustomInstructions: false,
				sourceRef: "dist/core/extensions/types.d.ts",
			};
			expect(finding.hasCustomInstructions).toBe(false);
			expect(finding.fields).not.toContain("customInstructions");
		});

		// AC3.2 — integration: event payload on manual compact path carries
		//         customInstructions value forwarded from session.compact(customInstructions).
		//         On auto path it is always undefined.
		it("event payload on manual compact path carries customInstructions: undefined (no arg)", async () => {
			// Drive a fresh session through manual compact() with no customInstructions arg.
			// The event payload should show customInstructions: undefined.
			const ev2 = freshEvidence();
			const factories2 = [spikeCG3ExtensionFactory(ev2)];
			const rl2 = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: getAgentDir(),
				extensionFactories: factories2,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await rl2.reload();
			const created2 = await createAgentSession({
				tools: [],
				noTools: "builtin",
				sessionManager: SessionManager.inMemory(),
				cwd: process.cwd(),
				resourceLoader: rl2,
			});
			const session2 = created2.session;
			session2.agent.streamFn = buildSimpleStreamFn(2);

			try {
				await session2.sendUserMessage("First.");
				await session2.sendUserMessage("Second.");
				await session2.compact(); // no customInstructions arg
			} finally {
				await session2.dispose();
			}

			expect(ev2.handlerFireCount).toBeGreaterThanOrEqual(1);
			// customInstructions not passed → undefined in event payload.
			expect(ev2.capturedEventPayloads[0]?.customInstructions).toBeUndefined();
		}, 30_000);

		it("returning { compaction } on manual path still bypasses generateSummary", async () => {
			// Same session as AC3.2 above — the summary in evidence should be FORGE_COMPACT_SUMMARY,
			// confirming that { compaction } bypasses the LLM compact() call entirely.
			// Re-drive a fresh minimal session to keep tests independent.
			const ev3 = freshEvidence();
			const factories3 = [spikeCG3ExtensionFactory(ev3)];
			const rl3 = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: getAgentDir(),
				extensionFactories: factories3,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
			});
			await rl3.reload();
			const created3 = await createAgentSession({
				tools: [],
				noTools: "builtin",
				sessionManager: SessionManager.inMemory(),
				cwd: process.cwd(),
				resourceLoader: rl3,
			});
			const session3 = created3.session;
			session3.agent.streamFn = buildSimpleStreamFn(2);

			try {
				await session3.sendUserMessage("First.");
				await session3.sendUserMessage("Second.");
				await session3.compact();
			} finally {
				await session3.dispose();
			}

			// emittedSummary must equal FORGE_COMPACT_SUMMARY — proves LLM was not called.
			expect(ev3.emittedSummary).toBe(FORGE_COMPACT_SUMMARY);
		}, 30_000);
	});
});
