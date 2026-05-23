// lib/frontmatter-parser.ts — FORGE-S25-T16
//
// Extracted from 10 byte-identical copies of extractPersonaNames() across
// kickoff shim files (approve.ts, collate.ts, commit.ts, enhance.ts,
// implement.ts, plan.ts, retrospective.ts, review-code.ts, review-plan.ts,
// validate.ts). Finding H-1 (Round-2-validation.md).
//
// Parses the YAML frontmatter `deps.personas` array from a workflow markdown
// file. Used by kickoff shims to determine which persona files to load, and by
// lib/manifest-checker.ts to validate that personas are referenced in the body.

/**
 * Extract persona names from a workflow's YAML frontmatter `deps.personas` list.
 *
 * Expects the frontmatter block to begin and end with `---` delimiters.
 * Looks for:
 *   ```yaml
 *   deps:
 *     personas: [architect, engineer]
 *   ```
 *
 * @returns Array of persona name strings, or empty array if not found.
 */
export function extractPersonaNames(workflowMd: string): string[] {
	const lines = workflowMd.split(/\r?\n/);
	if (lines.length === 0 || lines[0] !== "---") return [];
	let inside = false;
	let depsBlock = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (i === 0 && line === "---") {
			inside = true;
			continue;
		}
		if (!inside) break;
		if (line === "---") break;
		if (/^deps\s*:\s*$/.test(line)) {
			depsBlock = true;
			continue;
		}
		const m = /^\s*personas\s*:\s*\[([^\]]*)\]\s*$/.exec(line);
		if (m && (depsBlock || /^\s/.test(line))) {
			return m[1]
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""))
				.filter((s) => s.length > 0);
		}
		if (depsBlock && /^[A-Za-z0-9_-]+\s*:/.test(line) && !/^\s/.test(line)) {
			depsBlock = false;
		}
	}
	return [];
}
