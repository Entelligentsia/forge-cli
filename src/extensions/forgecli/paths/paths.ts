// Central path resolver for forge-cli user-level and project-level data — FORGE-S20-T11.
//
// Single source of truth for every filesystem location forge-cli reads or
// writes. Call sites MUST import from this module instead of hardcoding
// `os.homedir()`, `XDG_CACHE_HOME`, `.pi/forge-cli`, `.cache/forgecli`, etc.
//
// Layout (post v0.10.0):
//   ~/.pi/forge-cli/                       user root (override via FORGE_CLI_HOME)
//     ├── config.json                      L1 global routing config
//     ├── cache/                           probe + dismiss caches
//     │   ├── update-banner.json
//     │   ├── whats-new-seen.json
//     │   ├── seen.json                    foundry-collision dismissal
//     │   └── drift-seen.json
//     ├── state/                           reserved for future state markers
//     └── .migrated-from-legacy            idempotency marker (set by migrator)
//
//   <cwd>/.pi/forge-cli/                   project root (unchanged)
//
// Themes and agents stay in pi's namespace (~/.pi/agent/themes/,
// ~/.pi/agent/agents/) because pi loads them from getAgentDir() before
// forge-cli's extension hook runs. Those paths are re-exported from this
// module for architectural consistency — call sites still go through
// the resolver, never through a direct pi import.
//
// Legacy paths intentionally derive from the real os.homedir() /
// XDG_CACHE_HOME and ignore FORGE_CLI_HOME: legacy data lives at its
// physical location on disk, and a test-time override of the new root
// must not make the migrator a no-op on real systems.

import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { migrateLegacyData } from "./migrator.js";

// ── One-shot lazy migration trigger ─────────────────────────────────────────
//
// `ensureForgeCliPathsReady()` runs the migrator exactly once per process
// and is invoked from every forge-cli entry point (extension activate,
// `bin/config.ts`, headless bin). Path getters do NOT trigger it on
// each call — that would re-stat the filesystem on every read.
//
// The import cycle paths↔migrator is safe: migrator only calls path
// getters at function-invocation time (not at module load), and getters
// do not call back into the migrator.
//
// Tests can disable the trigger entirely via FORGE_CLI_SKIP_MIGRATION=1.

let migrationAttempted = false;

export function ensureForgeCliPathsReady(): void {
	if (migrationAttempted) return;
	migrationAttempted = true;
	if (process.env.FORGE_CLI_SKIP_MIGRATION === "1") return;
	try {
		migrateLegacyData();
	} catch {
		// Migration failures must never block path resolution; the
		// migrator records its own failures and retries next run.
	}
}

/** Test-only: reset the in-process migration guard. */
export function __resetMigrationGuardForTests(): void {
	migrationAttempted = false;
}

// ── User root resolution ────────────────────────────────────────────────────

/**
 * Resolve the forge-cli user root. Honors FORGE_CLI_HOME for tests/CI;
 * otherwise defaults to `~/.pi/forge-cli/`.
 */
function userRoot(): string {
	const override = process.env.FORGE_CLI_HOME;
	if (override && override.length > 0) return override;
	return path.join(os.homedir(), ".pi", "forge-cli");
}

// ── New-layout (post-v0.10.0) accessors ─────────────────────────────────────

/** ~/.pi/forge-cli/ (or FORGE_CLI_HOME override) */
export function getForgeCliUserRoot(): string {
	return userRoot();
}

/** ~/.pi/forge-cli/config.json — L1 global routing config */
export function getGlobalConfigPath(): string {
	return path.join(userRoot(), "config.json");
}

/** ~/.pi/forge-cli/cache/ — probe + dismissal caches */
export function getUserCacheDir(): string {
	return path.join(userRoot(), "cache");
}

/** ~/.pi/forge-cli/state/ — reserved for future state markers */
export function getUserStateDir(): string {
	return path.join(userRoot(), "state");
}

/** ~/.pi/forge-cli/.migrated-from-legacy — migrator idempotency marker */
export function getMigrationMarkerPath(): string {
	return path.join(userRoot(), ".migrated-from-legacy");
}

// ── Transcript archive (central, cross-project, full retention) ─────────────

/** ~/.pi/forge-cli/transcripts/ — central run-transcript archive root */
export function getTranscriptArchiveRoot(): string {
	return path.join(userRoot(), "transcripts");
}

/** ~/.pi/forge-cli/transcripts/index.jsonl — append-only global run timeline */
export function getTranscriptIndexPath(): string {
	return path.join(getTranscriptArchiveRoot(), "index.jsonl");
}

/** ~/.pi/forge-cli/transcripts/projects.json — projectKey registry */
export function getTranscriptProjectsPath(): string {
	return path.join(getTranscriptArchiveRoot(), "projects.json");
}

/** ~/.pi/forge-cli/transcripts/<projectKey>/<entityId>/<runId>/ — one archived run */
export function getRunArchiveDir(projectKey: string, entityId: string, runId: string): string {
	return path.join(getTranscriptArchiveRoot(), projectKey, entityId, runId);
}

// ── Project-level accessors (unchanged) ─────────────────────────────────────

/** <cwd>/.pi/forge-cli/ */
export function getProjectForgeCliDir(cwd: string): string {
	return path.join(cwd, ".pi", "forge-cli");
}

/** <cwd>/.pi/forge-cli/config.json */
export function getProjectConfigPath(cwd: string): string {
	return path.join(getProjectForgeCliDir(cwd), "config.json");
}

// ── Pi-namespace accessors (themes, agents — re-exported for boundary discipline) ─

/** ~/.pi/agent/themes/ — pi loads bundled themes from here */
export function getPiAgentThemesDir(): string {
	return path.join(getAgentDir(), "themes");
}

/** ~/.pi/agent/agents/ — pi's standard agent directory */
export function getPiAgentAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

// ── Legacy paths (used by migrator + nothing else) ──────────────────────────
//
// These intentionally derive from os.homedir() / XDG_CACHE_HOME directly,
// NOT from userRoot(). FORGE_CLI_HOME must not leak into legacy resolution
// or the migrator becomes a no-op on the very systems that need it.

function legacyHome(): string {
	return os.homedir();
}

function legacyXdgCacheBase(): string {
	return process.env.XDG_CACHE_HOME ?? path.join(legacyHome(), ".cache");
}

export interface LegacyPaths {
	/** ~/.pi/agent/forge-cli/config.json — pre-v0.10.0 global config */
	globalConfig: string;
	/** ${XDG_CACHE_HOME:-~/.cache}/forgecli/ — pre-v0.10.0 cache dir */
	cacheDir: string;
}

export function getLegacyPaths(): LegacyPaths {
	return {
		globalConfig: path.join(legacyHome(), ".pi", "agent", "forge-cli", "config.json"),
		cacheDir: path.join(legacyXdgCacheBase(), "forgecli"),
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Replace a leading $HOME prefix with `~` for display. Pure string op.
 * Mirrors the helper that previously lived inline in vendored subagent
 * code; centralizing here keeps it discoverable and lets future call
 * sites pick it up. Always uses the real os.homedir() — does NOT honor
 * FORGE_CLI_HOME, because display paths describe physical locations.
 */
export function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
