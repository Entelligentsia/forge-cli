// Forge root resolver — walks up from cwd looking for `.forge/config.json`,
// then resolves `paths.forgeRoot` (relative paths are resolved against the
// project dir — the parent of `.forge/` — not cwd). Returns null when no
// config is found or when the config is missing/malformed/unreadable. All filesystem reads are wrapped
// in try/catch so a malformed config can never crash the extension.
//
// Pattern modelled on `findNearestProjectAgentsDir` in
// `subagent/agents.ts:96-106`.

import * as fs from "node:fs";
import * as path from "node:path";

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function findNearestForgeConfig(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".forge", "config.json");
		if (isFile(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverForgeRoot(cwd: string = process.cwd()): string | null {
	const configPath = findNearestForgeConfig(cwd);
	if (!configPath) return null;

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

	const forgeRootValue =
		config && typeof config === "object" && "paths" in config
			? (config as { paths?: { forgeRoot?: unknown } }).paths?.forgeRoot
			: undefined;

	if (typeof forgeRootValue !== "string" || forgeRootValue.length === 0) {
		return null;
	}

	// `configPath` is `<projectDir>/.forge/config.json`. Relative `forgeRoot`
	// values in Forge configs are written relative to the project dir (the
	// parent of `.forge/`), not the `.forge/` dir itself. Example dogfood
	// config: `paths.forgeRoot = "./forge/forge"` resolving to
	// `<projectDir>/forge/forge`.
	const projectDir = path.dirname(path.dirname(configPath));
	const resolved = path.isAbsolute(forgeRootValue) ? forgeRootValue : path.resolve(projectDir, forgeRootValue);

	return resolved;
}
