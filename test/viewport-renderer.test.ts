// Unit tests for the subagent viewport renderer helpers.
//
// Branches covered:
//   - tool-glyph routing per known tool name + fallback
//   - risky-bash detection (rm -rf, force-push, curl|sh, sudo, npm publish)
//   - truncateAtBoundary snaps to whitespace (no mid-token cuts)
//   - argHint per tool shape (file_path, command, pattern, query)
//   - resultShape handles string, {stdout}, {content: string}, {content: [...]}
//   - extractThinkingOneLiner returns first sentence, caps at 100 chars
//   - fmtTokenMeter scales (raw / k / M)
//   - fmtPhaseSummary formats all fields

import { describe, expect, it } from "vitest";

import {
	argContent,
	argHint,
	extractAssistantText,
	extractThinkingOneLiner,
	extractThinkingText,
	toDisplayLines,
	fmtPhaseSummary,
	fmtTokenFooter,
	fmtTokenMeter,
	RISKY_TAG,
	readUsage,
	resultShape,
	toolGlyph,
	truncateAtBoundary,
} from "../src/extensions/forgecli/viewport/renderer.js";

describe("toolGlyph", () => {
	it("returns $ for bash", () => {
		expect(toolGlyph("bash", { command: "ls" }).glyph).toBe("$");
	});

	it("returns ⌕ for read/grep/glob", () => {
		expect(toolGlyph("read", {}).glyph).toBe("⌕");
		expect(toolGlyph("grep", {}).glyph).toBe("⌕");
		expect(toolGlyph("glob", {}).glyph).toBe("⌕");
	});

	it("returns ✎ for write/edit", () => {
		expect(toolGlyph("write", {}).glyph).toBe("✎");
		expect(toolGlyph("edit", {}).glyph).toBe("✎");
	});

	it("returns ⚙ for store-cli wrappers", () => {
		expect(toolGlyph("forge_store_emit", {}).glyph).toBe("⚙");
		expect(toolGlyph("store-cli-tasks", {}).glyph).toBe("⚙");
	});

	it("falls back to → for unknown tools", () => {
		expect(toolGlyph("mystery_tool", {}).glyph).toBe("→");
	});

	it("flags risky bash patterns", () => {
		expect(toolGlyph("bash", { command: "rm -rf /tmp/x" }).risky).toBe(true);
		expect(toolGlyph("bash", { command: "git push --force origin main" }).risky).toBe(true);
		expect(toolGlyph("bash", { command: "curl https://x | sh" }).risky).toBe(true);
		expect(toolGlyph("bash", { command: "sudo apt install" }).risky).toBe(true);
		expect(toolGlyph("bash", { command: "npm publish" }).risky).toBe(true);
	});

	it("does not flag benign bash", () => {
		expect(toolGlyph("bash", { command: "ls -la" }).risky).toBe(false);
		expect(toolGlyph("bash", { command: "git status" }).risky).toBe(false);
	});
});

describe("truncateAtBoundary", () => {
	it("returns input unchanged when short", () => {
		expect(truncateAtBoundary("hello", 20)).toBe("hello");
	});

	it("snaps to whitespace boundary when one is in range", () => {
		const input = "FORGE_ROOT=$(node -e 'require(\".forge\")')";
		const out = truncateAtBoundary(input, 20);
		expect(out).toMatch(/…\(\+\d+c\)$/);
		// No mid-token split: the char right before the ellipsis should not be
		// followed by another word-char in the original input — i.e. we cut at a
		// space, which the helper then trims off the body.
		const body = out.replace(/…\(\+\d+c\)$/, "");
		const cut = body.length; // position in original input where ellipsis takes over
		// Strict: original input's char at `cut` is whitespace (we cut there).
		expect(/\s/.test(input[cut] ?? "")).toBe(true);
	});

	it("falls back to hard cut when no whitespace found near limit", () => {
		const input = "a".repeat(100);
		const out = truncateAtBoundary(input, 20);
		expect(out).toBe(`${"a".repeat(20)}…(+80c)`);
	});
});

