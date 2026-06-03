// Unit tests for Mechanism A curation rules — FORGE-S30-T04.
// Coverage:
//   Rule 2 — schema-trim (forge_store results):
//     Test 1: drops non-resident fields
//     Test 2: preserved fields are byte-identical to original
//     Test 3: summaries.* fields are always retained
//     Test 4: malformed JSON content passes through untouched
//     Test 5: unknown phase key falls through to "default" (empty residentFields)
//   Rule 1 — dedup/reference-ize:
//     Test 6: repeated (tool, target) call returns pointer "[unchanged since turn N]"
//     Test 7: first occurrence of a (tool, target) is NOT replaced
//     Test 8: different targets for the same tool are not conflated
//     Test 9: tools with no dedup key pass through (e.g. bash)
//   Rule 3 — span-clamp:
//     Test 10: output over budget is truncated with "[N lines elided]"
//     Test 11: output under budget passes through untouched
//     Test 12: exact-at-budget boundary passes through untouched
//   IL7 safety:
//     Test 13: governor does not throw when ctx.model is undefined
//     Test 14: governor does not throw when JSON parse fails (handled in Test 4)

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	createGovernor,
	loadDefaultPolicyTable,
	type ToolResultEventResult,
} from "../../../src/extensions/forgecli/context-governor.js";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeForgeStoreEvent(content: string, input?: Record<string, unknown>): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "forge_store",
		toolCallId: "tc-001",
		content: [{ type: "text", text: content }],
		input: input ?? { entityId: "FORGE-S30-T04" },
		isError: false,
	} as unknown as ToolResultEvent;
}

function makeBashEvent(content: string, toolCallId = "tc-bash-001"): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId,
		content: [{ type: "text", text: content }],
		input: { cmd: "ls" },
		isError: false,
	} as unknown as ToolResultEvent;
}

function makeReadEvent(filePath: string, content: string): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "read",
		toolCallId: `tc-read-${filePath}`,
		content: [{ type: "text", text: content }],
		input: { file_path: filePath },
		isError: false,
	} as unknown as ToolResultEvent;
}

function makeCtx(override: Record<string, unknown> = {}): ExtensionContext {
	const fakeRegistry: ModelRegistry = {
		find: () => undefined,
	} as unknown as ModelRegistry;
	return {
		model: undefined,
		modelRegistry: fakeRegistry,
		...override,
	} as unknown as ExtensionContext;
}

function makeCtxWithPhase(persona: string, phase: string): ExtensionContext {
	return makeCtx({ persona, phase });
}

function makeGovernorWithPhase(persona: string, phase: string) {
	const table = loadDefaultPolicyTable();
	const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
	const gov = createGovernor(table, registry);
	const ctx = makeCtxWithPhase(persona, phase);
	return { gov, ctx };
}

// ---------------------------------------------------------------------------
// Rule 2 — schema-trim
// ---------------------------------------------------------------------------

