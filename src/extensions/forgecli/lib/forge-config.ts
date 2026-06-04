// lib/forge-config.ts — memoized Forge config accessor (C-3, S-13).
//
// Wraps discoverForgeConfig() with a per-cwd Map cache so repeated calls
// during a single session don't re-walk the filesystem.
//
// CRITICAL INVARIANT: only `ForgeConfig | null` is cached. The `LayeredConfig`
// produced by `loadLayeredConfig()` is NOT cached here — T20 must retain full
// access to `LayeredConfig.errors` to surface the N-B-E issue. Callers that
// need `LayeredConfig` must call `loadLayeredConfig()` directly; this module
// optimises only the walk-up discovery phase.

import { discoverForgeConfig, type ForgeConfig } from "./forge-root.js";

/** Module-level cache keyed by the `cwd` argument (or `""` for the default). */
const cache = new Map<string, ForgeConfig | null>();

/**
 * Memoized variant of `discoverForgeConfig`.
 *
 * On the first call for a given `cwd` the function walks the directory tree
 * upward to locate `.forge/config.json`; subsequent calls for the same `cwd`
 * return the cached result immediately.
 *
 * @param cwd - Working directory to start the search from.
 *              Defaults to `process.cwd()` (same default as the underlying
 *              `discoverForgeConfig`).
 */
export function discoverForgeConfigCached(cwd: string = process.cwd()): ForgeConfig | null {
	const key = cwd;
	if (cache.has(key)) {
		return cache.get(key)!;
	}
	const result = discoverForgeConfig(cwd);
	cache.set(key, result);
	return result;
}

/**
 * Clears all cached entries.
 *
 * Primarily for test isolation — call in `beforeEach`/`afterEach` to
 * prevent cache bleed between test cases that change the filesystem.
 */
export function clearForgeConfigCache(): void {
	cache.clear();
}
