// Unit tests for advisory-render.ts (FEAT-009 T02 — rich advisory rendering).

import { describe, expect, it } from "vitest";

import { renderAdvisoryBlock } from "../../../../src/extensions/forgecli/orchestrators/advisory-render.js";

describe("renderAdvisoryBlock()", () => {
	it("frames the block with the title in the top border", () => {
		const lines = renderAdvisoryBlock("Halt advisory — T1", "Hello world.", { width: 40 });
		expect(lines[0].startsWith("╭ Halt advisory — T1 ")).toBe(true);
		expect(lines[0].length).toBe(40);
		expect(lines[lines.length - 1]).toBe(`╰${"─".repeat(38)}╯`);
		// every framed body line is exactly `width` wide
		for (const l of lines) expect(l.length).toBe(40);
	});

	it("strips markdown heading hashes and bold/code markers", () => {
		const md = "## What happened\n\nThe **review** phase wrote no `summary`.";
		const out = renderAdvisoryBlock("T1", md, { width: 60 }).join("\n");
		expect(out).not.toContain("##");
		expect(out).not.toContain("**");
		expect(out).not.toContain("`");
		expect(out).toContain("What happened");
		expect(out).toContain("The review phase wrote no summary.");
	});

	it("normalises bullets to a glyph", () => {
		const out = renderAdvisoryBlock("T1", "- first\n- second", { width: 50 }).join("\n");
		expect(out).toContain("• first");
		expect(out).toContain("• second");
	});

	it("word-wraps long lines to the inner width", () => {
		const long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";
		const lines = renderAdvisoryBlock("T", long, { width: 30 });
		// body lines (exclude top/bottom borders) must each fit the frame
		for (const l of lines) expect(l.length).toBe(30);
		// it actually wrapped onto multiple framed rows
		expect(lines.length).toBeGreaterThan(3);
	});

	it("collapses runs of blank lines and trims leading/trailing blanks", () => {
		const md = "\n\n\nfirst\n\n\n\nsecond\n\n";
		const lines = renderAdvisoryBlock("T", md, { width: 40 });
		// first framed line should be 'first', not a blank
		expect(lines[1]).toContain("first");
		// no more than one blank framed row between paragraphs
		const blankRows = lines.filter((l) => l === `│ ${" ".repeat(36)} │`).length;
		expect(blankRows).toBeLessThanOrEqual(1);
	});

	it("clamps absurdly small widths without crashing", () => {
		const lines = renderAdvisoryBlock("T", "some text here", { width: 5 });
		expect(lines.length).toBeGreaterThan(0);
		// width clamped to the minimum (24)
		expect(lines[0].length).toBe(24);
	});
});
