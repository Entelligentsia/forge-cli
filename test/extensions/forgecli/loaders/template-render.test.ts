// Unit tests for the shared template-render helper (FORGE-S20-T03).
//
// Conventions mirror persona-skill-loader.test.ts: tmp-dir per-test fixtures
// via fs.mkdtempSync + afterEach cleanup; absolute paths only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderTemplate, TemplateRenderError } from "../../../../src/extensions/forgecli/loaders/template-render.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-tmpl-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeTemplate(contents: string, name = "tmpl.md"): string {
	const p = path.join(tmpRoot, name);
	fs.writeFileSync(p, contents, "utf8");
	return p;
}

describe("renderTemplate — happy path", () => {
	it("substitutes a single {NAME} token", () => {
		const tpl = writeTemplate("hello, {WHO}!");
		expect(renderTemplate(tpl, { WHO: "world" })).toBe("hello, world!");
	});

	it("substitutes multiple tokens including repeats and preserves order", () => {
		const tpl = writeTemplate("{A} then {B}, and {A} again.\n{B}!");
		expect(renderTemplate(tpl, { A: "first", B: "second" })).toBe("first then second, and first again.\nsecond!");
	});

	it("ignores extra vars not referenced in the template", () => {
		const tpl = writeTemplate("only {USED}");
		expect(renderTemplate(tpl, { USED: "x", UNUSED: "y" })).toBe("only x");
	});
});

describe("renderTemplate — missing var", () => {
	it("throws TemplateRenderError with code=missing_var when token absent from vars", () => {
		const tpl = writeTemplate("name is {MISSING}");
		expect(() => renderTemplate(tpl, {})).toThrow(TemplateRenderError);
		try {
			renderTemplate(tpl, {});
		} catch (err) {
			expect(err).toBeInstanceOf(TemplateRenderError);
			const e = err as TemplateRenderError;
			expect(e.code).toBe("missing_var");
			// Offending name surfaced in the message for operator debugability.
			expect(e.message).toContain("MISSING");
		}
	});

	it("does not silently render empty string for unknown token (Iron Law 7)", () => {
		const tpl = writeTemplate("[{KNOWN}][{UNKNOWN}]");
		expect(() => renderTemplate(tpl, { KNOWN: "k" })).toThrow(TemplateRenderError);
	});
});

describe("renderTemplate — escape / literal-brace edge cases", () => {
	it("passes through brace patterns that don't match the identifier grammar", () => {
		// All of these must remain literal:
		//   - `{}` empty
		//   - `{ NAME }` whitespace-padded (grammar rejects)
		//   - `{1NAME}` leading digit (grammar rejects)
		//   - `{lowercase-dashed}` dash (grammar rejects)
		const literal = "keep {} and { NAME } and {1NAME} and {lowercase-dashed}";
		const tpl = writeTemplate(literal);
		expect(renderTemplate(tpl, {})).toBe(literal);
	});

	it("renders identifier tokens but leaves adjacent non-matching braces alone", () => {
		const tpl = writeTemplate("{ NAME } -> {NAME} -> {1bad}");
		expect(renderTemplate(tpl, { NAME: "OK" })).toBe("{ NAME } -> OK -> {1bad}");
	});

	it("preserves regex-meaningful characters in values verbatim", () => {
		// `replace` callback returns the value as-is — no `$1`/`$&` expansion,
		// no backslash collapsing.
		const tpl = writeTemplate("value: {V}");
		const value = "$1 \\n $& \\\\ $`";
		expect(renderTemplate(tpl, { V: value })).toBe(`value: ${value}`);
	});
});

describe("renderTemplate — missing template file", () => {
	it("throws TemplateRenderError with code=missing_template_file for a non-existent path", () => {
		const tpl = path.join(tmpRoot, "does-not-exist.md");
		expect(() => renderTemplate(tpl, {})).toThrow(TemplateRenderError);
		try {
			renderTemplate(tpl, {});
		} catch (err) {
			expect(err).toBeInstanceOf(TemplateRenderError);
			const e = err as TemplateRenderError;
			expect(e.code).toBe("missing_template_file");
			expect(e.message).toContain(tpl);
		}
	});
});

describe("renderTemplate — invalid args", () => {
	it("rejects empty templatePath", () => {
		expect(() => renderTemplate("", {})).toThrow(TemplateRenderError);
		try {
			renderTemplate("", {});
		} catch (err) {
			const e = err as TemplateRenderError;
			expect(e.code).toBe("invalid_args");
		}
	});

	it("rejects non-string values in vars", () => {
		const tpl = writeTemplate("{X}");
		// Cast through unknown to bypass TS contract — we are testing the
		// runtime guard that protects JS callers.
		const badVars = { X: 42 } as unknown as Record<string, string>;
		expect(() => renderTemplate(tpl, badVars)).toThrow(TemplateRenderError);
		try {
			renderTemplate(tpl, badVars);
		} catch (err) {
			const e = err as TemplateRenderError;
			expect(e.code).toBe("invalid_args");
		}
	});
});