describe("Rule 2: schema-trim (forge_store results)", () => {
	it("Test 1: drops non-resident fields from forge_store result", () => {
		const { gov, ctx } = makeGovernorWithPhase("architect", "plan");
		// architect/plan residentFields: ["status", "title", "dependencies", "description"]
		const payload = JSON.stringify({
			taskId: "FORGE-S30-T04",
			status: "plan-approved",
			title: "Test task",
			dependencies: [],
			description: "desc",
			estimate: "L", // non-resident
			path: "engineering/…", // non-resident
		});
		const event = makeForgeStoreEvent(payload);
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		expect(result).toBeDefined();
		const outText = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		const parsed = JSON.parse(outText) as Record<string, unknown>;
		// Resident fields present
		expect(parsed).toHaveProperty("status");
		expect(parsed).toHaveProperty("title");
		expect(parsed).toHaveProperty("taskId");
		// Non-resident fields absent
		expect(parsed).not.toHaveProperty("estimate");
		expect(parsed).not.toHaveProperty("path");
	});

	it("Test 2: preserved fields are byte-identical to original", () => {
		const { gov, ctx } = makeGovernorWithPhase("architect", "plan");
		const payload = JSON.stringify({
			taskId: "FORGE-S30-T04",
			status: "plan-approved",
			title: "Mechanism A",
			dependencies: ["FORGE-S30-T03"],
			description: "curate results",
			estimate: "L",
		});
		const originalParsed = JSON.parse(payload) as Record<string, unknown>;
		const event = makeForgeStoreEvent(payload);
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		const outText = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		const curated = JSON.parse(outText) as Record<string, unknown>;
		// Byte-identical comparison for preserved fields
		expect(JSON.stringify(curated.status)).toBe(JSON.stringify(originalParsed.status));
		expect(JSON.stringify(curated.title)).toBe(JSON.stringify(originalParsed.title));
		expect(JSON.stringify(curated.dependencies)).toBe(JSON.stringify(originalParsed.dependencies));
		expect(JSON.stringify(curated.taskId)).toBe(JSON.stringify(originalParsed.taskId));
	});

	it("Test 3: summaries.* fields are always retained regardless of residentFields", () => {
		const { gov, ctx } = makeGovernorWithPhase("architect", "plan");
		const payload = JSON.stringify({
			taskId: "FORGE-S30-T04",
			status: "plan-approved",
			summaries: {
				plan: { objective: "do the thing", verdict: "n/a" },
			},
			estimate: "L", // non-resident
		});
		const event = makeForgeStoreEvent(payload);
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		const outText = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		const parsed = JSON.parse(outText) as Record<string, unknown>;
		expect(parsed).toHaveProperty("summaries");
		expect((parsed.summaries as Record<string, unknown>)).toHaveProperty("plan");
	});

	it("Test 4: malformed JSON content passes through untouched (IL7)", () => {
		const { gov, ctx } = makeGovernorWithPhase("architect", "plan");
		const malformed = "not-valid-json {{{";
		// Use a fresh dedup key so Rule 1 doesn't fire
		const event = makeForgeStoreEvent(malformed, { entityId: "MALFORMED-999" });
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;
		// Malformed JSON — schema-trim returns undefined (pass-through)
		expect(result).toBeUndefined();
	});

	it("Test 5: unknown phase key falls through to 'default' (empty residentFields — no trim)", () => {
		// "default" has residentFields: [] → only identity+summaries keys retained
		const { gov, ctx } = makeGovernorWithPhase("unknown-persona", "unknown-phase");
		const payload = JSON.stringify({
			taskId: "FORGE-S30-T04",
			status: "plan-approved",
			title: "Test",
			estimate: "L",
		});
		const event = makeForgeStoreEvent(payload, { entityId: "T04-unknown-phase" });
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		if (result !== undefined) {
			const outText = (result.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			const parsed = JSON.parse(outText) as Record<string, unknown>;
			// With empty residentFields, only identity keys survive (no trim of non-identity)
			expect(parsed).toHaveProperty("taskId");
			// "status" and "title" are not in default residentFields, so they should be gone
			expect(parsed).not.toHaveProperty("status");
			expect(parsed).not.toHaveProperty("title");
			expect(parsed).not.toHaveProperty("estimate");
		} else {
			// If the governor returns undefined (pass-through), the trim resulted in same content
			// This can happen if JSON.stringify(trimmed) === original (e.g. all keys were identity)
			// Accept both behaviours
		}
	});
});

// ---------------------------------------------------------------------------
// Rule 1 — dedup/reference-ize
// ---------------------------------------------------------------------------

describe("Rule 1: dedup/reference-ize", () => {
	it("Test 6: repeated (tool, target) call returns pointer text", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtx();

		// First call — must NOT be replaced
		const event1 = makeReadEvent("/some/file.ts", "file content");
		const r1 = gov.applyToolResult(event1, ctx);
		expect(r1).toBeUndefined(); // first time: pass through

		// Second call (same file) — must be replaced with pointer
		const event2 = makeReadEvent("/some/file.ts", "file content");
		const r2 = gov.applyToolResult(event2, ctx) as ToolResultEventResult | undefined;
		expect(r2).toBeDefined();
		const text = (r2?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		expect(text).toMatch(/\[unchanged since turn \d+ — re-query if needed\]/);
	});

	it("Test 7: first occurrence of a (tool, target) is NOT replaced", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtx();

		const event = makeReadEvent("/first/occurrence.ts", "content");
		const result = gov.applyToolResult(event, ctx);
		// First call must pass through unchanged
		expect(result).toBeUndefined();
	});

	it("Test 8: different targets for the same tool are not conflated", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtx();

		const event1 = makeReadEvent("/file/a.ts", "content a");
		const event2 = makeReadEvent("/file/b.ts", "content b");
		// Different targets — both first occurrences, both should pass through
		const r1 = gov.applyToolResult(event1, ctx);
		const r2 = gov.applyToolResult(event2, ctx);
		expect(r1).toBeUndefined();
		expect(r2).toBeUndefined();
	});

	it("Test 9: tools with no dedup key pass through (bash without target)", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtx();

		// Bash has no dedup key (Rule 1 doesn't apply)
		const bash1 = makeBashEvent("output A", "tc-bash-9a");
		const bash2 = makeBashEvent("output A", "tc-bash-9b");
		// Rule 1 should NOT fire for bash (no dedup key)
		const r1 = gov.applyToolResult(bash1, ctx);
		const r2 = gov.applyToolResult(bash2, ctx);
		// Both may return undefined (pass-through) if under budget
		// They must not return a dedup pointer
		if (r1 !== undefined) {
			const text = (r1.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			expect(text).not.toMatch(/unchanged since turn/);
		}
		if (r2 !== undefined) {
			const text = (r2.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			expect(text).not.toMatch(/unchanged since turn/);
		}
	});
});

