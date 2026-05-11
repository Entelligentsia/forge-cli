// Unit tests for audience-gate.ts and CallerContextStore (FORGE-S21-T01).
//
// Test isolation: CallerContextStore is a module-level singleton. Every test
// that mutates the store MUST reset it in afterEach. Failure to do so will
// cause state to bleed across tests when run in a single worker.
//
// Test #6 intentionally exercises CallerContextStore.set() to prove the gate
// fires without an explicit callerContext param.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { assertAudience, CallerContextStore } from "../../../src/extensions/forgecli/audience-gate.js";

// ── Mock ctx factory ─────────────────────────────────────────────────────

function makeCtx(): { ctx: ExtensionCommandContext; notifyCalls: Array<[string, string]> } {
	const notifyCalls: Array<[string, string]> = [];
	const ctx = {
		ui: {
			notify: vi.fn((message: string, level: string) => {
				notifyCalls.push([message, level]);
			}),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, notifyCalls };
}

// ── Reset store after each test that mutates it ───────────────────────────

afterEach(() => {
	CallerContextStore.set("orchestrator");
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe("assertAudience", () => {
	// Test 1: orchestrator caller, orchestrator-only workflow — allowed
	it("allows orchestrator caller to dispatch orchestrator-only workflow", () => {
		const { ctx, notifyCalls } = makeCtx();
		const result = assertAudience(
			{ workflowName: "test-workflow", audience: "orchestrator-only", callerContext: "orchestrator" },
			ctx,
		);
		expect(result).toBe(true);
		expect(notifyCalls).toHaveLength(0);
	});

	// Test 2: subagent caller, orchestrator-only workflow — refused
	it("refuses subagent caller from dispatching orchestrator-only workflow", () => {
		const { ctx, notifyCalls } = makeCtx();
		const result = assertAudience(
			{ workflowName: "enhance", audience: "orchestrator-only", callerContext: "subagent" },
			ctx,
		);
		expect(result).toBe(false);
		expect(notifyCalls).toHaveLength(1);
		const [message, level] = notifyCalls[0];
		expect(level).toBe("error");
		expect(message).toContain("enhance");
		expect(message).toContain("orchestrator-only");
		expect(message).toContain("subagent context");
	});

	// Test 3a: audience "any", subagent context — unrestricted
	it("allows subagent caller when audience is 'any'", () => {
		const { ctx, notifyCalls } = makeCtx();
		const result = assertAudience(
			{ workflowName: "plan_task", audience: "any", callerContext: "subagent" },
			ctx,
		);
		expect(result).toBe(true);
		expect(notifyCalls).toHaveLength(0);
	});

	// Test 3b: audience "any", orchestrator context — unrestricted
	it("allows orchestrator caller when audience is 'any'", () => {
		const { ctx, notifyCalls } = makeCtx();
		const result = assertAudience(
			{ workflowName: "plan_task", audience: "any", callerContext: "orchestrator" },
			ctx,
		);
		expect(result).toBe(true);
		expect(notifyCalls).toHaveLength(0);
	});

	// Test 4: refusal-message format pinned (AC#3 verbatim)
	it("refusal message exactly matches AC#3 prescribed format", () => {
		const { ctx, notifyCalls } = makeCtx();
		assertAudience(
			{ workflowName: "enhance", audience: "orchestrator-only", callerContext: "subagent" },
			ctx,
		);
		expect(notifyCalls[0][0]).toBe(
			"× workflow enhance is orchestrator-only; cannot run from subagent context — forge-cli internal error if you did not run it as a subagent",
		);
	});

	// Test 5: CallerContextStore defaults to "orchestrator"
	it("CallerContextStore defaults to 'orchestrator'", () => {
		// Ensure clean state (afterEach resets, but test is explicit).
		CallerContextStore.set("orchestrator");
		expect(CallerContextStore.get()).toBe("orchestrator");
	});

	// Test 6: assertAudience uses CallerContextStore when callerContext param absent
	it("uses CallerContextStore when callerContext is not provided, refusing when store says subagent", () => {
		const { ctx, notifyCalls } = makeCtx();
		CallerContextStore.set("subagent");
		// No explicit callerContext — assertAudience reads from store.
		const result = assertAudience({ workflowName: "x", audience: "orchestrator-only" }, ctx);
		expect(result).toBe(false);
		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0][1]).toBe("error");
	});

	// Test 7a: structural — enhance.ts contains assertAudience and sendKickoff
	it("enhance.ts contains assertAudience and sendKickoff (structural invariant)", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const __dirname = fileURLToPath(new URL(".", import.meta.url));
		const src = readFileSync(
			resolve(__dirname, "../../../src/extensions/forgecli/enhance.ts"),
			"utf8",
		);
		expect(src).toContain("assertAudience");
		expect(src).toContain("sendKickoff");
	});

	// Test 7b: structural — plan.ts contains assertAudience and sendKickoff
	it("plan.ts contains assertAudience and sendKickoff (structural invariant)", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const __dirname = fileURLToPath(new URL(".", import.meta.url));
		const src = readFileSync(
			resolve(__dirname, "../../../src/extensions/forgecli/plan.ts"),
			"utf8",
		);
		expect(src).toContain("assertAudience");
		expect(src).toContain("sendKickoff");
	});

	// Test 7c: structural — implement.ts contains assertAudience and sendKickoff
	it("implement.ts contains assertAudience and sendKickoff (structural invariant)", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const { fileURLToPath } = await import("node:url");
		const __dirname = fileURLToPath(new URL(".", import.meta.url));
		const src = readFileSync(
			resolve(__dirname, "../../../src/extensions/forgecli/implement.ts"),
			"utf8",
		);
		expect(src).toContain("assertAudience");
		expect(src).toContain("sendKickoff");
	});
});

describe("CallerContextStore", () => {
	it("asSubagent sets context to subagent and restores on return", () => {
		expect(CallerContextStore.get()).toBe("orchestrator");
		const inner = CallerContextStore.asSubagent(() => CallerContextStore.get());
		expect(inner).toBe("subagent");
		expect(CallerContextStore.get()).toBe("orchestrator");
	});

	it("asOrchestrator sets context to orchestrator and restores on return", () => {
		CallerContextStore.set("subagent");
		const inner = CallerContextStore.asOrchestrator(() => CallerContextStore.get());
		expect(inner).toBe("orchestrator");
		expect(CallerContextStore.get()).toBe("subagent");
	});

	it("asSubagent restores context even when fn throws", () => {
		expect(CallerContextStore.get()).toBe("orchestrator");
		expect(() =>
			CallerContextStore.asSubagent(() => {
				throw new Error("test");
			}),
		).toThrow("test");
		expect(CallerContextStore.get()).toBe("orchestrator");
	});
});
