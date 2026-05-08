// health-check.ts — shared runHealthCheck() function for /forge:health command
// and /forge:init post-Phase-4 health verification.
//
// Per PLAN.md sub-decision #9 (F4 fix): extracted from forge-commands.ts
// so both the /forge:health command handler AND the init handler call this
// function directly. sendUserMessage is NOT used here (skill §198 pitfall).
//
// Implements a programmatic subset of the checks listed in
// forge/forge/commands/health.md (config-completeness + KB freshness +
// store integrity). Full check output is returned as structured data;
// the caller formats it for display.

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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
 * @param bundleRoot - path to dist/forge-payload/ (contains .tools/)
 */
export async function runHealthCheck(cwd: string, bundleRoot: string): Promise<HealthCheckResult> {
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
	const validateStoreTool = path.join(bundleRoot, ".tools", "validate-store.cjs");
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

	const clean = gaps.length === 0;
	const summary = clean ? "〇 /forge:health: clean." : `△ /forge:health: ${gaps.length} gap(s) detected.`;

	return {
		clean,
		gaps,
		configPresent: true,
		summary,
	};
}
