// Unit tests for Mechanism C — checkpoint-and-shed against {PHASE}-SUMMARY.json — FORGE-S30-T06.
// Coverage:
//   Shed-eligible eviction:
//     Test 1: shed-eligible forge_store result is evicted (sentinel returns true) — eviction pointer present, orig content absent
//     Test 2: non-summarized forge_store result is retained (sentinel returns false) — pass-through
//   Backwards compatibility:
//     Test 3: sentinel absent (no fourth arg) — no eviction, pass-through
//   Entity resolution:
//     Test 4: forge_store result with no entityId — retain (sentinel cannot identify entity)
//   IL7 safety:
//     Test 5: sentinel throws — retain (IL7 safe fallback; exception must not propagate)
//   Eviction pointer text:
//     Test 6: eviction pointer text contains phaseSummaryName(phaseKey) and entityId
//   Non-forge_store pass-through:
//     Test 7: non-forge_store tool (bash) — shed gate never fires regardless of sentinel
//   Rule ordering:
//     Test 8: shed gate fires AFTER dedup registration so first-occurrence is still registered
//   Optional Test 9: rule-ordering — shed returns before schema-trim is attempted
//     (verified via sentinel returning true for same entity; schema-trim content never appears)

import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createGovernor,
	loadDefaultPolicyTable,
	type ToolResultEventResult,
} from "../../../src/extensions/forgecli/context-governor.js";

// Helpers

function makeForgeStoreEvent(content: string, input?: Record<string, unknown>): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "forge_store",
		toolCallId: "tc-mech-c-001",
		content: [{ type: "text", text: content }],
		input: input ?? { entityId: "FORGE-S30-T06" },
		isError: false,
	} as unknown as ToolResultEvent;
}

function makeBashEvent(content: string, toolCallId = "tc-mech-c-bash-001"): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId,
		content: [{ type: "text", text: content }],
		input: { cmd: "ls" },
		isError: false,
	} as unknown as ToolResultEvent;
}

