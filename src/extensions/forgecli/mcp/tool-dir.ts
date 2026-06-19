// mcp/tool-dir.ts — resolves the .forge/tools/ directory from project root.
//
// Reads .forge/config.json → paths.forgeRoot → joins "tools/".
// Does NOT import store-resolver.ts (would pull pi types into the bundle).
// Inline reimplementation of the same forgeRoot walk as store-resolver.resolveToolDir.

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Resolve the directory containing the Forge .cjs tools.
 *
 * Reads .forge/config.json from projectRoot to find paths.forgeRoot,
 * then resolves <forgeRoot>/tools/ (or <forgeRoot>/ if tools/ subdir is absent).
 * Falls back to projectRoot/.forge/tools/ on any read/parse failure.
 */
export function resolveForgeToolDir(projectRoot: string): string {
	const fallback = path.join(projectRoot, ".forge", "tools");
	try {
		const configPath = path.join(projectRoot, ".forge", "config.json");
		const raw = fs.readFileSync(configPath, "utf8");
		const config = JSON.parse(raw) as { paths?: { forgeRoot?: string } };
		const forgeRoot = config.paths?.forgeRoot;
		if (typeof forgeRoot !== "string") {
			return fallback;
		}
		// forgeRoot may be relative (e.g. "./forge/forge") or absolute
		const resolvedForgeRoot = path.resolve(projectRoot, forgeRoot);
		const nested = path.join(resolvedForgeRoot, "tools");
		if (fs.existsSync(nested) && fs.statSync(nested).isDirectory()) {
			return nested;
		}
		// Older layout: tools at forgeRoot level
		return resolvedForgeRoot;
	} catch {
		return fallback;
	}
}
