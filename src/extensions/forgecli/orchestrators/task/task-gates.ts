// task-gates.ts — preflight / postflight gate execution helpers.
// Extracted from run-task.ts (no logic changes). run-task.ts re-exports these.

import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

// ── Preflight gate ────────────────────────────────────────────────────────

export type PreflightResult = "proceed" | "halt" | "escalate";

/** Structured gate failure shape emitted by preflight-gate.cjs on stdout (exit 1). */
export interface GateFailureData {
	phase: string;
	reasonCode: string;
	detail: string;
	remediation: string;
}

/** Extended result carrying the structured failure alongside the status enum. */
export interface PreflightOutcome {
	result: PreflightResult;
	/** Parsed structured failure from stdout, or null on pass / escalate. */
	gateFailure: GateFailureData | null;
}

export function runPreflightGate(
	preflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
	entityType?: "task" | "bug",
): PreflightResult {
	const outcome = runPreflightGateWithData(preflightGate, role, taskId, cwd, entityType);
	return outcome.result;
}

/**
 * Run postflight-gate.cjs after a phase subagent returns, before FSM advance.
 * Mirrors runPreflightGateWithData — same argv-array discipline, same structured-JSON
 * parsing from stdout on exit 1.
 *
 * Returns:
 *   "ok"          — gate passed (or no outputs block for this phase); advance may proceed.
 *   "unsatisfied" — gate failed; do NOT advance FSM; halt and call runHaltAdvisor.
 *   "error"       — gate binary missing or parse error; treat as pass-through (additive).
 */
export function runPostflightGate(
	postflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
): { result: "ok" | "unsatisfied" | "error"; gateFailure: GateFailureData | null } {
	if (!fs.existsSync(postflightGate)) {
		// postflight-gate.cjs not present in this forgeRoot — pass through (additive).
		return { result: "ok", gateFailure: null };
	}
	const spawnResult = spawnSync("node", [postflightGate, "--phase", role, "--task", taskId], {
		cwd,
		encoding: "utf8",
	});
	if (spawnResult.status === 0) return { result: "ok", gateFailure: null };
	if (spawnResult.status === 2) return { result: "error", gateFailure: null };
	// Exit 1: parse structured JSON from stdout
	let gateFailure: GateFailureData | null = null;
	try {
		const stdout = typeof spawnResult.stdout === "string" ? spawnResult.stdout.trim() : "";
		if (stdout) {
			const parsed = JSON.parse(stdout) as GateFailureData;
			if (parsed && typeof parsed.reasonCode === "string") {
				gateFailure = parsed;
			}
		}
	} catch {
		// stdout not valid JSON — gate failure but no structured data
	}
	return { result: "unsatisfied", gateFailure };
}

/**
 * Upgraded variant that returns structured failure data alongside the status enum.
 * Callers that need the advisory data should use this function directly.
 */
export function runPreflightGateWithData(
	preflightGate: string,
	role: string,
	taskId: string,
	cwd: string,
	entityType?: "task" | "bug",
): PreflightOutcome {
	const entityFlag = entityType === "bug" ? "--bug" : "--task";
	const spawnResult = spawnSync("node", [preflightGate, "--phase", role, entityFlag, taskId], {
		cwd,
		encoding: "utf8",
	});
	if (spawnResult.status === 0) return { result: "proceed", gateFailure: null };
	if (spawnResult.status === 2) return { result: "escalate", gateFailure: null };
	// Exit 1: parse structured JSON from stdout
	let gateFailure: GateFailureData | null = null;
	try {
		const stdout = typeof spawnResult.stdout === "string" ? spawnResult.stdout.trim() : "";
		if (stdout) {
			const parsed = JSON.parse(stdout) as GateFailureData;
			if (parsed && typeof parsed.reasonCode === "string") {
				gateFailure = parsed;
			}
		}
	} catch {
		// stdout not valid JSON — gate failure but no structured data
	}
	return { result: "halt", gateFailure };
}
