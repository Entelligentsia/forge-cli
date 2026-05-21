// regenerate.test.ts — forge-cli#26 / forge#106 / FORGE-BUG-037.
//
// Tests the pre-write modification guard added to the /forge:regenerate
// handler. The guard runs `generation-manifest.cjs check` against every file
// in .forge/{personas,skills,workflows,templates}/ and prompts the user via
// ctx.ui.confirm before allowing substitute-placeholders.cjs to overwrite.
//
// Scope of this file: the pure detection function `findModifiedStructuralFiles`
// (logic-tested with a real generation-manifest.cjs tool against an isolated
// tmpdir). The full handler invocation is exercised via integration smoke,
// not unit-mocked here — too many dependencies (substitute-placeholders.cjs,
// bundled payload, ctx).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { findModifiedStructuralFiles } from "../../../src/extensions/forgecli/regenerate.js";

// Resolve a real generation-manifest.cjs from the bundled payload so the test
// exercises the actual exit-code contract (0=pristine, 1=modified, 2=untracked).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const manifestTool = path.join(repoRoot, "dist", "forge-payload", "tools", "generation-manifest.cjs");
const toolsRoot = path.dirname(manifestTool);

function makeTestProject(): string {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "forge-regen-guard-"));
	for (const cat of ["personas", "skills", "workflows", "templates"]) {
		fs.mkdirSync(path.join(tmp, ".forge", cat), { recursive: true });
	}
	return tmp;
}

function recordHash(cwd: string, relPath: string): void {
	const r = spawnSync("node", [manifestTool, "record", relPath], { cwd, encoding: "utf8" });
	if (r.status !== 0) {
		throw new Error(
			`failed to record ${relPath}: status=${r.status} stderr=${r.stderr} stdout=${r.stdout}`,
		);
	}
}

describe("findModifiedStructuralFiles (forge-cli#26 / forge#106)", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = makeTestProject();
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("returns empty list when no files exist", () => {
		const modified = findModifiedStructuralFiles(tmp, toolsRoot);
		expect(modified).toEqual([]);
	});

	it("returns empty list when files are pristine (hash matches manifest)", () => {
		const file = ".forge/personas/architect.md";
		fs.writeFileSync(path.join(tmp, file), "# Architect\n\nIdentity line.\n", "utf8");
		recordHash(tmp, file);

		const modified = findModifiedStructuralFiles(tmp, toolsRoot);
		expect(modified).toEqual([]);
	});

	it("flags a single modified persona file", () => {
		const file = ".forge/personas/architect.md";
		fs.writeFileSync(path.join(tmp, file), "# Architect\n\nIdentity line.\n", "utf8");
		recordHash(tmp, file);

		// Simulate /forge:enhance edit
		fs.writeFileSync(
			path.join(tmp, file),
			"# Architect\n\nIdentity line.\n\n## New section by enhance\n",
			"utf8",
		);

		const modified = findModifiedStructuralFiles(tmp, toolsRoot);
		expect(modified).toHaveLength(1);
		expect(modified[0]).toEqual({
			category: "personas",
			relativePath: ".forge/personas/architect.md",
		});
	});

	it("flags modified files across all four structural categories", () => {
		const fixtures = [
			".forge/personas/architect.md",
			".forge/skills/engineer-skills.md",
			".forge/workflows/plan_task.md",
			".forge/templates/PLAN_TEMPLATE.md",
		];
		for (const f of fixtures) {
			fs.writeFileSync(path.join(tmp, f), `original ${f}\n`, "utf8");
			recordHash(tmp, f);
			fs.writeFileSync(path.join(tmp, f), `edited ${f}\n`, "utf8");
		}

		const modified = findModifiedStructuralFiles(tmp, toolsRoot);
		const paths = modified.map((m) => m.relativePath).sort();
		expect(paths).toEqual(fixtures.slice().sort());

		const categories = new Set(modified.map((m) => m.category));
		expect(categories).toEqual(new Set(["personas", "skills", "workflows", "templates"]));
	});

	it("does NOT flag pristine files when others in the same dir are modified", () => {
		fs.writeFileSync(path.join(tmp, ".forge/skills/engineer-skills.md"), "engineer v1\n", "utf8");
		fs.writeFileSync(path.join(tmp, ".forge/skills/supervisor-skills.md"), "supervisor v1\n", "utf8");
		recordHash(tmp, ".forge/skills/engineer-skills.md");
		recordHash(tmp, ".forge/skills/supervisor-skills.md");

		// Modify only engineer
		fs.writeFileSync(path.join(tmp, ".forge/skills/engineer-skills.md"), "engineer v2 EDITED\n", "utf8");

		const modified = findModifiedStructuralFiles(tmp, toolsRoot);
		expect(modified).toHaveLength(1);
		expect(modified[0].relativePath).toBe(".forge/skills/engineer-skills.md");
	});

	it("ignores untracked files (no manifest entry)", () => {
		// File on disk but never recorded — exit 2 (untracked).
		fs.writeFileSync(
			path.join(tmp, ".forge/personas/new-persona.md"),
			"# Untracked\n",
			"utf8",
		);
		const modified = findModifiedStructuralFiles(tmp, toolsRoot);
		expect(modified).toEqual([]);
	});

	it("returns empty list when the manifest tool is missing (graceful no-op)", () => {
		const bogusToolsRoot = path.join(tmp, "no-such-tools");
		const modified = findModifiedStructuralFiles(tmp, bogusToolsRoot);
		expect(modified).toEqual([]);
	});

	it("ignores files outside the four structural categories", () => {
		fs.mkdirSync(path.join(tmp, ".forge/cache"), { recursive: true });
		fs.writeFileSync(path.join(tmp, ".forge/cache/random.md"), "noise\n", "utf8");

		const modified = findModifiedStructuralFiles(tmp, toolsRoot);
		expect(modified).toEqual([]);
	});
});
