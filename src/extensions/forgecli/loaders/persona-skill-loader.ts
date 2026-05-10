// Central persona/skill loader — FORGE-S20-T02.
//
// Single canonical surface for reading persona and skill markdown files from
// the user's `.forge/personas/` and `.forge/skills/` directories. Future
// kickoff handlers (T04 /forge:enhance, T05 /forge:plan, T06 /forge:implement)
// load typed Persona/Skill records through this module instead of issuing
// ad-hoc fs.readFile calls. The smoke gate locks the invariant in place.
//
// Path resolution anchors at the **project root** containing `.forge/`, not
// at `forgeRoot` (which points at the bundled plugin source — `.forge/personas/`
// is a project-local generated directory).
//
// Iron Law 6 (no shell-string interpolation): all I/O is via fs synchronous
// APIs with absolute paths constructed by `path.join`/`path.resolve`. No
// external process invocation.
// Iron Law 7 (no silent continuation): every failure mode raises a typed
// `PersonaSkillLoaderError` with an explicit `code`.

import * as fs from "node:fs";
import * as path from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

import { discoverForgeConfig } from "../forge-root.js";

// ── TypeBox schemas ──────────────────────────────────────────────────────

export const PersonaSchema = Type.Object({
	name: Type.String(),
	filePath: Type.String(),
	identity: Type.String(),
	body: Type.String(),
	capabilities: Type.Array(Type.String()),
	frontmatter: Type.Record(Type.String(), Type.Unknown()),
});
export type Persona = Static<typeof PersonaSchema>;

export const SkillSchema = Type.Object({
	name: Type.String(),
	filePath: Type.String(),
	body: Type.String(),
	capabilities: Type.Array(Type.String()),
	frontmatter: Type.Record(Type.String(), Type.Unknown()),
});
export type Skill = Static<typeof SkillSchema>;

// ── Errors ───────────────────────────────────────────────────────────────

export type PersonaSkillLoaderErrorCode =
	| "missing_file"
	| "invalid_frontmatter"
	| "path_traversal"
	| "no_project_root"
	| "validation_failed";

export class PersonaSkillLoaderError extends Error {
	public readonly code: PersonaSkillLoaderErrorCode;
	constructor(code: PersonaSkillLoaderErrorCode, message: string) {
		super(message);
		this.name = "PersonaSkillLoaderError";
		this.code = code;
	}
}

// ── Options ──────────────────────────────────────────────────────────────

export interface LoaderOptions {
	/** Override project root (the directory containing `.forge/`). */
	projectRoot?: string;
	/** cwd to start `.forge/config.json` discovery from. Defaults to `process.cwd()`. */
	cwd?: string;
}

// ── Project-root discovery ───────────────────────────────────────────────

function resolveProjectRoot(opts: LoaderOptions | undefined): string {
	if (opts?.projectRoot) return opts.projectRoot;
	const cwd = opts?.cwd ?? process.cwd();
	const cfg = discoverForgeConfig(cwd);
	if (!cfg) {
		throw new PersonaSkillLoaderError(
			"no_project_root",
			`No .forge/config.json found walking up from ${cwd}. ` +
				"Run /forge:init to scaffold the project, or pass `projectRoot` explicitly.",
		);
	}
	// configPath = <projectDir>/.forge/config.json → projectDir = parent of .forge/
	return path.dirname(path.dirname(cfg.configPath));
}

// ── Name validation (defence in depth) ───────────────────────────────────

function validateName(name: string, kind: "persona" | "skill"): void {
	if (typeof name !== "string" || name.length === 0) {
		throw new PersonaSkillLoaderError("path_traversal", `${kind} name must be a non-empty string`);
	}
	if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
		throw new PersonaSkillLoaderError(
			"path_traversal",
			`${kind} name contains path separators: ${JSON.stringify(name)}`,
		);
	}
	const parts = name.split(/[/\\]/);
	for (const p of parts) {
		if (p === ".." || p === "." || p === "") {
			throw new PersonaSkillLoaderError(
				"path_traversal",
				`${kind} name contains traversal segment: ${JSON.stringify(name)}`,
			);
		}
	}
}

// ── Realpath confinement check ───────────────────────────────────────────

function assertWithinDir(realFile: string, realDir: string, kind: "persona" | "skill"): void {
	const prefix = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
	if (!realFile.startsWith(prefix)) {
		throw new PersonaSkillLoaderError("path_traversal", `${kind} path escapes ${realDir}: resolved to ${realFile}`);
	}
}

// ── Frontmatter parser (minimal) ─────────────────────────────────────────

interface ParsedDoc {
	frontmatter: Record<string, unknown>;
	body: string;
}

