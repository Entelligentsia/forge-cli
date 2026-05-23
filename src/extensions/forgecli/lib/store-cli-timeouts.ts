// lib/store-cli-timeouts.ts — FORGE-S25-T17 (N-C-A)
//
// Named timeout constants for store-cli.cjs subprocess invocations.
// Import these instead of using bare numeric literals so all callers
// share a single source of truth and the value is visible in diffs.

/** Default timeout (ms) for store-cli read / validate / update-status calls. */
export const STORE_CLI_TIMEOUT_MS = 10_000;

/** Timeout (ms) for store-cli emit calls (event emission). */
export const STORE_CLI_EMIT_TIMEOUT_MS = 10_000;
