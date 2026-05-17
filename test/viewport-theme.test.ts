// Unit tests for paintTailLine.
//
// We use a stub Theme that wraps each segment in a unique marker so we can
// assert which segments get which ThemeColor. This keeps the test independent
// of pi's actual ANSI emission.

import { describe, expect, it } from "vitest";

import { paintTailLine } from "../src/extensions/forgecli/viewport-theme.js";

interface StubCall {
	method: string;
	color?: string;
	text: string;
}

function makeStub(): {
	theme: any;
	calls: StubCall[];
} {
	const calls: StubCall[] = [];
	const theme = {
		fg(color: string, text: string): string {
			calls.push({ method: "fg", color, text });
			return `<${color}>${text}</${color}>`;
		},
		bold(text: string): string {
			calls.push({ method: "bold", text });
			return `<b>${text}</b>`;
		},
		italic(text: string): string {
			calls.push({ method: "italic", text });
			return `<i>${text}</i>`;
		},
	};
	return { theme, calls };
}

describe("paintTailLine", () => {
	it("returns line unchanged when theme is undefined", () => {
		const line = "[plan 12:00:00 t1 ↑1k↓0] $ bash ls";
		expect(paintTailLine(line, undefined)).toBe(line);
	});

	it("paints prefix dim and bash glyph with bashMode", () => {
		const { theme } = makeStub();
		const out = paintTailLine("[plan 12:00:00 t1 ↑1k↓0] $ bash ls -la", theme as never);
		expect(out).toContain("<dim>[plan 12:00:00 t1 ↑1k↓0]</dim>");
		expect(out).toContain("<bashMode>$</bashMode>");
		expect(out).toContain(" bash ls -la");
	});

	it("paints read glyph with accent", () => {
		const { theme } = makeStub();
		const out = paintTailLine("[plan 12:00:00 t1 ↑1k↓0] ⌕ read FINDINGS.md", theme as never);
		expect(out).toContain("<accent>⌕</accent>");
	});

	it("paints write glyph with warning", () => {
		const { theme } = makeStub();
		const out = paintTailLine("[plan 12:00:00 t1 ↑1k↓0] ✎ write plan.md", theme as never);
		expect(out).toContain("<warning>✎</warning>");
	});

	it("paints store-cli glyph with toolTitle", () => {
		const { theme } = makeStub();
		const out = paintTailLine(
			"[plan 12:00:00 t1 ↑1k↓0] ⚙ forge_store_emit task=X",
			theme as never,
		);
		expect(out).toContain("<toolTitle>⚙</toolTitle>");
	});

	it("paints success result line in success colour", () => {
		const { theme } = makeStub();
		const out = paintTailLine("[plan 12:00:00 t1 ↑1k↓0] ← bash ok 247L", theme as never);
		expect(out).toContain("<success>← bash ok 247L</success>");
	});

	it("paints failure line in error colour", () => {
		const { theme } = makeStub();
		const out = paintTailLine(
			"[plan 12:00:00 t1 ↑1k↓0] ⚠ bash failed: ENOENT",
			theme as never,
		);
		expect(out).toContain("<error>⚠ bash failed: ENOENT</error>");
	});

	it("paints risky tag in bold error", () => {
		const { theme } = makeStub();
		const out = paintTailLine("[plan 12:00:00 t1 ↑1k↓0] 🔒 $ bash rm -rf /tmp/x", theme as never);
		expect(out).toMatch(/<b><error>🔒 \$ bash rm -rf \/tmp\/x<\/error><\/b>/);
	});

	it("paints thinking line italic + thinkingText", () => {
		const { theme } = makeStub();
		const out = paintTailLine(
			"[plan 12:00:00 t1 ↑1k↓0] ✱ analysing preflight gate failure",
			theme as never,
		);
		expect(out).toMatch(/<i><thinkingText>✱ analysing preflight gate failure<\/thinkingText><\/i>/);
	});

	it("paints preview line italic + muted", () => {
		const { theme } = makeStub();
		const out = paintTailLine(
			'[plan 12:00:00 t1 ↑1k↓0] » "Now let me read..."',
			theme as never,
		);
		expect(out).toMatch(/<i><muted>» "Now let me read\.\.\."<\/muted><\/i>/);
	});

	it("paints batched line in dim", () => {
		const { theme } = makeStub();
		const out = paintTailLine(
			"[plan 12:00:00 t1 ↑1k↓0] ⇉ batched 6 tool calls in turn 9",
			theme as never,
		);
		expect(out).toMatch(/<dim>⇉ batched 6 tool calls in turn 9<\/dim>/);
	});

	it("paints phase summary bold + accent", () => {
		const { theme } = makeStub();
		const out = paintTailLine(
			"[plan 12:14:22 t91 ↑5.01M↓30k] ▣ plan: turns=91 tools=42 ↑5.01M↓30k wall=14m22s",
			theme as never,
		);
		expect(out).toMatch(/<b><accent>▣ plan:[^<]*<\/accent><\/b>/);
	});

	it("paints phase boundary line bold + accent (no prefix)", () => {
		const { theme } = makeStub();
		const out = paintTailLine("─── phase 1/7 plan begin · FORGE-S22-T03 ───", theme as never);
		expect(out).toMatch(/<b><accent>─── phase 1\/7 plan begin · FORGE-S22-T03 ───<\/accent><\/b>/);
	});

	it("leaves unknown leading glyph body uncoloured", () => {
		const { theme } = makeStub();
		const out = paintTailLine("[plan 12:00:00 t1 ↑1k↓0] @ mystery line", theme as never);
		// Prefix still dim; body returned as-is.
		expect(out).toContain("<dim>[plan 12:00:00 t1 ↑1k↓0]</dim>");
		expect(out).toContain(" @ mystery line");
	});

	it("handles missing prefix gracefully", () => {
		const { theme } = makeStub();
		const out = paintTailLine("✱ no prefix", theme as never);
		expect(out).toMatch(/<i><thinkingText>✱ no prefix<\/thinkingText><\/i>/);
	});
});
