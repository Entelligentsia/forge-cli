// bug-triage-routing.ts — bug-specific control flow extracted VERBATIM from
// fix-bug.ts's phase loop (FORGE-S31 file-size refactor). Two self-contained
// blocks, each a pure-ish helper the pipeline switches on:
//
//   1. maybeSkipPhase   — the state-aware phase-skip heuristic (§6a): skip a
//      non-review phase whose output is already reflected in the bug status,
//      writing a synthetic summary so downstream predecessor-verdict checks pass.
//   2. captureTriageBugId — post-triage bugId capture (§ bugId capture): read the
//      real FORGE-BUG-NNN from triage events, fall back to a list-and-filter,
//      then re-initialize the debug log under the real id. Preserves the
//      PENDING- nuance exactly — the transcript writer keeps the PENDING entityId.
//   3. routeAfterTriage — the orchestrator-owned post-triage status transitions
//      (§6c) followed by the Path A/B branch read from bug.summaries.triage.route.
//      The source-introspection contract test scans the `postTriageTransitions`
//      wiring here.
//
// No logic changes; the inline `continue` / `return` paths are surfaced as small
// discriminated results.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { loadGovernorProjectConfig } from "../../governor-config.js";
import type { PhaseDescriptor } from "../run-task.js";
import { BUG_PHASES, postTriageTransitions } from "./bug-phases.js";
import { extractBugIdFromEvents, readBugRecord } from "./bug-id.js";
import type { BugRecord } from "./bug-id.js";
import type { RunBugPipelineResult } from "./run-bug-types.js";

// ── 6a. Phase skip (state-aware, defense-in-depth) ─────────────
// Belt-and-suspenders alongside the explicit summaries.triage.route
// branch (handled in routeAfterTriage below). Some subagents in some
// runtimes still go end-to-end during triage instead of just triaging
// — rather than roll back the work they did, skip non-review phases
// whose output is already reflected in the bug status. Review phases
// are never skipped — they are quality gates that must always run.
//
// Post-v0.44.0: terminal status is `fixed` only. `approved` and
// `verified` are no longer valid bug status values; references removed.
const PHASE_SKIP_STATES: Record<string, Set<string>> = {
	"plan-fix": new Set(["fixed"]),
	implement: new Set(["fixed"]),
	commit: new Set(["fixed"]), // commit writes the terminal status; skip if already there
};

export interface MaybeSkipParams {
	phase: PhaseDescriptor;
	bugId: string;
	cwd: string;
	ctx: ExtensionCommandContext;
	storeCli: string;
	/** Bug record read at the top of §6a (same read the caller already did). */
	bugNow: BugRecord | null;
	summaryKeyByRole: Record<string, string | null>;
}

/**
 * §6a — decide whether the current phase should be skipped because the bug is
 * already in a done state. When skipping, writes a synthetic summary so
 * downstream `after <phase>` verdict checks succeed. Returns true when the
 * caller should `currentPhaseIndex++; continue;`.
 */
