// prompts.test.ts — FORGE-S25-T23 (B-4)
// Smoke tests for forge-init/prompts.ts: buildPhase1PromptText, buildPhase2PromptText.

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildPhase1PromptText,
	buildPhase2PromptText,
} from "../../../../src/extensions/forgecli/forge-init/prompts.js";

const BUNDLE_ROOT = "/fake/bundle";
const PROJECT_NAME = "MyProject";
const KB_PATH = "my-engineering";

describe("buildPhase1PromptText", () => {
	it("returns a non-empty string", () => {
		const result = buildPhase1PromptText(BUNDLE_ROOT, PROJECT_NAME);
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(100);
	});

	it("includes the project name", () => {
		const result = buildPhase1PromptText(BUNDLE_ROOT, PROJECT_NAME);
		expect(result).toContain(PROJECT_NAME);
	});

	it("includes paths for all 5 discovery topics", () => {
		const result = buildPhase1PromptText(BUNDLE_ROOT, PROJECT_NAME);
		for (const topic of ["stack", "processes", "database", "routing", "testing"]) {
			expect(result).toContain(`discover-${topic}.md`);
		}
	});

	it("includes the bundleRoot in discovery file paths", () => {
		const result = buildPhase1PromptText(BUNDLE_ROOT, PROJECT_NAME);
		expect(result).toContain(path.join(BUNDLE_ROOT, ".init", "discovery"));
	});

	it("includes the manage-config.cjs tool path", () => {
		const result = buildPhase1PromptText(BUNDLE_ROOT, PROJECT_NAME);
		expect(result).toContain("manage-config.cjs");
	});

	it("includes the required config structure fields", () => {
		const result = buildPhase1PromptText(BUNDLE_ROOT, PROJECT_NAME);
		expect(result).toContain('"version"');
		expect(result).toContain('"project"');
		expect(result).toContain('"paths"');
	});
});

describe("buildPhase2PromptText", () => {
	it("returns a non-empty string", () => {
		const result = buildPhase2PromptText(BUNDLE_ROOT, KB_PATH, PROJECT_NAME);
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(100);
	});

	it("includes the project name", () => {
		const result = buildPhase2PromptText(BUNDLE_ROOT, KB_PATH, PROJECT_NAME);
		expect(result).toContain(PROJECT_NAME);
	});

	it("includes the kbPath", () => {
		const result = buildPhase2PromptText(BUNDLE_ROOT, KB_PATH, PROJECT_NAME);
		expect(result).toContain(KB_PATH);
	});

	it("includes paths for all 7 KB docs", () => {
		const result = buildPhase2PromptText(BUNDLE_ROOT, KB_PATH, PROJECT_NAME);
		for (const doc of [
			"stack",
			"processes",
			"database",
			"routing",
			"deployment",
			"entity-model",
			"stack-checklist",
		]) {
			expect(result).toContain(`${doc}.md`);
		}
	});

	it("includes the generate-kb-doc.md rulebook path", () => {
		const result = buildPhase2PromptText(BUNDLE_ROOT, KB_PATH, PROJECT_NAME);
		expect(result).toContain("generate-kb-doc.md");
	});

	it("includes MASTER_INDEX.md scaffold instruction", () => {
		const result = buildPhase2PromptText(BUNDLE_ROOT, KB_PATH, PROJECT_NAME);
		expect(result).toContain("MASTER_INDEX.md");
	});
});
