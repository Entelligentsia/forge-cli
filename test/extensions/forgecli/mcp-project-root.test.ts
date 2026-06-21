// mcp-project-root.test.ts — resolveProjectRoot env-validation regression.
//
// Guards the fix for the `${projectRoot}` ENOENT bug: a project-scoped
// `.mcp.json` that sets CLAUDE_PROJECT_DIR to an unexpanded template token
// must NOT be trusted as the project root (it would flow into execFile's cwd
// and surface as a misleading `spawn <node> ENOENT`). The resolver must
// validate that the value is a real directory and otherwise fall back to cwd.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectRoot } from "../../../src/extensions/forgecli/mcp/project-root.js";

describe("resolveProjectRoot", () => {
	const original = process.env["CLAUDE_PROJECT_DIR"];

	beforeEach(() => {
		delete process.env["CLAUDE_PROJECT_DIR"];
	});

	afterEach(() => {
		if (original === undefined) delete process.env["CLAUDE_PROJECT_DIR"];
		else process.env["CLAUDE_PROJECT_DIR"] = original;
	});

	it("returns CLAUDE_PROJECT_DIR when it is a real directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "forge-pr-"));
		try {
			process.env["CLAUDE_PROJECT_DIR"] = dir;
			expect(resolveProjectRoot()).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to cwd when CLAUDE_PROJECT_DIR is an unexpanded template token", () => {
		process.env["CLAUDE_PROJECT_DIR"] = "${projectRoot}";
		expect(resolveProjectRoot()).toBe(process.cwd());
	});

	it("falls back to cwd when CLAUDE_PROJECT_DIR points at a non-existent path", () => {
		process.env["CLAUDE_PROJECT_DIR"] = "/no/such/forge/project/dir";
		expect(resolveProjectRoot()).toBe(process.cwd());
	});

	it("falls back to cwd when CLAUDE_PROJECT_DIR is unset", () => {
		delete process.env["CLAUDE_PROJECT_DIR"];
		expect(resolveProjectRoot()).toBe(process.cwd());
	});
});
