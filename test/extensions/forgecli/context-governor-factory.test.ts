// Unit tests for buildGovernorFactory — per-subagent governor injection.
// Fixes the dormant-governor defect found benchmarking CART-S02-T03:
//   (a) the governor never ran inside phase subagent sessions (only the parent),
//   (b) resolvePhaseKey always returned "default" because pi's ExtensionContext
//       carries no persona/phase fields and FORGE_PHASE_KEY is never set,
//   (c) the policy table only shipped keys ("architect/plan", "engineer/review")
//       that match NO real `${personaNoun}/${role}` pipeline combination,
//   (d) steerFn / summarySentinel / compactFn were never wired in production.
//
// buildGovernorFactory closes all four: it is an ExtensionFactory constructed
// per-phase by run-task.ts with the pipeline-known phaseKey, registering a
// governor whose steer/compact ride the per-call ExtensionContext and whose
// summary sentinel reads the store task record (read-only — Pack 07).
//
// Coverage:
//   Registration:
//     Test 1: factory registers tool_call AND tool_result handlers on pi
//   Injected phaseKey (THE regression test — bare ctx, no persona/phase):
//     Test 2: span-clamp applies the injected phase's bash budget with a
//             production-shaped ctx that has NO persona/phase fields
//     Test 3: schema-trim retains engineer/plan residentFields, drops others
//   Policy table coverage:
//     Test 4: every governed `${personaNoun}/${role}` pipeline key is present
//   Mechanism B steer via ctx.sendUserMessage:
//     Test 5: fires exactly once with deliverAs: "steer" at threshold
//   Mechanism E proactive compact via ctx.compact:
//     Test 6: fires exactly once at threshold
//   Mechanism C sentinel against the store record:
//     Test 7: forge_store result shed when summaries[<phase key>] exists
//     Test 8: no shed when the summary is absent
//   IL7:
//     Test 9: handler never throws when ctx lacks ui/getContextUsage entirely

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildGovernorFactory,
	loadDefaultPolicyTable,
} from "../../../src/extensions/forgecli/context-governor.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolResultHandler = (
	event: ToolResultEvent,
	ctx: ExtensionContext,
) => { content?: Array<{ type: string; text: string }> } | undefined;

interface CapturedHandlers {
	tool_call?: (event: ToolCallEvent, ctx: ExtensionContext) => unknown;
	tool_result?: ToolResultHandler;
}

/** Minimal pi mock capturing on() registrations + sendUserMessage (steer channel). */
function makeFakePi(): {
	pi: ExtensionAPI;
	handlers: CapturedHandlers;
	sendUserMessage: ReturnType<typeof vi.fn>;
} {
	const handlers: CapturedHandlers = {};
	const sendUserMessage = vi.fn();
	const pi = {
		on: (event: string, handler: unknown): void => {
			(handlers as Record<string, unknown>)[event] = handler;
		},
		sendUserMessage,
	} as unknown as ExtensionAPI;
	return { pi, handlers, sendUserMessage };
}

/**
 * Production-shaped ctx: NO persona, NO phase fields — exactly what pi hands
 * extensions at runtime. The pre-fix governor resolved "default" from this.
 */
function makeBareCtx(opts: { tokens?: number; contextWindow?: number } = {}): {
	ctx: ExtensionContext;
	compact: ReturnType<typeof vi.fn>;
} {
	const compact = vi.fn();
	const ctx = {
		ui: { setStatus: vi.fn(), notify: vi.fn() },
		getContextUsage: () =>
			opts.tokens === undefined
				? undefined
				: {
						tokens: opts.tokens,
						contextWindow: opts.contextWindow ?? 200_000,
						percent: Math.round((opts.tokens / (opts.contextWindow ?? 200_000)) * 100),
					},
		compact,
		model: undefined,
		modelRegistry: { find: () => undefined },
	} as unknown as ExtensionContext;
	return { ctx, compact };
}

