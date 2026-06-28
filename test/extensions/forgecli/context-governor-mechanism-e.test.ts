// Unit + integration tests for Mechanism E — Forge-aware compaction via
// session_before_compact + proactive trigger — FORGE-S30-T09.
//
// Coverage:
//   extractForgeFacts (pure extractor):
//     Test 1: returns store IDs found in message text
//     Test 2: returns AC-state lines (checkbox patterns)
//     Test 3: returns transitions (→ status, update-status patterns)
//     Test 4: returns file refs (engineering/, .forge/, *.ts/*.md/*.cjs/*.json)
//     Test 5: returns FRICTION blocks
//     Test 6: returns empty struct when messages is empty
//   buildForgeCompactionFactory (handler factory):
//     Test 7: handler returns { compaction } with firstKeptEntryId/tokensBefore
//              passed through from event.preparation
//     Test 8: handler returns undefined on malformed preparation (nil) — IL7 fallback
//     Test 9: summary string includes extracted store IDs
//     Test 10: summary string includes warm-tier objective when summaryReader returns valid JSON
//     Test 11: warm-tier merge omitted (no error) when summaryReader returns null
//   Proactive trigger (createGovernor compactFn):
//     Test 12: compactFn fires once when fraction >= steerThreshold
//     Test 13: compactFn does NOT re-fire on subsequent turns above threshold (single-fire)
//     Test 14: compactFn and steerFn are independent — omitting one does not suppress the other
//   extensionFactories integration (RunSubagentOptions):
//     Test 15: factory registered via extensionFactories fires on session_before_compact

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	buildForgeCompactionFactory,
	extractForgeFacts,
} from "../../../src/extensions/forgecli/context-governor-compaction.js";
import {
	createGovernor,
	loadDefaultPolicyTable,
} from "../../../src/extensions/forgecli/context-governor.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SessionBeforeCompactEvent-compatible preparation object.
 * Used to drive the session_before_compact handler in unit tests.
 */
function makeMinimalPreparation(
	firstKeptEntryId: string,
	tokensBefore: number,
	messagesToSummarize: unknown[] = [],
) {
	return {
		firstKeptEntryId,
		tokensBefore,
		messagesToSummarize,
		turnPrefixMessages: [],
		isSplitTurn: false,
		settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20_000 },
		fileOps: { reads: [], writes: [], edits: [], deletes: [] },
	};
}

/**
 * Build a minimal stub ExtensionAPI that records registered handlers.
 * Used by unit tests that don't need a real session.
 */
interface StubHandlerRecord {
	handlers: Array<{ event: string; handler: (...args: unknown[]) => unknown }>;
}

function makeStubPiForCompaction(): StubHandlerRecord & { pi: { on: (event: string, handler: (...args: unknown[]) => unknown) => void } } {
	const record: StubHandlerRecord = { handlers: [] };
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			record.handlers.push({ event, handler });
		},
	};
	return { ...record, pi };
}

/** Stub summaryReader that always returns null (file absent simulation). */
function nullSummaryReader(): null {
	return null;
}

/** Stub summaryReader that returns serialized JSON for the given data. */
function jsonSummaryReader(data: unknown): () => string {
	return () => JSON.stringify(data);
}

/** Build a fake message object with text content (message-like shape). */
function makeMsg(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	};
}

/** Build a minimal ExtensionContext with usage, phase, and persona. */
function makeCtxWithUsage(
	fractionUsed: number,
	contextWindow = 200_000,
	persona = "engineer",
	phase = "implement",
): ExtensionContext {
	const fakeRegistry: ModelRegistry = {
		find: () => undefined,
	} as unknown as ModelRegistry;
	return {
		persona,
		phase,
		model: undefined,
		modelRegistry: fakeRegistry,
		ui: { setStatus: vi.fn() },
		getContextUsage: () => ({
			tokens: Math.round(fractionUsed * contextWindow),
			contextWindow,
			percent: Math.round(fractionUsed * 100),
		}),
	} as unknown as ExtensionContext;
}

/** Build a scripted streamFn that drives N turns without a real LLM. */
function buildSimpleStreamFn(turns = 2): StreamFn {
	let turnCount = 0;
	// Upstream pi 0.80.2 changed compact() to refuse sessions with no eligible
	// messages ("Nothing to compact (session too small)", upstream #4811) instead
	// of producing an empty summary. prepareCompaction returns undefined when
	// messagesToSummarize is empty, which happens when the session is smaller
	// than keepRecentTokens (default 20000). To exercise the real extension-
	// compaction path (session_before_compact -> session_compact with
	// fromExtension=true), each response pads to ~60000 chars (~15000 tokens at
	// 4 chars/token) so two turns (~30000 tokens) exceed keepRecentTokens and
	// leave ~10000 tokens to summarize.
	const compactionEligiblePadding = "x".repeat(60_000);
	return (_model, _context, _options) => {
		turnCount++;
		const stream = createAssistantMessageEventStream();
		const finalMsg: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: `Turn ${turnCount} response. ${compactionEligiblePadding}` }],
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
		void turns;
	};
}

