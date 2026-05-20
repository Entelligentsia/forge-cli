// hooks/check-update.ts — Session-start Forge-awareness + project-state sync (FORGE-S23-T05).
//
// Port of forge/forge/hooks/check-update.js functions (1), (3), (4), (5) for the
// pi extension context. Function (2) — version-check throttle (npm + GH dual-probe)
// — is covered by the existing update-check.ts and is NOT duplicated here.
//
// Five functions ported:
//   (1) buildForgeAwarenessMsg  — AC#1: forge-awareness context injection
//   (3) syncForgeRootAndRef     — AC#2, AC#6: distribution-switch detection + forgeRoot/forgeRef sync
//   (4) scanPluginInstallations — AC#3: multi-plugin scanning
//       buildMultiPluginMsg     — AC#3: builds notification from scan results
//   (5) buildPendingMigrationMsg — AC#4: pending-migration state surfacing
//
// Key differences from plugin:
//   - No stdout hook protocol: pi has no `{"additionalContext":"..."}` stdout pipe.
//     All surfacing is via ctx.ui.notify() — callers do the notify, this module
//     returns strings (or null) for testability.
//   - Config-authoritative: forge-cli uses paths.forgeRoot from .forge/config.json
//     as truth; no CLAUDE_PLUGIN_ROOT env var.
//   - forgeRef source: reads <paths.forgeRoot>/.claude-plugin/plugin.json at runtime
//     (live version), not PKG_VERSIONS.bundledForgeVersion (baked at build time).
//   - Plugin-level cache (CLAUDE_PLUGIN_DATA/update-check-cache.json): not used.
//     Only the project-level cache (.forge/update-check-cache.json) is read/written.
//
// All file I/O is wrapped in try/catch — non-fatal. Session-start must never throw.
//
// Plugin parity reference: forge/forge/hooks/check-update.js (read-only — do NOT edit).
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL5 — vendored forge is read-only; check-update.js is reference only.
//   IL6 — no shell-string interpolation; no spawn calls; only Node fs built-in.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CheckUpdateOptions {
	forgeRoot: string;
	configPath: string;
	cwd?: string; // injectable for tests (default: process.cwd())
	homeDir?: string; // injectable for tests (default: os.homedir())
}

export interface ProjectCache {
	migratedFrom?: string;
	localVersion?: string;
	distribution?: string;
	forgeRoot?: string;
	forgeRef?: string;
	updateStatus?: "pending" | "complete";
	pendingReason?: string | null;
	pendingMigrations?: string[];
}

export interface InstallRecord {
	path: string;
	version: string;
	distribution: string;
	scope: "user" | "project" | "unknown";
	enabled: boolean;
}

// ── Distribution detection (ported verbatim from check-update.js) ─────────────

/**
 * Derives the distribution name from a plugin root path.
 * Ported verbatim from forge/forge/hooks/check-update.js `detectDistribution()`.
 *
 * Returns "forge@skillforge" for skillforge-marketplace installs,
 * "forge@forge" for all others (direct forge installs).
 */
export function detectDistribution(root: string): string {
	return root.includes("/cache/skillforge/forge/") || root.includes("/marketplaces/skillforge/forge/")
		? "forge@skillforge"
		: "forge@forge";
}

// ── Project cache I/O ─────────────────────────────────────────────────────────

/**
 * Reads and parses the project-level update-check cache from .forge/update-check-cache.json.
 * Returns null if the file is absent or malformed.
 * Non-fatal — all errors are swallowed.
 */
export function readProjectCache(forgeDir: string): ProjectCache | null {
	try {
		const cacheFile = path.join(forgeDir, "update-check-cache.json");
		const raw = fs.readFileSync(cacheFile, "utf8");
		const parsed = JSON.parse(raw) as ProjectCache;
		return parsed;
	} catch {
		return null;
	}
}

// ── Function (1): Forge-awareness context injection ───────────────────────────

/**
 * Builds a Forge-awareness message if this project has a .forge/config.json.
 * Corresponds to the forge-awareness context injection in check-update.js.
 *
 * In the plugin, this is emitted as {"additionalContext":"..."} to stdout.
 * In forge-cli, the caller does ctx.ui.notify(msg, "info") — pi has no
 * session_start additionalContext protocol.
 *
 * Returns null when configPath is missing or unreadable (e.g. outside-Forge project).
 */
export function buildForgeAwarenessMsg(configPath: string): string | null {
	try {
		if (!fs.existsSync(configPath)) return null;
		return (
			"This project uses Forge AI-SDLC. Engineering knowledge base: engineering/. " +
			"Generated workflows: .forge/workflows/. Sprint and task store: .forge/store/. " +
			"Use the project slash commands (/plan, /implement, /sprint-plan) to drive development. " +
			"Run /forge:health to check knowledge base currency."
		);
	} catch {
		return null;
	}
}

