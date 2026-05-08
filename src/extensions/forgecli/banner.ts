// Banner helpers — reads .forge/config.json for project metadata.
//
// Pure utility module; no side effects on import.

import * as fs from "node:fs";

interface ForgeConfig {
	project?: {
		name?: unknown;
		prefix?: unknown;
	};
}

export interface ProjectMeta {
	name: string;
	prefix: string;
}

/**
 * Read project.name and project.prefix from a `.forge/config.json` path.
 * Returns null when the file is missing, unreadable, malformed, or lacks
 * the required fields. Never throws.
 */
export function readProjectMeta(configPath: string): ProjectMeta | null {
	let raw: string;
	try {
		raw = fs.readFileSync(configPath, "utf8");
	} catch {
		return null;
	}

	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!config || typeof config !== "object") return null;

	const cfg = config as ForgeConfig;
	const name = cfg.project?.name;
	const prefix = cfg.project?.prefix;

	if (typeof name !== "string" || name.length === 0) return null;
	if (typeof prefix !== "string" || prefix.length === 0) return null;

	return { name, prefix };
}