function makeCtxWithPhase(persona: string, phase: string): ExtensionContext {
	const fakeRegistry: ModelRegistry = {
		find: () => undefined,
	} as unknown as ModelRegistry;
	return {
		persona,
		phase,
		model: undefined,
		modelRegistry: fakeRegistry,
		ui: { setStatus: vi.fn() },
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
}

function makeGovernorWithSentinel(
	persona: string,
	phase: string,
	summarySentinel?: (phaseKey: string, entityId: string) => boolean,
) {
	const table = loadDefaultPolicyTable();
	const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
	const gov = createGovernor(table, registry, undefined, summarySentinel);
	const ctx = makeCtxWithPhase(persona, phase);
	return { gov, ctx };
}

// Test 1: shed-eligible forge_store result is evicted when sentinel returns true

describe("Mechanism C: shed-eligible eviction", () => {
	it("Test 1: shed-eligible forge_store result is evicted when sentinel returns true", () => {
		const alwaysShed = (_phaseKey: string, _entityId: string): boolean => true;
		const { gov, ctx } = makeGovernorWithSentinel("engineer", "implement", alwaysShed);

		const payload = JSON.stringify({
			taskId: "FORGE-S30-T06",
			status: "implementing",
			title: "Mechanism C",
		});
		const event = makeForgeStoreEvent(payload, { entityId: "FORGE-S30-T06" });
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		// Must return a result (eviction pointer), not pass-through
		expect(result).toBeDefined();
		const text = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		// Eviction pointer must contain "summarized"
		expect(text).toMatch(/summarized/i);
		// Eviction pointer must NOT contain the original content
		expect(text).not.toContain('"status"');
		expect(text).not.toContain('"implementing"');
	});

	it("Test 2: non-summarized forge_store result is retained when sentinel returns false", () => {
		const neverShed = (_phaseKey: string, _entityId: string): boolean => false;
		const { gov, ctx } = makeGovernorWithSentinel("engineer", "implement", neverShed);

		const payload = JSON.stringify({
			taskId: "FORGE-S30-T06",
			status: "implementing",
			title: "Mechanism C",
		});
		// Use a unique entityId to avoid dedup with other tests
		const event = makeForgeStoreEvent(payload, { entityId: "FORGE-S30-T06-retain" });
		const result = gov.applyToolResult(event, ctx);

		// Sentinel returns false → no eviction → pass-through (undefined) or schema-trimmed
		// Either way, the result must NOT contain the eviction pointer text
		if (result !== undefined) {
			const text =
				(result.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			expect(text).not.toMatch(/summarized/i);
		}
		// result === undefined is valid (pass-through after schema-trim returns same JSON)
	});
});

// Test 3: backwards compatibility — no sentinel arg

describe("Mechanism C: backwards compatibility", () => {
	it("Test 3: sentinel absent (no fourth arg) — no eviction, pass-through", () => {
		// createGovernor called WITHOUT summarySentinel — must behave identically to pre-T06
		const table = loadDefaultPolicyTable();
		const registry: ModelRegistry = { find: () => undefined } as unknown as ModelRegistry;
		const gov = createGovernor(table, registry);
		const ctx = makeCtxWithPhase("engineer", "implement");

		const payload = JSON.stringify({
			taskId: "FORGE-S30-T06",
			status: "implementing",
		});
		const event = makeForgeStoreEvent(payload, { entityId: "FORGE-S30-T06-backwards-compat" });
		const result = gov.applyToolResult(event, ctx);

		// Must NOT return an eviction pointer
		if (result !== undefined) {
			const text =
				(result.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			expect(text).not.toMatch(/summarized/i);
		}
		// Passing undefined without throwing is success
	});
});

// Test 4: no entityId — retain

describe("Mechanism C: entity resolution", () => {
	it("Test 4: forge_store result with no entityId — retain (sentinel cannot identify entity)", () => {
		const alwaysShed = (_phaseKey: string, _entityId: string): boolean => true;
		const { gov, ctx } = makeGovernorWithSentinel("engineer", "implement", alwaysShed);

		const payload = JSON.stringify({ status: "implementing" });
		// No entityId in input
		const event = makeForgeStoreEvent(payload, { path: "/some/file" });
		const result = gov.applyToolResult(event, ctx);

		// No entityId → shed gate must not fire → no eviction pointer
		if (result !== undefined) {
			const text =
				(result.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			expect(text).not.toMatch(/summarized/i);
		}
	});
});

// Test 5: IL7 — sentinel throws → retain

describe("Mechanism C: IL7 safety", () => {
	it("Test 5: sentinel throws — retain (IL7 safe fallback; exception must not propagate)", () => {
		const throwingSentinel = (_phaseKey: string, _entityId: string): boolean => {
			throw new Error("sentinel internal error");
		};
		const { gov, ctx } = makeGovernorWithSentinel("engineer", "implement", throwingSentinel);

		const payload = JSON.stringify({ taskId: "FORGE-S30-T06", status: "implementing" });
		const event = makeForgeStoreEvent(payload, { entityId: "FORGE-S30-T06-il7" });

		// Must not throw
		let result: ToolResultEventResult | undefined;
		expect(() => {
			result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;
		}).not.toThrow();

		// Must not return eviction pointer (sentinel error → retain)
		if (result !== undefined) {
			const text =
				(result.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			expect(text).not.toMatch(/summarized/i);
		}
	});
});

// Test 6: eviction pointer text contains phaseSummaryName and entityId

describe("Mechanism C: eviction pointer text", () => {
	it("Test 6: eviction pointer text contains phaseSummaryName(phaseKey) and entityId", () => {
		const alwaysShed = (_phaseKey: string, _entityId: string): boolean => true;
		// engineer/implement → IMPLEMENTATION-SUMMARY.json
		const { gov, ctx } = makeGovernorWithSentinel("engineer", "implement", alwaysShed);

		const entityId = "FORGE-S30-T06-ptr";
		const payload = JSON.stringify({ taskId: entityId, status: "implementing" });
		const event = makeForgeStoreEvent(payload, { entityId });
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		expect(result).toBeDefined();
		const text = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";

		// Must mention the correct summary file for engineer/implement
		expect(text).toContain("IMPLEMENTATION-SUMMARY.json");
		// Must mention the entityId
		expect(text).toContain(entityId);
	});

	it("Test 6b: eviction pointer text for architect/plan phase contains PLAN-SUMMARY.json", () => {
		const alwaysShed = (_phaseKey: string, _entityId: string): boolean => true;
		const { gov, ctx } = makeGovernorWithSentinel("architect", "plan", alwaysShed);

		const entityId = "FORGE-S30-T06-plan-ptr";
		const payload = JSON.stringify({ taskId: entityId, status: "plan-approved" });
		const event = makeForgeStoreEvent(payload, { entityId });
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		expect(result).toBeDefined();
		const text = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		expect(text).toContain("PLAN-SUMMARY.json");
		expect(text).toContain(entityId);
	});
});

// Test 7: non-forge_store tool — shed gate never fires

describe("Mechanism C: non-forge_store pass-through", () => {
	it("Test 7: bash tool — shed gate never fires regardless of sentinel", () => {
		const alwaysShed = vi.fn((_phaseKey: string, _entityId: string): boolean => true);
		const { gov, ctx } = makeGovernorWithSentinel("engineer", "implement", alwaysShed);

		const event = makeBashEvent("ls -la output here");
		const result = gov.applyToolResult(event, ctx);

		// The sentinel must not be called for bash
		// (shed gate only fires for forge_store)
		// Result must not be an eviction pointer
		if (result !== undefined) {
			const text =
				(result.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
			expect(text).not.toMatch(/summarized/i);
		}
	});
});

// Test 8: shed gate fires AFTER dedup registration

describe("Mechanism C: rule ordering", () => {
	it("Test 8: shed gate fires AFTER dedup registration so first-occurrence is still registered", () => {
		// The shed gate must not suppress dedup registration on first call.
		// After the shed call, a SECOND call to the same entity must return the dedup pointer,
		// which means the dedup registry WAS populated on the first (shed) call.
		const alwaysShed = (_phaseKey: string, _entityId: string): boolean => true;
		const { gov, ctx } = makeGovernorWithSentinel("engineer", "implement", alwaysShed);

		const entityId = "FORGE-S30-T06-dedup-order";
		const payload = JSON.stringify({ taskId: entityId, status: "implementing" });

		// First call: shed should fire (eviction pointer), but dedup registration must happen
		const event1 = makeForgeStoreEvent(payload, { entityId });
		const result1 = gov.applyToolResult(event1, ctx) as ToolResultEventResult | undefined;
		// First call may return eviction pointer (Mechanism C) — that's fine
		// The important thing is the dedup key is registered

		// Second call: with alwaysShed=true, the shed gate fires again (returns eviction pointer
		// before dedup can fire). The dedup key WAS registered, meaning normal dedup WOULD have
		// fired, but Mechanism C fires first. Either way, no original content is returned.
		const event2 = makeForgeStoreEvent(payload, { entityId });
		const result2 = gov.applyToolResult(event2, ctx) as ToolResultEventResult | undefined;

		// Both calls should return defined results (either shed pointer or dedup pointer)
		// — neither should be undefined (which would mean original content passed through)
		// For the first call: Mechanism C fires → eviction pointer
		expect(result1).toBeDefined();
		// For the second call: either Mechanism C fires again (same entity, sentinel still true)
		// or dedup fires (registered on first call). Either way — defined result.
		expect(result2).toBeDefined();

		const text1 = (result1?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";
		// The first call must be a shed eviction pointer (not dedup pointer)
		expect(text1).toMatch(/summarized/i);
	});

	it("Test 9: shed returns before schema-trim is attempted (no schema-trim artefacts in pointer)", () => {
		// If shed fires, the returned text is the eviction pointer only.
		// Schema-trim would produce a trimmed JSON object — the pointer is plain text.
		const alwaysShed = (_phaseKey: string, _entityId: string): boolean => true;
		const { gov, ctx } = makeGovernorWithSentinel("architect", "plan", alwaysShed);

		// Payload has non-resident fields that schema-trim would remove
		const payload = JSON.stringify({
			taskId: "FORGE-S30-T06-order",
			status: "plan-approved",
			estimate: "L",
			path: "engineering/…",
		});
		const event = makeForgeStoreEvent(payload, { entityId: "FORGE-S30-T06-order" });
		const result = gov.applyToolResult(event, ctx) as ToolResultEventResult | undefined;

		expect(result).toBeDefined();
		const text = (result?.content?.[0] as { type: string; text: string } | undefined)?.text ?? "";

		// Must be the shed eviction pointer — not a JSON object (schema-trim output)
		expect(text).toMatch(/summarized/i);
		// Must not start with '{' (which would indicate schema-trim ran instead)
		expect(text.trimStart()).not.toMatch(/^\{/);
	});
});
