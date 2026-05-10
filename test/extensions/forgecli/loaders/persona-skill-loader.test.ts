// Unit tests for the central persona/skill loader (FORGE-S20-T02).
//
// Conventions mirror test/forge-root.test.ts: tmp-dir per-test fixtures via
// fs.mkdtempSync + afterEach cleanup; absolute paths only.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	loadPersona,
	loadSkill,
	PersonaSkillLoaderError,
} from "../../../../src/extensions/forgecli/loaders/persona-skill-loader.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-loader-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function scaffoldProject(): string {
	// Create <tmpRoot>/proj/.forge/{config.json,personas,skills}.
	const proj = path.join(tmpRoot, "proj");
	fs.mkdirSync(path.join(proj, ".forge", "personas"), { recursive: true });
	fs.mkdirSync(path.join(proj, ".forge", "skills"), { recursive: true });
	fs.writeFileSync(
		path.join(proj, ".forge", "config.json"),
		JSON.stringify({ paths: { forgeRoot: "./forge/forge" } }),
		"utf8",
	);
	return proj;
}

describe("loadPersona", () => {
	it("happy path: persona loads and parses body, capabilities, frontmatter", () => {
		const proj = scaffoldProject();
		const body = [
			"---",
			'role: "Forge Engineer"',
			"id: engineer",
			"---",
			"🌱 **Forge Engineer** — I plan what will be built.",
			"",
			"## Capabilities",
			"",
			"- Read and write code",
			"- Run tests",
			"",
			"## Other",
			"",
			"- ignored bullet",
		].join("\n");
		fs.writeFileSync(path.join(proj, ".forge", "personas", "engineer.md"), body, "utf8");

		const p = loadPersona("engineer", { projectRoot: proj });
		expect(p.name).toBe("engineer");
		expect(p.filePath).toBe(fs.realpathSync(path.join(proj, ".forge", "personas", "engineer.md")));
		expect(p.identity).toBe("🌱 **Forge Engineer** — I plan what will be built.");
		expect(p.frontmatter.role).toBe("Forge Engineer");
		expect(p.frontmatter.id).toBe("engineer");
		expect(p.capabilities).toEqual(["Read and write code", "Run tests"]);
		expect(p.body).toContain("## Capabilities");
	});

	it("frontmatter-less persona loads (matches existing .forge/personas/*.md format)", () => {
		const proj = scaffoldProject();
		const body = ["🌱 **Forge Engineer** — I plan things.", "", "## Capabilities", "", "- One"].join("\n");
		fs.writeFileSync(path.join(proj, ".forge", "personas", "noFm.md"), body, "utf8");

		const p = loadPersona("noFm", { projectRoot: proj });
		expect(p.frontmatter).toEqual({});
		expect(p.identity).toBe("🌱 **Forge Engineer** — I plan things.");
		expect(p.capabilities).toEqual(["One"]);
	});

	it("missing persona file → PersonaSkillLoaderError code=missing_file", () => {
		const proj = scaffoldProject();
		expect(() => loadPersona("does-not-exist", { projectRoot: proj })).toThrow(PersonaSkillLoaderError);
		try {
			loadPersona("does-not-exist", { projectRoot: proj });
		} catch (err) {
			expect((err as PersonaSkillLoaderError).code).toBe("missing_file");
		}
	});

	it("invalid frontmatter (unclosed) → code=invalid_frontmatter", () => {
		const proj = scaffoldProject();
		// Opens with --- but never closes.
		const body = ["---", "role: Engineer", "no closing fence", "body line"].join("\n");
		fs.writeFileSync(path.join(proj, ".forge", "personas", "bad.md"), body, "utf8");

		expect(() => loadPersona("bad", { projectRoot: proj })).toThrow(PersonaSkillLoaderError);
		try {
			loadPersona("bad", { projectRoot: proj });
		} catch (err) {
			expect((err as PersonaSkillLoaderError).code).toBe("invalid_frontmatter");
		}
	});

	it("path-traversal name (string) → code=path_traversal", () => {
		const proj = scaffoldProject();
		expect(() => loadPersona("../../../etc/passwd", { projectRoot: proj })).toThrow(PersonaSkillLoaderError);
		try {
			loadPersona("../../../etc/passwd", { projectRoot: proj });
		} catch (err) {
			expect((err as PersonaSkillLoaderError).code).toBe("path_traversal");
		}
	});

	it("path-traversal via symlink escape → code=path_traversal", () => {
		const proj = scaffoldProject();
		// Target file outside the personas dir.
		const outside = path.join(tmpRoot, "outside.md");
		fs.writeFileSync(outside, "# outside\n", "utf8");
		// Create a symlink inside personas/ that points outside.
		const link = path.join(proj, ".forge", "personas", "escape.md");
		try {
			fs.symlinkSync(outside, link);
		} catch (err) {
			// Skip on platforms without symlink permission (e.g. Windows non-admin).
			console.warn("skipping symlink test:", err);
			return;
		}

		expect(() => loadPersona("escape", { projectRoot: proj })).toThrow(PersonaSkillLoaderError);
		try {
			loadPersona("escape", { projectRoot: proj });
		} catch (err) {
			expect((err as PersonaSkillLoaderError).code).toBe("path_traversal");
		}
	});

	it("no project root → code=no_project_root", () => {
		// tmpRoot has no .forge/config.json anywhere up to filesystem root from
		// tmpRoot's perspective (mkdtemp'd siblings are isolated). But /tmp's
		// ancestor / could conceivably contain a stray config — unlikely on test
		// runners, but to be safe we point cwd at a deeply-nested path inside an
		// empty subtree and rely on the assertion that resolveProjectRoot reads
		// `.forge/config.json` only if it exists.
		const empty = path.join(tmpRoot, "empty", "deep");
		fs.mkdirSync(empty, { recursive: true });
		// We do NOT use `cwd: empty` because if the system happens to have a
		// .forge/config.json in /tmp or a parent, the discovery would find it.
		// Instead we pass projectRoot=undefined and rely on cwd override; we
		// guard by setting cwd to a path with no upward .forge presence on a
		// freshly-made tmp dir.
		try {
			loadPersona("anything", { cwd: empty });
			// If no throw, it means discovery found *some* config — that's a test
			// environment with a stray .forge/config.json upward. Skip rather
			// than fail.
			console.warn("skipping no_project_root test — ancestor .forge/config.json found");
			return;
		} catch (err) {
			expect(err).toBeInstanceOf(PersonaSkillLoaderError);
			expect((err as PersonaSkillLoaderError).code).toBe("no_project_root");
		}
	});
});

describe("loadSkill", () => {
	it("happy path: skill loads and parses capabilities", () => {
		const proj = scaffoldProject();
		const body = [
			"# Engineer Skills",
			"",
			"## Capabilities",
			"",
			"- Plan tasks",
			"- Implement code",
			"- Write tests",
		].join("\n");
		fs.writeFileSync(path.join(proj, ".forge", "skills", "engineer-skills.md"), body, "utf8");

		const s = loadSkill("engineer-skills", { projectRoot: proj });
		expect(s.name).toBe("engineer-skills");
		expect(s.capabilities).toEqual(["Plan tasks", "Implement code", "Write tests"]);
		expect(s.frontmatter).toEqual({});
		expect(s.body).toContain("# Engineer Skills");
	});

	it("missing skill file → code=missing_file", () => {
		const proj = scaffoldProject();
		expect(() => loadSkill("not-here", { projectRoot: proj })).toThrow(PersonaSkillLoaderError);
		try {
			loadSkill("not-here", { projectRoot: proj });
		} catch (err) {
			expect((err as PersonaSkillLoaderError).code).toBe("missing_file");
		}
	});
});