export function maybeSkipPhase(p: MaybeSkipParams): boolean {
	const { phase, bugId, cwd, ctx, storeCli, bugNow, summaryKeyByRole } = p;
	const skipStates = PHASE_SKIP_STATES[phase.role];
	if (!(skipStates && bugNow?.status && skipStates.has(bugNow.status) && !phase.isReview)) {
		return false;
	}
	ctx.ui.notify(
		`⊘ forge:fix-bug — skipping ${phase.role}: bug ${bugId} is already '${bugNow.status}' (work already done).`,
		"info",
	);
	// Write a synthetic "approved" summary so downstream `after` predecessor
	// verdict checks find a verdict and don't block review phases.
	const summaryKey = summaryKeyByRole[phase.role];
	if (summaryKey) {
		const synthSummary = {
			objective: `Phase ${phase.role} skipped — bug already ${bugNow.status}`,
			findings: ["Subagent completed fix during triage (Path A); phase output implicitly satisfied."],
			// Non-review phases should have verdict "n/a" — the phase
			// didn't produce a gate verdict. This matches the `after
			// <phase> = n/a` preflight gate contract. Review phases
			// use "approved" since they are gate phases.
			verdict: phase.isReview ? "approved" : "n/a",
			written_at: new Date().toISOString(),
		};
		const synthFile = path.join(cwd, ".forge", "cache", `synthetic-summary-${bugId}-${summaryKey}.json`);
		fs.writeFileSync(synthFile, JSON.stringify(synthSummary, null, 2), "utf8");
		const synthResult = spawnSync("node", [storeCli, "set-bug-summary", bugId, summaryKey, synthFile], {
			cwd,
			encoding: "utf8",
		});
		if (synthResult.status !== 0) {
			ctx.ui.notify(
				`⚠ forge:fix-bug — synthetic summary write failed for ${phase.role}: ${String(synthResult.stderr).trim()}`,
				"warning",
			);
		}
		try {
			fs.unlinkSync(synthFile);
		} catch {
			/* non-fatal */
		}
	}
	return true;
}

// ── BugId capture after triage phase (Finding #1, #2) ──────────

export interface CaptureTriageBugIdParams {
	bugId: string;
	cwd: string;
	ctx: ExtensionCommandContext;
	storeCli: string;
	currentPhaseIndex: number;
	iterationCounts: Record<string, number>;
	debugLogDisabled: boolean;
	toolExecutionEvents: Array<{ toolName?: string; result?: unknown }>;
}

export type CaptureTriageBugIdOutcome =
	| { kind: "return"; result: RunBugPipelineResult }
	| {
			kind: "ok";
			bugId: string;
			debugLogPath: string | null;
			writeDebug: (rec: Record<string, unknown>) => void;
	  };

/**
 * Post-triage bugId capture: for new bugs the triage subagent creates the bug
 * record via store-cli; capture the real id by scanning tool_execution_end
 * events, with a list-and-filter fallback. On success re-initializes the debug
 * log under the real id and returns the updated locals. Preserves the PENDING-
 * nuance: the orchestrator transcript writer keeps the PENDING entityId — this
 * only updates the loop's local bugId.
 */
export function captureTriageBugId(
	p: CaptureTriageBugIdParams,
	writeDebug: (rec: Record<string, unknown>) => void,
	debugLogPath: string | null,
): CaptureTriageBugIdOutcome {
	const { cwd, ctx, storeCli, currentPhaseIndex, iterationCounts, debugLogDisabled, toolExecutionEvents } = p;
	let bugId = p.bugId;

	const capturedBugId = extractBugIdFromEvents(toolExecutionEvents, loadGovernorProjectConfig(cwd).prefix);
	if (capturedBugId) {
		ctx.ui.notify(`forge:fix-bug — captured bug ID: ${capturedBugId}`, "info");
		bugId = capturedBugId;
	} else {
		// Fallback: list bugs and find the most recent one created after pipeline start.
		const listResult = spawnSync("node", [storeCli, "list", "bug", "--json"], { cwd, encoding: "utf8" });
		if (listResult.status === 0 && listResult.stdout) {
			try {
				const bugs = JSON.parse(listResult.stdout);
				if (Array.isArray(bugs)) {
					// Find most recent bug whose reportedAt is after the pipeline start
					const pipelineStartIso = new Date(parseInt(bugId.replace("PENDING-", ""))).toISOString();
					const recent = bugs
						.filter((b: Record<string, unknown>) => b.reportedAt && b.reportedAt >= pipelineStartIso)
						.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
							String(b.reportedAt).localeCompare(String(a.reportedAt)),
						)[0];
					if (
						recent &&
						recent.bugId &&
						typeof recent.bugId === "string" &&
						recent.bugId.startsWith("FORGE-BUG-")
					) {
						bugId = recent.bugId;
						ctx.ui.notify(`forge:fix-bug — captured bug ID via store fallback: ${bugId}`, "info");
					}
				}
			} catch {
				/* parse failure — fall through to assertion */
			}
		}
	}

	// Defensive guard: if bugId is still PENDING after triage, pipeline cannot proceed.
	if (bugId.startsWith("PENDING-")) {
		ctx.ui.notify(
			"× forge:fix-bug — failed to capture real bug ID after triage. Cannot proceed with PENDING placeholder.",
			"error",
		);
		return {
			kind: "return",
			result: {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: "bugId still PENDING after triage",
			},
		};
	}

	// Re-initialize debug log now that real bugId is available.
	if (!debugLogDisabled) {
		debugLogPath = path.join(cwd, ".forge", "cache", `fix-bug-debug-${bugId}.jsonl`);
		const capturedPath = debugLogPath;
		writeDebug = (rec: Record<string, unknown>) => {
			try {
				fs.mkdirSync(path.dirname(capturedPath), { recursive: true });
				try {
					const st = fs.statSync(capturedPath);
					if (st.size > 10 * 1024 * 1024) {
						const all = fs.readFileSync(capturedPath, "utf8");
						const lines = all.split("\n");
						const keep = Math.floor(lines.length * 0.8);
						fs.writeFileSync(capturedPath, lines.slice(-keep).join("\n"), "utf8");
					}
				} catch {
					/* file may not exist yet */
				}
				fs.appendFileSync(
					capturedPath,
					`${JSON.stringify({ ts: new Date().toISOString(), phase: "triage", ...rec })}\n`,
					"utf8",
				);
			} catch {
				// non-fatal
			}
		};
		writeDebug({ kind: "bugid_captured", bugId });
	}

	return { kind: "ok", bugId, debugLogPath, writeDebug };
}