function makeToolResultEvent(
	toolName: string,
	content: string,
	input: Record<string, unknown> = {},
	toolCallId = "tc-factory-001",
): ToolResultEvent {
	return {
		type: "tool_result",
		toolName,
		toolCallId,
		content: [{ type: "text", text: content }],
		input,
		isError: false,
	} as unknown as ToolResultEvent;
}

function resultText(result: ReturnType<ToolResultHandler>): string {
	const block = result?.content?.[0];
	return block && "text" in block ? block.text : "";
}

/** Pipeline phase keys that carry a governed policy (writeback/commit stay default). */
const GOVERNED_PIPELINE_KEYS = [
	"engineer/plan",
	"supervisor/review-plan",
	"engineer/implement",
	"supervisor/review-code",
	"qa-engineer/validate",
	"architect/approve",
];

const tmpDirs: string[] = [];
function makeStoreCwd(taskId: string, summaries?: Record<string, unknown>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gov-factory-"));
	tmpDirs.push(dir);
	const tasksDir = path.join(dir, ".forge", "store", "tasks");
	fs.mkdirSync(tasksDir, { recursive: true });
	const record: Record<string, unknown> = { id: taskId, status: "implementing" };
	if (summaries) record.summaries = summaries;
	fs.writeFileSync(path.join(tasksDir, `${taskId}.json`), JSON.stringify(record), "utf8");
	return dir;
}

