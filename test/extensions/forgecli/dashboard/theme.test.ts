// dashboard/theme.test.ts — Unit tests for dashboard theme helpers.
//
// Verifies IL1 (theming) and IL2 (width safety) conformance.

import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	cursor,
	nodeGlyph,
	statusLabel,
	dim,
	accent,
	accentBold,
	warn,
	bold,
	border,
	collapseIndicator,
	promptExpandIcon,
	cancelWarningGlyph,
	truncateLines,
} from "../../../../src/extensions/forgecli/dashboard/theme.js";
import type { NodeStatus } from "../../../../src/extensions/forgecli/orchestrator-tree.js";

// Mock theme: strips all ANSI codes so assertions match plain text.
const mockTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	dim: (text: string) => text,
} as unknown as Theme;

describe("dashboard/theme", () => {
	describe("cursor()", () => {
		it("returns accent-coloured arrow when selected", () => {
			expect(cursor(true, mockTheme)).toBe("❯");
		});

		it("returns space when not selected", () => {
			expect(cursor(false, mockTheme)).toBe(" ");
		});

		it("produces themed output with a real theme", () => {
			// With a real theme, cursor(true) should produce an ANSI-styled string.
			// We can't easily test ANSI output with the mock, but we verify the
			// function routes through theme.fg.
			let receivedColor = "";
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => {
					receivedColor = color;
					return text;
				},
			} as unknown as Theme;
			cursor(true, spyTheme);
			expect(receivedColor).toBe("accent");
		});
	});

	describe("nodeGlyph()", () => {
		const statuses: NodeStatus[] = [
			"completed", "running", "cancelling", "cancelled", "failed", "escalated", "pending",
		];

		it("returns a non-empty string for every status", () => {
			for (const s of statuses) {
				expect(nodeGlyph(s, mockTheme).length).toBeGreaterThan(0);
			}
		});

		it("routes through theme.fg for each status", () => {
			const colourMap: Record<string, string> = {};
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => {
					colourMap[text] = color;
					return text;
				},
			} as unknown as Theme;

			for (const s of statuses) {
				nodeGlyph(s, spyTheme);
			}

			// Verify that each glyph was routed through theme.fg with the correct colour.
			expect(colourMap["✔"]).toBe("success");
			expect(colourMap["●"]).toBe("accent");
			expect(colourMap["⏳"]).toBe("warning");
			expect(colourMap["⊘"]).toBe("muted");
			expect(colourMap["✗"]).toBe("error");
			expect(colourMap["▲"]).toBe("error");
			expect(colourMap["○"]).toBe("dim");
		});
	});

	describe("statusLabel()", () => {
		it("returns human-readable labels for all statuses", () => {
			expect(statusLabel("completed")).toBe("Completed");
			expect(statusLabel("running")).toBe("Running");
			expect(statusLabel("cancelling")).toBe("Cancelling…");
			expect(statusLabel("cancelled")).toBe("Cancelled");
			expect(statusLabel("failed")).toBe("Failed");
			expect(statusLabel("escalated")).toBe("Escalated");
			expect(statusLabel("pending")).toBe("Pending");
		});
	});

	describe("collapseIndicator()", () => {
		it("returns a themed unicode arrow", () => {
			expect(collapseIndicator(mockTheme)).toBe("▸");
		});

		it("routes through theme.fg with muted colour", () => {
			let receivedColor = "";
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => {
					receivedColor = color;
					return text;
				},
			} as unknown as Theme;
			collapseIndicator(spyTheme);
			expect(receivedColor).toBe("muted");
		});
	});

	describe("promptExpandIcon()", () => {
		it("returns ▼ when expanded", () => {
			expect(promptExpandIcon(true, mockTheme)).toBe("▼");
		});

		it("returns ▶ when collapsed", () => {
			expect(promptExpandIcon(false, mockTheme)).toBe("▶");
		});

		it("routes through theme.fg with muted colour", () => {
			let receivedColor = "";
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => {
					receivedColor = color;
					return text;
				},
			} as unknown as Theme;
			promptExpandIcon(true, spyTheme);
			expect(receivedColor).toBe("muted");
		});
	});

	describe("cancelWarningGlyph()", () => {
		it("returns a themed ⚠ glyph", () => {
			expect(cancelWarningGlyph(mockTheme)).toBe("⚠");
		});
	});

	describe("truncateLines()", () => {
		it("truncates lines that exceed the width", () => {
			const lines = ["short", "a very long line that exceeds 20 characters easily"];
			const result = truncateLines(lines, 20);
			// Strip any ANSI codes before checking visible width.
			const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
			for (const line of result) {
				expect(stripAnsi(line).length).toBeLessThanOrEqual(20);
			}
		});

		it("passes through lines that fit within width", () => {
			const lines = ["hello", "world"];
			const result = truncateLines(lines, 80);
			expect(result).toEqual(["hello", "world"]);
		});

		it("returns empty array for empty input", () => {
			expect(truncateLines([], 80)).toEqual([]);
		});
	});

	describe("inline style helpers", () => {
		it("dim() routes through theme.fg with dim colour", () => {
			let receivedColor = "";
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => { receivedColor = color; return text; },
			} as unknown as Theme;
			dim("text", spyTheme);
			expect(receivedColor).toBe("dim");
		});

		it("accent() routes through theme.fg with accent colour", () => {
			let receivedColor = "";
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => { receivedColor = color; return text; },
			} as unknown as Theme;
			accent("text", spyTheme);
			expect(receivedColor).toBe("accent");
		});

		it("warn() routes through theme.fg with warning colour", () => {
			let receivedColor = "";
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => { receivedColor = color; return text; },
			} as unknown as Theme;
			warn("text", spyTheme);
			expect(receivedColor).toBe("warning");
		});

		it("bold() routes through theme.bold", () => {
			let received = "";
			const spyTheme: Theme = {
				...mockTheme,
				bold: (text: string) => { received = text; return text; },
			} as unknown as Theme;
			bold("text", spyTheme);
			expect(received).toBe("text");
		});

		it("border() routes through theme.fg with border colour", () => {
			let receivedColor = "";
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => { receivedColor = color; return text; },
			} as unknown as Theme;
			border("│", spyTheme);
			expect(receivedColor).toBe("border");
		});

		it("accentBold() routes through theme.bold then theme.fg(accent)", () => {
			let receivedColor = "";
			let boldWasCalled = false;
			const spyTheme: Theme = {
				...mockTheme,
				fg: (color: string, text: string) => { receivedColor = color; return text; },
				bold: (text: string) => { boldWasCalled = true; return text; },
			} as unknown as Theme;
			accentBold("text", spyTheme);
			expect(receivedColor).toBe("accent");
			expect(boldWasCalled).toBe(true);
		});
	});
});