// lib/spawn-store-cli.ts — FORGE-S25-T17 (C-1, C-17, N-C-A)
//
// Centralised wrappers for the three store-cli.cjs spawn patterns used across
// forge-cli. Replaces inline spawnSync calls in:
//   - transition-guard.ts  (read)
//   - store-validator.ts   (validate)
//   - friction-emit.ts     (emit)
//   - skill-retriever.ts   (emit)
//   - skill-usage-tracker.ts (emit)
//
// Iron Law IL6 compliance: every external call uses argv arrays — no shell
// string interpolation.
//
// Timeout discipline (N-C-A): emit calls use STORE_CLI_EMIT_TIMEOUT_MS so
// the three previous callers that were missing timeouts now carry them.

import { spawnSync } from "node:child_process";
import { STORE_CLI_TIMEOUT_MS, STORE_CLI_EMIT_TIMEOUT_MS } from "./store-cli-timeouts.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SpawnEmitResult {
	ok: boolean;
	stderr: string;
}

export interface SpawnValidateResult {
	ok: boolean;
	reason: string;
}

// ---------------------------------------------------------------------------
// spawnStoreCliEmit
// ---------------------------------------------------------------------------

/**
 * Spawn `store-cli.cjs emit <sprintId> <event-json>` synchronously.
 *
 * Uses `STORE_CLI_EMIT_TIMEOUT_MS` (10 s). Fail-closed: returns ok=false on
 * any non-zero exit or error signal.
 *
 * @param storeCli  Absolute path to store-cli.cjs.
 * @param sprintId  Sprint ID string (e.g. "FORGE-S25").
 * @param event     Event payload object; JSON.stringify'd before dispatch.
 * @param cwd       Working directory for the subprocess.
 */
export function spawnStoreCliEmit(
	storeCli: string,
	sprintId: string,
	event: unknown,
	cwd: string,
): SpawnEmitResult {
	const result = spawnSync(
		process.execPath,
		[storeCli, "emit", sprintId, JSON.stringify(event)],
		{ cwd, encoding: "utf8", timeout: STORE_CLI_EMIT_TIMEOUT_MS },
	);
	if (result.status !== 0 || result.error) {
		const stderr =
			(typeof result.stderr === "string" ? result.stderr : "") ||
			result.error?.message ||
			`store-cli emit exited ${String(result.status)}`;
		return { ok: false, stderr };
	}
	return { ok: true, stderr: "" };
}

// ---------------------------------------------------------------------------
// spawnStoreCliRead
// ---------------------------------------------------------------------------

/**
 * Spawn `store-cli.cjs read <entity> <entityId>` synchronously and parse stdout
 * as JSON.
 *
 * Fail-open: returns null on non-zero exit, error signal, or JSON parse error.
 * Callers that need fail-open semantics (like transition-guard) rely on this.
 *
 * @param storeCli  Absolute path to store-cli.cjs.
 * @param entity    Entity type: "task" | "sprint" | "bug" | …
 * @param entityId  Entity ID string.
 * @param cwd       Working directory for the subprocess.
 */
export function spawnStoreCliRead(
	storeCli: string,
	entity: string,
	entityId: string,
	cwd: string,
): Record<string, unknown> | null {
	try {
		const result = spawnSync(
			process.execPath,
			[storeCli, "read", entity, entityId],
			{ cwd, encoding: "utf8", timeout: STORE_CLI_TIMEOUT_MS },
		);
		if (result.status !== 0 || result.error) return null;
		const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		return JSON.parse(stdout) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// spawnStoreCliValidate
// ---------------------------------------------------------------------------

/**
 * Spawn `store-cli.cjs validate <entity> <payload-json>` synchronously.
 *
 * Returns ok=false with a reason string on non-zero exit.
 *
 * @param storeCli  Absolute path to store-cli.cjs.
 * @param entity    Entity type: "task" | "sprint" | "bug" | "event" | …
 * @param payload   Payload object or pre-serialised JSON string.
 * @param cwd       Working directory for the subprocess.
 */
export function spawnStoreCliValidate(
	storeCli: string,
	entity: string,
	payload: unknown,
	cwd: string,
): SpawnValidateResult {
	const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);
	const result = spawnSync(
		process.execPath,
		[storeCli, "validate", entity, payloadStr],
		{ encoding: "utf8", cwd, timeout: STORE_CLI_TIMEOUT_MS },
	);
	if (result.status !== 0 || result.error) {
		const reason =
			result.stderr?.trim() ||
			result.error?.message ||
			`store-cli validate exited ${String(result.status)}`;
		return { ok: false, reason };
	}
	return { ok: true, reason: "" };
}
