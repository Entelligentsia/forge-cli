// migration-engine-defs.test.ts — FORGE-S25-T12 PREREQUISITE (PLAN §2.0, F-1/F-2)
//
// The refactored task.schema.json and bug.schema.json reference
// `_defs/phaseSummary.schema.json` via external $ref. The migration entry
// declares the regenerate target as bare `"schemas"`. For `/forge:update` to
// actually ship the new `_defs/` subtree, the migration engine's `schemas`
// branch must walk `bundle/.schemas/` recursively and preserve relative
// subdirectory structure under the destination `.forge/schemas/` directory.
//
// Test-first per Iron Law 2: this file must fail against HEAD (non-recursive
// resolver) before the resolver change lands.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test__ } from "../../../src/extensions/forgecli/migration-engine.js";

const { resolveCategory } = __test__;

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `migration-engine-defs-test-${crypto.randomBytes(6).toString("hex")}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

interface WriteDescriptor {
	src: string;
	dest: string;
}

describe("resolveCategory('schemas') — recursive _defs/ walk (F-1, F-2)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = tmpDir();
	});

	afterEach(() => {
		try {
			fs.rmSync(workDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	});

	function makeBundle(): { bundleRoot: string; projectRoot: string } {
		const bundleRoot = path.join(workDir, "bundle");
		const projectRoot = path.join(workDir, "project");
		fs.mkdirSync(path.join(bundleRoot, ".schemas", "_defs"), { recursive: true });
		fs.mkdirSync(path.join(projectRoot, ".forge"), { recursive: true });

		// Top-level schema
		fs.writeFileSync(
			path.join(bundleRoot, ".schemas", "task.schema.json"),
			JSON.stringify({ $id: "forge/task.schema.json" }),
		);
		// Nested _defs schema
		fs.writeFileSync(
			path.join(bundleRoot, ".schemas", "_defs", "phaseSummary.schema.json"),
			JSON.stringify({ $id: "forge/_defs/phaseSummary.schema.json" }),
		);

		return { bundleRoot, projectRoot };
	}

	it("emits a write for top-level *.schema.json under .schemas/", () => {
		const { bundleRoot, projectRoot } = makeBundle();
		const writes: WriteDescriptor[] = [];
		resolveCategory("schemas", bundleRoot, projectRoot, writes);

		const dests = writes.map((w) => w.dest);
		const expected = path.join(projectRoot, ".forge", "schemas", "task.schema.json");
		expect(dests).toContain(expected);
	});

	it("emits a write for nested _defs/*.schema.json preserving subdirectory structure", () => {
		const { bundleRoot, projectRoot } = makeBundle();
		const writes: WriteDescriptor[] = [];
		resolveCategory("schemas", bundleRoot, projectRoot, writes);

		const dests = writes.map((w) => w.dest);
		const expected = path.join(projectRoot, ".forge", "schemas", "_defs", "phaseSummary.schema.json");
		expect(dests).toContain(expected);
	});

	it("source paths for nested files point at the bundle's _defs/ subdirectory", () => {
		const { bundleRoot, projectRoot } = makeBundle();
		const writes: WriteDescriptor[] = [];
		resolveCategory("schemas", bundleRoot, projectRoot, writes);

		const nested = writes.find((w) => w.dest.endsWith(path.join("_defs", "phaseSummary.schema.json")));
		expect(nested).toBeDefined();
		expect(nested!.src).toBe(path.join(bundleRoot, ".schemas", "_defs", "phaseSummary.schema.json"));
	});

	it("filters non-.schema.json files at every depth", () => {
		const { bundleRoot, projectRoot } = makeBundle();
		// Decoy files
		fs.writeFileSync(path.join(bundleRoot, ".schemas", "README.md"), "ignore me");
		fs.writeFileSync(path.join(bundleRoot, ".schemas", "_defs", "NOTES.txt"), "ignore me");

		const writes: WriteDescriptor[] = [];
		resolveCategory("schemas", bundleRoot, projectRoot, writes);

		const dests = writes.map((w) => w.dest);
		expect(dests.every((d) => d.endsWith(".schema.json"))).toBe(true);
	});

	it("graceful no-op when .schemas/ directory is absent", () => {
		const bundleRoot = path.join(workDir, "empty-bundle");
		const projectRoot = path.join(workDir, "project");
		fs.mkdirSync(bundleRoot, { recursive: true });
		fs.mkdirSync(path.join(projectRoot, ".forge"), { recursive: true });

		const writes: WriteDescriptor[] = [];
		expect(() => resolveCategory("schemas", bundleRoot, projectRoot, writes)).not.toThrow();
		expect(writes).toHaveLength(0);
	});
});
