// Unit tests for loaders/workflow-loader.ts (FORGE-S21-T01).
//
// Conventions: tmp-dir fixtures per test via fs.mkdtempSync + afterEach
// cleanup; absolute paths only. Mirror the pattern of
// loaders/persona-skill-loader.test.ts.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	extractAudience,
	loadWorkflow,
	parseWorkflowFrontmatter,
	WorkflowLoaderError,
} from "../../../../src/extensions/forgecli/loaders/workflow-loader.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-wf-loader-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeWorkflow(name: string, content: string): string {
	const p = path.join(tmpRoot, name);
	fs.writeFileSync(p, content, "utf8");
	return p;
}

// ── parseWorkflowFrontmatter tests ────────────────────────────────────────

describe("parseWorkflowFrontmatter", () => {
	it("parses audience: orchestrator-only from frontmatter", () => {
		const md = [
			"---",
			"audience: orchestrator-only",
			"deps:",
			"  personas: [engineer]",
			"---",
			"",
			"# Workflow body",
		].join("\n");
		const fm = parseWorkflowFrontmatter(md);
		expect(fm.audience).toBe("orchestrator-only");
	});

	it("returns empty object when no frontmatter delimiter", () => {
		const md = "# Workflow body\nno frontmatter here";
		const fm = parseWorkflowFrontmatter(md);
		expect(fm).toEqual({});
	});

	it("audience is absent when key not in frontmatter", () => {
		const md = [
			"---",
			"requirements:",
			"  reasoning: Medium",
			"deps:",
			"  personas: [engineer]",
			"---",
			"# body",
		].join("\n");
		const fm = parseWorkflowFrontmatter(md);
		expect(fm.audience).toBeUndefined();
	});

	it("throws invalid_frontmatter on malformed frontmatter (unclosed array)", () => {
		const md = ["---", "invalid: [unclosed", "---", "body"].join("\n");
		// Unclosed bracket is technically still parsed as a scalar value —
		// valid YAML subset. The real malformation test is an unclosed block.
		const md2 = ["---", "audience: orchestrator-only"].join("\n"); // never closed
		expect(() => parseWorkflowFrontmatter(md2)).toThrow(WorkflowLoaderError);
		try {
			parseWorkflowFrontmatter(md2);
		} catch (e) {
			expect(e).toBeInstanceOf(WorkflowLoaderError);
			expect((e as WorkflowLoaderError).code).toBe("invalid_frontmatter");
		}
	});
});

// ── extractAudience tests ─────────────────────────────────────────────────

describe("extractAudience", () => {
	it("returns 'orchestrator-only' when frontmatter has that value", () => {
		expect(extractAudience({ audience: "orchestrator-only" })).toBe("orchestrator-only");
	});

	it("returns 'any' when audience key is absent", () => {
		expect(extractAudience({})).toBe("any");
	});

	it("returns 'subagent' for subagent audience value", () => {
		expect(extractAudience({ audience: "subagent" })).toBe("subagent");
	});
});

// ── loadWorkflow tests ────────────────────────────────────────────────────

describe("loadWorkflow", () => {
	// Test 8: audience parsed from frontmatter
	it("parses audience: orchestrator-only from workflow file", () => {
		const md = [
			"---",
			"audience: orchestrator-only",
			"deps:",
			"  personas: [engineer]",
			"---",
			"",
			"# Meta-Workflow: Enhance",
			"",
			"Store-Write Verification",
			"Iron Laws",
			"forge_store",
		].join("\n");
		const p = writeWorkflow("enhance.md", md);
		const loaded = loadWorkflow(p);
		expect(loaded.audience).toBe("orchestrator-only");
		expect(loaded.filePath).toBe(p);
		expect(loaded.rawMarkdown).toBe(md);
	});

	// Test 9: missing audience treated as "any"
	it("returns audience 'any' when audience key is absent", () => {
		const md = [
			"---",
			"requirements:",
			"  reasoning: Medium",
			"deps:",
			"  personas: [engineer]",
			"---",
			"",
			"# Workflow body",
		].join("\n");
		const p = writeWorkflow("plan_task.md", md);
		const loaded = loadWorkflow(p);
		expect(loaded.audience).toBe("any");
	});

	// Test 10: malformed frontmatter rejected
	it("throws WorkflowLoaderError(invalid_frontmatter) for unclosed frontmatter block", () => {
		const md = ["---", "audience: orchestrator-only", "# body without closing ---"].join("\n");
		const p = writeWorkflow("bad.md", md);
		expect(() => loadWorkflow(p)).toThrow(WorkflowLoaderError);
		try {
			loadWorkflow(p);
		} catch (e) {
			expect(e).toBeInstanceOf(WorkflowLoaderError);
			expect((e as WorkflowLoaderError).code).toBe("invalid_frontmatter");
		}
	});

	// Test 11: file not found
	it("throws WorkflowLoaderError(missing_file) for non-existent file", () => {
		const p = path.join(tmpRoot, "does-not-exist.md");
		expect(() => loadWorkflow(p)).toThrow(WorkflowLoaderError);
		try {
			loadWorkflow(p);
		} catch (e) {
			expect(e).toBeInstanceOf(WorkflowLoaderError);
			expect((e as WorkflowLoaderError).code).toBe("missing_file");
		}
	});
});
