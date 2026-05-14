/**
 * Spike R6 — skill frontmatter compatibility load test.
 *
 * FORGE-S15-T09 — Discharges architectural-review.md §R5/§5 (skill format
 * compatibility) by exercising pi v0.73.1's `loadSkills()` against a fixture
 * directory containing all four Forge skills (refresh-kb-links plus three
 * breadth fixtures). Auth-free, no `AgentSession` involvement.
 *
 * Acceptance bar: zero diagnostics on `refresh-kb-links/SKILL.md`. Soft
 * warnings on the breadth set are documented in RESULT.md.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LoadSkillsResult, loadSkills, type ResourceDiagnostic, type Skill } from "@entelligentsia/pi-coding-agent";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const FORGE_SKILLS_DIR = join(REPO_ROOT, "forge", "forge", "skills");

export const FIXTURE_SKILL_NAMES = [
	"refresh-kb-links",
	"store-custodian",
	"store-query-grammar",
	"store-query-nlp",
] as const;

export type FixtureSkillName = (typeof FIXTURE_SKILL_NAMES)[number];

export interface SpikeResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
	fixtureRoot: string;
	skillsRoot: string;
	cleanup: () => void;
}

export function buildFixtureAndLoad(): SpikeResult {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "forge-spike-r6-"));
	const skillsRoot = join(fixtureRoot, "skills");
	mkdirSync(skillsRoot, { recursive: true });
	// Plan-review advisory 1 — explicit empty agent dir to neutralise user-global
	// skill discovery without relying on loadSkills' implicit handling.
	const agentDir = join(fixtureRoot, ".pi-agent-empty");
	mkdirSync(agentDir, { recursive: true });

	for (const name of FIXTURE_SKILL_NAMES) {
		const srcSkillDir = join(FORGE_SKILLS_DIR, name);
		const dstSkillDir = join(skillsRoot, name);
		mkdirSync(dstSkillDir, { recursive: true });
		cpSync(join(srcSkillDir, "SKILL.md"), join(dstSkillDir, "SKILL.md"));
	}

	const result: LoadSkillsResult = loadSkills({
		cwd: fixtureRoot,
		agentDir,
		skillPaths: [skillsRoot],
		includeDefaults: false,
	});

	return {
		skills: result.skills,
		diagnostics: result.diagnostics,
		fixtureRoot,
		skillsRoot,
		cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }),
	};
}