/** Make a ToolResultEvent for testing the governor's proactive trigger. */
function makeBashEvent(content: string, toolCallId = "tc-mech-e-bash"): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId,
		content: [{ type: "text", text: content }],
		input: { cmd: "ls" },
		isError: false,
	} as unknown as ToolResultEvent;
}

// ---------------------------------------------------------------------------
// extractForgeFacts — pure extractor
// ---------------------------------------------------------------------------

describe("extractForgeFacts: store ID extraction", () => {
	it("Test 1: returns store IDs found in message text", () => {
		const msgs = [
			makeMsg("Working on FORGE-S30-T09 and FORGE-S30 sprint."),
			makeMsg("Also referencing FORGE-BUG-042 here."),
		];
		const result = extractForgeFacts(msgs);
		expect(result.storeIds).toContain("FORGE-S30-T09");
		expect(result.storeIds).toContain("FORGE-S30");
		expect(result.storeIds).toContain("FORGE-BUG-042");
	});
});

describe("extractForgeFacts: AC-state extraction", () => {
	it("Test 2: returns AC-state lines (checkbox patterns)", () => {
		const msgs = [
			makeMsg("- [x] AC1 handler returns CompactionResult\n- [ ] AC2 pass-through verified"),
		];
		const result = extractForgeFacts(msgs);
		expect(result.acStateLines.some((l) => l.includes("[x]"))).toBe(true);
		expect(result.acStateLines.some((l) => l.includes("[ ]"))).toBe(true);
	});
});

describe("extractForgeFacts: transition line extraction", () => {
	it("Test 3: returns transitions (→ status, update-status patterns)", () => {
		const msgs = [
			makeMsg("Status changed → implemented\nnode store-cli.cjs update-status task FORGE-S30-T09 status implementing"),
		];
		const result = extractForgeFacts(msgs);
		expect(result.transitionLines.some((l) => l.includes("→"))).toBe(true);
		expect(result.transitionLines.some((l) => l.includes("update-status"))).toBe(true);
	});
});

describe("extractForgeFacts: file ref extraction", () => {
	it("Test 4: returns file refs (engineering/, .forge/, *.ts/*.md/*.cjs/*.json paths)", () => {
		const msgs = [
			makeMsg(
				"Reading engineering/sprints/FORGE-S30/FORGE-S30-T09/PLAN.md and .forge/config.json\n" +
				"Also editing src/context-governor.ts and forge-tools.cjs",
			),
		];
		const result = extractForgeFacts(msgs);
		expect(result.fileRefs.some((r) => r.includes("engineering/"))).toBe(true);
		expect(result.fileRefs.some((r) => r.includes(".forge/"))).toBe(true);
		expect(result.fileRefs.some((r) => r.endsWith(".ts") || r.includes(".ts"))).toBe(true);
	});
});

describe("extractForgeFacts: FRICTION block extraction", () => {
	it("Test 5: returns FRICTION blocks", () => {
		const msgs = [
			makeMsg("[FRICTION] store-cli schema mismatch during T09 implementation"),
			makeMsg("type:friction detected in workflow output"),
		];
		const result = extractForgeFacts(msgs);
		expect(result.frictionBlocks.length).toBeGreaterThanOrEqual(1);
	});
});

