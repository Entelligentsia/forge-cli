// init-context.ts — project-name discovery, project-context.json construction,
// and calibration baseline computation for /forge:init.
//
// Per INIT_PARITY_SPEC.md §9 and PLAN.md Phase C.
// Iron Law 6: no shell-string interpolation.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Project name discovery ─────────────────────────────────────────────────

/**
 * Discover project name from package.json:name, falling back to cwd basename.
 *
 * Tries to read <cwd>/package.json and parse the `name` field. If the file is
 * absent, malformed, or missing the name field, returns `path.basename(cwd)`.
 */
export function discoverProjectName(cwd: string): string {
	const pkgPath = path.join(cwd, "package.json");
	try {
		const raw = fs.readFileSync(pkgPath, "utf8");
		const pkg = JSON.parse(raw) as unknown;
		if (
			pkg &&
			typeof pkg === "object" &&
			"name" in pkg &&
			typeof (pkg as Record<string, unknown>).name === "string"
		) {
			const name = (pkg as Record<string, string>).name;
			if (name.trim()) return name.trim();
		}
	} catch {
		// ENOENT or JSON parse error — fall through to basename
	}
	return path.basename(cwd);
}

// ── ProjectContext types ───────────────────────────────────────────────────

export interface ProjectContextProject {
	name: string;
	prefix: string;
	description?: string;
	stack?: string[];
	commands?: {
		test?: string;
		build?: string;
		deploy?: string;
	};
}

export interface ProjectContextArchitecture {
	frameworks?: {
		backend?: string;
		frontend?: string;
		database?: string;
	};
	dataAccess?: string;
	deployment?: string;
	entrypoints?: string[];
}

export interface ProjectContextWorkflow {
	testCommand?: string;
	lintCommand?: string;
	buildCommand?: string;
}

export interface ProjectContextKnowledgeBase {
	path?: string;
	indexFile?: string;
}

export interface ProjectContext {
	project: ProjectContextProject;
	architecture?: ProjectContextArchitecture;
	workflow?: ProjectContextWorkflow;
	knowledgeBase?: ProjectContextKnowledgeBase;
}

/** Minimal discovery results passed from Phase 2 */
export interface DiscoveryResults {
	projectName?: string;
	prefix?: string;
	description?: string;
	stack?: string[];
	testCommand?: string;
	lintCommand?: string;
	buildCommand?: string;
	backendFramework?: string;
	frontendFramework?: string;
	database?: string;
	deployment?: string;
	dataAccess?: string;
	kbPath?: string;
}

export interface ForgeConfig {
	project?: {
		name?: string;
		prefix?: string;
	};
	paths?: {
		engineering?: string;
		forgeRoot?: string;
	};
}

/**
 * Build a ProjectContext from discovery results and forge config.
 *
 * Merges discoveryResults with config data. Config project.name/prefix take
 * precedence over discovery if both are present (config was set interactively).
 */
