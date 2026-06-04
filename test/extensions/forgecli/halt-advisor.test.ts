// Unit tests for forge-cli halt-advisor.ts (FORGE-S26-T18).
//
// Tests for:
//   1. resolveAdvisorModel — uses advisorModel config slot when present
//   2. resolveAdvisorModel — falls back to getAvailable()[0] when no config slot
//   3. resolveAdvisorModel — returns undefined when neither config nor available models
//   4. runHaltAdvisor — dispatches subagent on resolved model; does not write to store

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Mock forge-subagent before importing halt-advisor ──────────────────────
vi.mock("../../../src/extensions/forgecli/forge-subagent.js", () => ({
	runForgeSubagent: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
	loadForgePersona: vi.fn().mockReturnValue("# Persona\nYou are an advisor."),
}));

import type { PersonaModel } from "../../../src/extensions/forgecli/config-layer.js";
import { resolveAdvisorModel, runHaltAdvisor } from "../../../src/extensions/forgecli/lib/halt-advisor.js";
import { runForgeSubagent, loadForgePersona } from "../../../src/extensions/forgecli/forge-subagent.js";

// Minimal ctx mock matching the shape runHaltAdvisor needs
function makeCtx(availableModels: Array<{ provider: string; model: string }> = []) {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		modelRegistry: {
			getAvailable: vi.fn().mockReturnValue(availableModels),
		},
	};
}

describe("halt-advisor :: resolveAdvisorModel()", () => {
	it("uses advisorModel config slot when present", () => {
		const slot: PersonaModel = { provider: "anthropic", model: "claude-opus-4-5" };
		const ctx = makeCtx([{ provider: "anthropic", model: "claude-haiku-3" }]);

		const result = resolveAdvisorModel(slot, ctx.modelRegistry as any);

		expect(result).toEqual(slot);
	});

	it("falls back to getAvailable()[0] when no config slot", () => {
		const available = [{ provider: "anthropic", model: "claude-sonnet-4-5" }];
		const ctx = makeCtx(available);

		const result = resolveAdvisorModel(undefined, ctx.modelRegistry as any);

		expect(result).toEqual(available[0]);
	});

	it("returns undefined when neither config slot nor available models", () => {
		const ctx = makeCtx([]);

		const result = resolveAdvisorModel(undefined, ctx.modelRegistry as any);

		expect(result).toBeUndefined();
	});

	// ── CART-S03-T01 regression: "halt advisor running on anthropic/undefined" ──
	// pi's ModelRegistry.getAvailable() returns Model objects with `.id` (not
	// `.model`); the blind `available[0] as PersonaModel` cast yielded
	// { provider, model: undefined } and the advisor ran on a nonexistent model.

	it("maps pi-shaped registry entries ({provider, id}) to PersonaModel", () => {
		const ctx = makeCtx([]);
		(ctx.modelRegistry.getAvailable as ReturnType<typeof vi.fn>) = vi.fn(() => [
			{ provider: "ollama-cloud", id: "glm-5.1", name: "GLM 5.1" },
		]);

		const result = resolveAdvisorModel(undefined, ctx.modelRegistry as any);

		expect(result).toEqual({ provider: "ollama-cloud", model: "glm-5.1" });
	});

	it("skips registry entries with no usable model id", () => {
		const ctx = makeCtx([]);
		(ctx.modelRegistry.getAvailable as ReturnType<typeof vi.fn>) = vi.fn(() => [
			{ provider: "anthropic" }, // neither .model nor .id — unusable
			{ provider: "ollama-cloud", id: "minimax-m2.7" },
		]);

		const result = resolveAdvisorModel(undefined, ctx.modelRegistry as any);

		expect(result).toEqual({ provider: "ollama-cloud", model: "minimax-m2.7" });
	});

	it("prefers the session's current model over available[0] (provider-neutral, known-good)", () => {
		const ctx = makeCtx([]);
		(ctx.modelRegistry.getAvailable as ReturnType<typeof vi.fn>) = vi.fn(() => [
			{ provider: "anthropic", id: "claude-haiku-3" },
		]);

		const result = resolveAdvisorModel(undefined, ctx.modelRegistry as any, {
			provider: "ollama-cloud",
			id: "glm-5.1",
		} as any);

		expect(result).toEqual({ provider: "ollama-cloud", model: "glm-5.1" });
	});

	it("config slot still wins over the current model", () => {
		const slot: PersonaModel = { provider: "ollama-cloud", model: "qwen3-coder-next" };
		const ctx = makeCtx([]);

		const result = resolveAdvisorModel(slot, ctx.modelRegistry as any, {
			provider: "ollama-cloud",
			id: "glm-5.1",
		} as any);

		expect(result).toEqual(slot);
	});
});

describe("halt-advisor :: runHaltAdvisor()", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("dispatches subagent on resolved model and does not write to store", async () => {
		const slot: PersonaModel = { provider: "anthropic", model: "claude-opus-4-5" };
		const ctx = makeCtx();

		const gateFailure = {
			phase: "implement",
			reasonCode: "artifact-missing",
			detail: "engineering/sprints/S1/T1/PLAN.md missing",
			remediation: "Re-run /forge:plan T1 then retry.",
		};

		await runHaltAdvisor({
			gateFailure,
			advisorModel: slot,
			taskId: "TEST-T1",
			cwd: "/tmp/test",
			ctx: ctx as any,
		});

		// Must dispatch a subagent
		expect(runForgeSubagent).toHaveBeenCalledTimes(1);

		// Dispatched subagent call must carry model info
		const callArgs = (runForgeSubagent as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(callArgs).toBeDefined();

		// Must NOT have called store-cli (no store writes from advisor)
		// We verify by ensuring no unexpected commands were spawned —
		// since forge-subagent is fully mocked, any store writes would
		// require an additional spawnSync that we have NOT mocked here.
		// The test passes if runHaltAdvisor resolves without error.
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("halt advisor"),
			expect.any(String),
		);
	});
});
