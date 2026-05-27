// forge-init/verifiers.ts — per-phase deliverable verification helpers (FORGE-S26-T17)
//
// Thin async wrappers over the shared `verify-phase.cjs` plugin tool.
// Each function calls `verify-phase.cjs` via execFileAsync, parses the JSON
// output, and returns a VerifyResult. Exit code 0 → ok=true; exit code 1 →
// ok=false with parsed JSON; any other error → ok=false with reason.
//
// The VerifyResult interface is defined here (authoritative home after
// phase-descriptors.ts deletion) and re-exported for all consumers.
//
// Iron Law 6: execFileAsync with argv arrays — no shell-string interpolation.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileAsync } from "../lib/exec-helpers.js";

export interface VerifyResult {
	ok: boolean;
	missing: string[];
	reason?: string;
}

/** Absolute path to verify-phase.cjs in the bundled forge-payload. */
function resolveVerifyPhaseTool(cwd: string): string {
	// Try forgeRoot from config.json first (populated after Phase 4)
	let forgeRoot = "";
	try {
		const cfg = JSON.parse(
			fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8"),
		) as { paths?: { forgeRoot?: string } };
		forgeRoot = cfg.paths?.forgeRoot ?? "";
	} catch {
		// fall through — forgeRoot stays ""
	}
	if (forgeRoot) {
		return path.join(forgeRoot, "tools", "verify-phase.cjs");
	}
	// Fallback: resolve from this file's location
	// dist/extensions/forgecli/forge-init/verifiers.js
	// → dist/extensions/forgecli/ → dist/extensions/ → dist/ → <pkg-root>/
	// → dist/forge-payload/tools/
	const thisDir = path.dirname(fileURLToPath(import.meta.url));
	const pkgRoot = path.resolve(thisDir, "..", "..", "..", "..");
	return path.join(pkgRoot, "dist", "forge-payload", "tools", "verify-phase.cjs");
}

/** Internal: run verify-phase.cjs with given args and parse result. */
async function runVerifyPhase(cwd: string, args: string[]): Promise<VerifyResult> {
	const toolPath = resolveVerifyPhaseTool(cwd);
	try {
		await execFileAsync("node", [toolPath, ...args], { cwd, encoding: "utf8" });
		// exit 0 — pass
		return { ok: true, missing: [] };
	} catch (err: unknown) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		// exit code 1 — fail, JSON on stdout
		if (e.code === 1 && e.stdout) {
			try {
				const parsed = JSON.parse(e.stdout) as { ok: boolean; missing: string[]; reason?: string };
				return { ok: false, missing: parsed.missing ?? [], reason: parsed.reason };
			} catch {
				return { ok: false, missing: [], reason: `verify-phase.cjs returned non-parseable output: ${e.stdout}` };
			}
		}
		// exit code 2 or other error
		return {
			ok: false,
			missing: [],
			reason: `verify-phase.cjs failed: ${e.stderr ?? e.message ?? "unknown error"}`,
		};
	}
}

/**
 * Verify Phase 1 deliverable: `.forge/config.json` exists and contains all required fields.
 *
 * Async wrapper over `verify-phase.cjs --phase 1`.
 */
export async function verifyPhase1(cwd: string): Promise<VerifyResult> {
	return runVerifyPhase(cwd, ["--phase", "1"]);
}

/**
 * Verify Phase 1 foundation fields only: `project.name` and `project.prefix`.
 *
 * Async wrapper over `verify-phase.cjs --phase 1 --foundation-only`.
 */
export async function verifyPhase1Foundation(cwd: string): Promise<VerifyResult> {
	return runVerifyPhase(cwd, ["--phase", "1", "--foundation-only"]);
}

/**
 * Verify Phase 2 deliverable: 7 architecture KB docs exist under `kbPath/architecture/`.
 *
 * Async wrapper over `verify-phase.cjs --phase 2 --kb-path <kbPath>`.
 */
export async function verifyPhase2(cwd: string, kbPath: string): Promise<VerifyResult> {
	return runVerifyPhase(cwd, ["--phase", "2", "--kb-path", kbPath]);
}

/**
 * Verify Phase 3 deliverable: all four `.forge/` subdirectories contain at least one file.
 *
 * Async wrapper over `verify-phase.cjs --phase 3`.
 */
export async function verifyPhase3(cwd: string): Promise<VerifyResult> {
	return runVerifyPhase(cwd, ["--phase", "3"]);
}
