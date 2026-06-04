// Status-transition guard — FORGE-S18-T03
//
// Checks whether a proposed status transition is legal for a given entity.
//
// The guard reads the current status from disk via `store-cli read` (spawnSync).
// Fail-open: if the current-status lookup fails for any reason, the guard returns
// { allowed: true } and sets reason="lookup-failed". The caller (hook-dispatcher)
// logs this as "lookup-failed" under FORGE_HOOK_AUDIT=1 but never blocks the
// operation — a lookup failure must not block a valid operation.
//
// FORGE-S25-T17: spawnSync replaced with spawnStoreCliRead from lib/spawn-store-cli.ts.
// FORGE-S25-T27: inline TASK/SPRINT/BUG_TRANSITIONS tables replaced with catalog-loader
//   constants derived from T26 enum-catalog.json + transitions/*.json. Tables now match
//   the T25 ADR-canonical FSM (doc/decisions/state-machine-reconciliation.md):
//     - terminal states (committed, blocked, escalated, abandoned) are truly terminal (Set [])
//     - plan-revision-required and code-revision-required reachable from more states
//   Closes finding N-E-2 (forge-cli side), round-2-validation.md findings 36, 40.

import * as path from "node:path";
import { BUG_TRANSITIONS, SPRINT_TRANSITIONS, TASK_TRANSITIONS } from "../lib/catalog-loader.js";
import { spawnStoreCliRead } from "../lib/spawn-store-cli.js";

export interface TransitionGuardResult {
	allowed: boolean;
	reason: string;
}

// ── Legal transition tables ───────────────────────────────────────────────────
//
// Loaded from enum-catalog.json / transitions/*.json (T25 ADR-canonical).
// Source: build-enum-catalog.cjs (FORGE-S25-T26) → bundled by build-payload.cjs (FORGE-S25-T27).
// Do NOT inline transition tables here — edit forge/forge/tools/build-enum-catalog.cjs instead.

const ENTITY_TABLES: Record<string, Record<string, Set<string>>> = {
	task: TASK_TRANSITIONS,
	sprint: SPRINT_TRANSITIONS,
	bug: BUG_TRANSITIONS,
};

function legalNextStates(entity: string, fromStatus: string): string[] {
	const table = ENTITY_TABLES[entity];
	if (!table) return [];
	const allowed = table[fromStatus];
	return allowed ? [...allowed] : [];
}

// ── Current-status lookup (fail-open) ────────────────────────────────────────

/**
 * Read the current status of an entity from the store via `store-cli read`.
 * Returns the status string on success, or null on any failure (fail-open).
 */
function readCurrentStatus(entity: string, entityId: string, forgeRoot: string): string | null {
	const storeCliPath = path.join(forgeRoot, "tools", "store-cli.cjs");
	// Use the shared wrapper from lib/spawn-store-cli.ts (FORGE-S25-T17).
	// Fail-open: spawnStoreCliRead returns null on any error — matches prior behaviour.
	const record = spawnStoreCliRead(storeCliPath, entity, entityId, forgeRoot);
	if (record === null) return null;
	const status = record["status"];
	return typeof status === "string" ? status : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface TransitionGuardInput {
	entity: string;
	entityId: string;
	toStatus: string;
}

/**
 * Check whether a status transition is legal.
 *
 * Fail-open: if the current status cannot be read, returns
 * `{ allowed: true, reason: "lookup-failed" }`. The caller
 * should audit-log this outcome but MUST NOT block the operation.
 *
 * @param input     Entity, entity ID, and target status.
 * @param forgeRoot Absolute path to the Forge plugin root.
 */
export function checkTransition(input: TransitionGuardInput, forgeRoot: string): TransitionGuardResult {
	const { entity, entityId, toStatus } = input;

	// Lookup current status — fail-open on any error.
	const fromStatus = readCurrentStatus(entity, entityId, forgeRoot);
	if (fromStatus === null) {
		return {
			allowed: true,
			reason: "lookup-failed",
		};
	}

	const table = ENTITY_TABLES[entity];
	if (!table) {
		// Unknown entity type — allow through (future-proofing).
		return { allowed: true, reason: "" };
	}

	const allowed = table[fromStatus]?.has(toStatus) ?? false;
	if (allowed) {
		return { allowed: true, reason: "" };
	}

	const legal = legalNextStates(entity, fromStatus);
	const legalStr = legal.length > 0 ? legal.join(", ") : "(none)";
	return {
		allowed: false,
		reason: `${fromStatus} → ${toStatus} is not a legal transition for ${entity}. Legal next states from ${fromStatus}: ${legalStr}.`,
	};
}