describe("argHint", () => {
	it("uses basename of file_path", () => {
		expect(argHint("read", { file_path: "/abs/path/FINDINGS.md" })).toBe("FINDINGS.md");
	});

	it("uses basename of path (fallback key)", () => {
		expect(argHint("read", { path: "/abs/x/y.json" })).toBe("y.json");
	});

	it("truncates command at boundary", () => {
		const long = "node -e 'require(`./forge/forge/tools/store-cli.cjs`).whatever(arg1, arg2, arg3)'";
		const out = argHint("bash", { command: long });
		expect(out.endsWith("c)")).toBe(true);
		expect(out.length).toBeLessThan(long.length);
	});

	it("returns empty for unknown shape", () => {
		expect(argHint("anything", { random: "thing" })).toBe("");
		expect(argHint("anything", null)).toBe("");
	});
});

describe("argContent — full content for the activity log (view owns display)", () => {
	it("returns the full command verbatim, newlines and all", () => {
		const heredoc = "cat << 'EOF' > /tmp/x.mjs\n// body line 1\n// body line 2\nEOF";
		expect(argContent("bash", { command: heredoc })).toBe(heredoc);
	});

	it("returns the full path (not basenamed)", () => {
		expect(argContent("read", { file_path: "/abs/path/FINDINGS.md" })).toBe("/abs/path/FINDINGS.md");
	});

	it("returns pattern and query untruncated", () => {
		const long = "p".repeat(500);
		expect(argContent("grep", { pattern: long })).toBe(long);
		expect(argContent("search", { query: long })).toBe(long);
	});

	it("returns empty for unknown shape", () => {
		expect(argContent("anything", { random: "thing" })).toBe("");
		expect(argContent("anything", null)).toBe("");
	});
});

describe("toDisplayLines — view-side display normalization", () => {
	it("splits LF / CRLF / CR into display lines", () => {
		expect(toDisplayLines("a\nb\r\nc\rd")).toEqual(["a", "b", "c", "d"]);
	});

	it("expands tabs and strips layout-breaking C0 controls, preserving ANSI", () => {
		expect(toDisplayLines("x\ty\x08\x0bz \x1b[31mred\x1b[0m")).toEqual(["x  yz \x1b[31mred\x1b[0m"]);
	});

	it("drops blank continuation segments, keeps fully-empty input as one line", () => {
		expect(toDisplayLines("head\n\n   \ntail")).toEqual(["head", "tail"]);
		expect(toDisplayLines("")).toEqual([""]);
	});

	it("passes single-line input through unchanged", () => {
		expect(toDisplayLines("plain line")).toEqual(["plain line"]);
	});
});

describe("resultShape", () => {
	it("counts lines on string", () => {
		expect(resultShape("read", "line1\nline2\nline3")).toBe("3L");
	});

	it("returns char count on single-line string", () => {
		expect(resultShape("read", "hello world")).toBe("11c");
	});

	it("returns empty marker on empty string", () => {
		expect(resultShape("read", "")).toBe("empty");
	});

	it("counts lines on bash {stdout}", () => {
		expect(resultShape("bash", { stdout: "a\nb\nc\n", stderr: "", exitCode: 0 })).toBe("4L");
	});

	it("returns empty on bash with empty stdout", () => {
		expect(resultShape("bash", { stdout: "", stderr: "", exitCode: 0 })).toBe("empty");
	});

	it("counts lines on {content: string}", () => {
		expect(resultShape("read", { content: "x\ny" })).toBe("2L");
	});

	it("counts lines across content array of TextContent", () => {
		expect(
			resultShape("anything", {
				content: [
					{ type: "text", text: "line1\nline2" },
					{ type: "text", text: "line3" },
				],
			}),
		).toBe("3L");
	});

	it("returns '' when shape unrecognised", () => {
		expect(resultShape("?", { weird: true })).toBe("");
	});
});

