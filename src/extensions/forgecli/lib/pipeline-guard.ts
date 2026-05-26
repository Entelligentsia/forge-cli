// lib/pipeline-guard.ts — FORGE-S26-T11
//
// Pipeline step guard for CLI handlers: checks task state via store-cli before
// a workflow agent is dispatched.
//
// Design mirrors FORGE-S26-T06 plugin guards (workflow-prose level):
//   - Reads current task status via `store-cli.cjs read task <taskId>`.
//   - If the status is NOT in the allowed set for this phase, returns an error
//     message matching the plugin error format (AC #1):
//     "× Task {ID} is in state '{state}' — /forge:{required-step} must complete
//      first. To run the full pipeline: /forge:run-task {ID}"
//   - Returns null when the guard passes (status is allowed or task not found).
//   - The --force flag bypasses the check entirely (returns null).
//
// Fail-open: if the store-cli lookup fails for any reason (missing file, bad
// JSON, timeout) the guard returns null (pass-through) so a lookup failure
// never blocks a valid operation. IL7: no silent continuation past hard failures
// in callers; the guard itself is designed fail-open for lookup errors.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/
//   IL6 — no shell-string interpolation; uses spawnStoreCliRead (argv array)
//   IL7 — callers must emit ctx.ui.notify on non-null return and return early

import * as path from "node:path";
import { spawnStoreCliRead } from "./spawn-store-cli.js";

// ── Allowed-states table ──────────────────────────────────────────────────────
//
// Mirrors the T06 plugin guard table (FORGE-S26-T06 PLAN.md §5).

export type PipelinePhase =
	| "plan"
	| "review-plan"
	| "implement"
	| "review-code"
	| "validate"
	| "approve"
	| "commit";

/** States that allow each phase to execute without --force. */
const ALLOWED_STATES: Record<PipelinePhase, ReadonlySet<string>> = {
	plan: new Set(["draft", "planned", "plan-revision-required"]),
	"review-plan": new Set(["planned"]),
	implement: new Set(["plan-approved"]),
	"review-code": new Set(["implemented", "implementing"]),
	validate: new Set(["implemented", "review-approved"]),
	approve: new Set(["review-approved"]),
	commit: new Set(["approved"]),
};

/**
 * Maps each blocked phase to the required predecessor command (used in the
 * error message).  Follows the T06 PLAN.md §5 predecessor map.
 */
const REQUIRED_PREDECESSOR: Record<PipelinePhase, string> = {
	plan: "plan (entry point — check task state)",
	"review-plan": "plan",
	implement: "review-plan",
	"review-code": "implement",
	validate: "implement",
	approve: "review-code",
	commit: "approve",
};

// ── Arg parsing ───────────────────────────────────────────────────────────────

/**
 * Split raw args into (taskId, forceFlag, remainder).
 *
 * - `--force` is consumed; the boolean is returned.
 * - The first non-flag token is taken as the task ID hint (may be empty when
 *   the user passes no args — in that case the agent will infer the task from
 *   context; the guard cannot run and returns null).
 * - All other tokens (excluding `--force`) are returned as remainder.
 */
export interface ParsedGuardArgs {
	force: boolean;
	/** First non-flag arg; empty string when absent. */
	taskIdHint: string;
	/** Remaining args with --force stripped (for re-passing to composeKickoff). */
	cleanArgs: string;
}

export function parseGuardArgs(rawArgs: string): ParsedGuardArgs {
	const parts = (rawArgs ?? "").trim().split(/\s+/).filter(Boolean);
	const force = parts.includes("--force");
	const withoutForce = parts.filter((p) => p !== "--force");
	// First non-flag token is the task ID hint
	const firstNonFlag = withoutForce.find((p) => !p.startsWith("-")) ?? "";
	return {
		force,
		taskIdHint: firstNonFlag,
		cleanArgs: withoutForce.join(" "),
	};
}

// ── Guard ─────────────────────────────────────────────────────────────────────

export interface PipelineGuardResult {
	/** true = blocked; false = allowed or lookup failed (fail-open). */
	blocked: boolean;
	/** Error message to emit when blocked. Empty string when allowed/fail-open. */
	message: string;
}

/**
 * Run the pipeline step guard for a given phase.
 *
 * @param phase      The pipeline phase being invoked.
 * @param taskId     Task ID to look up. If empty, the guard is a no-op (returns allowed).
 * @param forgeRoot  Absolute path to the forge plugin root (needed to locate store-cli.cjs).
 * @param cwd        Working directory for the store-cli subprocess.
 *
 * Returns `{ blocked: false, message: "" }` when:
 *   - taskId is empty (can't check — fail-open)
 *   - store-cli lookup fails (fail-open)
 *   - current status is in the allowed set for this phase
 *
 * Returns `{ blocked: true, message: "..." }` when the current status is NOT
 * in the allowed set.
 */
export function runPipelineGuard(
	phase: PipelinePhase,
	taskId: string,
	forgeRoot: string,
	cwd: string,
): PipelineGuardResult {
	const allowed: PipelineGuardResult = { blocked: false, message: "" };

	// No task ID → fail-open (agent will infer task from context)
	if (!taskId.trim()) return allowed;

	const storeCli = path.join(forgeRoot, "tools", "store-cli.cjs");
	const record = spawnStoreCliRead(storeCli, "task", taskId.trim(), cwd);

	// Lookup failed → fail-open
	if (record === null) return allowed;

	const status = typeof record["status"] === "string" ? record["status"] : null;

	// No status field → fail-open
	if (status === null) return allowed;

	const allowedSet = ALLOWED_STATES[phase];
	if (allowedSet.has(status)) return allowed;

	const predecessor = REQUIRED_PREDECESSOR[phase];
	const message =
		`× Task ${taskId} is in state '${status}' — ` +
		`/forge:${predecessor} must complete first. ` +
		`To run the full pipeline: /forge:run-task ${taskId}`;

	return { blocked: true, message };
}
