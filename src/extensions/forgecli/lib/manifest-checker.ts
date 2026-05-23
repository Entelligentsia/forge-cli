// lib/manifest-checker.ts — FORGE-S25-T16
//
// Extracted from 9 byte-identical copies of checkMaterialization() across
// kickoff shim files (approve.ts, collate.ts, commit.ts, enhance.ts,
// implement.ts, plan.ts, review-code.ts, review-plan.ts, validate.ts).
// Finding H-2 (Round-2-validation.md).
//
// The 3 orchestrators (run-task.ts, run-sprint.ts, fix-bug.ts) already imported
// checkMaterialization from plan.ts. After this extraction they import from here.
//
// N-H-E: fix-bug.ts:725 intentionally skips checkMaterialization for fix_bug.md.
// This is a call-site decision in fix-bug.ts, not a function decision — the lib
// function is unaware of this skip and must NOT encode it.

import { extractPersonaNames } from "./frontmatter-parser.js";

/**
 * Result of a workflow materialization check.
 * `ok` is true iff all required Pack-06 markers are present.
 * `missing` lists the human-readable names of any absent markers.
 */
export interface MaterializationCheck {
	ok: boolean;
	missing: string[];
}

/**
 * Verify that a workflow markdown file contains the four Pack-06 materialization
 * markers required by the forge-cli kickoff shims:
 *   1. "Store-Write Verification" — confirms write discipline section.
 *   2. "Iron Laws" — confirms iron laws section.
 *   3. "forge_store" — confirms tool reference.
 *   4. deps.personas declared in frontmatter AND at least one persona referenced in body.
 *
 * Note: fix-bug.ts intentionally skips this check for fix_bug.md (N-H-E) because
 * fix_bug.md is orchestrator-owned prose, not a tool-use sub-workflow. That skip
 * lives in the call site (fix-bug.ts:725), not here.
 */
export function checkMaterialization(workflowPath: string, workflowMd: string): MaterializationCheck {
	const missing: string[] = [];

	if (!workflowMd.includes("Store-Write Verification")) {
		missing.push("Store-Write Verification");
	}
	if (!workflowMd.includes("Iron Laws")) {
		missing.push("Iron Laws");
	}
	if (!workflowMd.includes("forge_store")) {
		missing.push("forge_store");
	}

	const personas = extractPersonaNames(workflowMd);
	if (personas.length === 0) {
		missing.push("deps.personas: declaration");
	} else {
		const bodyStart = (() => {
			if (!workflowMd.startsWith("---\n") && !workflowMd.startsWith("---\r\n")) return 0;
			const re = /\r?\n---\r?\n/;
			const m = re.exec(workflowMd);
			return m ? m.index + m[0].length : 0;
		})();
		const body = workflowMd.slice(bodyStart);

		const anyHit = personas.some((name) => {
			if (!name) return false;
			const tokenRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
			return body.includes(`${name}.md`) || tokenRegex.test(body);
		});
		if (!anyHit) {
			missing.push(`persona file path (${personas.join(", ")})`);
		}
	}

	void workflowPath;
	return { ok: missing.length === 0, missing };
}
