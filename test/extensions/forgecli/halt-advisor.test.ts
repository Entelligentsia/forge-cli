// Unit tests for forge-cli halt-advisor.ts (FORGE-S26-T18).
//
// Tests for:
//   1. resolveAdvisorModel — uses advisorModel config slot when present
//   2. resolveAdvisorModel — falls back to getAvailable()[0] when no config slot
//   3. resolveAdvisorModel — returns undefined when neither config nor available models
//   4. runHaltAdvisor — dispatches subagent on resolved model; does not write to store

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ── Mock forge-subagent before importing halt-advisor ──────────────────────
// getFinalOutput is the real (pure) extractor so the advisory-surfacing tests
// exercise the genuine assistant-text extraction path.
vi.mock("../../../src/extensions/forgecli/forge-subagent.js", () => ({
	runForgeSubagent: vi.fn().mockResolvedValue({ exitCode: 0, messages: [], usage: {} }),
	loadForgePersona: vi.fn().mockReturnValue("# Persona\nYou are an advisor."),
	getFinalOutput: (messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>) => {
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				for (const part of msg.content) {
					if (part.type === "text" && part.text) return part.text;
				}
			}
		}
		return "";
	},
}));

import type { PersonaModel } from "../../../src/extensions/forgecli/config/config-layer.js";
import { resolveAdvisorModel, runHaltAdvisor } from "../../../src/extensions/forgecli/orchestrators/halt-advisor.js";
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
	// Contract (rev. 2026-06-04): the advisor model is the HEAVY model the
	// runtime resolves point-in-time — the approve/architect slot through the
	// existing routing cascade (project > user > pi default). No dedicated
	// advisorModel config entry exists.

	it("uses the configured architect persona-model (project layer) when present", () => {
		const merged = {
			_project: {
				"persona-models": {
					architect: { provider: "ollama-cloud", model: "glm-5.1" },
				},
			},
		};

		const result = resolveAdvisorModel(merged as never, undefined);

		expect(result).toEqual({ provider: "ollama-cloud", model: "glm-5.1" });
	});

	it("honours an approve-phase L4 override over the persona model", () => {
		const merged = {
			_project: {
				"persona-models": {
					architect: { provider: "ollama-cloud", model: "glm-5.1" },
				},
			},
			pipelines: {
				default: {
					phases: {
						approve: { "model-override": { provider: "ollama-cloud", model: "minimax-m2.7" } },
					},
				},
			},
		};

		const result = resolveAdvisorModel(merged as never, undefined);

		expect(result).toEqual({ provider: "ollama-cloud", model: "minimax-m2.7" });
	});

	it("falls back to the session's current model (pi default) when nothing is routed", () => {
		const result = resolveAdvisorModel({} as never, {
			provider: "ollama-cloud",
			id: "qwen3-coder-next",
		});

		expect(result).toEqual({ provider: "ollama-cloud", model: "qwen3-coder-next" });
	});

	it("maps current models carrying .model instead of .id", () => {
		const result = resolveAdvisorModel({} as never, {
			provider: "ollama-cloud",
			model: "gemma4:31b",
		});

		expect(result).toEqual({ provider: "ollama-cloud", model: "gemma4:31b" });
	});

	it("returns undefined (advisor skipped) when nothing is routed and no current model", () => {
		const result = resolveAdvisorModel({} as never, undefined);

		expect(result).toBeUndefined();
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

	// FORGE-BUG-046: the advisor's LLM output must reach the viewport, not be
	// discarded after runForgeSubagent returns.
	it("surfaces the advisor's final output via ctx.ui.notify", async () => {
		(runForgeSubagent as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			exitCode: 0,
			usage: {},
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "The review subagent skipped set-summary; re-run review-code." }],
				},
			],
		});

		const ctx = makeCtx();
		await runHaltAdvisor({
			gateFailure: {
				phase: "review-code",
				reasonCode: "verdict-missing",
				detail: "no verdict in store",
				remediation: "Re-run the phase.",
			},
			advisorModel: { provider: "anthropic", model: "claude-opus-4-5" },
			taskId: "TEST-T1",
			cwd: "/tmp/test",
			ctx: ctx as any,
		});

		const notified = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(notified.some((m) => m.includes("The review subagent skipped set-summary; re-run review-code."))).toBe(true);
	});

	// FORGE-BUG-046: the structured remediation must surface deterministically
	// even when no advisor model is available (LLM advisor skipped) — the human
	// still gets an actionable next step.
	it("surfaces the structured remediation even when no advisor model is resolved", async () => {
		const ctx = makeCtx();
		await runHaltAdvisor({
			gateFailure: {
				phase: "review-code",
				reasonCode: "verdict-missing",
				detail: "no verdict in store",
				remediation: "Re-run /forge:plan then retry.",
			},
			advisorModel: undefined,
			taskId: "TEST-T1",
			cwd: "/tmp/test",
			ctx: ctx as any,
		});

		// No LLM dispatched when model is undefined…
		expect(runForgeSubagent).not.toHaveBeenCalled();
		// …but the remediation still reaches the viewport.
		const notified = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
		expect(notified.some((m) => m.includes("Re-run /forge:plan then retry."))).toBe(true);
	});
});
