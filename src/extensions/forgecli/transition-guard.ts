// Status-transition guard — FORGE-S18-T03
//
// Encodes the legal status-transition table for each entity (task, sprint, bug)
// and checks whether a proposed transition is allowed.
//
// The guard reads the current status from disk via `store-cli read` (spawnSync).
// Fail-open: if the current-status lookup fails for any reason, the guard returns
// { allowed: true } and sets reason="lookup-failed". The caller (hook-dispatcher)
// logs this as "lookup-failed" under FORGE_HOOK_AUDIT=1 but never blocks the
// operation — a lookup failure must not block a valid operation.

import { spawnSync } from "node:child_process";
import * as path from "node:path";

export interface TransitionGuardResult {
	allowed: boolean;
	reason: string;
}

// ── Legal transition tables ───────────────────────────────────────────────────
//
// Derived from task.schema.json, sprint.schema.json, bug.schema.json status enums.
// Each entry: fromStatus → Set<toStatus>

const TASK_TRANSITIONS: Record<string, Set<string>> = {
	draft: new Set(["planned", "blocked", "escalated", "abandoned"]),
	planned: new Set(["plan-approved", "plan-revision-required", "blocked", "escalated", "abandoned"]),
	"plan-approved": new Set(["implementing", "blocked", "escalated", "abandoned"]),
	implementing: new Set(["implemented", "code-revision-required", "blocked", "escalated", "abandoned"]),
	implemented: new Set(["review-approved", "blocked", "escalated", "abandoned"]),
	"review-approved": new Set(["approved", "blocked", "escalated", "abandoned"]),
	approved: new Set(["committed", "blocked", "escalated", "abandoned"]),
	"plan-revision-required": new Set(["planned", "blocked", "escalated", "abandoned"]),
	"code-revision-required": new Set(["implementing", "blocked", "escalated", "abandoned"]),
	// Terminal / sink states — can only be re-opened by --force.
	blocked: new Set(["blocked", "escalated", "abandoned"]),
	escalated: new Set(["blocked", "escalated", "abandoned"]),
	abandoned: new Set(["blocked", "escalated", "abandoned"]),
	committed: new Set(["blocked", "escalated", "abandoned"]),
};

const SPRINT_TRANSITIONS: Record<string, Set<string>> = {
	planning: new Set(["active", "abandoned"]),
	active: new Set(["completed", "partially-completed", "blocked", "abandoned"]),
	completed: new Set(["retrospective-done"]),
	"partially-completed": new Set(["retrospective-done"]),
	"retrospective-done": new Set([]),
	blocked: new Set(["active", "abandoned"]),
	abandoned: new Set([]),
};

const BUG_TRANSITIONS: Record<string, Set<string>> = {
	reported: new Set(["triaged", "abandoned"]),
	triaged: new Set(["in-progress", "abandoned"]),
	"in-progress": new Set(["fixed", "abandoned"]),
	fixed: new Set(["verified"]),
	verified: new Set([]),
	abandoned: new Set([]),
};

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

	try {
		const result = spawnSync(process.execPath, [storeCliPath, "read", entity, entityId], {
			encoding: "utf8",
			timeout: 10_000,
		});

		if (result.status !== 0 || result.error) return null;

		const stdout = result.stdout?.trim();
		if (!stdout) return null;

		// store-cli read emits JSON; parse and extract the status field.
		const record = JSON.parse(stdout) as Record<string, unknown>;
		const status = record.status;
		return typeof status === "string" ? status : null;
	} catch {
		// Any parse error or subprocess error → fail-open.
		return null;
	}
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