export function buildProjectContext(discoveryResults: DiscoveryResults, config: ForgeConfig): ProjectContext {
	const name = config.project?.name ?? discoveryResults.projectName ?? "";
	const prefix = config.project?.prefix ?? discoveryResults.prefix ?? "";

	const ctx: ProjectContext = {
		project: {
			name,
			prefix,
		},
	};

	if (discoveryResults.description) {
		ctx.project.description = discoveryResults.description;
	}
	if (discoveryResults.stack && discoveryResults.stack.length > 0) {
		ctx.project.stack = discoveryResults.stack;
	}

	const testCmd = discoveryResults.testCommand ?? "";
	const buildCmd = discoveryResults.buildCommand ?? "";
	const lintCmd = discoveryResults.lintCommand ?? "";
	if (testCmd || buildCmd) {
		ctx.project.commands = {
			...(testCmd ? { test: testCmd } : {}),
			...(buildCmd ? { build: buildCmd } : {}),
		};
	}

	const hasArch =
		discoveryResults.backendFramework ??
		discoveryResults.frontendFramework ??
		discoveryResults.database ??
		discoveryResults.deployment ??
		discoveryResults.dataAccess;
	if (hasArch) {
		ctx.architecture = {};
		const frameworks: ProjectContextArchitecture["frameworks"] = {};
		if (discoveryResults.backendFramework) frameworks.backend = discoveryResults.backendFramework;
		if (discoveryResults.frontendFramework) frameworks.frontend = discoveryResults.frontendFramework;
		if (discoveryResults.database) frameworks.database = discoveryResults.database;
		if (Object.keys(frameworks).length > 0) ctx.architecture.frameworks = frameworks;
		if (discoveryResults.dataAccess) ctx.architecture.dataAccess = discoveryResults.dataAccess;
		if (discoveryResults.deployment) ctx.architecture.deployment = discoveryResults.deployment;
	}

	const hasWorkflow = testCmd || lintCmd || buildCmd;
	if (hasWorkflow) {
		ctx.workflow = {
			...(testCmd ? { testCommand: testCmd } : {}),
			...(lintCmd ? { lintCommand: lintCmd } : {}),
			...(buildCmd ? { buildCommand: buildCmd } : {}),
		};
	}

	const kbPath = discoveryResults.kbPath ?? config.paths?.engineering ?? "engineering";
	ctx.knowledgeBase = {
		path: kbPath,
		indexFile: `${kbPath}/MASTER_INDEX.md`,
	};

	return ctx;
}

/**
 * Validate a ProjectContext object structurally. Throws with a descriptive
 * error if required fields are missing.
 */
export function validateProjectContext(ctx: unknown): asserts ctx is ProjectContext {
	if (!ctx || typeof ctx !== "object") {
		throw new Error("project-context validation failed: not an object");
	}
	const record = ctx as Record<string, unknown>;
	if (!record.project || typeof record.project !== "object") {
		throw new Error("project-context validation failed: missing required field 'project'");
	}
	const project = record.project as Record<string, unknown>;
	if (typeof project.name !== "string" || !project.name.trim()) {
		throw new Error("project-context validation failed: project.name is missing or empty");
	}
	if (typeof project.prefix !== "string" || !project.prefix.trim()) {
		throw new Error("project-context validation failed: project.prefix is missing or empty");
	}
}

/**
 * Write project-context.json to <cwd>/.forge/project-context.json
 */
export function writeProjectContext(cwd: string, ctx: ProjectContext): void {
	const filePath = path.join(cwd, ".forge", "project-context.json");
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(ctx, null, 2) + "\n", "utf8");
}

// ── Calibration baseline ───────────────────────────────────────────────────

export interface CalibrationBaseline {
	lastCalibrated: string; // ISO 8601
	version: string; // bundled plugin version
	masterIndexHash: string | null; // SHA-256 of MASTER_INDEX.md if present, null otherwise
	sprintsCovered: number; // count of sprint dirs in <kbPath>/sprints/
}

/**
 * Compute a calibration baseline snapshot for /forge:init Phase 2.
 *
 * @param cwd - project working directory
 * @param kbPath - relative path to the knowledge base directory (e.g. "engineering")
 * @param bundledPluginVersion - version string from package.json forge.bundledVersion
 */
export function computeCalibrationBaseline(
	cwd: string,
	kbPath: string,
	bundledPluginVersion: string,
): CalibrationBaseline {
	const baseline: CalibrationBaseline = {
		lastCalibrated: new Date().toISOString(),
		version: bundledPluginVersion,
		masterIndexHash: null,
		sprintsCovered: 0,
	};

	// Compute SHA-256 of MASTER_INDEX.md if it exists
	const masterIndexPath = path.join(cwd, kbPath, "MASTER_INDEX.md");
	try {
		const content = fs.readFileSync(masterIndexPath, "utf8");
		baseline.masterIndexHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
	} catch {
		// File not yet present — leave as null (init just started Phase 2)
	}

	// Count sprint directories
	const sprintsDir = path.join(cwd, kbPath, "sprints");
	try {
		const entries = fs.readdirSync(sprintsDir, { withFileTypes: true });
		baseline.sprintsCovered = entries.filter((e) => e.isDirectory()).length;
	} catch {
		// Sprints dir not yet created — leave as 0
	}

	return baseline;
}