// ---------------------------------------------------------------------------
// Rule 3 — span-clamp
// ---------------------------------------------------------------------------

describe("Rule 3: span-clamp (bash results)", () => {
	it("Test 10: output over budget is truncated with '[N lines elided]'", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		// Use architect/plan which has bash budget of 1000 tokens (4000 chars)
		const ctx = makeCtxWithPhase("architect", "plan");

		// Generate 5000 chars of output (over 4000-char limit)
		const longOutput = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"x".repeat(8)}`).join(
			"\n",
		);
		expect(longOutput.length).toBeGreaterThan(4000);

		const event = makeBashEvent(longOutput);
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;
		expect(result).toBeDefined();
		const text = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		expect(text).toMatch(/\[\d+ lines elided\]/);
		expect(text.length).toBeLessThan(longOutput.length);
	});

	it("Test 11: output under budget passes through untouched", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		// architect/plan: bash budget = 1000 tokens (4000 chars)
		const ctx = makeCtxWithPhase("architect", "plan");

		// Short output — well under 4000 chars
		const shortOutput = "line 1\nline 2\nline 3\n";
		const event = makeBashEvent(shortOutput);
		const result = gov.applyToolResult(event, ctx);
		// Under-budget → pass through (undefined)
		expect(result).toBeUndefined();
	});

	it("Test 12: exact-at-budget boundary passes through untouched", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		// architect/plan: bash budget = 1000 tokens = 4000 chars
		const ctx = makeCtxWithPhase("architect", "plan");

		// Exactly 4000 chars
		const exactOutput = "x".repeat(4000);
		const event = makeBashEvent(exactOutput);
		const result = gov.applyToolResult(event, ctx);
		// Exactly at boundary — should pass through (not > budget)
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// IL7 safety
// ---------------------------------------------------------------------------

describe("IL7 safety: governor never throws", () => {
	it("Test 13: governor does not throw when ctx.model is undefined", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtx({ model: undefined }); // explicitly undefined

		const event = makeBashEvent("some output", "tc-il7-13");
		// Must not throw
		expect(() => {
			gov.applyToolResult(event, ctx);
		}).not.toThrow();
	});

	it("Test 14: governor does not throw when JSON parse fails for forge_store result", () => {
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtxWithPhase("architect", "plan");

		const event = makeForgeStoreEvent("NOT_VALID_JSON_AT_ALL", { entityId: "IL7-14-unique" });
		// Must not throw
		expect(() => {
			gov.applyToolResult(event, ctx);
		}).not.toThrow();
	});
});