// ── Plugin enabled check (ported from check-update.js) ───────────────────────

/**
 * Returns true if the Forge plugin is enabled in user/project settings.
 * Mirrors isPluginEnabled() from check-update.js.
 */
function isPluginEnabled(pluginPath: string, scope: string, homeDir: string, cwd: string): boolean {
	try {
		const userSettingsPath = path.join(homeDir, ".claude", "settings.json");
		if (fs.existsSync(userSettingsPath)) {
			const userSettings = JSON.parse(fs.readFileSync(userSettingsPath, "utf8")) as Record<string, unknown>;
			if (userSettings.disablePlugin === true) return false;
			const plugins = userSettings.plugins as Record<string, unknown> | undefined;
			if (plugins && plugins.forge === false) return false;
		}

		const projectSettingsPath = path.join(cwd, ".claude", "settings.local.json");
		if (fs.existsSync(projectSettingsPath)) {
			const projectSettings = JSON.parse(fs.readFileSync(projectSettingsPath, "utf8")) as Record<
				string,
				unknown
			>;
			if (projectSettings.disablePlugin === true) return false;
			const plugins = projectSettings.plugins as Record<string, unknown> | undefined;
			if (plugins && plugins.forge === false) return false;
		}

		return true;
	} catch {
		return true; // Non-fatal — assume enabled if cannot read settings
	}
}

// ── Function (4): Multi-plugin scanning ──────────────────────────────────────

/**
 * Scans known plugin locations for all Forge installations.
 * Ported from check-update.js scanPluginInstallations() with injectable options for testing.
 *
 * Returns an array of installation records with version, distribution, scope, enabled status.
 */
export function scanPluginInstallations(opts?: { homeDir?: string; cwd?: string }): InstallRecord[] {
	const installations: InstallRecord[] = [];
	const homeDir = opts?.homeDir ?? os.homedir();
	const cwd = opts?.cwd ?? process.cwd();

	// Candidate paths — user scope (global) and project scope (local)
	// Also scan skillforge subdirectory variant (skillforge/forge/forge)
	const basePaths = [path.join(homeDir, ".claude", "plugins"), path.join(cwd, ".claude", "plugins")];
	const variants = ["cache", "marketplaces"];
	const pluginNames = ["forge/forge", "skillforge/forge/forge"];

	const candidates: string[] = [];
	for (const basePath of basePaths) {
		for (const variant of variants) {
			for (const pluginName of pluginNames) {
				candidates.push(path.join(basePath, variant, pluginName));
			}
		}
	}

	for (const candidate of candidates) {
		try {
			const pluginJsonPath = path.join(candidate, ".claude-plugin", "plugin.json");
			if (!fs.existsSync(pluginJsonPath)) continue;

			const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8")) as { version?: string };
			// Determine scope: project-scope paths start with cwd/.claude (check first to avoid
			// false positives when cwd is a subdirectory of homeDir)
			const isProjectScope = candidate.startsWith(path.join(cwd, ".claude"));
			const isUserScope = candidate.startsWith(path.join(homeDir, ".claude"));
			const scope: "user" | "project" | "unknown" = isProjectScope ? "project" : isUserScope ? "user" : "unknown";
			const enabled = isPluginEnabled(candidate, scope, homeDir, cwd);

			// Avoid duplicates
			if (installations.some((i) => i.path === candidate)) continue;

			installations.push({
				path: candidate,
				version: manifest.version ?? "unknown",
				distribution: detectDistribution(candidate),
				scope,
				enabled,
			});
		} catch {
			// Non-fatal — skip broken installations silently
		}
	}

	return installations;
}

/**
 * Builds a multi-plugin awareness message if multiple Forge installations are detected.
 * Returns null if only one (or zero) installations found.
 */
export function buildMultiPluginMsg(opts: CheckUpdateOptions): string | null {
	try {
		const cwd = opts.cwd ?? process.cwd();
		const homeDir = opts.homeDir ?? os.homedir();
		const allInstallations = scanPluginInstallations({ homeDir, cwd });

		if (allInstallations.length < 2) return null;

		const activeInst = allInstallations.find((i) => i.path === opts.forgeRoot) ?? allInstallations[0];
		if (!activeInst) return null;
		const otherInsts = allInstallations.filter((i) => i.path !== activeInst.path);
		if (otherInsts.length === 0) return null;

		const otherDesc = otherInsts.map((i) => `${i.version} (${i.distribution}, ${i.scope})`).join(", ");
		return `Forge: also installed: ${otherDesc}.`;
	} catch {
		return null;
	}
}

