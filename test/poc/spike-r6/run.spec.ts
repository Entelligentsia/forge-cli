/**
 * Spike R6 — vitest spec.
 *
 * FORGE-S15-T09 — Auth-free spec exercising pi `loadSkills()` against a
 * fixture directory containing all four Forge skills. ACs:
 *
 *   AC1 — load returns successfully; result.skills.length === 4.
 *   AC2 — every loaded skill carries name/description/filePath/baseDir/
 *         disableModelInvocation with the expected runtime types.
 *   AC3 — diagnostics dumped to a sibling JSON file for mechanical
 *         transcription into RESULT.md (plan-review advisory 2).
 *   AC4 — zero diagnostics whose `path` ends with refresh-kb-links/SKILL.md.
 *
 * Plan-review advisory 3 — explicit `collision`-kind diagnostic check.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixtureAndLoad, FIXTURE_SKILL_NAMES, type SpikeResult } from "./spike.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIAGNOSTICS_DUMP_PATH = join(HERE, "diagnostics.json");

let result: SpikeResult;

describe("Spike R6 — Forge skill frontmatter loads in pi v0.73.1", () => {
	beforeAll(() => {
		result = buildFixtureAndLoad();
		// Plan-review advisory 2 — dump diagnostics to a sibling JSON for AC3
		// mechanical transcription into RESULT.md. Written before assertions so
		// the artifact survives even if a later expect() fails.
		writeFileSync(
			DIAGNOSTICS_DUMP_PATH,
			JSON.stringify(
				{
					skillNames: result.skills.map((s) => s.name),
					diagnostics: result.diagnostics,
				},
				null,
				2,
			),
		);
	});

	afterAll(() => {
		result?.cleanup();
	});

	it("AC1 — loadSkills returns four skills with no thrown error", () => {
		expect(result.skills).toHaveLength(FIXTURE_SKILL_NAMES.length);
		const loadedNames = new Set(result.skills.map((s) => s.name));
		for (const expected of FIXTURE_SKILL_NAMES) {
			expect(loadedNames.has(expected)).toBe(true);
		}
	});

	it("AC2 — every skill carries name/description/filePath/baseDir/disableModelInvocation", () => {
		for (const skill of result.skills) {
			expect(typeof skill.name).toBe("string");
			expect(skill.name.length).toBeGreaterThan(0);
			expect(typeof skill.description).toBe("string");
			expect(skill.description.length).toBeGreaterThan(0);
			expect(typeof skill.filePath).toBe("string");
			expect(skill.filePath.endsWith("/SKILL.md")).toBe(true);
			expect(typeof skill.baseDir).toBe("string");
			expect(typeof skill.disableModelInvocation).toBe("boolean");
		}
	});

	it("AC4 — refresh-kb-links emits zero diagnostics", () => {
		const refreshKbDiagnostics = result.diagnostics.filter((d) => d.path?.endsWith("refresh-kb-links/SKILL.md"));
		expect(refreshKbDiagnostics).toEqual([]);
	});

	it("AC2 spec compliance — every name matches its parent directory", () => {
		for (const skill of result.skills) {
			const parentDir = skill.filePath.split("/").slice(-2, -1)[0];
			expect(skill.name).toBe(parentDir);
		}
	});

	it("Plan-review advisory 3 — no collision diagnostics across the four-skill set", () => {
		const collisions = result.diagnostics.filter((d) => d.type === "collision");
		expect(collisions).toEqual([]);
	});
});