afterEach(() => {
	while (tmpDirs.length > 0) {
		const dir = tmpDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildGovernorFactory — registration", () => {
	it("Test 1: registers tool_call and tool_result handlers on pi", () => {
		const { pi, handlers } = makeFakePi();
		const factory = buildGovernorFactory({ phaseKey: "engineer/plan", cwd: os.tmpdir() });
		factory(pi);
		expect(typeof handlers.tool_call).toBe("function");
		expect(typeof handlers.tool_result).toBe("function");
	});
});

describe("buildGovernorFactory — injected phaseKey with bare production ctx", () => {
	it("Test 2: span-clamps bash output per the injected phase's budget (no persona/phase on ctx)", () => {
		const { pi, handlers } = makeFakePi();
		buildGovernorFactory({ phaseKey: "supervisor/review-code", cwd: os.tmpdir() })(pi);
		const { ctx } = makeBareCtx();

		const policy = loadDefaultPolicyTable()["supervisor/review-code"];
		expect(policy).toBeDefined();
		const budgetChars = policy.toolBudgets["bash"] * 4;
		const oversized = "x".repeat(budgetChars + 500) + "\ntail-line";

		const result = handlers.tool_result?.(
			makeToolResultEvent("bash", oversized, { command: "node store-cli.cjs list task" }),
			ctx,
		);
		expect(result).toBeDefined();
		const text = resultText(result);
		expect(text).toContain("lines elided]");
		expect(text.length).toBeLessThan(oversized.length);
	});

	it("Test 3: schema-trims forge_store results to engineer/plan residentFields", () => {
		const { pi, handlers } = makeFakePi();
		buildGovernorFactory({ phaseKey: "engineer/plan", cwd: os.tmpdir() })(pi);
		const { ctx } = makeBareCtx();

		const record = {
			taskId: "T-1",
			status: "draft",
			title: "Sample",
			description: "Body",
			dependencies: [],
			internalNotes: "should be trimmed away",
			files: ["a.ts", "b.ts"],
		};
		const result = handlers.tool_result?.(
			makeToolResultEvent("forge_store", JSON.stringify(record), { entityId: "T-1" }),
			ctx,
		);
		expect(result).toBeDefined();
		const trimmed = JSON.parse(resultText(result)) as Record<string, unknown>;
		expect(trimmed.status).toBe("draft");
		expect(trimmed.title).toBe("Sample");
		expect(trimmed.taskId).toBe("T-1");
		expect(trimmed.internalNotes).toBeUndefined();
		expect(trimmed.files).toBeUndefined();
	});
});

describe("loadDefaultPolicyTable — real pipeline keys", () => {
	it("Test 4: ships a policy for every governed `${personaNoun}/${role}` pipeline key", () => {
		const table = loadDefaultPolicyTable();
		for (const key of GOVERNED_PIPELINE_KEYS) {
			expect(table[key], `missing policy for ${key}`).toBeDefined();
			expect(
				table[key].toolBudgets["bash"],
				`missing bash budget for ${key}`,
			).toBeGreaterThan(0);
		}
		expect(table["default"]).toBeDefined();
	});
});

describe("buildGovernorFactory — Mechanism B steer via pi.sendUserMessage", () => {
	it("Test 5: fires exactly once with deliverAs steer at the phase threshold", () => {
		const { pi, handlers, sendUserMessage } = makeFakePi();
		buildGovernorFactory({ phaseKey: "supervisor/review-code", cwd: os.tmpdir() })(pi);
		// supervisor/review-code threshold 0.75 → 160k/200k = 0.8 crosses it
		const { ctx } = makeBareCtx({ tokens: 160_000, contextWindow: 200_000 });

		handlers.tool_result?.(makeToolResultEvent("bash", "ok", { command: "ls" }, "tc-1"), ctx);
		handlers.tool_result?.(makeToolResultEvent("bash", "ok", { command: "ls" }, "tc-2"), ctx);

		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		const [message, options] = sendUserMessage.mock.calls[0] as [string, { deliverAs?: string }];
		expect(message).toContain("[Forge context governor]");
		expect(options?.deliverAs).toBe("steer");
	});
});

describe("buildGovernorFactory — Mechanism E proactive compact via ctx.compact", () => {
	it("Test 6: fires ctx.compact exactly once at the phase threshold", () => {
		const { pi, handlers } = makeFakePi();
		buildGovernorFactory({ phaseKey: "engineer/implement", cwd: os.tmpdir() })(pi);
		// engineer/implement threshold 0.8 → 170k/200k = 0.85 crosses it
		const { ctx, compact } = makeBareCtx({ tokens: 170_000, contextWindow: 200_000 });

		handlers.tool_result?.(makeToolResultEvent("bash", "ok", { command: "ls" }, "tc-1"), ctx);
		handlers.tool_result?.(makeToolResultEvent("bash", "ok", { command: "ls" }, "tc-2"), ctx);

		expect(compact).toHaveBeenCalledTimes(1);
	});
});

describe("buildGovernorFactory — Mechanism C sentinel against the store record", () => {
	it("Test 7: sheds a forge_store result when the phase summary exists in the store", () => {
		const cwd = makeStoreCwd("CART-S02-T03", {
			code_review: { objective: "already checkpointed" },
		});
		const { pi, handlers } = makeFakePi();
		buildGovernorFactory({ phaseKey: "supervisor/review-code", cwd })(pi);
		const { ctx } = makeBareCtx();

		const result = handlers.tool_result?.(
			makeToolResultEvent("forge_store", JSON.stringify({ id: "CART-S02-T03" }), {
				entityId: "CART-S02-T03",
			}),
			ctx,
		);
		expect(resultText(result)).toContain("[summarized — see");
	});

	it("Test 8: does NOT shed when the phase summary is absent", () => {
		const cwd = makeStoreCwd("CART-S02-T03"); // no summaries at all
		const { pi, handlers } = makeFakePi();
		buildGovernorFactory({ phaseKey: "supervisor/review-code", cwd })(pi);
		const { ctx } = makeBareCtx();

		const result = handlers.tool_result?.(
			makeToolResultEvent("forge_store", JSON.stringify({ taskId: "CART-S02-T03" }), {
				entityId: "CART-S02-T03",
			}),
			ctx,
		);
		expect(resultText(result)).not.toContain("[summarized — see");
	});
});

describe("buildGovernorFactory — IL7", () => {
	it("Test 9: handler never throws when ctx lacks ui/getContextUsage entirely", () => {
		const { pi, handlers } = makeFakePi();
		buildGovernorFactory({ phaseKey: "engineer/plan", cwd: os.tmpdir() })(pi);
		const hollowCtx = {} as unknown as ExtensionContext;
		expect(() =>
			handlers.tool_result?.(
				makeToolResultEvent("bash", "ok", { command: "ls" }),
				hollowCtx,
			),
		).not.toThrow();
	});
});
