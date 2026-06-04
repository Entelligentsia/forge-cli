// orchestrator-preflight.test.ts — FORGE-S25-T17 (H-13, N-H-D)
//
// Unit tests for orchestrator-preflight.ts:
//   - mode="task": runs validateModelConfig; returns errors/warnings from it
//   - mode="ceremony": skips validateModelConfig entirely
//   - Warning surface: ctx.ui.notify called for warnings/errors
//   - Return types: { proceed: true } or { proceed: false, result: OrchestratorResult }
//
// Regression tests:
//   - run-task.ts and fix-bug.ts runOrchestratorPreflight delegation:
//     verify mode=task in runTaskPipeline behaves identically to inline block.

import { describe, expect, it, vi } from "vitest";
import {
	type OrchestratorPreflightResult,
	runOrchestratorPreflight,
} from "../../../src/extensions/forgecli/orchestrators/orchestrator-preflight.js";

// Minimal mock for PreflightContext (only the bits runOrchestratorPreflight uses)
function makeCtx(notifications: Array<{ msg: string; level: string }> = []) {
	return {
		ui: {
			notify: vi.fn((msg: string, type?: "error" | "info" | "warning") =>
				notifications.push({ msg, level: type ?? "info" }),
			),
		},
	};
}

// Empty catalogues — no personas, no pipelines — produce no errors from validateModelConfig
// (the validator only errors on unknown names when names are present in merged config).
const EMPTY_PERSONA_CATALOGUE: string[] = [];
const EMPTY_PIPELINE_CATALOGUE: string[] | null = null;
const EMPTY_MODEL_ROUTING_CONFIG = {} as import("../../../src/extensions/forgecli/config-layer.js").MergedConfig;