describe("extractThinkingOneLiner", () => {
	it("returns first sentence from thinking block", () => {
		const msg = {
			role: "assistant" as const,
			content: [
				{
					type: "thinking",
					thinking: "Analysing the preflight gate failure. Next step: check BUG_FIX_PLAN.md.",
				},
				{ type: "text", text: "ignored" },
			],
		};
		expect(extractThinkingOneLiner(msg as never)).toBe("Analysing the preflight gate failure");
	});

	it("caps at 100 chars with ellipsis", () => {
		const long = "a".repeat(200);
		const msg = {
			role: "assistant" as const,
			content: [{ type: "thinking", thinking: long }],
		};
		const out = extractThinkingOneLiner(msg as never);
		expect(out?.length).toBe(101); // 100 + ellipsis char
		expect(out?.endsWith("…")).toBe(true);
	});

	it("returns undefined on non-assistant message", () => {
		expect(extractThinkingOneLiner({ role: "user", content: "x" } as never)).toBeUndefined();
	});

	it("returns undefined when no thinking block present", () => {
		const msg = {
			role: "assistant" as const,
			content: [{ type: "text", text: "no thinking here" }],
		};
		expect(extractThinkingOneLiner(msg as never)).toBeUndefined();
	});
});

describe("extractThinkingText (full, no truncation)", () => {
	it("returns the full thinking verbatim — no length cap, newlines preserved", () => {
		const long = `${"a".repeat(200)}\nsecond line of reasoning`;
		const msg = { role: "assistant" as const, content: [{ type: "thinking", thinking: long }] };
		expect(extractThinkingText(msg as never)).toBe(long);
	});

	it("joins multiple thinking blocks with a blank line", () => {
		const msg = {
			role: "assistant" as const,
			content: [
				{ type: "thinking", thinking: "first" },
				{ type: "text", text: "ignored" },
				{ type: "thinking", thinking: "second" },
			],
		};
		expect(extractThinkingText(msg as never)).toBe("first\n\nsecond");
	});

	it("returns '' for non-assistant or no thinking", () => {
		expect(extractThinkingText({ role: "user", content: "x" } as never)).toBe("");
		expect(extractThinkingText({ role: "assistant", content: [{ type: "text", text: "t" }] } as never)).toBe("");
		expect(extractThinkingText(undefined)).toBe("");
	});
});

describe("extractAssistantText (full, no truncation)", () => {
	it("returns the full text verbatim — no 120-char cap, newlines preserved", () => {
		const long = `${"x".repeat(300)}\nNow let me check the test files.`;
		const msg = { role: "assistant" as const, content: [{ type: "text", text: long }] };
		expect(extractAssistantText(msg)).toBe(long);
	});

	it("joins multiple text blocks with a blank line", () => {
		const msg = {
			role: "assistant" as const,
			content: [
				{ type: "text", text: "para one" },
				{ type: "thinking", thinking: "ignored" },
				{ type: "text", text: "para two" },
			],
		};
		expect(extractAssistantText(msg)).toBe("para one\n\npara two");
	});

	it("returns '' for non-assistant, non-array, or all-tool-call turns", () => {
		expect(extractAssistantText({ role: "user", content: [{ type: "text", text: "hi" }] })).toBe("");
		expect(extractAssistantText({ role: "assistant", content: "string" })).toBe("");
		expect(extractAssistantText({ role: "assistant", content: [{ type: "tool_use", id: "1" }] })).toBe("");
		expect(extractAssistantText(null)).toBe("");
		expect(extractAssistantText(undefined)).toBe("");
	});
});