// ── Function (3): Distribution-switch detection + forgeRoot/forgeRef sync ─────

/**
 * Syncs paths.forgeRoot and paths.forgeRef in .forge/config.json if they drift.
 * Detects distribution switches (forge@forge ↔ forge@skillforge) and returns a
 * notification message if the distribution changed; returns null otherwise.
 *
 * Also updates the project-level cache (.forge/update-check-cache.json) with
 * current distribution, forgeRoot, and forgeRef (preserving updateStatus, pendingMigrations).
 *
 * Corresponds to the "Distribution + forgeRoot/forgeRef sync" section in check-update.js.
 */
export function syncForgeRootAndRef(opts: CheckUpdateOptions): string | null {
	try {
		const forgeDir = path.dirname(opts.configPath);
		const currentDistribution = detectDistribution(opts.forgeRoot);

		// Read current local version from the live plugin.json (faithful port of check-update.js §4.2)
		let localVersion = "unknown";
		try {
			const pluginJsonPath = path.join(opts.forgeRoot, ".claude-plugin", "plugin.json");
			const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, "utf8")) as { version?: string };
			localVersion = manifest.version ?? "unknown";
		} catch {
			// Non-fatal — version sync skipped if plugin.json unreadable
		}

		// Sync config.json paths.forgeRoot and paths.forgeRef
		try {
			const cfg = JSON.parse(fs.readFileSync(opts.configPath, "utf8")) as {
				paths?: { forgeRoot?: string; forgeRef?: string };
			};
			if (!cfg.paths) cfg.paths = {};
			let configChanged = false;
			if (cfg.paths.forgeRoot !== opts.forgeRoot) {
				cfg.paths.forgeRoot = opts.forgeRoot;
				configChanged = true;
			}
			if (localVersion !== "unknown" && cfg.paths.forgeRef !== localVersion) {
				cfg.paths.forgeRef = localVersion;
				configChanged = true;
			}
			if (configChanged) {
				fs.writeFileSync(opts.configPath, JSON.stringify(cfg, null, 2) + "\n");
			}
		} catch {
			// Non-fatal — config sync skipped
		}

		// Read project cache for distribution-switch detection
		const projectCache = readProjectCache(forgeDir);
		if (!projectCache) return null;

		const storedRoot = projectCache.forgeRoot;
		const storedDist = projectCache.distribution;
		const switched = storedRoot !== undefined && storedRoot !== opts.forgeRoot;

		let distributionSwitchMsg: string | null = null;

		if (switched && storedDist !== undefined && storedDist !== currentDistribution) {
			const versionNote =
				projectCache.localVersion !== undefined && projectCache.localVersion !== localVersion
					? ` Version: ${projectCache.localVersion} → ${localVersion}.`
					: "";
			distributionSwitchMsg =
				`Forge: plugin distribution switched from ${storedDist} to ${currentDistribution}.${versionNote}` +
				` paths.forgeRoot updated. Run /forge:update to verify migration state.`;
		}

		// Sync distribution + forgeRoot + forgeRef into the project cache whenever they drift.
		// Preserve updateStatus, pendingReason, pendingMigrations via spread (FR-002 parity).
		if (storedRoot !== opts.forgeRoot || storedDist !== currentDistribution) {
			try {
				const updated: ProjectCache = {
					...projectCache,
					distribution: currentDistribution,
					forgeRoot: opts.forgeRoot,
					forgeRef: localVersion,
				};
				const cacheFile = path.join(forgeDir, "update-check-cache.json");
				fs.writeFileSync(cacheFile, JSON.stringify(updated, null, 2) + "\n");
			} catch {
				// Non-fatal
			}
		}

		return distributionSwitchMsg;
	} catch {
		return null;
	}
}

// ── Function (5): Pending-migration state surfacing ───────────────────────────

/**
 * Surfaces a pending-migration warning if the project cache shows updateStatus === "pending".
 * Returns the warning message string, or null if no pending state or cache absent.
 *
 * Corresponds to FR-002 pending-state surfacing in check-update.js.
 */
export function buildPendingMigrationMsg(configPath: string): string | null {
	try {
		const forgeDir = path.dirname(configPath);
		const projectCache = readProjectCache(forgeDir);
		if (!projectCache) return null;
		if (projectCache.updateStatus !== "pending") return null;

		const pendingMigrations = Array.isArray(projectCache.pendingMigrations)
			? projectCache.pendingMigrations.join(", ")
			: "(unknown)";

		return (
			`Forge update is incomplete — pending migration(s): ${pendingMigrations}. ` +
			`Run /forge:update to continue or /forge:migrate to complete.`
		);
	} catch {
		return null;
	}
}
