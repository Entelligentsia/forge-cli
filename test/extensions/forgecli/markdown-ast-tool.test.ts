// markdown-ast-tool.test.ts — Unit tests for the forge_markdown native tool.
//
// Validates the structural operations (outline/section/tables/frontmatter/ast),
// relative-path resolution against projectRoot, and error paths. The mechanic
// is also exercised end-to-end against real Forge docs in the spike at
// test/poc/spike-md-ast/ (excluded from the default suite).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildForgeMarkdown } from "../../../src/extensions/forgecli/markdown-ast-tool.js";

interface ToolResult {
	content: { type: string; text: string }[];
	isError?: boolean;
}

// Tool execute() takes (toolCallId, params, signal, onProgress, ctx); tests only
// care about params, so invoke via this helper mirroring forge-tools.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function exec(def: any, params: Record<string, unknown>): Promise<ToolResult> {
	return def.execute("tc", params, new AbortController().signal, () => {}, {}) as Promise<ToolResult>;
}

const FIXTURE = `---
name: demo
metadata:
  type: project
---
# Title

Intro paragraph.

## Section A

- one
- two

## Section B

| Sprint | Status |
| --- | --- |
| S01 | done |
| S02 | active |

\`\`\`js
const x = 1;
\`\`\`
`;

let dir: string;
let mdPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-md-"));
	mdPath = path.join(dir, "doc.md");
	fs.writeFileSync(mdPath, FIXTURE);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

async function run(op: string, extra: Record<string, unknown> = {}): Promise<ToolResult> {
	const tool = buildForgeMarkdown(dir);
	return exec(tool, { operation: op, path: "doc.md", ...extra });
}

describe("forge_markdown — tool shape", () => {
	it("registers the expected name, params, and operations in the description", () => {
		const tool = buildForgeMarkdown(dir);
		expect(tool.name).toBe("forge_markdown");
		for (const op of ["outline", "ast", "section", "tables", "frontmatter"]) {
			expect(tool.description).toContain(op);
		}
	});
});

describe("forge_markdown — outline", () => {
	it("returns a heading tree with line ranges", async () => {
		const r = await run("outline");
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toContain("# Title");
		expect(text).toContain("## Section A");
		expect(text).toContain("## Section B");
		expect(text).toMatch(/\[\d+(-\d+)?\]/); // line span present
	});
});

describe("forge_markdown — section", () => {
	it("extracts the exact source of a named section", async () => {
		const r = await run("section", { heading: "Section A" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("## Section A");
		expect(r.content[0].text).toContain("- one");
		expect(r.content[0].text).not.toContain("Section B"); // bounded at next same-level heading
	});

	it("is case-insensitive on the heading", async () => {
		const r = await run("section", { heading: "section a" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("## Section A");
	});

	it("errors when heading is missing from the doc", async () => {
		const r = await run("section", { heading: "Nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("heading not found");
	});

	it("errors when the heading param is omitted", async () => {
		const r = await run("section");
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("requires `heading`");
	});
});

describe("forge_markdown — section heading tolerance (numbered headings)", () => {
	const NUMBERED = `# Doc

## 1. Objective

Do the thing.

## 4. Detailed Requirements

The details.

## 10.2 The mkdirSync regression guard

Keep it green.

## Plan

Top-level plan.

## Plan Review

Review of the plan.
`;
	async function sec(heading: string): Promise<ToolResult> {
		fs.writeFileSync(path.join(dir, "numbered.md"), NUMBERED);
		const tool = buildForgeMarkdown(dir);
		return exec(tool, { operation: "section", path: "numbered.md", heading });
	}

	it("resolves a plain title against a numbered heading ('Objective' → '1. Objective')", async () => {
		const r = await sec("Objective");
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("## 1. Objective");
		expect(r.content[0].text).toContain("Do the thing.");
		expect(r.content[0].text).not.toContain("Detailed Requirements");
	});

	it("resolves a dotted-number title ('mkdirSync regression guard' → '10.2 …')", async () => {
		const r = await sec("The mkdirSync regression guard");
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("10.2 The mkdirSync regression guard");
	});

	it("still honors an exact numbered query", async () => {
		const r = await sec("4. Detailed Requirements");
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("## 4. Detailed Requirements");
	});

	it("falls back to substring match", async () => {
		const r = await sec("Detailed");
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("Detailed Requirements");
	});

	it("prefers an exact match over a substring superstring ('Plan' → 'Plan', not 'Plan Review')", async () => {
		const r = await sec("Plan");
		expect(r.isError).toBeFalsy();
		const first = r.content[0].text.split("\n")[0];
		expect(first).toBe("## Plan");
	});

	it("still errors when nothing plausibly matches", async () => {
		const r = await sec("Nonexistent Heading");
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("heading not found");
	});
});

describe("forge_markdown — tables", () => {
	it("parses a GFM table into header + rows", async () => {
		const r = await run("tables");
		expect(r.isError).toBeFalsy();
		const tables = JSON.parse(r.content[0].text) as { header: string[]; rows: string[][] }[];
		expect(tables).toHaveLength(1);
		expect(tables[0].header).toEqual(["Sprint", "Status"]);
		expect(tables[0].rows).toEqual([
			["S01", "done"],
			["S02", "active"],
		]);
	});
});

describe("forge_markdown — frontmatter", () => {
	it("parses YAML frontmatter into an object (incl. nested)", async () => {
		const r = await run("frontmatter");
		expect(r.isError).toBeFalsy();
		const fm = JSON.parse(r.content[0].text) as { name: string; metadata: { type: string } };
		expect(fm.name).toBe("demo");
		expect(fm.metadata.type).toBe("project");
	});
});

describe("forge_markdown — ast", () => {
	it("emits a compact structural tree rooted at root", async () => {
		const r = await run("ast");
		expect(r.isError).toBeFalsy();
		const ast = JSON.parse(r.content[0].text) as { type: string; children: { type: string }[] };
		expect(ast.type).toBe("root");
		const types = ast.children.map((c) => c.type);
		expect(types).toContain("heading");
		expect(types).toContain("table");
	});
});

describe("forge_markdown — path + error handling", () => {
	it("resolves an absolute path", async () => {
		const tool = buildForgeMarkdown("/nonexistent-root");
		const r = await exec(tool, { operation: "outline", path: mdPath });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("# Title");
	});

	it("errors clearly when the file does not exist", async () => {
		const tool = buildForgeMarkdown(dir);
		const r = await exec(tool, { operation: "outline", path: "missing.md" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("file not found");
	});
});
