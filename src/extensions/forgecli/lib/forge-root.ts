// Forge root resolver — walks up from cwd looking for `.forge/config.json`,
// then resolves `paths.forgeRoot` (relative paths are resolved against the
// project dir — the parent of `.forge/` — not cwd). Returns null when no
// config is found or when the config is missing/malformed/unreadable. All filesystem reads are wrapped
// in try/catch so a malformed config can never crash the extension.
//
// Pattern modelled on `findNearestProjectAgentsDir` in
// `subagent/agents.ts:96-106`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBundledPayloadRoot } from "./catalog-loader.js";
import { isDirectory, isFile } from "./shared-fs-utils.js";

/**
 * True when `child` is `parent` itself or lives anywhere beneath it.
 * Used to constrain a config-supplied `forgeRoot` to trusted locations.
 */
function isWithinOrEqual(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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

export interface ForgeConfig {
	forgeRoot: string;
	configPath: string;
	/** Set when the configured forgeRoot did not exist and resolution fell
	 *  back to this forgecli's bundled payload (testbench clone-portability:
	 *  tracked configs carry another machine's global npm / plugin-cache
	 *  path). Carries the original dangling path for diagnostics. */
	healedFrom?: string;
	/** Set when the configured forgeRoot resolved to an untrusted location
	 *  (outside the project tree and outside this forgecli's bundled payload)
	 *  and was rejected in favour of the bundled payload. Carries the original
	 *  rejected path for diagnostics. See the containment note in
	 *  discoverForgeConfig. */
	rejectedFrom?: string;
}

/**
 * Discover the forge plugin root AND return the config path so callers can
 * read other config fields (e.g. `project.name`) without re-scanning.
 * Returns null when no `.forge/config.json` is found or it lacks `paths.forgeRoot`.
 */
export function discoverForgeConfig(cwd: string = process.cwd()): ForgeConfig | null {
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

	// Self-heal a dangling forgeRoot (forge-engineering testbench parity):
	// a git-tracked config may carry a path stamped on another machine
	// (global npm prefix, Claude plugin cache). Handing callers a nonexistent
	// root breaks forge_store (tools spawn from forgeRoot/tools) on every
	// fresh clone. Fall back to this forgecli's bundled payload, which always
	// exists in an installed or built package.
	if (!isDirectory(resolved)) {
		const bundled = resolveBundledPayloadRoot();
		if (isDirectory(bundled)) {
			return { forgeRoot: bundled, configPath, healedFrom: resolved };
		}
	}

	// Containment guard (security: clone-and-run RCE — see issue #43).
	// `forgeRoot` selects the directory whose `tools/*.cjs` this process spawns
	// (`lib/run-cjs.ts`) and `require()`s (`hooks/write-guard.ts`). A shared or
	// cloned `.forge/config.json` can therefore point it at attacker-controlled
	// code. We only honour a `forgeRoot` that resolves INSIDE one of the trusted
	// install roots:
	//   (a) the project tree (the parent of `.forge/`) — covers the dogfood
	//       layout `forgeRoot: "./forge/forge"` and any in-project payload,
	//   (b) this forgecli's bundled payload (the trusted installed copy),
	//   (c) the Claude Code plugin cache `<home>/.claude/plugins/` (the common
	//       installed-user case — `forge init` stamps a path under here), plus
	//       its `CLAUDE_CONFIG_DIR` / `CLAUDE_PLUGIN_ROOT` overrides.
	// Trusted roots are matched by absolute path containment (NOT substring), so
	// a spoof like `/tmp/evil/.claude/plugins/...` does not qualify. Anything
	// else (an absolute path elsewhere, a `..`-escape outside the project) is
	// rejected and healed to the bundled payload — the same safe fallback the
	// dangling-path heal above uses. `FORGE_ALLOW_EXTERNAL_ROOT=1` is an explicit
	// opt-out for users who intentionally point forgeRoot at an out-of-tree
	// plugin checkout.
	//
	// Residual: a fully-populated malicious payload committed INSIDE a cloned
	// repo is still trusted under (a) — that is the inherent "you ran this
	// repo's code" boundary (cf. npm lifecycle scripts / Makefiles) and is out
	// of scope for a path-containment guard.
	if (process.env.FORGE_ALLOW_EXTERNAL_ROOT !== "1") {
		const bundled = resolveBundledPayloadRoot();
		const trustedRoots = [projectDir, path.join(os.homedir(), ".claude", "plugins")];
		if (isDirectory(bundled)) trustedRoots.push(bundled);
		if (process.env.CLAUDE_CONFIG_DIR) trustedRoots.push(path.join(process.env.CLAUDE_CONFIG_DIR, "plugins"));
		if (process.env.CLAUDE_PLUGIN_ROOT) trustedRoots.push(process.env.CLAUDE_PLUGIN_ROOT);
		const trusted = trustedRoots.some((root) => isWithinOrEqual(root, resolved));
		if (!trusted) {
			if (isDirectory(bundled)) {
				return { forgeRoot: bundled, configPath, rejectedFrom: resolved };
			}
			// No bundled payload to fall back to: refuse rather than spawn from
			// an untrusted location.
			return null;
		}
	}

	return { forgeRoot: resolved, configPath };
}
