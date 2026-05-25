// manifest-checker.test.ts — FORGE-S25-T16 (H-2)
//
// Unit tests for lib/manifest-checker.ts: checkMaterialization() + MaterializationCheck.
// Includes regression tests verifying the re-export chain from plan.ts,
// implement.ts, and enhance.ts (these are all consumed by bundled-base-pack-markers.test.ts).

import { describe, expect, it } from "vitest";
import { checkMaterialization as checkFromEnhance } from "../../../../src/extensions/forgecli/enhance.js";
import { checkMaterialization as checkFromImplement } from "../../../../src/extensions/forgecli/implement.js";
import {
	checkMaterialization,
	type MaterializationCheck,
} from "../../../../src/extensions/forgecli/lib/manifest-checker.js";
// Regression imports: these kickoff shims re-export checkMaterialization from lib.
// The tests below verify the re-export chains.
import { checkMaterialization as checkFromPlan } from "../../../../src/extensions/forgecli/plan.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A fully-formed workflow containing all four Pack-06 markers. */
const FULL_WORKFLOW = `---
audience: subagent
deps:
  personas: [architect]
---

# Plan Task

Read .forge/personas/architect.md before proceeding.

## Iron Laws

Always use forge_store for writes.

## Store-Write Verification

Every forge_store write MUST succeed before advancing.
`;

function makeWorkflow(opts: {
	personas?: string[];
	bodyRef?: string;
	hasIronLaws?: boolean;
	hasStoreVerification?: boolean;
	hasForgeStore?: boolean;
}): string {
	const {
		personas = ["architect"],
		bodyRef = "architect.md",
		hasIronLaws = true,
		hasStoreVerification = true,
		hasForgeStore = true,
	} = opts;
	const frontmatter =
		personas.length > 0
			? `---\naudience: subagent\ndeps:\n  personas: [${personas.join(", ")}]\n---\n\n`
			: `---\naudience: subagent\n---\n\n`;
	const body = [
		bodyRef ? `# Workflow\n\nSee ${bodyRef} persona for guidance.` : "# Workflow\n",
		hasIronLaws ? "\n## Iron Laws\n\nFollow these laws.\n" : "",
		hasStoreVerification ? "\n## Store-Write Verification\n\nValidate all writes.\n" : "",
		hasForgeStore ? "\nUse forge_store for all writes.\n" : "",
	].join("");
	return frontmatter + body;
}

// ── Unit tests ────────────────────────────────────────────────────────────────

describe("checkMaterialization (lib/manifest-checker.ts)", () => {
	it("returns ok=true and empty missing for a fully-formed workflow", () => {
		const result: MaterializationCheck = checkMaterialization("/tmp/plan_task.md", FULL_WORKFLOW);
		expect(result.ok).toBe(true);
		expect(result.missing).toEqual([]);
	});

	it("reports missing 'Store-Write Verification' when absent", () => {
		const wf = makeWorkflow({ hasStoreVerification: false });
		const result = checkMaterialization("/tmp/wf.md", wf);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("Store-Write Verification");
	});

	it("reports missing 'Iron Laws' when absent", () => {
		const wf = makeWorkflow({ hasIronLaws: false });
		const result = checkMaterialization("/tmp/wf.md", wf);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("Iron Laws");
	});

	it("reports missing 'forge_store' when absent", () => {
		const wf = makeWorkflow({ hasForgeStore: false });
		const result = checkMaterialization("/tmp/wf.md", wf);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("forge_store");
	});

	it("reports missing 'deps.personas: declaration' when no personas in frontmatter", () => {
		const wf = makeWorkflow({ personas: [] });
		const result = checkMaterialization("/tmp/wf.md", wf);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("deps.personas: declaration");
	});

	it("reports missing persona file path reference when personas declared but not referenced in body", () => {
		const wf = makeWorkflow({ personas: ["architect"], bodyRef: "" });
		const result = checkMaterialization("/tmp/wf.md", wf);
		expect(result.ok).toBe(false);
		expect(result.missing.some((m) => m.startsWith("persona file path"))).toBe(true);
	});

	it("accepts persona referenced by name token (not necessarily .md path)", () => {
		const wf = `---\naudience: subagent\ndeps:\n  personas: [engineer]\n---\n\n## Iron Laws\n\nThe engineer role is assigned here.\n\n## Store-Write Verification\n\nAll forge_store writes must succeed.\n`;
		const result = checkMaterialization("/tmp/wf.md", wf);
		expect(result.ok).toBe(true);
	});

	it("returns all missing markers when multiple are absent", () => {
		const wf = "# Bare workflow — no frontmatter, no markers.";
		const result = checkMaterialization("/tmp/wf.md", wf);
		expect(result.ok).toBe(false);
		expect(result.missing).toContain("Store-Write Verification");
		expect(result.missing).toContain("Iron Laws");
		expect(result.missing).toContain("forge_store");
		expect(result.missing).toContain("deps.personas: declaration");
	});

	it("does not throw for empty string input", () => {
		expect(() => checkMaterialization("/tmp/wf.md", "")).not.toThrow();
	});
});

// ── Regression tests ──────────────────────────────────────────────────────────

describe("checkMaterialization regression — re-export chain", () => {
	it("plan.ts re-exports checkMaterialization from lib", () => {
		expect(typeof checkFromPlan).toBe("function");
		const result = checkFromPlan("/tmp/wf.md", FULL_WORKFLOW);
		expect(result.ok).toBe(true);
	});

	it("implement.ts re-exports checkMaterialization from lib (bundled-base-pack-markers.test.ts chain)", () => {
		expect(typeof checkFromImplement).toBe("function");
		const result = checkFromImplement("/tmp/wf.md", FULL_WORKFLOW);
		expect(result.ok).toBe(true);
	});

	it("enhance.ts re-exports checkMaterialization from lib (bundled-base-pack-markers.test.ts chain)", () => {
		expect(typeof checkFromEnhance).toBe("function");
		const result = checkFromEnhance("/tmp/wf.md", FULL_WORKFLOW);
		expect(result.ok).toBe(true);
	});

	it("plan.ts, implement.ts, and lib all return identical results for the same input", () => {
		const libResult = checkMaterialization("/tmp/wf.md", FULL_WORKFLOW);
		const planResult = checkFromPlan("/tmp/wf.md", FULL_WORKFLOW);
		const implResult = checkFromImplement("/tmp/wf.md", FULL_WORKFLOW);
		expect(planResult).toEqual(libResult);
		expect(implResult).toEqual(libResult);
	});
});