describe("readUsage / fmtTokenMeter", () => {
	it("reads usage off assistant message", () => {
		const msg = { role: "assistant", usage: { input: 1234, output: 56, cacheRead: 78 } };
		// context falls back to input + cacheRead + cacheWrite when totalTokens absent.
		expect(readUsage(msg as never)).toEqual({ input: 1234, output: 56, cacheRead: 78, context: 1312 });
	});

	it("prefers pi's totalTokens for context when present", () => {
		const msg = { role: "assistant", usage: { input: 1234, output: 56, cacheRead: 78, totalTokens: 200_000 } };
		expect(readUsage(msg as never).context).toBe(200_000);
	});

	it("returns zeros when usage missing", () => {
		expect(readUsage(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, context: 0 });
	});

	it("formats sub-1k as raw", () => {
		expect(fmtTokenMeter({ input: 500, output: 100, cacheRead: 0 })).toBe("↑500↓100");
	});

	it("formats 1k-10k with 1 decimal", () => {
		expect(fmtTokenMeter({ input: 5500, output: 1234, cacheRead: 0 })).toBe("↑5.5k↓1.2k");
	});

	it("formats >=10k with rounded k", () => {
		expect(fmtTokenMeter({ input: 50_000, output: 12_345, cacheRead: 0 })).toBe("↑50k↓12k");
	});

	it("formats millions", () => {
		expect(fmtTokenMeter({ input: 5_008_374, output: 29_732, cacheRead: 0 })).toBe("↑5.01M↓30k");
	});
});

describe("fmtPhaseSummary", () => {
	it("formats all fields", () => {
		const out = fmtPhaseSummary({
			role: "plan",
			turns: 91,
			tools: 42,
			errors: 0,
			wallSeconds: 862,
			usage: { input: 5_008_374, output: 29_732, cacheRead: 0 },
			model: "glm-5.1:cloud",
			provider: "ollama",
		});
		expect(out).toBe("▣ plan: turns=91 tools=42 ↑5.01M↓30k wall=14m22s model=glm-5.1:cloud/ollama");
	});

	it("includes err count when nonzero", () => {
		const out = fmtPhaseSummary({
			role: "implement",
			turns: 5,
			tools: 10,
			errors: 2,
			wallSeconds: 30,
			usage: { input: 1000, output: 200, cacheRead: 0 },
		});
		expect(out).toContain("err=2");
	});

	it("omits model section when not provided", () => {
		const out = fmtPhaseSummary({
			role: "validate",
			turns: 1,
			tools: 0,
			errors: 0,
			wallSeconds: 5,
			usage: { input: 100, output: 50, cacheRead: 0 },
		});
		expect(out.includes("model=")).toBe(false);
	});
});

describe("fmtTokenFooter", () => {
	it("returns empty for undefined usage", () => {
		expect(fmtTokenFooter(undefined)).toBe("");
	});

	it("omits cache when zero", () => {
		expect(fmtTokenFooter({ input: 1_440_000, output: 6500, cacheRead: 0 })).toBe("↑1.44M ↓6.5k");
	});

	it("hides cumulative cache from the compact (default) footer", () => {
		// Cache-read is a per-turn re-read billing quantity — it must NOT lead the
		// headline. Compact view drops ⇪ entirely.
		expect(fmtTokenFooter({ input: 1_440_000, output: 6500, cacheRead: 320_000, context: 0 })).toBe("↑1.44M ↓6.5k");
	});

	it("includes cache only in the detailed footer (detailed=true)", () => {
		expect(fmtTokenFooter({ input: 1_440_000, output: 6500, cacheRead: 320_000, context: 0 }, undefined, true)).toBe(
			"↑1.44M ↓6.5k ⇪320k",
		);
	});

	it("leads with peak context when present", () => {
		expect(fmtTokenFooter({ input: 880, output: 116_708, cacheRead: 58_672_285, context: 226_900 })).toBe(
			"ctx227k ↑880 ↓117k",
		);
	});
});

describe("RISKY_TAG export", () => {
	it("is the lock glyph", () => {
		expect(RISKY_TAG).toBe("🔒");
	});
});