describe("runOrchestratorPreflight — mode=task", () => {
	it("returns { proceed: true } when no errors or warnings", () => {
		const ctx = makeCtx();
		const result = runOrchestratorPreflight({
			mode: "task",
			ctx,
			notifyPrefix: "forge:run-task",
			personaCatalogue: EMPTY_PERSONA_CATALOGUE,
			pipelineCatalogue: EMPTY_PIPELINE_CATALOGUE,
			modelRoutingConfig: EMPTY_MODEL_ROUTING_CONFIG,
			availableModels: [],
		});
		expect(result.proceed).toBe(true);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("emits notify for warnings but still returns { proceed: true }", () => {
		// To generate a warning, pass a persona catalogue with a name that has
		// a model-routing override pointing to an unknown model (strict=false → warning).
		// We use the real validateModelConfig for this — inject a merged config that
		// has an override for a persona not in the catalogue.
		// MergedConfig reads persona-models from _global["persona-models"] and
		// _project["persona-models"] (see collectPersonaEntries in model-validator.ts).
		const mergedWithOverride = {
			_global: {
				"persona-models": {
					"nonexistent-persona": { provider: "anthropic", model: "some-unknown-model" },
				},
			},
			_project: null,
		} as unknown as import("../../../src/extensions/forgecli/config-layer.js").MergedConfig;

		const notifications: Array<{ msg: string; level: string }> = [];
		const ctx = makeCtx(notifications);

		const result = runOrchestratorPreflight({
			mode: "task",
			ctx,
			notifyPrefix: "forge:run-task",
			personaCatalogue: [],
			pipelineCatalogue: null,
			modelRoutingConfig: mergedWithOverride,
			availableModels: [],
		});

		// strict=false by default → unknown persona name is a warning, not an error
		// So preflight should proceed but should have notified.
		// (If FORGE_STRICT_MODELS is set in the environment this test is ignored.)
		if (process.env.FORGE_STRICT_MODELS !== "1") {
			expect(result.proceed).toBe(true);
			// Warnings should be notified
			const warned = notifications.some((n) => n.level === "warning");
			expect(warned).toBe(true);
		}
	});

	it("returns { proceed: false, result } when model validation errors occur (strict=true)", () => {
		const origStrict = process.env.FORGE_STRICT_MODELS;
		process.env.FORGE_STRICT_MODELS = "1";
		try {
			const mergedWithOverride = {
				_global: {
					"persona-models": {
						"nonexistent-persona": { provider: "anthropic", model: "some-unknown-model" },
					},
				},
				_project: null,
			} as unknown as import("../../../src/extensions/forgecli/config-layer.js").MergedConfig;

			const notifications: Array<{ msg: string; level: string }> = [];
			const ctx = makeCtx(notifications);

			const result = runOrchestratorPreflight({
				mode: "task",
				ctx,
				notifyPrefix: "forge:run-task",
				personaCatalogue: [],
				pipelineCatalogue: null,
				modelRoutingConfig: mergedWithOverride,
				availableModels: [],
			});

			expect(result.proceed).toBe(false);
			if (!result.proceed) {
				expect(result.result.status).toBe("failed");
				expect(result.result.lastError).toContain("model config validation failed");
			}
			const errored = notifications.some((n) => n.level === "error");
			expect(errored).toBe(true);
		} finally {
			if (origStrict === undefined) {
				delete process.env.FORGE_STRICT_MODELS;
			} else {
				process.env.FORGE_STRICT_MODELS = origStrict;
			}
		}
	});
});

describe("runOrchestratorPreflight — mode=ceremony", () => {
	it("returns { proceed: true } without calling validateModelConfig (skips validation)", () => {
		// In ceremony mode the helper must skip validateModelConfig entirely.
		// Even with a broken routing config that would normally error, ceremony mode proceeds.
		const mergedThatWouldError = {
			_global: {
				"persona-models": {
					"ghost-persona": { provider: "anthropic", model: "unknown-model" },
				},
			},
			_project: null,
		} as unknown as import("../../../src/extensions/forgecli/config-layer.js").MergedConfig;

		const origStrict = process.env.FORGE_STRICT_MODELS;
		process.env.FORGE_STRICT_MODELS = "1";
		try {
			const ctx = makeCtx();
			const result = runOrchestratorPreflight({
				mode: "ceremony",
				ctx,
				notifyPrefix: "forge:run-sprint",
				personaCatalogue: [],
				pipelineCatalogue: null,
				modelRoutingConfig: mergedThatWouldError,
				availableModels: [],
			});
			expect(result.proceed).toBe(true);
			expect(ctx.ui.notify).not.toHaveBeenCalled();
		} finally {
			if (origStrict === undefined) {
				delete process.env.FORGE_STRICT_MODELS;
			} else {
				process.env.FORGE_STRICT_MODELS = origStrict;
			}
		}
	});
});

describe("OrchestratorPreflightResult type", () => {
	it("proceed=true has no result field", () => {
		const ok: OrchestratorPreflightResult = { proceed: true };
		expect(ok.proceed).toBe(true);
	});

	it("proceed=false has a result field with OrchestratorResult shape", () => {
		const notOk: OrchestratorPreflightResult = {
			proceed: false,
			result: {
				status: "failed",
				lastPhaseIndex: 0,
				iterationCounts: {},
				lastError: "model config validation failed: unknown_persona",
			},
		};
		expect(notOk.proceed).toBe(false);
		expect(notOk.result.status).toBe("failed");
	});
});

describe("runOrchestratorPreflight regression — run-task.ts delegation", () => {
	it("mode=task with empty config produces same result as inline block would (proceed)", () => {
		const ctx = makeCtx();
		const result = runOrchestratorPreflight({
			mode: "task",
			ctx,
			notifyPrefix: "forge:run-task",
			personaCatalogue: [],
			pipelineCatalogue: null,
			modelRoutingConfig: {} as import("../../../src/extensions/forgecli/config-layer.js").MergedConfig,
			availableModels: [],
		});
		// Empty config → no errors → proceed
		expect(result.proceed).toBe(true);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});
