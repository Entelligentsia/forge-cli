// forge-init/verifiers.ts — per-phase deliverable verification helpers (FORGE-S25-T23, B-4, N-B-A)
//
// Each verifier reads the filesystem directly rather than accepting a cached config object
// because they run immediately after a phase's `waitForIdle()` — the moment the deliverable
// should have been written. Using a cached pre-phase value would return stale data.

import * as fs from "node:fs";
import * as path from "node:path";

export interface VerifyResult {
	ok: boolean;
	missing: string[];
	reason?: string;
}

/**
 * Verify Phase 1 deliverable: `.forge/config.json` exists and contains all required fields.
 *
 * Called immediately after the Phase-1 agent's `waitForIdle()` completes. Reads config.json
 * directly — intentionally does NOT use a cached value because Phase 1 writes this file.
 */
export function verifyPhase1(cwd: string): VerifyResult {
	const configPath = path.join(cwd, ".forge", "config.json");
	if (!fs.existsSync(configPath)) {
		return { ok: false, missing: [".forge/config.json"], reason: "config file not written" };
	}
	let cfg: Record<string, unknown>;
	try {
		cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
	} catch (err: unknown) {
		const e = err as { message?: string };
		return { ok: false, missing: [".forge/config.json"], reason: `JSON parse failed: ${e.message ?? "?"}` };
	}
	const missing: string[] = [];
	if (!cfg.version) missing.push("version");
	const proj = cfg.project as Record<string, unknown> | undefined;
	if (!proj?.name) missing.push("project.name");
	if (!proj?.prefix) missing.push("project.prefix");
	if (!cfg.stack) missing.push("stack");
	if (!cfg.commands) missing.push("commands");
	const paths = cfg.paths as Record<string, unknown> | undefined;
	if (!paths?.engineering) missing.push("paths.engineering");
	if (!paths?.store) missing.push("paths.store");
	if (!paths?.workflows) missing.push("paths.workflows");
	return { ok: missing.length === 0, missing };
}

/**
 * Verify Phase 2 deliverable: 7 architecture KB docs exist under `kbPath/architecture/`.
 */
export function verifyPhase2(cwd: string, kbPath: string): VerifyResult {
	const archDocs = ["stack", "processes", "database", "routing", "deployment", "entity-model", "stack-checklist"];
	const missing: string[] = [];
	for (const d of archDocs) {
		if (!fs.existsSync(path.join(cwd, kbPath, "architecture", `${d}.md`))) {
			missing.push(`${kbPath}/architecture/${d}.md`);
		}
	}
	return { ok: missing.length === 0, missing };
}

/**
 * Verify Phase 3 deliverable: all four `.forge/` subdirectories contain at least one file.
 */
export function verifyPhase3(cwd: string): VerifyResult {
	const dirs = ["workflows", "personas", "skills", "templates"];
	const missing: string[] = [];
	for (const d of dirs) {
		const dir = path.join(cwd, ".forge", d);
		let count = 0;
		try {
			count = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".json")).length;
		} catch {
			count = 0;
		}
		if (count === 0) missing.push(`.forge/${d}/ (empty)`);
	}
	return { ok: missing.length === 0, missing };
}
