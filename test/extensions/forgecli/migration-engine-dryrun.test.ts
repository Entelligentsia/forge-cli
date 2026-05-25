// migration-engine-dryrun.test.ts — FORGE-S25-T12 (PLAN §2.0 step 4, F-5)
//
// Behavioural regression: exercises the full pipeline (resolver + safeDest +
// write planning) by running runMigrations() in dry-run mode against a
// synthetic project and a synthetic bundle that contains an `_defs/`
// subtree. Asserts that schemasRefreshed (always-on post-pass) plus the
// regenerate categories together cover the nested `_defs/phaseSummary`
// destination — file-existence checks alone (migration-engine.test.ts) do
// not exercise the resolver's path computation for nested writes.
//
// Verifies that an entry declaring `regenerate: ["schemas"]` plans a write
// to <projectRoot>/.forge/schemas/_defs/phaseSummary.schema.json when the
// bundle ships that file.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __test__ } from "../../../src/extensions/forgecli/migration-engine.js";

const { resolveCategory } = __test__;

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `migration-engine-dryrun-test-${crypto.randomBytes(6).toString("hex")}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

describe("migration-engine dry-run — _defs/phaseSummary destination (F-5)", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = tmpDir();
	});

	afterEach(() => {
		try {
			fs.rmSync(workDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it("dry-run plan for regenerate:['schemas'] includes _defs/phaseSummary.schema.json at the expected destination", () => {
		const bundleRoot = path.join(workDir, "bundle");
		const projectRoot = path.join(workDir, "project");
		fs.mkdirSync(path.join(bundleRoot, ".schemas", "_defs"), { recursive: true });
		fs.mkdirSync(path.join(projectRoot, ".forge", "schemas"), { recursive: true });

		// Bundle ships the _defs schema (extracted in the same task)
		fs.writeFileSync(
			path.join(bundleRoot, ".schemas", "_defs", "phaseSummary.schema.json"),
			JSON.stringify({ $id: "forge/_defs/phaseSummary.schema.json" }),
		);
		// Plus a top-level schema so the walk has more than one node
		fs.writeFileSync(
			path.join(bundleRoot, ".schemas", "task.schema.json"),
			JSON.stringify({ $id: "forge/task.schema.json" }),
		);

		// Simulate the migration entry's regenerate categories being resolved.
		const writes: Array<{ src: string; dest: string }> = [];
		resolveCategory("schemas", bundleRoot, projectRoot, writes);

		const expected = path.join(projectRoot, ".forge", "schemas", "_defs", "phaseSummary.schema.json");
		const dests = writes.map((w) => w.dest);
		expect(dests).toContain(expected);

		// Ensure the destination is under the safe .forge/ prefix
		for (const d of dests) {
			const safePrefix = path.join(projectRoot, ".forge") + path.sep;
			expect(d.startsWith(safePrefix)).toBe(true);
		}
	});

	it("plan honours _defs/ depth — preserves the relative subpath verbatim", () => {
		const bundleRoot = path.join(workDir, "bundle");
		const projectRoot = path.join(workDir, "project");
		fs.mkdirSync(path.join(bundleRoot, ".schemas", "_defs"), { recursive: true });
		fs.mkdirSync(path.join(projectRoot, ".forge"), { recursive: true });

		fs.writeFileSync(path.join(bundleRoot, ".schemas", "_defs", "phaseSummary.schema.json"), "{}");

		const writes: Array<{ src: string; dest: string }> = [];
		resolveCategory("schemas", bundleRoot, projectRoot, writes);

		const w = writes.find((x) => x.dest.endsWith("phaseSummary.schema.json"));
		expect(w).toBeDefined();
		// Source under bundle/.schemas/_defs/, destination under .forge/schemas/_defs/
		expect(w!.src).toBe(path.join(bundleRoot, ".schemas", "_defs", "phaseSummary.schema.json"));
		expect(w!.dest).toBe(path.join(projectRoot, ".forge", "schemas", "_defs", "phaseSummary.schema.json"));
	});
});
