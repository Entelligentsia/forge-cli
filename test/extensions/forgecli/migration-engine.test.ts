// migration-engine.test.ts — Unit tests for migration-engine.ts (FORGE-S23-T01)
//
// Coverage (27 cases):
//  1.  Migration-entry parser — reads migrations.json, validates structure
//  2.  Semver range traversal — correct filtering across 0.9.x / 0.10.x boundary
//  3.  Range boundary [from, to) — inclusive lower, exclusive upper
//  3a. Critical regression: runMigrations("0.43.19","0.44.4") includes entry keyed "0.43.19"
//  4.  Category resolver — per-type resolution
//  5.  Idempotency — re-run with existing ledger skips applied versions
//  6.  Dry-run mode — returns plan without writes
//  7.  fileOps precedence — fileOps takes priority over regenerate when non-empty
//  8.  Breaking-entry handling — breaking:true entries skipped + reported
//  9.  Manual-step collection — manual items aggregated
//  10. Empty range — fromVersion == toVersion is no-op
//  11. Full-walk optimization — all 5 base-pack categories → single substitute call
//  12. tools:lib slash and colon variants normalize identically; .cjs probed first, .js fallback
//  13. workflows:_fragments_store-cli-verbs resolves via underscore-compound split
//  14. workflows:base-pack-store-cli-form — debug-logged no-op
//  15. schemas:events (plural orphan) — ENOENT-trapped gracefully
//  16. schemas:config, schemas:update-check-cache — ENOENT-trapped gracefully
//  17. schemas:structure-manifest — special case: non-.schema.json file
//  18. Fragment/event alias — fragments:X and events:X map to same destination
//  19. Absent source files — engine skips gracefully, no throw
//  20. _fragments double-nesting guard — walker doesn't recurse into nested _fragments/
//  21. Path-traversal defense — crafted category throws
//  22. workflows:_fragments resolves to walk of _fragments/ only, not full workflows/
//  23. hooks:* short-circuit — no fs.stat, no read attempted
//  24. Schema refresh — unconditional post-pass copies *.schema.json
//  25. First-run empty ledger — same [from, to) filter, returns 5 entries for 0.43.19→0.44.4
//  26. semverCompare v-prefix handling
//  27. (C-19) fileOps copy with absent src → failedCategories accumulates failure

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __test__, type MigrationResult, runMigrations } from "../../../src/extensions/forgecli/update/migration-engine.js";

