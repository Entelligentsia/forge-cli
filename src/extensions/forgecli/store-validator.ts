// Store-CLI payload validator — FORGE-S18-T03
//
// Spawns `store-cli.cjs validate <entity> '<json>'` synchronously and surfaces
// any schema error as a structured result. This module is the sole point of
// contact between hook-dispatcher.ts and store-cli's validation logic.
//
// Why spawnSync?
//   pi's tool_call handler is synchronous — the event system does not support
//   async handlers. spawnSync completes before the block result is returned to pi.

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { enhanceBlockMessage } from "./lib/store-error-remediation.js";

export interface StoreValidatorResult {
	ok: boolean;
	/** Raw error output from store-cli. Present when ok=false. */
	reason: string;
	/** Enhanced message with remediation hints. Present when ok=false. */
	remediation: string;
}

/**
 * Validate a store entity payload by spawning `store-cli.cjs validate`.
 *
 * @param entity    Entity type: "task" | "sprint" | "bug" | "event" | …
 * @param payload   The raw payload (will be JSON.stringify'd if object; passed as-is if string).
 * @param forgeRoot Absolute path to the Forge plugin root — locates store-cli.cjs.
 * @returns         `{ ok: true, reason: "" }` on success, `{ ok: false, reason: <stderr> }` on failure.
 */
export function validateStoreCLIPayload(entity: string, payload: unknown, forgeRoot: string): StoreValidatorResult {
	const storeCliPath = path.join(forgeRoot, "tools", "store-cli.cjs");

	const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload);

	const result = spawnSync(
		process.execPath, // node
		[storeCliPath, "validate", entity, payloadStr],
		{ encoding: "utf8", timeout: 10_000 },
	);

	// Non-zero exit code or error signal → validation failed.
	if (result.status !== 0 || result.error) {
		const reason =
			result.stderr?.trim() ||
			result.error?.message ||
			`store-cli validate exited with code ${String(result.status)}` ||
			"validation failed (no error message)";
		const remediation = enhanceBlockMessage(reason, entity, "unknown");
		return { ok: false, reason, remediation };
	}

	return { ok: true, reason: "", remediation: "" };
}
