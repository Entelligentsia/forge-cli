// lib/catalog-helpers.ts — FORGE-S25-T16
//
// Extracted from 3 byte-identical (modulo name suffix) pairs of
// readPersonaDir / readPipelineNames across orchestrators:
//   - run-task.ts:47   readPersonaDir      / readPipelineNames
//   - run-sprint.ts:73 readPersonaDirSprint / readPipelineNamesSprint
//   - fix-bug.ts:61    readPersonaDirBug    / readPipelineNamesBug
// Findings H-4 (Round-2-validation.md), N-H-G, N-H-F (Pass-3).
//
// Note on N-H-F: calibrate.ts uses readdirSync at line 214 to scan sprint store
// JSON files — a different use case (store scanning, not persona-dir enumeration).
// calibrate.ts is NOT migrated to this lib.

import * as fs from "node:fs";

/**
 * List persona names available in a `.forge/personas/` directory.
 * Returns basenames without `.md` extension, excluding skill files (`-skills.md`).
 * Returns empty array if the directory cannot be read (non-existent or permission error).
 */
export function readPersonaDir(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".md") && !f.endsWith("-skills.md"))
			.map((f) => f.replace(/\.md$/, ""));
	} catch {
		return [];
	}
}

/**
 * List pipeline names from a `.forge/config.json` file.
 * Returns the keys of the `pipelines` object if present.
 * Returns empty array if `pipelines` is present but empty.
 * Returns null if the `pipelines` key is absent or the file cannot be read.
 */
export function readPipelineNames(forgeCfgPath: string): string[] | null {
	try {
		const raw = fs.readFileSync(forgeCfgPath, "utf-8");
		const cfg = JSON.parse(raw) as unknown;
		if (cfg && typeof cfg === "object" && "pipelines" in cfg) {
			const pipelines = (cfg as { pipelines?: unknown }).pipelines;
			if (pipelines && typeof pipelines === "object") return Object.keys(pipelines);
			return [];
		}
		return null;
	} catch {
		return null;
	}
}