function parseFrontmatter(content: string): ParsedDoc {
	// Normalise CRLF for line-based parsing while preserving body intact below.
	const lines = content.split(/\r?\n/);
	if (lines.length === 0 || lines[0] !== "---") {
		return { frontmatter: {}, body: content };
	}
	const fm: Record<string, unknown> = {};
	let i = 1;
	let closed = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (line === "---") {
			closed = true;
			i++;
			break;
		}
		// Allow blank lines inside frontmatter.
		if (line.trim() === "") continue;
		const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
		if (!m) {
			throw new PersonaSkillLoaderError(
				"invalid_frontmatter",
				`Malformed frontmatter line ${i + 1}: ${JSON.stringify(line)}`,
			);
		}
		const value = m[2].trim();
		// Strip matching surrounding quotes if present.
		let parsed: string = value;
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			parsed = value.slice(1, -1);
		}
		fm[m[1]] = parsed;
	}
	if (!closed) {
		throw new PersonaSkillLoaderError("invalid_frontmatter", "Frontmatter block opened with `---` but never closed");
	}
	const body = lines.slice(i).join("\n");
	return { frontmatter: fm, body };
}

// ── Capability + identity extraction ─────────────────────────────────────

function extractCapabilities(body: string): string[] {
	const lines = body.split(/\r?\n/);
	const heading = /^##\s+Capabilities\s*$/;
	const nextSection = /^##\s+\S/;
	const bullet = /^[-*]\s+(.+)$/;
	const out: string[] = [];
	let inSection = false;
	for (const line of lines) {
		if (!inSection) {
			if (heading.test(line)) inSection = true;
			continue;
		}
		if (nextSection.test(line)) break;
		const m = bullet.exec(line);
		if (m) out.push(m[1].trim());
	}
	return out;
}

function extractIdentity(body: string): string {
	for (const line of body.split(/\r?\n/)) {
		if (line.trim().length > 0) return line.trim();
	}
	return "";
}

// ── Internal generic load ────────────────────────────────────────────────

function loadFile(
	kind: "persona" | "skill",
	subdir: "personas" | "skills",
	name: string,
	opts: LoaderOptions | undefined,
): { filePath: string; doc: ParsedDoc } {
	validateName(name, kind);
	const projectRoot = resolveProjectRoot(opts);
	const baseDir = path.join(projectRoot, ".forge", subdir);
	const candidate = path.join(baseDir, `${name}.md`);

	// Realpath the *directory* first — it must exist for confinement check.
	let realDir: string;
	try {
		realDir = fs.realpathSync(baseDir);
	} catch {
		throw new PersonaSkillLoaderError("missing_file", `${kind} directory does not exist: ${baseDir}`);
	}

	let realFile: string;
	try {
		realFile = fs.realpathSync(candidate);
	} catch {
		throw new PersonaSkillLoaderError("missing_file", `${kind} file not found: ${candidate}`);
	}

	assertWithinDir(realFile, realDir, kind);

	let raw: string;
	try {
		raw = fs.readFileSync(realFile, "utf8");
	} catch (err) {
		const e = err as { message?: string };
		throw new PersonaSkillLoaderError(
			"missing_file",
			`Failed to read ${kind} file ${realFile}: ${e.message ?? "unknown"}`,
		);
	}

	return { filePath: realFile, doc: parseFrontmatter(raw) };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Load a Persona record from `<projectRoot>/.forge/personas/<name>.md`.
 *
 * `name` is the filename stem (e.g. `"engineer"` for `engineer.md`). It must
 * not contain path separators or traversal segments — invalid names raise
 * `PersonaSkillLoaderError` with `code: "path_traversal"`.
 */
export function loadPersona(name: string, opts?: LoaderOptions): Persona {
	const { filePath, doc } = loadFile("persona", "personas", name, opts);
	const persona: Persona = {
		name,
		filePath,
		identity: extractIdentity(doc.body),
		body: doc.body,
		capabilities: extractCapabilities(doc.body),
		frontmatter: doc.frontmatter,
	};
	if (!Value.Check(PersonaSchema, persona)) {
		const errs = [...Value.Errors(PersonaSchema, persona)].map((e) => e.message);
		throw new PersonaSkillLoaderError(
			"validation_failed",
			`Persona ${name} failed schema validation: ${errs.join("; ")}`,
		);
	}
	return persona;
}

/**
 * Load a Skill record from `<projectRoot>/.forge/skills/<name>.md`.
 *
 * `name` is the filename stem. The Forge convention names skill files
 * `<noun>-skills.md` (e.g. `engineer-skills.md`); callers pass the full stem
 * including the `-skills` suffix. The loader does not auto-append it.
 */
export function loadSkill(name: string, opts?: LoaderOptions): Skill {
	const { filePath, doc } = loadFile("skill", "skills", name, opts);
	const skill: Skill = {
		name,
		filePath,
		body: doc.body,
		capabilities: extractCapabilities(doc.body),
		frontmatter: doc.frontmatter,
	};
	if (!Value.Check(SkillSchema, skill)) {
		const errs = [...Value.Errors(SkillSchema, skill)].map((e) => e.message);
		throw new PersonaSkillLoaderError(
			"validation_failed",
			`Skill ${name} failed schema validation: ${errs.join("; ")}`,
		);
	}
	return skill;
}
