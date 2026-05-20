// health-check.ts — shared runHealthCheck() function for /forge:health command
// and /forge:init post-Phase-4 health verification.
//
// Per PLAN.md sub-decision #9 (F4 fix): extracted from forge-commands.ts
// so both the /forge:health command handler AND the init handler call this
// function directly. sendUserMessage is NOT used here (skill §198 pitfall).
//
// Implements a programmatic subset of the checks listed in
// forge/forge/commands/health.md. As of FORGE-S23-T07, covers 6/15 checks:
//   1. Config completeness
//   2. KB freshness
//   3. Stale docs (NEW — architecture/*.md files older than STALE_DOCS_THRESHOLD_MS)
//   8. Store integrity
//   9. Modified generated files (NEW — generation-manifest.cjs list --modified)
//  15. Plugin integrity (NEW — native TS hash check against forgeRoot/integrity.json)
//
// Full check output is returned as structured data; the caller formats it for
// display. See forge-cli/doc/health-parity-audit.md for the full parity table.

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

/** Architecture docs older than this are flagged as stale (90 days). */
const STALE_DOCS_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface HealthGap {
	check: string;
	severity: "warning" | "error";
	message: string;
}

export interface HealthCheckResult {
	clean: boolean;
	gaps: HealthGap[];
	configPresent: boolean;
	summary: string;
}

// ── Required config fields ─────────────────────────────────────────────────

const REQUIRED_TOP_LEVEL = ["version", "project", "stack", "commands", "paths"] as const;
const REQUIRED_PROJECT = ["name", "prefix"] as const;
const REQUIRED_COMMANDS = ["test"] as const;
const REQUIRED_PATHS = ["engineering", "store", "workflows", "commands", "templates"] as const;

// ── Main function ──────────────────────────────────────────────────────────

/**
 * Run a programmatic health check on a Forge project.
 *
 * @param cwd - project working directory (where .forge/ lives)
 * @param bundleRoot - path to dist/forge-payload/ (contains tools/)
 * @param forgeRoot - optional path to the installed Forge plugin root (for plugin integrity check)
 */