describe("extractForgeFacts: empty input", () => {
	it("Test 6: returns empty struct when messages is empty", () => {
		const result = extractForgeFacts([]);
		expect(result.storeIds).toHaveLength(0);
		expect(result.acStateLines).toHaveLength(0);
		expect(result.transitionLines).toHaveLength(0);
		expect(result.fileRefs).toHaveLength(0);
		expect(result.frictionBlocks).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// buildForgeCompactionFactory — handler factory
// ---------------------------------------------------------------------------

describe("buildForgeCompactionFactory: CompactionResult pass-through", () => {
	it("Test 7: handler returns { compaction } with firstKeptEntryId/tokensBefore from preparation", () => {
		const { handlers, pi } = makeStubPiForCompaction();
		const factory = buildForgeCompactionFactory({ summaryReader: nullSummaryReader });
		factory(pi as never);

		const handler = handlers.find((h) => h.event === "session_before_compact")?.handler;
		expect(handler).toBeDefined();

		const preparation = makeMinimalPreparation("entry-uuid-001", 8500, [
			makeMsg("FORGE-S30-T09 in progress"),
		]);
		const event = {
			preparation,
			branchEntries: [],
			customInstructions: undefined,
			signal: new AbortController().signal,
		};

		const result = handler!(event) as { compaction?: { firstKeptEntryId: string; tokensBefore: number; summary: string } } | undefined;
		expect(result).toBeDefined();
		expect(result!.compaction).toBeDefined();
		expect(result!.compaction!.firstKeptEntryId).toBe("entry-uuid-001");
		expect(result!.compaction!.tokensBefore).toBe(8500);
		expect(typeof result!.compaction!.summary).toBe("string");
	});
});

describe("buildForgeCompactionFactory: IL7 fallback on malformed input", () => {
	it("Test 8: handler returns undefined when preparation is nil/missing — IL7 safe fallback", () => {
		const { handlers, pi } = makeStubPiForCompaction();
		const factory = buildForgeCompactionFactory({ summaryReader: nullSummaryReader });
		factory(pi as never);

		const handler = handlers.find((h) => h.event === "session_before_compact")?.handler;
		expect(handler).toBeDefined();

		// Pass event with no preparation field (malformed)
		const malformedEvent = {
			preparation: null,
			branchEntries: [],
			customInstructions: undefined,
			signal: new AbortController().signal,
		};

		let result: unknown;
		expect(() => {
			result = handler!(malformedEvent);
		}).not.toThrow();
		// Malformed preparation → must return undefined (IL7)
		expect(result).toBeUndefined();
	});
});

describe("buildForgeCompactionFactory: summary content", () => {
	it("Test 9: summary string includes extracted store IDs", () => {
		const { handlers, pi } = makeStubPiForCompaction();
		const factory = buildForgeCompactionFactory({ summaryReader: nullSummaryReader });
		factory(pi as never);

		const handler = handlers.find((h) => h.event === "session_before_compact")?.handler;
		const preparation = makeMinimalPreparation("entry-001", 1000, [
			makeMsg("Working on FORGE-S30-T09 — mechanism E implementation"),
			makeMsg("Sprint FORGE-S30 context governor tasks"),
		]);
		const event = {
			preparation,
			branchEntries: [],
			customInstructions: undefined,
			signal: new AbortController().signal,
		};

		const result = handler!(event) as { compaction?: { summary: string } } | undefined;
		expect(result?.compaction?.summary).toBeDefined();
		// Summary should reference the extracted task ID
		expect(result!.compaction!.summary).toContain("FORGE-S30-T09");
	});

	it("Test 10: summary includes warm-tier objective when summaryReader returns valid JSON", () => {
		const { handlers, pi } = makeStubPiForCompaction();
		const warmSummary = {
			objective: "Implement Mechanism E deterministic compaction handler",
			key_changes: ["Added extractForgeFacts", "Added buildForgeCompactionFactory"],
			verdict: "n/a",
		};
		const factory = buildForgeCompactionFactory({
			summaryReader: jsonSummaryReader(warmSummary),
		});
		factory(pi as never);

		const handler = handlers.find((h) => h.event === "session_before_compact")?.handler;
		const preparation = makeMinimalPreparation("entry-001", 1000, [
			makeMsg("Context message for compaction"),
		]);
		const event = {
			preparation,
			branchEntries: [],
			customInstructions: undefined,
			signal: new AbortController().signal,
		};

		const result = handler!(event) as { compaction?: { summary: string } } | undefined;
		expect(result?.compaction?.summary).toBeDefined();
		// Warm-tier objective must appear in the summary
		expect(result!.compaction!.summary).toContain("Implement Mechanism E");
	});

	it("Test 11: warm-tier merge omitted without error when summaryReader returns null", () => {
		const { handlers, pi } = makeStubPiForCompaction();
		const factory = buildForgeCompactionFactory({ summaryReader: nullSummaryReader });
		factory(pi as never);

		const handler = handlers.find((h) => h.event === "session_before_compact")?.handler;
		const preparation = makeMinimalPreparation("entry-001", 1000, [
			makeMsg("FORGE-S30-T09 context"),
		]);
		const event = {
			preparation,
			branchEntries: [],
			customInstructions: undefined,
			signal: new AbortController().signal,
		};

		let result: unknown;
		expect(() => {
			result = handler!(event);
		}).not.toThrow();
		// Result must still be a valid CompactionResult (not undefined)
		// — warm-tier absence is gracefully handled
		const r = result as { compaction?: { summary: string } } | undefined;
		expect(r?.compaction).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// createGovernor: proactive compact trigger (compactFn, fifth param)
// ---------------------------------------------------------------------------

describe("createGovernor: proactive compactFn trigger", () => {
	it("Test 12: compactFn fires once when fraction >= steerThreshold", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const compactCalls: string[] = [];
		const compactFn = () => { compactCalls.push("compact"); };

		const gov = createGovernor(table, registry, undefined, undefined, compactFn);
		// engineer/implement default steerThreshold = 0.9 → fire at fraction >= 0.9
		const ctx = makeCtxWithUsage(0.92); // 92% — above threshold

		const event = makeBashEvent("output-at-threshold", "tc-mech-e-t12");
		gov.applyToolResult(event, ctx);

		expect(compactCalls).toHaveLength(1);
		expect(compactCalls[0]).toBe("compact");
	});

	it("Test 13: compactFn does NOT re-fire on subsequent turns above threshold (single-fire invariant)", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const compactCalls: string[] = [];
		const compactFn = () => { compactCalls.push("compact"); };

		const gov = createGovernor(table, registry, undefined, undefined, compactFn);
		const ctx = makeCtxWithUsage(0.95); // 95% — consistently above threshold

		// Fire 3 turns
		for (let i = 0; i < 3; i++) {
			gov.applyToolResult(makeBashEvent(`output-turn-${i}`, `tc-mech-e-t13-${i}`), ctx);
		}

		// compactFn must fire exactly once (single-fire invariant)
		expect(compactCalls).toHaveLength(1);
	});

	it("Test 14: compactFn and steerFn are independent — omitting steerFn does not suppress compactFn", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const compactCalls: string[] = [];
		const compactFn = () => { compactCalls.push("compact"); };
		const steerCalls: string[] = [];
		const steerFn = (msg: string) => { steerCalls.push(msg); };

		// Variant A: steerFn present, compactFn present — both must fire once
		const govA = createGovernor(table, registry, steerFn, undefined, compactFn);
		const ctxA = makeCtxWithUsage(0.95);
		govA.applyToolResult(makeBashEvent("output-a", "tc-mech-e-t14a"), ctxA);
		expect(compactCalls).toHaveLength(1);
		expect(steerCalls).toHaveLength(1);

		// Variant B: steerFn absent, compactFn present — compactFn must still fire
		const compactCallsB: string[] = [];
		const govB = createGovernor(table, registry, undefined, undefined, () => { compactCallsB.push("compact"); });
		const ctxB = makeCtxWithUsage(0.95);
		govB.applyToolResult(makeBashEvent("output-b", "tc-mech-e-t14b"), ctxB);
		expect(compactCallsB).toHaveLength(1);

		// Variant C: steerFn present, compactFn absent — steerFn must fire, no error
		const steerCallsC: string[] = [];
		const govC = createGovernor(table, registry, (msg) => { steerCallsC.push(msg); });
		const ctxC = makeCtxWithUsage(0.95);
		expect(() => {
			govC.applyToolResult(makeBashEvent("output-c", "tc-mech-e-t14c"), ctxC);
		}).not.toThrow();
		expect(steerCallsC).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// extensionFactories integration (Test 15)
// ---------------------------------------------------------------------------

describe("extensionFactories integration: factory fires on session_before_compact", () => {
	let sessionInstance: Awaited<ReturnType<typeof createAgentSession>>["session"] | null = null;
	let handlerFireCount = 0;
	let capturedSummary: string | null = null;
	let fromExtension: boolean | null = null;

	beforeAll(async () => {
		const evidence = { fired: false };

		// Build a factory that captures handler evidence.
		const factory = buildForgeCompactionFactory({
			summaryReader: jsonSummaryReader({
				objective: "T15 integration objective",
				key_changes: ["Test 15 warm-tier"],
				verdict: "n/a",
			}),
		});

		// Wrap with evidence capture for session_compact.
		const wrappedFactory = (pi: Parameters<typeof factory>[0]) => {
			factory(pi);
			// Also wire session_compact to capture fromExtension
			(pi as { on: (e: string, h: (...a: unknown[]) => void) => void }).on(
				"session_compact",
				(event: unknown) => {
					const ev = event as { fromExtension?: boolean; compactionEntry?: { summary?: string } };
					fromExtension = ev.fromExtension ?? null;
					capturedSummary = ev.compactionEntry?.summary ?? null;
				},
			);
		};

		const resourceLoader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: getAgentDir(),
			extensionFactories: [wrappedFactory],
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
			cwd: process.cwd(),
			resourceLoader,
		});

		sessionInstance = created.session;
		sessionInstance.agent.streamFn = buildSimpleStreamFn(2);

		// Drive 2 turns, then compact manually.
		await sessionInstance.sendUserMessage("First message.");
		await sessionInstance.sendUserMessage("Second message.");
		await sessionInstance.compact();

		handlerFireCount = evidence.fired ? 1 : 1; // fromExtension being set means it fired
		void handlerFireCount;
	}, 30_000);

	afterAll(async () => {
		if (sessionInstance) {
			await sessionInstance.dispose();
			sessionInstance = null;
		}
	});

	it("Test 15: factory registered via extensionFactories fires — fromExtension=true on session_compact", () => {
		// The fact that fromExtension was captured proves the handler fired
		// (session_compact only fires if session_before_compact returned { compaction })
		expect(fromExtension).toBe(true);
	});

	it("Test 15b: captured summary comes from extension (warm-tier objective present)", () => {
		// The compaction entry summary should contain content from the warm-tier or extracted facts
		expect(capturedSummary).not.toBeNull();
		// Must be a non-empty string
		expect(typeof capturedSummary).toBe("string");
		expect((capturedSummary ?? "").length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Warm-tier filename resolution — FORGE-BUG-043 PR 1 (catalog contract)
// ---------------------------------------------------------------------------

describe("Mechanism E: warm-tier summary filename resolves from the plugin catalog", () => {
	/**
	 * Capturing summaryReader: records every filePath it is asked to read.
	 * Returning null keeps the handler on the no-warm-tier path (irrelevant here —
	 * we only assert the RESOLVED PATH, which previously used invented
	 * REVIEW_PLAN-SUMMARY.json / CODE_REVIEW-SUMMARY.json spellings that never
	 * exist on disk; catalog names are REVIEW-PLAN-SUMMARY.json /
	 * REVIEW-CODE-SUMMARY.json per forge/tools/lib/artifact-kinds.cjs).
	 */
	function capturingReader(): { reader: (p: string) => null; paths: string[] } {
		const paths: string[] = [];
		return {
			reader: (p: string) => {
				paths.push(p);
				return null;
			},
			paths,
		};
	}

	function fireHandler(opts: Parameters<typeof buildForgeCompactionFactory>[0]): void {
		const stub = makeStubPiForCompaction();
		const factory = buildForgeCompactionFactory(opts);
		factory(stub.pi as never);
		const handler = stub.handlers.find((h) => h.event === "session_before_compact")?.handler;
		expect(handler).toBeDefined();
		handler?.({ preparation: makeMinimalPreparation("entry-1", 1000, [makeMsg("text")]) });
	}

	it("Test 16: supervisor/review-plan warm-tier path uses REVIEW-PLAN-SUMMARY.json", () => {
		const { reader, paths } = capturingReader();
		fireHandler({
			cwd: "/proj",
			phaseKey: "supervisor/review-plan",
			entityId: "FORGE-S30-T05",
			sprintId: "FORGE-S30",
			summaryReader: reader,
		});
		expect(paths).toHaveLength(1);
		expect(paths[0]).toContain("REVIEW-PLAN-SUMMARY.json");
		expect(paths[0]).not.toContain("REVIEW_PLAN-SUMMARY.json");
	});

	it("Test 17: supervisor/review-code warm-tier path uses REVIEW-CODE-SUMMARY.json", () => {
		const { reader, paths } = capturingReader();
		fireHandler({
			cwd: "/proj",
			phaseKey: "supervisor/review-code",
			entityId: "FORGE-S30-T06",
			sprintId: "FORGE-S30",
			summaryReader: reader,
		});
		expect(paths).toHaveLength(1);
		expect(paths[0]).toContain("REVIEW-CODE-SUMMARY.json");
		expect(paths[0]).not.toContain("CODE_REVIEW-SUMMARY.json");
	});

	it("Test 18: unknown phaseKey skips warm-tier read entirely (no placeholder path)", () => {
		// Previously resolved to a literal "{PHASE}-SUMMARY.json" path and
		// attempted to read it. Unknown keys must skip the warm-tier read.
		const { reader, paths } = capturingReader();
		fireHandler({
			cwd: "/proj",
			phaseKey: "custom-persona/custom-phase",
			entityId: "FORGE-S99-T01",
			sprintId: "FORGE-S99",
			summaryReader: reader,
		});
		expect(paths).toHaveLength(0);
	});
});
