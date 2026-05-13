// Unit tests for buildProjectOrientation.
//
// Philosophy regression guard: orientation, not enforcement. The block must
// state facts about where the project lives, NOT prohibitions. See
// forge-cli#6 and forge#83.

import { describe, expect, it } from "vitest";

import { buildProjectOrientation } from "../../../src/extensions/forgecli/project-orientation.js";

describe("buildProjectOrientation", () => {
	const cwd = "/home/boni/src/forge-testbench/hello";

	it("includes the absolute project root path", () => {
		const out = buildProjectOrientation(cwd);
		expect(out).toContain(cwd);
		expect(out).toMatch(/Your project root is/);
	});

	it("points at .forge/config.json and forge_config MCP for config", () => {
		const out = buildProjectOrientation(cwd);
		expect(out).toMatch(/\.forge\/config\.json/);
		expect(out).toMatch(/forge_config/);
	});

	it("points at engineering/ as the knowledge root", () => {
		const out = buildProjectOrientation(cwd);
		expect(out).toMatch(/engineering\//);
		expect(out).toMatch(/MASTER_INDEX\.md/);
	});

	it("uses orientation language, not prohibitions", () => {
		const out = buildProjectOrientation(cwd);
		// These prior framings were withdrawn; ensure they do not creep back.
		expect(out).not.toMatch(/Do NOT/);
		expect(out).not.toMatch(/forbidden/i);
		expect(out).not.toMatch(/off-limits/i);
		expect(out).not.toMatch(/sandbox/i);
		expect(out).not.toMatch(/guardrail/i);
	});

	it("ends with a trailing newline so following content separates cleanly", () => {
		const out = buildProjectOrientation(cwd);
		expect(out.endsWith("\n")).toBe(true);
	});
});