export async function runHealthCheck(
	cwd: string,
	bundleRoot: string,
	forgeRoot?: string,
): Promise<HealthCheckResult> {
	const gaps: HealthGap[] = [];

	// 1. Config-completeness check
	const configPath = path.join(cwd, ".forge", "config.json");
	let config: Record<string, unknown> | null = null;
	let configPresent = false;

	try {
		const raw = fs.readFileSync(configPath, "utf8");
		config = JSON.parse(raw) as Record<string, unknown>;
		configPresent = true;
	} catch {
		gaps.push({
			check: "config-completeness",
			severity: "error",
			message: ".forge/config.json missing — run /forge:init first",
		});
	}

	if (!configPresent) {
		return {
			clean: false,
			gaps,
			configPresent: false,
			summary: "△ Config missing — run /forge:init first.",
		};
	}

	// Validate required fields
	const configRecord = config as Record<string, unknown>;
	const missingFields: string[] = [];

	for (const field of REQUIRED_TOP_LEVEL) {
		if (!(field in configRecord) || configRecord[field] === "" || configRecord[field] === null) {
			missingFields.push(field);
		}
	}

	if ("project" in configRecord && configRecord.project && typeof configRecord.project === "object") {
		const project = configRecord.project as Record<string, unknown>;
		for (const field of REQUIRED_PROJECT) {
			if (!(field in project) || project[field] === "" || project[field] === null) {
				missingFields.push(`project.${field}`);
			}
		}
	}

	if ("commands" in configRecord && configRecord.commands && typeof configRecord.commands === "object") {
		const commands = configRecord.commands as Record<string, unknown>;
		for (const field of REQUIRED_COMMANDS) {
			if (!(field in commands) || commands[field] === "" || commands[field] === null) {
				missingFields.push(`commands.${field}`);
			}
		}
	}

	if ("paths" in configRecord && configRecord.paths && typeof configRecord.paths === "object") {
		const paths_ = configRecord.paths as Record<string, unknown>;
		for (const field of REQUIRED_PATHS) {
			if (!(field in paths_) || paths_[field] === "" || paths_[field] === null) {
				missingFields.push(`paths.${field}`);
			}
		}
	}

	if (missingFields.length > 0) {
		gaps.push({
			check: "config-completeness",
			severity: "warning",
			message: `Config incomplete — missing fields: ${missingFields.join(", ")}`,
		});
	}

	// 2. KB freshness check
	const calibrationBaseline = configRecord.calibrationBaseline as { masterIndexHash?: string | null } | undefined;

	if (!calibrationBaseline) {
		gaps.push({
			check: "kb-freshness",
			severity: "warning",
			message: "No calibration baseline found — run /forge:calibrate to establish one.",
		});
	} else if (calibrationBaseline.masterIndexHash) {
		const engPath = (configRecord.paths as Record<string, string>)?.engineering ?? "engineering";
		const masterIndexPath = path.join(cwd, engPath, "MASTER_INDEX.md");
		try {
			const content = fs.readFileSync(masterIndexPath, "utf8");
			const currentHash = crypto.createHash("sha256").update(content, "utf8").digest("hex");
			if (currentHash !== calibrationBaseline.masterIndexHash) {
				gaps.push({
					check: "kb-freshness",
					severity: "warning",
					message:
						"KB freshness: MASTER_INDEX.md hash has changed since last calibration — consider /forge:calibrate.",
				});
			}
		} catch {
			gaps.push({
				check: "kb-freshness",
				severity: "warning",
				message: "MASTER_INDEX.md not found — KB docs may not have been written yet.",
			});
		}
	}

	// 3. Store integrity check
	const validateStoreTool = path.join(bundleRoot, "tools", "validate-store.cjs");
	if (fs.existsSync(validateStoreTool)) {
		try {
			execFileSync("node", [validateStoreTool, "--dry-run"], {
				cwd,
				encoding: "utf8",
				timeout: 10000,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (err: unknown) {
			const e = err as { stderr?: string; stdout?: string };
			const detail = e.stderr || e.stdout || "unknown error";
			gaps.push({
				check: "store-integrity",
				severity: "warning",
				message: `Store integrity check failed: ${detail.trim().slice(0, 200)}`,
			});
		}
	}

	// 4. Stale docs check — engineering/architecture/*.md files older than 90 days
	// This check runs regardless of .forge/ presence (only needs cwd + engPath).
	gaps.push(...checkStaleDocs(cwd, configRecord));

	// 5. Modified generated files check — generation-manifest.cjs list --modified
	// Only runs when config is present (manifest lives in .forge/).
	gaps.push(...checkModifiedGeneratedFiles(cwd, bundleRoot));

	// 6. Plugin integrity check — native TS hash check against forgeRoot/integrity.json
	// Only runs when forgeRoot is provided.
	if (forgeRoot) {
		gaps.push(...checkPluginIntegrity(forgeRoot));
	}

	const clean = gaps.length === 0;
	const summary = clean ? "〇 /forge:health: clean." : `△ /forge:health: ${gaps.length} gap(s) detected.`;

	return {
		clean,
		gaps,
		configPresent: true,
		summary,
	};
}

// ── Check: Stale docs ──────────────────────────────────────────────────────

/**
 * Check for architecture docs not updated in over 90 days.
 * Returns one HealthGap per stale file.
 * Silently returns [] if the architecture directory does not exist.
 */
export function checkStaleDocs(
	cwd: string,
	config: Record<string, unknown>,
): HealthGap[] {
	const gaps: HealthGap[] = [];
	const engPath =
		(config.paths as Record<string, string> | undefined)?.engineering ?? "engineering";
	const archDir = path.join(cwd, engPath, "architecture");

	if (!fs.existsSync(archDir)) {
		return gaps;
	}

	let files: string[];
	try {
		files = fs.readdirSync(archDir).filter((f) => f.endsWith(".md"));
	} catch {
		return gaps;
	}

	const now = Date.now();
	for (const file of files) {
		const filePath = path.join(archDir, file);
		try {
			const stat = fs.statSync(filePath);
			const ageMs = now - stat.mtimeMs;
			if (ageMs > STALE_DOCS_THRESHOLD_MS) {
				const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
				gaps.push({
					check: "stale-docs",
					severity: "warning",
					message: `${engPath}/architecture/${file} not updated in ${ageDays} days — may be stale. Run /forge:collate to refresh.`,
				});
			}
		} catch {
			// Skip files we can't stat
		}
	}

	return gaps;
}

// ── Check: Modified generated files ───────────────────────────────────────

/**
 * Check for generated files that have been manually edited.
 * Spawns generation-manifest.cjs list --modified from the bundled tools.
 * Returns one HealthGap per modified/missing file.
 * Silently returns [] if the tool is absent.
 */
export function checkModifiedGeneratedFiles(
	cwd: string,
	bundleRoot: string,
): HealthGap[] {
	const gaps: HealthGap[] = [];
	const genManifestTool = path.join(bundleRoot, "tools", "generation-manifest.cjs");

	if (!fs.existsSync(genManifestTool)) {
		return gaps;
	}

	let stdout = "";
	try {
		stdout = execFileSync("node", [genManifestTool, "list", "--modified"], {
			cwd,
			encoding: "utf8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err: unknown) {
		// generation-manifest exits non-zero when modifications are found.
		// Parse stdout from the error object.
		const e = err as { stdout?: string };
		stdout = e.stdout ?? "";
	}

	const lines = stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));

	for (const line of lines) {
		gaps.push({
			check: "modified-generated-files",
			severity: "warning",
			message: `Generated file modified: ${line} — regeneration will warn before overwriting. Run /forge:regenerate to review.`,
		});
	}

	return gaps;
}

// ── Check: Plugin integrity ────────────────────────────────────────────────

/** Shape of integrity.json (subset we consume). */
interface IntegrityManifest {
	version?: string;
	files: Record<string, string>;
}

/**
 * Check plugin files against the integrity.json manifest.
 * Natively implemented in TypeScript — no subprocess required.
 * Returns one HealthGap per modified or missing file.
 * Silently returns [] if forgeRoot is not provided or integrity.json is missing.
 */
export function checkPluginIntegrity(forgeRoot: string): HealthGap[] {
	const gaps: HealthGap[] = [];
	const integrityPath = path.join(forgeRoot, "integrity.json");

	if (!fs.existsSync(integrityPath)) {
		gaps.push({
			check: "plugin-integrity",
			severity: "warning",
			message: "integrity.json not found in forge plugin root — run /forge:update to restore.",
		});
		return gaps;
	}

	let manifest: IntegrityManifest;
	try {
		manifest = JSON.parse(fs.readFileSync(integrityPath, "utf8")) as IntegrityManifest;
	} catch (err: unknown) {
		const e = err as Error;
		gaps.push({
			check: "plugin-integrity",
			severity: "warning",
			message: `integrity.json is not valid JSON: ${e.message}`,
		});
		return gaps;
	}

	if (!manifest.files || typeof manifest.files !== "object") {
		gaps.push({
			check: "plugin-integrity",
			severity: "warning",
			message: "integrity.json has no files section — run /forge:update to restore.",
		});
		return gaps;
	}

	for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
		const absolutePath = path.join(forgeRoot, relativePath);
		if (!fs.existsSync(absolutePath)) {
			gaps.push({
				check: "plugin-integrity",
				severity: "warning",
				message: `Plugin file missing: ${relativePath} — run /forge:update to restore.`,
			});
			continue;
		}
		try {
			const content = fs.readFileSync(absolutePath);
			const actualHash = crypto.createHash("sha256").update(content).digest("hex");
			if (actualHash !== expectedHash) {
				gaps.push({
					check: "plugin-integrity",
					severity: "warning",
					message: `Plugin file modified: ${relativePath} — run /forge:update to restore.`,
				});
			}
		} catch {
			gaps.push({
				check: "plugin-integrity",
				severity: "warning",
				message: `Cannot read plugin file: ${relativePath} — permission or I/O error.`,
			});
		}
	}

	return gaps;
}
