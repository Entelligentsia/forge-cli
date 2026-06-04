// governor-config.ts — project-config reader for the context governor.
// FORGE-BUG-043 PR 2.
//
// The governor previously hardcoded three values that are owned by the
// project's .forge/config.json:
//   project.prefix     — store-ID prefix ("FORGE-…" was baked into the
//                        compaction fact-extraction regex, so any project
//                        with a different prefix — e.g. the CART dogfooding
//                        project that benchmarked the governor — extracted
//                        ZERO store IDs during compaction)
//   paths.store        — sentinel reads assumed ".forge/store"
//   paths.engineering  — warm-tier summary reads assumed "engineering"
//
// loadGovernorProjectConfig reads them once at factory-construction time
// (never per-event) with IL7 semantics: any missing/malformed config falls
// back to the historical defaults, so projects without a config see exactly
// the old behaviour. Read-only — never writes .forge/ (Pack 07).

import * as fs from "node:fs";
import * as path from "node:path";

/** Governor-relevant subset of .forge/config.json. */
export interface GovernorProjectConfig {
	/** Store-ID prefix (project.prefix), e.g. "FORGE", "CART". */
	prefix: string;
	/** Store directory relative to the project cwd (paths.store). */
	storePath: string;
	/** Engineering artifacts directory relative to the project cwd (paths.engineering). */
	engineeringPath: string;
}

const DEFAULTS: GovernorProjectConfig = {
	prefix: "FORGE",
	storePath: ".forge/store",
	engineeringPath: "engineering",
};

/**
 * Read the governor-relevant fields from `<cwd>/.forge/config.json`.
 * Missing cwd, missing file, malformed JSON, or invalid field values fall
 * back to the historical defaults (IL7 — the governor must never throw or
 * change behaviour for projects without a valid config).
 *
 * The prefix is validated to a conservative identifier shape so a corrupt
 * value can never inject regex syntax into the fact-extraction patterns.
 */
export function loadGovernorProjectConfig(cwd: string | undefined): GovernorProjectConfig {
	if (!cwd) return DEFAULTS;
	try {
		const raw = fs.readFileSync(path.join(cwd, ".forge", "config.json"), "utf8");
		const cfg = JSON.parse(raw) as {
			project?: { prefix?: unknown };
			paths?: { store?: unknown; engineering?: unknown };
		};
		if (typeof cfg !== "object" || cfg === null) return DEFAULTS;

		const rawPrefix = cfg.project?.prefix;
		const prefix =
			typeof rawPrefix === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(rawPrefix)
				? rawPrefix
				: DEFAULTS.prefix;

		const rawStore = cfg.paths?.store;
		const storePath =
			typeof rawStore === "string" && rawStore.length > 0 ? rawStore : DEFAULTS.storePath;

		const rawEngineering = cfg.paths?.engineering;
		const engineeringPath =
			typeof rawEngineering === "string" && rawEngineering.length > 0
				? rawEngineering
				: DEFAULTS.engineeringPath;

		return { prefix, storePath, engineeringPath };
	} catch {
		return DEFAULTS;
	}
}