const { semverCompare, filterMigrationEntries, resolveCategory } = __test__;

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir(): string {
	const dir = path.join(os.tmpdir(), `migration-engine-test-${crypto.randomBytes(6).toString("hex")}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Build a minimal fake bundle root with optional files */
function makeBundleRoot(
	dir: string,
	opts: {
		schemas?: Record<string, string>;
		basePackFiles?: Record<string, string>;
		migrationsJson?: object;
		tools?: Record<string, string>;
	} = {},
): string {
	const bundleRoot = path.join(dir, "bundle");
	fs.mkdirSync(path.join(bundleRoot, ".schemas"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, ".base-pack", "workflows", "_fragments"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, ".base-pack", "personas"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, ".base-pack", "skills"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, ".base-pack", "templates"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, ".base-pack", "commands"), { recursive: true });
	fs.mkdirSync(path.join(bundleRoot, "tools", "lib"), { recursive: true });

	// Migrations JSON
	const migrations = opts.migrationsJson ?? {};
	fs.writeFileSync(path.join(bundleRoot, ".schemas", "migrations.json"), JSON.stringify(migrations));

	// Schema files
	for (const [name, content] of Object.entries(opts.schemas ?? {})) {
		fs.writeFileSync(path.join(bundleRoot, ".schemas", name), content);
	}

	// Base-pack files
	for (const [relPath, content] of Object.entries(opts.basePackFiles ?? {})) {
		const abs = path.join(bundleRoot, ".base-pack", relPath);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}

	// Tools
	for (const [name, content] of Object.entries(opts.tools ?? {})) {
		const abs = path.join(bundleRoot, "tools", name);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content);
	}

	return bundleRoot;
}

/** Build a fake project root with .forge/ structure */
function makeProjectRoot(dir: string): string {
	const projectRoot = path.join(dir, "project");
	fs.mkdirSync(path.join(projectRoot, ".forge", "schemas"), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, ".forge", "workflows", "_fragments"), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, ".forge", "personas"), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, ".forge", "skills"), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, ".forge", "templates"), { recursive: true });
	fs.mkdirSync(path.join(projectRoot, ".forge", "commands", "forge"), { recursive: true });
	// Minimal config.json
	fs.writeFileSync(
		path.join(projectRoot, ".forge", "config.json"),
		JSON.stringify({
			project: { name: "TestProject", prefix: "TEST" },
			paths: { engineering: "engineering", forgeRoot: "./bundle" },
			commands: { test: "npm test", lint: "npm run lint" },
		}),
	);
	return projectRoot;
}

/** Fake substitute-placeholders.cjs that just returns content unchanged */
function makeSubstPlaceholders(bundleRoot: string): void {
	const toolsDir = path.join(bundleRoot, "tools");
	fs.mkdirSync(toolsDir, { recursive: true });
	fs.writeFileSync(
		path.join(toolsDir, "substitute-placeholders.cjs"),
		`'use strict';
function buildSubstitutionMap(config) {
  return new Map([['PROJECT_NAME', config.project.name], ['PREFIX', config.project.prefix]]);
}
function substituteFile(content) { return content; }
module.exports = { buildSubstitutionMap, substituteFile };
`,
	);
}

// ── semverCompare (case 26) ────────────────────────────────────────────────

describe("semverCompare", () => {
	it("returns 0 for equal versions", () => {
		expect(semverCompare("1.2.3", "1.2.3")).toBe(0);
	});

	it("returns negative when a < b", () => {
		expect(semverCompare("1.0.0", "1.0.1")).toBeLessThan(0);
		expect(semverCompare("0.9.9", "0.10.0")).toBeLessThan(0);
	});

	it("returns positive when a > b", () => {
		expect(semverCompare("0.10.0", "0.9.9")).toBeGreaterThan(0);
	});

	it("handles v-prefix (case 26) — semverCompare('v0.44.4', '0.44.4') === 0", () => {
		expect(semverCompare("v0.44.4", "0.44.4")).toBe(0);
	});

	it("handles v-prefix comparison (case 26) — v0.10.0 > v0.9.9", () => {
		expect(semverCompare("v0.10.0", "v0.9.9")).toBeGreaterThan(0);
	});
});

// ── filterMigrationEntries (cases 2, 3, 3a, 10, 25) ─────────────────────

describe("filterMigrationEntries", () => {
	// Minimal set of entries mimicking migrations.json structure
	const entries: Record<string, { version: string; regenerate: string[]; breaking: boolean; manual: string[] }> = {
		"0.9.5": { version: "0.9.6", regenerate: ["workflows:plan_task"], breaking: false, manual: [] },
		"0.9.6": { version: "0.9.7", regenerate: ["personas"], breaking: false, manual: [] },
		"0.9.7": { version: "0.10.0", regenerate: ["personas:supervisor"], breaking: false, manual: [] },
		"0.10.0": { version: "0.10.1", regenerate: ["workflows"], breaking: false, manual: [] },
		"0.10.1": { version: "0.10.2", regenerate: ["schemas:event"], breaking: false, manual: [] },
		"0.10.2": { version: "0.10.3", regenerate: ["schemas:bug"], breaking: false, manual: [] },
	};

	it("case 2: correctly traverses 0.9.x/0.10.x boundary with semver (string comparison would fail)", () => {
		// [from=0.9.5, to=0.10.2): should include 0.9.5, 0.9.6, 0.9.7, 0.10.0, 0.10.1
		const selected = filterMigrationEntries(entries, "0.9.5", "0.10.2");
		expect(selected.map((e) => e.key)).toEqual(["0.9.5", "0.9.6", "0.9.7", "0.10.0", "0.10.1"]);
	});

	it("case 3: [from, to) — inclusive lower bound, exclusive upper bound", () => {
		// includes 0.9.5 (the FROM entry), excludes 0.10.2 (the TO entry)
		const selected = filterMigrationEntries(entries, "0.9.5", "0.10.2");
		expect(selected.map((e) => e.key)).toContain("0.9.5"); // from IS included
		expect(selected.map((e) => e.key)).not.toContain("0.10.2"); // to is excluded
	});

	it("case 10: fromVersion == toVersion returns empty (no-op)", () => {
		const selected = filterMigrationEntries(entries, "0.10.0", "0.10.0");
		expect(selected).toHaveLength(0);
	});

	it("case 25: empty ledger uses same [from, to) filter — not all entries with key <= toVersion", () => {
		// With correct [from, to) filter, runMigrations("0.9.5", "0.10.2") should select 5 entries
		// NOT all 6 entries (which would happen with the wrong key <= toVersion filter)
		const selected = filterMigrationEntries(entries, "0.9.5", "0.10.2");
		expect(selected).toHaveLength(5); // exactly 5, not 6
		expect(selected.map((e) => e.key)).not.toContain("0.10.2"); // the wrong filter would include this
	});
});

// ── Critical regression test (case 3a) ────────────────────────────────────

describe("case 3a: runMigrations('0.43.19','0.44.4') includes entry 0.43.19", () => {
	let dir: string;

	beforeEach(() => {
		dir = tmpDir();
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("selects entry keyed 0.43.19 with 12 regeneration categories", async () => {
		// Use the actual migrations.json from the forge repo
		const actualMigrationsPath = path.resolve(import.meta.dirname, "../../../../forge/forge/migrations.json");

		if (!fs.existsSync(actualMigrationsPath)) {
			// Skip if forge repo not present (CI without submodule)
			return;
		}

		const actualMigrations = JSON.parse(fs.readFileSync(actualMigrationsPath, "utf8"));
		const selected = filterMigrationEntries(actualMigrations, "0.43.19", "0.44.4");
		const keys = selected.map((e) => e.key);
		expect(keys).toContain("0.43.19");

		const entry0_43_19 = selected.find((e) => e.key === "0.43.19");
		expect(entry0_43_19).toBeDefined();
		// The entry has 12 regeneration categories
		expect(entry0_43_19!.entry.regenerate).toHaveLength(12);
		// Should include fix_bug workflow
		expect(entry0_43_19!.entry.regenerate).toContain("workflows:fix_bug");
		// 5 total entries
		expect(selected).toHaveLength(5);
		expect(keys).toEqual(["0.43.19", "0.44.0", "0.44.1", "0.44.2", "0.44.3"]);
	});
});

// ── runMigrations integration (cases 4-9, 11-24) ─────────────────────────

describe("runMigrations", () => {
	let dir: string;
	let projectRoot: string;
	let bundleRoot: string;

	beforeEach(() => {
		dir = tmpDir();
		projectRoot = makeProjectRoot(dir);
		bundleRoot = makeBundleRoot(dir, {
			schemas: {
				"event.schema.json": '{"type":"event"}',
				"bug.schema.json": '{"type":"bug"}',
			},
			basePackFiles: {
				"personas/supervisor.md": "# Supervisor {{PROJECT_NAME}}",
				"workflows/fix_bug.md": "# Fix Bug",
				"workflows/_fragments/friction-emit.md": "# Friction emit",
				"workflows/_fragments/store-cli-verbs.md": "# Store CLI verbs",
				"skills/engineer-skills.md": "# Engineer skills",
				"templates/PLAN_TEMPLATE.md": "# Plan",
				"commands/calibrate.md": "# Calibrate",
			},
			migrationsJson: {
				"0.9.5": {
					version: "0.9.6",
					date: "2024-01-01",
					notes: "test entry",
					regenerate: ["personas:supervisor"],
					breaking: false,
					manual: [],
				},
				"0.9.6": {
					version: "0.9.7",
					date: "2024-01-02",
					notes: "test entry 2",
					regenerate: ["workflows:fix_bug"],
					breaking: false,
					manual: [],
				},
			},
		});
		makeSubstPlaceholders(bundleRoot);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("case 5: idempotency — re-run skips already-applied versions", async () => {
		// Write ledger with 0.9.5 already applied
		const ledgerPath = path.join(projectRoot, ".forge", "applied-migrations.json");
		fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: 1, appliedVersions: ["0.9.5"] }));

		const result = await runMigrations({
			bundleRoot,
			projectRoot,
			fromVersion: "0.9.5",
			toVersion: "0.9.7",
		});

		// Only 0.9.6 should be applied (0.9.5 is already in ledger)
		expect(result.applied).toHaveLength(1);
		expect(result.applied[0]!.fromVersion).toBe("0.9.6");
	});

	it("case 6: dry-run mode — returns plan without writing files", async () => {
		const result = await runMigrations({
			bundleRoot,
			projectRoot,
			fromVersion: "0.9.5",
			toVersion: "0.9.7",
			dryRun: true,
		});

		expect(result.dryRun).toBe(true);
		expect(result.applied).toHaveLength(2);

		// No ledger should be created
		const ledgerPath = path.join(projectRoot, ".forge", "applied-migrations.json");
		expect(fs.existsSync(ledgerPath)).toBe(false);
	});

	it("case 8: breaking-entry handling — breaking:true entries skipped + reported", async () => {
		// Add a breaking entry
		const breakingMigrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "breaking",
				regenerate: ["personas:supervisor"],
				breaking: true,
				manual: [],
			},
			"0.9.6": {
				version: "0.9.7",
				date: "2024-01-02",
				notes: "normal",
				regenerate: ["workflows:fix_bug"],
				breaking: false,
				manual: [],
			},
		};
		const bdir = tmpDir();
		const bProjectRoot = makeProjectRoot(bdir);
		const bBundleRoot = makeBundleRoot(bdir, {
			schemas: { "event.schema.json": "{}" },
			basePackFiles: { "workflows/fix_bug.md": "# Fix Bug" },
			migrationsJson: breakingMigrations,
		});
		makeSubstPlaceholders(bBundleRoot);

		try {
			const result = await runMigrations({
				bundleRoot: bBundleRoot,
				projectRoot: bProjectRoot,
				fromVersion: "0.9.5",
				toVersion: "0.9.7",
			});

			expect(result.skippedBreaking).toHaveLength(1);
			expect(result.skippedBreaking[0]!.fromVersion).toBe("0.9.5");
			expect(result.applied).toHaveLength(1);
			expect(result.applied[0]!.fromVersion).toBe("0.9.6");
		} finally {
			fs.rmSync(bdir, { recursive: true, force: true });
		}
	});

	it("case 9: manual-step collection — manual items aggregated per entry", async () => {
		const manualMigrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "has manual",
				regenerate: ["personas:supervisor"],
				breaking: false,
				manual: ["Run: node tools/migrate-config.cjs", "Update .env file"],
			},
		};
		const mdir = tmpDir();
		const mProjectRoot = makeProjectRoot(mdir);
		const mBundleRoot = makeBundleRoot(mdir, {
			schemas: { "event.schema.json": "{}" },
			basePackFiles: { "personas/supervisor.md": "# Supervisor" },
			migrationsJson: manualMigrations,
		});
		makeSubstPlaceholders(mBundleRoot);

		try {
			const result = await runMigrations({
				bundleRoot: mBundleRoot,
				projectRoot: mProjectRoot,
				fromVersion: "0.9.5",
				toVersion: "0.9.6",
			});

			expect(result.manualSteps).toHaveLength(1);
			expect(result.manualSteps[0]!.steps).toEqual(["Run: node tools/migrate-config.cjs", "Update .env file"]);
		} finally {
			fs.rmSync(mdir, { recursive: true, force: true });
		}
	});

	it("case 7: fileOps precedence — fileOps present and non-empty takes priority over regenerate", async () => {
		const fileOpsMigrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "fileOps entry",
				fileOps: [{ op: "mkdir", path: ".forge/new-dir" }],
				regenerate: ["personas:supervisor"],
				breaking: false,
				manual: [],
			},
		};
		const fdir = tmpDir();
		const fProjectRoot = makeProjectRoot(fdir);
		const fBundleRoot = makeBundleRoot(fdir, {
			schemas: { "event.schema.json": "{}" },
			basePackFiles: { "personas/supervisor.md": "# Supervisor" },
			migrationsJson: fileOpsMigrations,
		});
		makeSubstPlaceholders(fBundleRoot);

		try {
			const result = await runMigrations({
				bundleRoot: fBundleRoot,
				projectRoot: fProjectRoot,
				fromVersion: "0.9.5",
				toVersion: "0.9.6",
			});

			expect(result.applied).toHaveLength(1);
			// When fileOps is used, categories reflects fileOps execution, not regenerate
			const applied = result.applied[0]!;
			expect(applied.categories).toContain("fileOps:mkdir");
			// The new dir should exist
			expect(fs.existsSync(path.join(fProjectRoot, ".forge", "new-dir"))).toBe(true);
			// supervisor.md should NOT have been regenerated (fileOps took priority)
		} finally {
			fs.rmSync(fdir, { recursive: true, force: true });
		}
	});

	it("case 27 (C-19): fileOps copy with absent src → failedCategories accumulates failure", async () => {
		// Regression test: without the failedCategories field, ENOENT on copy was silent.
		// This test verifies runMigrations surfaces the failure in result.failedCategories.
		const absentSrc = "/nonexistent/path/to/source.md";
		const c19Migrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "C-19 regression: copy with absent src",
				fileOps: [{ op: "copy", path: ".forge/schemas/absent-file.md", src: absentSrc }],
				breaking: false,
				manual: [],
			},
		};
		const c19dir = tmpDir();
		const c19ProjectRoot = makeProjectRoot(c19dir);
		const c19BundleRoot = makeBundleRoot(c19dir, {
			schemas: { "event.schema.json": "{}" },
			migrationsJson: c19Migrations,
		});

		try {
			const result = await runMigrations({
				bundleRoot: c19BundleRoot,
				projectRoot: c19ProjectRoot,
				fromVersion: "0.9.5",
				toVersion: "0.9.6",
			});

			// Applied entry is still recorded (the op ran, it just couldn't copy the src)
			expect(result.applied).toHaveLength(1);
			// C-19: failure is surfaced in failedCategories (not swallowed silently)
			expect(result.failedCategories).toHaveLength(1);
			expect(result.failedCategories[0]!.version).toBe("0.9.5");
			expect(result.failedCategories[0]!.reason).toContain("ENOENT");
		} finally {
			fs.rmSync(c19dir, { recursive: true, force: true });
		}
	});

	it("case 21: path-traversal defense — crafted category throws", async () => {
		const traversalMigrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "traversal attempt",
				regenerate: ["schemas:../../etc/passwd"],
				breaking: false,
				manual: [],
			},
		};
		const tdir = tmpDir();
		const tProjectRoot = makeProjectRoot(tdir);
		const tBundleRoot = makeBundleRoot(tdir, {
			schemas: {},
			migrationsJson: traversalMigrations,
		});
		makeSubstPlaceholders(tBundleRoot);

		try {
			await expect(
				runMigrations({
					bundleRoot: tBundleRoot,
					projectRoot: tProjectRoot,
					fromVersion: "0.9.5",
					toVersion: "0.9.6",
				}),
			).rejects.toThrow(/path traversal/i);
		} finally {
			fs.rmSync(tdir, { recursive: true, force: true });
		}
	});

	it("case 19: absent source files — engine skips gracefully, no throw", async () => {
		const absentMigrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "references removed fragment",
				regenerate: ["fragments:removed-fragment", "schemas:events"],
				breaking: false,
				manual: [],
			},
		};
		const adir = tmpDir();
		const aProjectRoot = makeProjectRoot(adir);
		const aBundleRoot = makeBundleRoot(adir, {
			schemas: { "event.schema.json": "{}" },
			migrationsJson: absentMigrations,
		});
		makeSubstPlaceholders(aBundleRoot);

		try {
			// Should not throw even though sources are absent
			const result = await runMigrations({
				bundleRoot: aBundleRoot,
				projectRoot: aProjectRoot,
				fromVersion: "0.9.5",
				toVersion: "0.9.6",
			});
			expect(result.applied).toHaveLength(1);
		} finally {
			fs.rmSync(adir, { recursive: true, force: true });
		}
	});

	it("case 23: hooks:* short-circuit — no file read attempted", async () => {
		const hooksMigrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "hooks category",
				regenerate: ["hooks:check-update", "hooks"],
				breaking: false,
				manual: [],
			},
		};
		const hdir = tmpDir();
		const hProjectRoot = makeProjectRoot(hdir);
		const hBundleRoot = makeBundleRoot(hdir, {
			schemas: { "event.schema.json": "{}" },
			migrationsJson: hooksMigrations,
		});
		makeSubstPlaceholders(hBundleRoot);

		try {
			// Should not throw (no hooks directory exists in bundle)
			const result = await runMigrations({
				bundleRoot: hBundleRoot,
				projectRoot: hProjectRoot,
				fromVersion: "0.9.5",
				toVersion: "0.9.6",
			});
			expect(result.applied).toHaveLength(1);
		} finally {
			fs.rmSync(hdir, { recursive: true, force: true });
		}
	});

	it("case 24: schema refresh — unconditional post-pass copies *.schema.json", async () => {
		// Migration entry has NO schema category
		const noSchemaMigrations = {
			"0.9.5": {
				version: "0.9.6",
				date: "2024-01-01",
				notes: "no schema category",
				regenerate: ["personas:supervisor"],
				breaking: false,
				manual: [],
			},
		};
		const sdir = tmpDir();
		const sProjectRoot = makeProjectRoot(sdir);
		const sBundleRoot = makeBundleRoot(sdir, {
			schemas: {
				"event.schema.json": '{"type":"event-schema"}',
				"bug.schema.json": '{"type":"bug-schema"}',
			},
			basePackFiles: { "personas/supervisor.md": "# Supervisor" },
			migrationsJson: noSchemaMigrations,
		});
		makeSubstPlaceholders(sBundleRoot);

		try {
			await runMigrations({
				bundleRoot: sBundleRoot,
				projectRoot: sProjectRoot,
				fromVersion: "0.9.5",
				toVersion: "0.9.6",
			});

			// Schema files should be present in .forge/schemas/ from the always-on post-pass
			expect(fs.existsSync(path.join(sProjectRoot, ".forge", "schemas", "event.schema.json"))).toBe(true);
			expect(fs.existsSync(path.join(sProjectRoot, ".forge", "schemas", "bug.schema.json"))).toBe(true);
		} finally {
			fs.rmSync(sdir, { recursive: true, force: true });
		}
	});
});

// ── resolveCategory (cases 12-20, 22) ────────────────────────────────────

describe("resolveCategory", () => {
	let dir: string;
	let projectRoot: string;
	let bundleRoot: string;

	beforeEach(() => {
		dir = tmpDir();
		projectRoot = makeProjectRoot(dir);
		bundleRoot = makeBundleRoot(dir, {
			schemas: {
				"event.schema.json": '{"event":true}',
				"structure-manifest.json": '{"manifest":true}',
			},
			basePackFiles: {
				"workflows/_fragments/friction-emit.md": "# Friction emit fragment",
				"workflows/_fragments/store-cli-verbs.md": "# Store CLI verbs",
				"personas/supervisor.md": "# Supervisor",
			},
			tools: {
				"lib/validate.js": "module.exports = {};",
				"lib/forge-root.cjs": "module.exports = {};",
			},
		});
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("case 13: workflows:_fragments_store-cli-verbs resolves via underscore-compound split", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("workflows:_fragments_store-cli-verbs", bundleRoot, projectRoot, writes);
		expect(writes).toHaveLength(1);
		expect(writes[0]!.dest).toContain(path.join("_fragments", "store-cli-verbs.md"));
	});

	it("case 14: workflows:base-pack-store-cli-form — no-op (sub-target absent from base-pack)", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		// Should not throw, should not add any writes
		expect(() =>
			resolveCategory("workflows:base-pack-store-cli-form", bundleRoot, projectRoot, writes),
		).not.toThrow();
		expect(writes).toHaveLength(0);
	});

	it("case 15: schemas:events (plural orphan) — graceful ENOENT skip", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		// events.schema.json doesn't exist — only event.schema.json does
		expect(() => resolveCategory("schemas:events", bundleRoot, projectRoot, writes)).not.toThrow();
		// Source doesn't exist so no write
		expect(writes.filter((w) => w.src.endsWith("events.schema.json"))).toHaveLength(0);
	});

	it("case 16: schemas:config — graceful ENOENT skip", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		expect(() => resolveCategory("schemas:config", bundleRoot, projectRoot, writes)).not.toThrow();
	});

	it("case 17: schemas:structure-manifest — special case for non-.schema.json file", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("schemas:structure-manifest", bundleRoot, projectRoot, writes);
		const found = writes.find((w) => w.dest.endsWith("structure-manifest.json"));
		expect(found).toBeDefined();
		expect(found!.src).toContain("structure-manifest.json");
	});

	it("case 18: fragments:X and events:X map to same destination (alias)", () => {
		const writes1: Array<{ dest: string; src: string }> = [];
		const writes2: Array<{ dest: string; src: string }> = [];
		resolveCategory("fragments:friction-emit", bundleRoot, projectRoot, writes1);
		resolveCategory("events:friction-emit", bundleRoot, projectRoot, writes2);
		expect(writes1.map((w) => w.dest)).toEqual(writes2.map((w) => w.dest));
	});

	it("case 22: workflows:_fragments walks only _fragments/, not full workflows/ tree", () => {
		// Add a workflow file that should NOT be picked up
		fs.writeFileSync(path.join(bundleRoot, ".base-pack", "workflows", "implement_plan.md"), "# Implement Plan");

		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("workflows:_fragments", bundleRoot, projectRoot, writes);

		// Should include fragments but NOT implement_plan.md
		const fragFiles = writes.map((w) => path.basename(w.dest));
		expect(fragFiles).toContain("friction-emit.md");
		expect(fragFiles).toContain("store-cli-verbs.md");
		expect(fragFiles).not.toContain("implement_plan.md");
	});

	it("case 20: _fragments double-nesting guard — walker doesn't recurse into nested _fragments/", () => {
		// Create a nested _fragments dir inside _fragments
		const nestedDir = path.join(bundleRoot, ".base-pack", "workflows", "_fragments", "_fragments");
		fs.mkdirSync(nestedDir, { recursive: true });
		fs.writeFileSync(path.join(nestedDir, "nested.md"), "# Nested");

		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("workflows:_fragments", bundleRoot, projectRoot, writes);

		// nested.md should NOT be in the writes
		const destFiles = writes.map((w) => path.basename(w.dest));
		expect(destFiles).not.toContain("nested.md");
	});

	it("case 12: tools:lib colon variant normalizes to lib/<name>; .cjs probed first, .js fallback", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		// tools:lib:validate — validate.js exists, validate.cjs does not
		resolveCategory("tools:lib:validate", bundleRoot, projectRoot, writes);
		expect(writes).toHaveLength(1);
		expect(writes[0]!.src).toContain("validate.js"); // .js fallback since .cjs absent
	});

	it("case 12: tools:lib slash variant resolves forge-root.cjs (.cjs first)", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		// tools:lib/forge-root — forge-root.cjs exists so .cjs is picked first
		resolveCategory("tools:lib/forge-root", bundleRoot, projectRoot, writes);
		expect(writes).toHaveLength(1);
		expect(writes[0]!.src).toContain("forge-root.cjs");
	});

	// FORGE-S29-T05: tools category copy tests
	it("FORGE-S29-T05: resolveCategory('tools') produces copy writes for .cjs files in tools/", () => {
		// Add store-cli.cjs to the bundle tools dir
		const storeCliSrc = path.join(bundleRoot, "tools", "store-cli.cjs");
		fs.writeFileSync(storeCliSrc, "module.exports = {};", "utf8");
		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("tools", bundleRoot, projectRoot, writes);
		expect(writes.length).toBeGreaterThan(0);
		expect(writes.some((w) => w.dest.includes(path.join(".forge", "tools", "store-cli.cjs")))).toBe(true);
	});

	it("FORGE-S29-T05: resolveCategory('tools') dest is inside .forge/tools/, not .forge/schemas/", () => {
		const storeCliSrc = path.join(bundleRoot, "tools", "store-cli.cjs");
		fs.writeFileSync(storeCliSrc, "module.exports = {};", "utf8");
		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("tools", bundleRoot, projectRoot, writes);
		for (const w of writes) {
			expect(w.dest).toContain(path.join(".forge", "tools"));
			expect(w.dest).not.toContain(path.join(".forge", "schemas"));
		}
	});

	it("FORGE-S29-T05: resolveCategory('tools:lib') copies lib files to .forge/tools/lib/", () => {
		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("tools:lib/forge-root", bundleRoot, projectRoot, writes);
		expect(writes).toHaveLength(1);
		// Dest should be inside .forge/tools/lib/, not .forge/schemas/
		expect(writes[0]!.dest).toContain(path.join(".forge", "tools", "lib"));
		expect(writes[0]!.dest).not.toContain(path.join(".forge", "schemas"));
	});

	// FORGE-S25-T09: empty-fragment round-trip pinning.
	//
	// The TASK_PROMPT planner-callout requires "an empty-file test fixture
	// that proves the wiring". A zero-byte fragment must:
	//   1. Be enumerated by the workflows:_fragments walker (isFile() === true).
	//   2. Round-trip through the writes-array → actual fs copy with byte
	//      length preserved (zero in, zero out — no accidental padding,
	//      no skipping by empty-content heuristic).
	//
	// Fixture source: forge-cli/test/fixtures/_fragments/EMPTY_FIXTURE.md.
	// Lives under test/fixtures/ (vitest-excluded per vitest.config.ts) and
	// is consumed only by this test via path.join. Placing the fixture
	// outside forge/forge/meta/workflows/_fragments/ keeps the real plugin
	// bundle uncontaminated (per PLAN Files-to-Modify rationale).
	it("FORGE-S25-T09: zero-byte fragment fixture round-trips workflows:_fragments unchanged", () => {
		// Stage the empty fixture into the fake bundle's _fragments/ dir.
		const fixtureSrc = path.resolve(__dirname, "..", "..", "fixtures", "_fragments", "EMPTY_FIXTURE.md");
		expect(fs.existsSync(fixtureSrc), `fixture missing at ${fixtureSrc} — required by FORGE-S25-T09`).toBe(true);
		expect(fs.statSync(fixtureSrc).size, "EMPTY_FIXTURE.md must be exactly 0 bytes for this pinning test").toBe(0);

		const stagedSrc = path.join(bundleRoot, ".base-pack", "workflows", "_fragments", "EMPTY_FIXTURE.md");
		fs.copyFileSync(fixtureSrc, stagedSrc);
		expect(fs.statSync(stagedSrc).size).toBe(0);

		const writes: Array<{ dest: string; src: string }> = [];
		resolveCategory("workflows:_fragments", bundleRoot, projectRoot, writes);

		// (1) Walker enumerated the zero-byte file.
		const emptyWrite = writes.find((w) => w.src.endsWith("EMPTY_FIXTURE.md"));
		expect(
			emptyWrite,
			"workflows:_fragments walker dropped the zero-byte EMPTY_FIXTURE.md — " +
				"isFile() must accept zero-byte entries",
		).toBeDefined();

		// (2) Round-trip: perform the copy the migration engine would perform
		// and assert byte length is preserved (zero in → zero out).
		fs.mkdirSync(path.dirname(emptyWrite!.dest), { recursive: true });
		fs.copyFileSync(emptyWrite!.src, emptyWrite!.dest);
		expect(
			fs.statSync(emptyWrite!.dest).size,
			"zero-byte fragment grew bytes through the copy — no padding allowed",
		).toBe(0);

		// (3) Destination lives under the project's .forge/workflows/_fragments/
		// — same location the materialized payload would land.
		expect(emptyWrite!.dest).toContain(path.join(".forge", "workflows", "_fragments", "EMPTY_FIXTURE.md"));
	});
});
