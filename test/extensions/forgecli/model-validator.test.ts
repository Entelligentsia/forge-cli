// Tests for the model config validator (Slice 3 — Plan 16).
//
// Coverage:
//  1. Empty merged config → no errors, no warnings
//  2. persona-models key not in catalogue, non-strict → warning, no error
//  3. persona-models key not in catalogue, strict → error
//  4. 'default' key in persona-models → always valid (reserved, not checked against catalogue)
//  5. Unauthenticated / unavailable provider, non-strict → warning, no error
//  6. Unauthenticated / unavailable provider, strict → error
//  7. pipelines.<name> not in pipelineCatalogue → always error
//  8. pipelines.<name> not in pipelineCatalogue, pipelineCatalogue null → warning (no .forge config)
//  9. phases[i].model-override string referencing unknown persona-model key → always error
// 10. phases[i].model-override inline {provider, model} unavailable, non-strict → warning
// 11. All valid: known personas + pipelines + available models → no issues
// 12. Multiple issues at once: collects all, doesn't short-circuit

import { describe, expect, it } from "vitest";
import type { MergedConfig } from "../../../src/extensions/forgecli/config-layer.js";
import { type ValidationReport, validateModelConfig } from "../../../src/extensions/forgecli/model-validator.js";

type AvailableModel = { provider: string; id: string };

const PERSONA_CATALOGUE = ["architect", "engineer", "supervisor", "scribe", "orchestrator"];
const PIPELINE_CATALOGUE = ["sprint", "hotfix"];

function available(pairs: Array<[string, string]>): AvailableModel[] {
	return pairs.map(([provider, id]) => ({ provider, id }));
}

const ALL_AVAILABLE: AvailableModel[] = available([
	["anthropic", "claude-opus-4-5"],
	["ollama", "glm-5.1:cloud"],
	["openai", "gpt-4o"],
]);

function emptyMerged(): MergedConfig {
	return { _global: null, _project: null };
}

function mergedWithPersona(key: string, provider: string, model: string): MergedConfig {
	return {
		_global: { "persona-models": { [key]: { provider, model } } },
		_project: null,
		"persona-models": { [key]: { provider, model } },
	};
}

