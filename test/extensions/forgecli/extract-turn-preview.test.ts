// Unit test for extractTurnPreview — pulls the first non-empty assistant
// text from a turn_end message, collapses whitespace, truncates to 120 chars
// with ellipsis. Drives the sticky last-message status line under the
// run-task footer.

import { describe, expect, it } from "vitest";

import { extractTurnPreview } from "../../../src/extensions/forgecli/run-task.js";

describe("extractTurnPreview", () => {
	it("returns first non-empty text from an assistant message", () => {
		const out = extractTurnPreview({
			role: "assistant",
			content: [{ type: "text", text: "Now let me run the banner command." }],
		});
		expect(out).toBe("Now let me run the banner command.");
	});

	it("collapses whitespace to single spaces", () => {
		const out = extractTurnPreview({
			role: "assistant",
			content: [{ type: "text", text: "line one\n\n  line two\t\tthree" }],
		});
		expect(out).toBe("line one line two three");
	});

	it("truncates strings longer than 120 chars with ellipsis", () => {
		const long = "x".repeat(200);
		const out = extractTurnPreview({
			role: "assistant",
			content: [{ type: "text", text: long }],
		});
		expect(out.length).toBe(118); // 117 chars + ellipsis
		expect(out.endsWith("…")).toBe(true);
	});

	it("returns empty string for tool-only assistant turns", () => {
		const out = extractTurnPreview({
			role: "assistant",
			content: [{ type: "toolCall", name: "bash", arguments: {} }],
		});
		expect(out).toBe("");
	});

	it("returns empty string for non-assistant roles", () => {
		const out = extractTurnPreview({
			role: "toolResult",
			content: [{ type: "text", text: "tool output" }],
		});
		expect(out).toBe("");
	});

	it("skips empty text blocks and returns next non-empty", () => {
		const out = extractTurnPreview({
			role: "assistant",
			content: [
				{ type: "text", text: "   " },
				{ type: "text", text: "real text" },
			],
		});
		expect(out).toBe("real text");
	});

	it("returns empty for malformed input", () => {
		expect(extractTurnPreview(null)).toBe("");
		expect(extractTurnPreview(undefined)).toBe("");
		expect(extractTurnPreview("not an object")).toBe("");
		expect(extractTurnPreview({ role: "assistant" })).toBe("");
		expect(extractTurnPreview({ role: "assistant", content: "string" })).toBe("");
	});
});
