// load-skills.test.ts — Tests for loadSkillsFromDir integration (FORGE-S22-T04).
//
// Coverage:
//   1. Happy path: 4 skill dirs with valid frontmatter → 4 skills, 0 diagnostics
//   2. Missing directory: nonexistent path → 0 skills, 0 diagnostics (no throw)
//   3. Invalid frontmatter: skill missing description → diagnostics present, skill null/excluded
//   4. Empty directory: no SKILL.md, no subdirs → 0 skills, 0 diagnostics

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/**
 * Create a temporary directory with a deterministic prefix, cleaned up after each test.
 */
function createTempDir(prefix: string = "forge-load-skills-test-"): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return dir;
}

/**
 * Scaffold a skill directory: <baseDir>/<name>/SKILL.md with the given frontmatter fields.
 */
function writeSkillMd(
	baseDir: string,
	name: string,
	frontmatter: { name?: string; description?: string },
	body: string = "Skill instructions here.",
): string {
	const skillDir = path.join(baseDir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	const fmParts: string[] = [];
	if (frontmatter.name !== undefined) fmParts.push(`name: ${frontmatter.name}`);
	if (frontmatter.description !== undefined) fmParts.push(`description: ${frontmatter.description}`);
	const content = `---\n${fmParts.join("\n")}\n---\n${body}\n`;
	fs.writeFileSync(path.join(skillDir, "SKILL.md"), content, "utf8");
	return skillDir;
}

describe("loadSkillsFromDir integration", () => {
	const tmpDirs: string[] = [];

	afterEach(() => {
		for (const d of tmpDirs) {
			fs.rmSync(d, { recursive: true, force: true });
		}
		tmpDirs.length = 0;
	});

	function mkTempDir(): string {
		const d = createTempDir();
		tmpDirs.push(d);
		return d;
	}

	it("happy path: 4 skill dirs with valid frontmatter load correctly", () => {
		const dir = mkTempDir();
		writeSkillMd(dir, "store-custodian", { name: "store-custodian", description: "Manage the forge store" });
		writeSkillMd(dir, "store-query-grammar", { name: "store-query-grammar", description: "Parse store queries" });
		writeSkillMd(dir, "store-query-nlp", { name: "store-query-nlp", description: "NLP store queries" });
		writeSkillMd(dir, "refresh-kb-links", { name: "refresh-kb-links", description: "Refresh knowledge base links" });

		const result = loadSkillsFromDir({ dir, source: "test" });

		expect(result.skills).toHaveLength(4);
		expect(result.diagnostics).toHaveLength(0);

		for (const skill of result.skills) {
			expect(skill.name).toBeTruthy();
			expect(skill.description).toBeTruthy();
			expect(skill.filePath).toBeTruthy();
		}
	});

	it("missing directory: returns 0 skills and 0 diagnostics without throwing", () => {
		const nonexistentPath = path.join(os.tmpdir(), "forge-load-skills-nonexistent-" + Date.now());
		// Ensure it really doesn't exist
		expect(fs.existsSync(nonexistentPath)).toBe(false);

		const result = loadSkillsFromDir({ dir: nonexistentPath, source: "test" });

		expect(result.skills).toHaveLength(0);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("invalid frontmatter: missing description yields diagnostics and skill is excluded", () => {
		const dir = mkTempDir();
		// writeSkillMd with no description
		const skillDir = path.join(dir, "broken-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, "SKILL.md"),
			"---\nname: broken-skill\n---\nNo description field.\n",
			"utf8",
		);

		const result = loadSkillsFromDir({ dir, source: "test" });

		// Skills without description should not be loaded as valid skills
		expect(result.skills).toHaveLength(0);
		// Diagnostics should contain at least one warning about the missing field
		expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
		expect(result.diagnostics.some((d) => d.message.toLowerCase().includes("description"))).toBe(true);
	});

	it("empty directory: no SKILL.md, no subdirectories → 0 skills, 0 diagnostics", () => {
		const dir = mkTempDir();

		const result = loadSkillsFromDir({ dir, source: "test" });

		expect(result.skills).toHaveLength(0);
		expect(result.diagnostics).toHaveLength(0);
	});
});