// artifact-section-read.test.ts — forge_artifact section/outline reads.
//
// Enhancement: read a managed markdown artifact by SECTION (or get its heading
// outline) instead of fetching the whole file. Path resolution stays in the
// plugin artifact.cjs (mocked here via the runCjs override); section/outline
// extraction is layered in-process via the markdown-AST engine.

import { describe, expect, it, vi } from "vitest";

import { buildForgeArtifact } from "../../../src/extensions/forgecli/forge-artifact-tool.js";

interface ToolResult {
	content: { type: string; text: string }[];
	isError?: boolean;
}

const PLAN_MD = `# Plan

## Objective

Ship the thing.

## Approach

- step one
- step two

## Risks

Something could break.
`;

// Fake runCjs: returns PLAN_MD for read; echoes argv for everything else.
function fakeRunCjs(stdout: string) {
	return vi.fn(async () => ({ stdout, stderr: "" }));
}

function makeTool(stdout: string = PLAN_MD) {
	const run = fakeRunCjs(stdout);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const tool = buildForgeArtifact("/proj", "engineering", "/tooldir", run as any) as any;
	return { tool, run };
}

function exec(tool: unknown, params: Record<string, unknown>): Promise<ToolResult> {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return (tool as any).execute("tc", params, new AbortController().signal, () => {}, {}) as Promise<ToolResult>;
}

describe("forge_artifact — outline command", () => {
	it("returns the heading map of a markdown artifact", async () => {
		const { tool, run } = makeTool();
		const r = await exec(tool, { command: "outline", entity: "task", entityId: "X-S1-T1", artifact: "plan" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("# Plan");
		expect(r.content[0].text).toContain("## Objective");
		expect(r.content[0].text).toContain("## Approach");
		expect(r.content[0].text).toContain("## Risks");
		// outline is fetched via the plugin `read` command
		expect((run.mock.calls[0] as unknown[])[1]).toEqual(["read", "task", "X-S1-T1", "plan"]);
	});

	it("rejects outline on a JSON summary artifact", async () => {
		const { tool } = makeTool();
		const r = await exec(tool, {
			command: "outline",
			entity: "task",
			entityId: "X-S1-T1",
			artifact: "plan-summary",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("markdown artifacts only");
	});
});

describe("forge_artifact — read by section", () => {
	it("returns just the named section's source", async () => {
		const { tool } = makeTool();
		const r = await exec(tool, {
			command: "read",
			entity: "task",
			entityId: "X-S1-T1",
			artifact: "plan",
			section: "Approach",
		});
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("## Approach");
		expect(r.content[0].text).toContain("- step one");
		expect(r.content[0].text).not.toContain("## Risks");
		expect(r.content[0].text).not.toContain("Ship the thing");
	});

	it("is case-insensitive on the section heading", async () => {
		const { tool } = makeTool();
		const r = await exec(tool, {
			command: "read",
			entity: "task",
			entityId: "X-S1-T1",
			artifact: "plan",
			section: "objective",
		});
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("## Objective");
		expect(r.content[0].text).toContain("Ship the thing");
	});

	it("errors with available headings when the section is missing", async () => {
		const { tool } = makeTool();
		const r = await exec(tool, {
			command: "read",
			entity: "task",
			entityId: "X-S1-T1",
			artifact: "plan",
			section: "Nope",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("section not found");
		expect(r.content[0].text).toContain("Objective");
		expect(r.content[0].text).toContain("Approach");
	});

	it("rejects section read on a JSON summary artifact", async () => {
		const { tool } = makeTool("{}");
		const r = await exec(tool, {
			command: "read",
			entity: "task",
			entityId: "X-S1-T1",
			artifact: "plan-summary",
			section: "Objective",
		});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("markdown artifacts only");
	});

	it("falls back to whole-file read when no section is given", async () => {
		const { tool } = makeTool();
		const r = await exec(tool, { command: "read", entity: "task", entityId: "X-S1-T1", artifact: "plan" });
		expect(r.isError).toBeFalsy();
		// whole document present (objective + risks)
		expect(r.content[0].text).toContain("Objective");
		expect(r.content[0].text).toContain("Risks");
	});
});
