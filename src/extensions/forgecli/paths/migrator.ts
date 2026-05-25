// One-shot, idempotent forge-cli data migrator — FORGE-S20-T11.
//
// Moves pre-v0.10.0 user-level files into the new ~/.pi/forge-cli/
// layout. Safe to invoke on every startup:
//   - The presence of the `.migrated-from-legacy` marker short-circuits
//     subsequent runs with no filesystem stat work beyond a single
//     marker check.
//   - When legacy files are absent the run is a no-op.
//   - When some files move and others fail the marker is NOT written
//     and the migrator retries on the next run.
//
// Migration policy:
//   - Legacy global config (~/.pi/agent/forge-cli/config.json) →
//     ~/.pi/forge-cli/config.json (only if new path is absent).
//   - Legacy cache files (~/.cache/forgecli/<file>) →
//     ~/.pi/forge-cli/cache/<file> (only if new path is absent).
//   - Existing new-path files are left untouched (no overwrite).
//   - Legacy directories are not removed (manual cleanup is safer).
//
// One human-readable line per file moved is forwarded to the supplied
// logger; defaults to console.error so it surfaces in non-TTY runs
// without polluting stdout output.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getForgeCliUserRoot,
	getGlobalConfigPath,
	getLegacyPaths,
	getMigrationMarkerPath,
	getUserCacheDir,
} from "./paths.js";

export interface MigrationResult {
	/** Whether the migrator ran (false when marker present or no work to do). */
	ran: boolean;
	/** Files successfully moved. */
	moved: string[];
	/** Files that failed to move along with the error message. */
	failures: Array<{ from: string; to: string; error: string }>;
	/** Whether the idempotency marker was written this run. */
	markerWritten: boolean;
}

export interface MigrateOptions {
	/** Sink for one-line-per-file progress messages. Defaults to console.error. */
	log?: (line: string) => void;
}

/** Cache filenames that may live under the legacy ~/.cache/forgecli/ root. */
const LEGACY_CACHE_FILES = ["update-banner.json", "whats-new-seen.json", "seen.json", "drift-seen.json"];

function exists(p: string): boolean {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Move src → dst, creating dst's parent directory as needed. Falls back
 * to copy+unlink when rename fails across devices (EXDEV — common when
 * XDG_CACHE_HOME is on a different filesystem from $HOME).
 */
function moveFile(src: string, dst: string): void {
	fs.mkdirSync(path.dirname(dst), { recursive: true });
	try {
		fs.renameSync(src, dst);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "EXDEV") throw err;
		// Cross-device — copy then unlink.
		fs.copyFileSync(src, dst);
		fs.unlinkSync(src);
	}
}

/**
 * Run the migrator once. Returns details of what happened so callers
 * (tests, debug logging) can assert behavior; production callers may
 * safely ignore the return value.
 */
export function migrateLegacyData(opts: MigrateOptions = {}): MigrationResult {
	const log = opts.log ?? ((line: string) => console.error(line));
	const marker = getMigrationMarkerPath();

	const result: MigrationResult = {
		ran: false,
		moved: [],
		failures: [],
		markerWritten: false,
	};

	// Short-circuit: marker present → migration already complete.
	if (exists(marker)) return result;

	const legacy = getLegacyPaths();
	const userRoot = getForgeCliUserRoot();
	const newCacheDir = getUserCacheDir();
	const newConfigPath = getGlobalConfigPath();

	// Determine whether there is any legacy work to do at all.
	const hasLegacyConfig = exists(legacy.globalConfig);
	const hasLegacyCache = exists(legacy.cacheDir);

	if (!hasLegacyConfig && !hasLegacyCache) {
		// Nothing to migrate. Write the marker so subsequent runs skip
		// even this much filesystem work.
		try {
			fs.mkdirSync(userRoot, { recursive: true });
			fs.writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
			result.markerWritten = true;
		} catch {
			// Best-effort — if we cannot write the marker, the next run
			// will reach this no-op path again. Not a correctness issue.
		}
		return result;
	}

	result.ran = true;

	// 1. Legacy global config → new config.json
	if (hasLegacyConfig && !exists(newConfigPath)) {
		try {
			moveFile(legacy.globalConfig, newConfigPath);
			result.moved.push(newConfigPath);
			log(`forge-cli migrate: moved ${legacy.globalConfig} → ${newConfigPath}`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			result.failures.push({ from: legacy.globalConfig, to: newConfigPath, error: msg });
			log(`forge-cli migrate: FAILED ${legacy.globalConfig} → ${newConfigPath} (${msg})`);
		}
	}

	// 2. Legacy cache files → new cache dir
	if (hasLegacyCache) {
		for (const file of LEGACY_CACHE_FILES) {
			const src = path.join(legacy.cacheDir, file);
			if (!exists(src)) continue;
			const dst = path.join(newCacheDir, file);
			if (exists(dst)) continue; // never overwrite
			try {
				moveFile(src, dst);
				result.moved.push(dst);
				log(`forge-cli migrate: moved ${src} → ${dst}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				result.failures.push({ from: src, to: dst, error: msg });
				log(`forge-cli migrate: FAILED ${src} → ${dst} (${msg})`);
			}
		}
	}

	// Write idempotency marker only on full success. Partial-success
	// runs are retried on next startup so the operator does not need
	// to intervene.
	if (result.failures.length === 0) {
		try {
			fs.mkdirSync(userRoot, { recursive: true });
			fs.writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
			result.markerWritten = true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			log(`forge-cli migrate: marker write failed (${msg}); will retry next run`);
		}
	}

	return result;
}