describe("validateModelConfig", () => {
	it("1. empty config → no issues", () => {
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, emptyMerged(), ALL_AVAILABLE, false);
		expect(report.errors).toHaveLength(0);
		expect(report.warnings).toHaveLength(0);
	});

	it("2. unknown persona key, non-strict → warning", () => {
		const merged = mergedWithPersona("typo-persona", "anthropic", "claude-opus-4-5");
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, false);
		expect(report.errors).toHaveLength(0);
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0].code).toBe("UNKNOWN_PERSONA");
		expect(report.warnings[0].message).toContain("typo-persona");
	});

	it("3. unknown persona key, strict → error", () => {
		const merged = mergedWithPersona("typo-persona", "anthropic", "claude-opus-4-5");
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, true);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0].code).toBe("UNKNOWN_PERSONA");
		expect(report.warnings).toHaveLength(0);
	});

	it("4. 'default' key is always valid (reserved, not checked against catalogue)", () => {
		const merged = mergedWithPersona("default", "anthropic", "claude-opus-4-5");
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, true);
		expect(report.errors).toHaveLength(0);
		expect(report.warnings).toHaveLength(0);
	});

	it("5. unavailable provider, non-strict → warning", () => {
		const merged = mergedWithPersona("engineer", "ollama", "not-installed");
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, false);
		expect(report.errors).toHaveLength(0);
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0].code).toBe("MODEL_UNAVAILABLE");
		expect(report.warnings[0].message).toContain("ollama:not-installed");
	});

	it("6. unavailable provider, strict → error", () => {
		const merged = mergedWithPersona("engineer", "ollama", "not-installed");
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, true);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0].code).toBe("MODEL_UNAVAILABLE");
		expect(report.warnings).toHaveLength(0);
	});

	it("7. pipelines.<name> not in catalogue → always error", () => {
		const merged: MergedConfig = {
			_global: null,
			_project: { pipelines: { "unknown-pipeline": {} } },
			pipelines: { "unknown-pipeline": {} },
		};
		const report = validateModelConfig(
			PERSONA_CATALOGUE,
			PIPELINE_CATALOGUE,
			merged,
			ALL_AVAILABLE,
			false, // non-strict — pipeline unknown is still an error
		);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0].code).toBe("UNKNOWN_PIPELINE");
		expect(report.errors[0].message).toContain("unknown-pipeline");
	});

	it("8. pipelines.<name> unknown with null catalogue → warning (no .forge config)", () => {
		const merged: MergedConfig = {
			_global: null,
			_project: { pipelines: { "any-pipeline": {} } },
			pipelines: { "any-pipeline": {} },
		};
		const report = validateModelConfig(
			PERSONA_CATALOGUE,
			null, // no pipeline catalogue available
			merged,
			ALL_AVAILABLE,
			false,
		);
		expect(report.errors).toHaveLength(0);
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0].code).toBe("UNKNOWN_PIPELINE");
	});

	it("9. phases[i].model-override string referencing unknown persona-model key → always error", () => {
		const merged: MergedConfig = {
			_global: null,
			_project: {
				pipelines: {
					sprint: {
						phases: { plan: { "model-override": "nonexistent-key" } },
					},
				},
			},
			pipelines: {
				sprint: {
					phases: { plan: { "model-override": "nonexistent-key" } },
				},
			},
		};
		const report = validateModelConfig(
			PERSONA_CATALOGUE,
			PIPELINE_CATALOGUE,
			merged,
			ALL_AVAILABLE,
			false, // non-strict — unresolvable override is still an error
		);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0].code).toBe("UNRESOLVABLE_OVERRIDE");
		expect(report.errors[0].message).toContain("nonexistent-key");
	});

	it("10. phases[i].model-override inline object, model unavailable, non-strict → warning", () => {
		const merged: MergedConfig = {
			_global: null,
			_project: {
				pipelines: {
					sprint: {
						phases: {
							plan: { "model-override": { provider: "ollama", model: "missing-model" } },
						},
					},
				},
			},
			pipelines: {
				sprint: {
					phases: {
						plan: { "model-override": { provider: "ollama", model: "missing-model" } },
					},
				},
			},
		};
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, false);
		expect(report.errors).toHaveLength(0);
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0].code).toBe("MODEL_UNAVAILABLE");
		expect(report.warnings[0].message).toContain("ollama:missing-model");
	});

	it("11. all valid → no issues", () => {
		const merged: MergedConfig = {
			_global: { "persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } } },
			_project: {
				"persona-models": { supervisor: { provider: "openai", model: "gpt-4o" } },
				pipelines: {
					sprint: {
						"persona-models": { scribe: { provider: "ollama", model: "glm-5.1:cloud" } },
						phases: { plan: { "model-override": { provider: "anthropic", model: "claude-opus-4-5" } } },
					},
				},
			},
			"persona-models": {
				engineer: { provider: "anthropic", model: "claude-opus-4-5" },
				supervisor: { provider: "openai", model: "gpt-4o" },
			},
			pipelines: {
				sprint: {
					"persona-models": { scribe: { provider: "ollama", model: "glm-5.1:cloud" } },
					phases: { plan: { "model-override": { provider: "anthropic", model: "claude-opus-4-5" } } },
				},
			},
		};
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, true);
		expect(report.errors).toHaveLength(0);
		expect(report.warnings).toHaveLength(0);
	});

	it("12. multiple issues collected without short-circuit", () => {
		const merged: MergedConfig = {
			_global: {
				"persona-models": {
					"bad-persona": { provider: "ollama", model: "not-installed" },
					engineer: { provider: "anthropic", model: "claude-opus-4-5" },
				},
			},
			_project: {
				pipelines: {
					"bad-pipeline": {},
				},
			},
			"persona-models": {
				"bad-persona": { provider: "ollama", model: "not-installed" },
				engineer: { provider: "anthropic", model: "claude-opus-4-5" },
			},
			pipelines: { "bad-pipeline": {} },
		};
		const report = validateModelConfig(PERSONA_CATALOGUE, PIPELINE_CATALOGUE, merged, ALL_AVAILABLE, false);
		// bad-persona → UNKNOWN_PERSONA warning
		// not-installed → MODEL_UNAVAILABLE warning
		// bad-pipeline → UNKNOWN_PIPELINE error
		expect(report.errors.length).toBeGreaterThanOrEqual(1);
		expect(report.warnings.length).toBeGreaterThanOrEqual(2);
		const codes = [...report.errors.map((e) => e.code), ...report.warnings.map((w) => w.code)];
		expect(codes).toContain("UNKNOWN_PERSONA");
		expect(codes).toContain("MODEL_UNAVAILABLE");
		expect(codes).toContain("UNKNOWN_PIPELINE");
	});
});
