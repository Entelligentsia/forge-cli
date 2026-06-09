// summary-recovery.ts — deterministic phase-completion recovery for the
// orchestrator pipelines (forge-engineering#41).
//
// Failure mode: a phase's subagent finalizes in two steps —
//   1. `forge_artifact write <phase>-summary` → writes the {PHASE}-SUMMARY.json
//      sidecar to the record's path on disk, and
//   2. `forge_store set-summary <id> <phaseKey>` → ingests that sidecar into
//      `record.summaries.<phaseKey>`.
// Under turn-budget pressure (or with a weaker model) the subagent stops after
// step 1 with stopReason=stop, silently eliding step 2. The orchestrator then
// reads the store, finds no verdict, and hard-fails the phase — forcing the
// operator to rerun the whole task even though the work artifact is on disk.
//
// Recovery: the orchestrator registers the subagent's already-authored sidecar
// itself by running step 2 (store-cli set-summary / set-bug-summary — the
// sidecar is auto-resolved from record.path when the file arg is omitted), then
// re-checks its gate. This does NOT fabricate a verdict (IL10): the verdict
// content is the subagent's own sidecar; the orchestrator only registers it,
// exactly as it already emits phase events on the subagent's behalf. When the
// sidecar is genuinely absent, set-summary exits non-zero and the caller falls
// through to the existing hard-fail + halt advisor.
//
// IL6 — external invocation via spawnSync argv array, no shell interpolation.

import { spawnSync } from "node:child_process";

export interface SummaryRecoveryResult {
	/** Always true — the recovery was attempted (caller decides when to call). */
	attempted: boolean;
	/** True only when set-summary exited 0 (sidecar present + schema-valid). */
	ok: boolean;
	/** Captured stderr for debug logging. */
	stderr: string;
}

export interface RecoverPhaseSummaryParams {
	/** Absolute path to the project's store-cli.cjs. */
	storeCli: string;
	/** Task or bug record id whose summary is being registered. */
	entityId: string;
	/** Canonical `summaries.*` store key (e.g. "plan", "code_review"). */
	summaryKey: string;
	cwd: string;
	/** "set-summary" (task, default) or "set-bug-summary" (bug). */
	summaryVerb?: "set-summary" | "set-bug-summary";
}

/**
 * Attempt to register a phase's already-written {PHASE}-SUMMARY.json sidecar
 * into the store via store-cli. Returns ok=true only when the verb exits 0.
 */
export function recoverPhaseSummary(p: RecoverPhaseSummaryParams): SummaryRecoveryResult {
	const verb = p.summaryVerb ?? "set-summary";
	const r = spawnSync("node", [p.storeCli, verb, p.entityId, p.summaryKey], {
		cwd: p.cwd,
		encoding: "utf8",
	});
	return { attempted: true, ok: r.status === 0, stderr: (r.stderr ?? "").toString() };
}
