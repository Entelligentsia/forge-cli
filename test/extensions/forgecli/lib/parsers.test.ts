// Unit tests for lib/parsers.ts — parseFrontmatterBlock (FORGE-S25-T19).
//
// These tests verify the shared frontmatter parser extracted from
// persona-skill-loader.ts (flat) and workflow-loader.ts (nested).
// AC#3: at least one test that would fail without the parseFrontmatterBlock
// extraction (tests import the shared export directly, not the loaders).

import { describe, expect, it } from "vitest";
import { parseFrontmatterBlock, FrontmatterParseError } from "../../../../src/extensions/forgecli/lib/parsers.js";

// ── Flat parsing (allowNesting: false) ─────────────────────────────────────

describe("parseFrontmatterBlock — flat (allowNesting: false)", () => {
	it("parses simple key:value frontmatter", () => {
		const content = `---
name: engineer
role: implementer
---
# Body text
`;
		const { frontmatter, body } = parseFrontmatterBlock(content, { allowNesting: false });
		expect(frontmatter).toEqual({ name: "engineer", role: "implementer" });
		expect(body).toContain("# Body text");
	});

	it("returns empty frontmatter when content does not start with ---", () => {
		const content = "no frontmatter here\n";
		const { frontmatter, body } = parseFrontmatterBlock(content, { allowNesting: false });
		expect(frontmatter).toEqual({});
		expect(body).toBe(content);
	});

	it("strips surrounding quotes from values", () => {
		const content = `---
quoted: "hello world"
single: 'value'
---
`;
		const { frontmatter } = parseFrontmatterBlock(content, { allowNesting: false });
		expect(frontmatter.quoted).toBe("hello world");
		expect(frontmatter.single).toBe("value");
	});

	it("handles blank lines inside frontmatter", () => {
		const content = `---
name: test

role: qa
---
body
`;
		const { frontmatter } = parseFrontmatterBlock(content, { allowNesting: false });
		expect(frontmatter.name).toBe("test");
		expect(frontmatter.role).toBe("qa");
	});

	it("handles CRLF line endings", () => {
		const content = "---\r\nname: engineer\r\nrole: coder\r\n---\r\nbody\r\n";
		const { frontmatter } = parseFrontmatterBlock(content, { allowNesting: false });
		expect(frontmatter.name).toBe("engineer");
		expect(frontmatter.role).toBe("coder");
	});

	it("throws FrontmatterParseError for unclosed frontmatter block", () => {
		const content = "---\nname: test\n";
		expect(() => parseFrontmatterBlock(content, { allowNesting: false })).toThrowError(FrontmatterParseError);
		expect(() => parseFrontmatterBlock(content, { allowNesting: false })).toThrow(
			"Frontmatter block opened with `---` but never closed",
		);
	});

	it("throws FrontmatterParseError for malformed frontmatter line", () => {
		const content = "---\nnot: a: valid: line\n---\n";
		// "not: a: valid: line" matches key "not" value "a: valid: line" — actually valid
		// Use a truly invalid line:
		const content2 = "---\n!badkey: value\n---\n";
		expect(() => parseFrontmatterBlock(content2, { allowNesting: false })).toThrowError(FrontmatterParseError);
	});

	it("returns body as the content after closing ---", () => {
		const content = `---
key: val
---
Line 1
Line 2
`;
		const { body } = parseFrontmatterBlock(content, { allowNesting: false });
		expect(body).toBe("Line 1\nLine 2\n");
	});
});

// ── Nested parsing (allowNesting: true) ────────────────────────────────────

describe("parseFrontmatterBlock — nested (allowNesting: true)", () => {
	it("parses top-level key:value pairs", () => {
		const content = `---
audience: subagent
phase: implement
---
body
`;
		const { frontmatter } = parseFrontmatterBlock(content, { allowNesting: true });
		expect(frontmatter.audience).toBe("subagent");
		expect(frontmatter.phase).toBe("implement");
	});

	it("parses nested (indented) block children", () => {
		const content = `---
deps:
  personas: [engineer, supervisor]
  skills: [engineer]
---
`;
		const { frontmatter } = parseFrontmatterBlock(content, { allowNesting: true });
		expect(frontmatter.deps).toEqual({
			personas: ["engineer", "supervisor"],
			skills: ["engineer"],
		});
	});

	it("parses inline arrays in nested children", () => {
		const content = `---
requirements:
  reasoning: High
  speed: Low
---
`;
		const { frontmatter } = parseFrontmatterBlock(content, { allowNesting: true });
		expect((frontmatter.requirements as Record<string, unknown>).reasoning).toBe("High");
		expect((frontmatter.requirements as Record<string, unknown>).speed).toBe("Low");
	});

	it("returns empty frontmatter when content does not start with ---", () => {
		const { frontmatter, body } = parseFrontmatterBlock("no frontmatter", { allowNesting: true });
		expect(frontmatter).toEqual({});
		expect(body).toBe("no frontmatter");
	});

	it("handles CRLF line endings in nested mode", () => {
		const content = "---\r\naudience: subagent\r\n---\r\nbody\r\n";
		const { frontmatter } = parseFrontmatterBlock(content, { allowNesting: true });
		expect(frontmatter.audience).toBe("subagent");
	});

	it("throws FrontmatterParseError for unclosed block in nested mode", () => {
		const content = "---\naudience: subagent\n";
		expect(() => parseFrontmatterBlock(content, { allowNesting: true })).toThrowError(FrontmatterParseError);
		expect(() => parseFrontmatterBlock(content, { allowNesting: true })).toThrow(
			"Frontmatter block opened with `---` but never closed",
		);
	});

	it("throws FrontmatterParseError for indented line with no parent block", () => {
		const content = "---\n  orphan: value\n---\n";
		expect(() => parseFrontmatterBlock(content, { allowNesting: true })).toThrowError(FrontmatterParseError);
		expect(() => parseFrontmatterBlock(content, { allowNesting: true })).toThrow(
			"Indented frontmatter line",
		);
	});

	it("returns body content after closing --- in nested mode", () => {
		const content = `---
audience: any
---
# Workflow title
`;
		const { body } = parseFrontmatterBlock(content, { allowNesting: true });
		expect(body).toContain("# Workflow title");
	});
});