// ── 6c. Post-triage transitions + Path A / Path B branch ───────

export interface RouteAfterTriageParams {
	bugId: string;
	cwd: string;
	ctx: ExtensionCommandContext;
	storeCli: string;
	currentPhaseIndex: number;
}

export type RouteAfterTriageOutcome = { kind: "jump"; toIndex: number } | { kind: "advance" };

/**
 * §6c — orchestrator-owned post-triage status transitions, then the Path A/B
 * branch read from bug.summaries.triage.route. Path A skips plan-fix +
 * review-plan (jumps to implement); Path B / missing / any other value advances
 * normally.
 */
export function routeAfterTriage(p: RouteAfterTriageParams): RouteAfterTriageOutcome {
	const { bugId, cwd, ctx, storeCli, currentPhaseIndex } = p;
	const bugAfterTriage = readBugRecord(bugId, storeCli, cwd);

	// Orchestrator-owned post-triage transitions (meta-fix-bug.md
	// step 2). Two sequential writes through store-cli (the FSM
	// authority); failure warns but does not halt — the commit
	// phase's status guard is the backstop.
	for (const target of postTriageTransitions(bugAfterTriage?.status as string | undefined)) {
		const upd = spawnSync("node", [storeCli, "update-status", "bug", bugId, "status", target], {
			cwd,
			encoding: "utf8",
		});
		if (upd.status !== 0) {
			ctx.ui.notify(
				`⚠ forge:fix-bug — post-triage transition to '${target}' failed: ${(upd.stderr ?? "").toString().trim()}`,
				"warning",
			);
			break;
		}
	}

	const triageSummary = bugAfterTriage?.summaries?.triage as { route?: unknown } | undefined;
	const route = triageSummary?.route;
	if (route === "A") {
		const skipUntilIndex = BUG_PHASES.findIndex((ph) => ph.role === "implement");
		if (skipUntilIndex > currentPhaseIndex + 1) {
			ctx.ui.notify(`⊘ forge:fix-bug — Path A selected by triage; skipping plan-fix and review-plan.`, "info");
			return { kind: "jump", toIndex: skipUntilIndex };
		}
	}
	// route === "B", missing, or any other value → fall through to standard advance
	return { kind: "advance" };
}
