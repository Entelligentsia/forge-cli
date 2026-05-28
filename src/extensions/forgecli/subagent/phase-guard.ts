// phase-guard.ts — Defense-in-depth tool-layer enforcement that a
// subagent only acts within its own phase (FORGE-BUG-040).
//
// Background: prior to the fix landed for FORGE-BUG-040, the triage
// subagent received `fix_bug.md` (the orchestrator-only algorithm) as
// its workflow body and silently executed the full lifecycle — preflight
// for every phase, set-bug-summary for every phase, update-status bug
// X status fixed. The root cause (forge-cli BUG_PHASES wiring + meta
// source orchestrator-only-body) is fixed at those layers; this guard
// catches future regressions of the same shape at the tool boundary
// so they fail loudly with a structured error rather than silently
// corrupting state.
//
// Rule (per BUG_FIX_PLAN.md § Per-tool guard rule):
//   For any tool that names a phase (explicitly or implicitly), the
//   tool's *named phase parameter* MUST equal the caller's `phase`
//   tag when called from a subagent context. From an orchestrator
//   context, the guard is a no-op.
//
// Phase ↔ summary-key mapping for set-bug-summary / set-summary is
// imported from the canonical phase-summary-map.ts. The guard does NOT
// duplicate the mapping inline — a divergence between the runtime guard
// and the dispatcher's summary writes would be undetectable otherwise.
//
// Iron Laws:
//   IL1 — code only under forge-cli/src/extensions/forgecli/.
//   IL7 — every refusal path throws PhaseOwnershipError (no silent
//         continuation past a guard failure).

import type { PhaseRole } from "./caller-context.js";
import { CallerContextStore } from "./caller-context.js";
import { BUG_SUMMARY_KEY_BY_ROLE } from "./phase-summary-map.js";

/**
 * Bug-status transitions that may only be written by a specific phase
 * (subagent caller) or by the orchestrator. Used by the guard for
 * `forge_store update-status bug X status ...` calls.
 */
const BUG_STATUS_OWNERSHIP: Record<string, { allowedSubagentPhases: PhaseRole[]; orchestratorAllowed: boolean }> = {
	// commit phase makes the git commit then transitions bug.status to fixed
	fixed: { allowedSubagentPhases: ["commit"], orchestratorAllowed: true },
	// triaged and in-progress are orchestrator-only transitions
	triaged: { allowedSubagentPhases: [], orchestratorAllowed: true },
	"in-progress": { allowedSubagentPhases: [], orchestratorAllowed: true },
	// escalation paths — allowed from orchestrator OR the current phase
	// (the calling subagent is in some phase; escalation is in-band)
	escalated: { allowedSubagentPhases: [], orchestratorAllowed: true, anySubagent: true } as any,
	blocked: { allowedSubagentPhases: [], orchestratorAllowed: true, anySubagent: true } as any,
	abandoned: { allowedSubagentPhases: [], orchestratorAllowed: true, anySubagent: true } as any,
};

export class PhaseOwnershipError extends Error {
	readonly toolName: string;
	readonly callerPhase: PhaseRole | "orchestrator";
	readonly attemptedPhase: string;
	readonly hint: string;

	constructor(toolName: string, callerPhase: PhaseRole | "orchestrator", attemptedPhase: string, hint = "") {
		super(
			`phase-ownership: subagent in phase '${callerPhase}' attempted ${toolName} for phase '${attemptedPhase}'` +
				(hint ? ` — ${hint}` : ""),
		);
		this.name = "PhaseOwnershipError";
		this.toolName = toolName;
		this.callerPhase = callerPhase;
		this.attemptedPhase = attemptedPhase;
		this.hint = hint;
	}
}

/**
 * Assert that the calling subagent's phase context matches the phase
 * named in the tool's arguments. From an orchestrator caller, this is
 * a no-op. From a subagent caller with a mismatched phase, throws
 * `PhaseOwnershipError`.
 *
 * @param toolName  Display name of the tool / subcommand for the error message.
 * @param namedPhase The phase string passed to the tool (e.g. `--phase commit`
 *                  or the `phase` positional arg of `set-bug-summary`).
 */
export function assertPhaseOwnership(toolName: string, namedPhase: string): void {
	const caller = CallerContextStore.get();
	if (caller.kind === "orchestrator") return;

	// set-bug-summary / set-summary callers pass the legacy summary-key
	// (e.g. "implementation") rather than the PhaseRole (e.g. "implement").
	// Always route through the summary-key path for these tools — a
	// direct-name match (caller.phase === namedPhase) would falsely allow
	// a commit-phase caller to call `set-bug-summary <bug> commit ...` even
	// though commit writes no summary at all.
	const isSummaryTool = toolName.includes("set-bug-summary") || toolName.includes("set-summary");
	if (!isSummaryTool && caller.phase === namedPhase) return;

	if (isSummaryTool) {
		const expectedKey = BUG_SUMMARY_KEY_BY_ROLE[caller.phase];
		if (expectedKey === null) {
			throw new PhaseOwnershipError(
				toolName,
				caller.phase,
				namedPhase,
				`phase '${caller.phase}' writes no summary — set-bug-summary is forbidden from this phase`,
			);
		}
		if (expectedKey === undefined) {
			throw new PhaseOwnershipError(
				toolName,
				caller.phase,
				namedPhase,
				`phase '${caller.phase}' is not a recognised bug-mode phase`,
			);
		}
		if (expectedKey !== namedPhase) {
			throw new PhaseOwnershipError(
				toolName,
				caller.phase,
				namedPhase,
				`expected summary key '${expectedKey}' for caller phase`,
			);
		}
		return;
	}

	throw new PhaseOwnershipError(toolName, caller.phase, namedPhase);
}

/**
 * Assert that a `forge_store update-status bug X status <statusValue>`
 * call is permitted from the current caller context. Status transitions
 * are owned by specific phases or by the orchestrator; calling outside
 * the allowed set is rejected.
 */
export function assertBugStatusOwnership(toolName: string, statusValue: string): void {
	const caller = CallerContextStore.get();
	const rule = BUG_STATUS_OWNERSHIP[statusValue];
	if (!rule) {
		// Unknown status — let downstream schema validation reject it
		// with its own (more informative) error.
		return;
	}
	if (caller.kind === "orchestrator") {
		if (rule.orchestratorAllowed) return;
		throw new PhaseOwnershipError(
			toolName,
			"orchestrator",
			`update-status bug ${statusValue}`,
			"this status transition is not orchestrator-allowed",
		);
	}
	if ((rule as any).anySubagent) return;
	if (rule.allowedSubagentPhases.includes(caller.phase)) return;
	throw new PhaseOwnershipError(
		toolName,
		caller.phase,
		`update-status bug ${statusValue}`,
		`status '${statusValue}' may only be written from phase(s): ${rule.allowedSubagentPhases.join(", ") || "(orchestrator only)"}`,
	);
}

/**
 * Phase-event emissions (`forge_store emit` with a phase token in the
 * payload) are always orchestrator-owned per `meta-fix-bug.md § Iron
 * Laws`. The orchestrator composes the canonical event from runtime
 * telemetry plus the subagent's SUMMARY and emits it; subagents that
 * call emit themselves hallucinate runtime facts.
 */
export function assertOrchestratorOnlyEmit(toolName: string): void {
	const caller = CallerContextStore.get();
	if (caller.kind === "orchestrator") return;
	throw new PhaseOwnershipError(
		toolName,
		caller.phase,
		"emit (phase event)",
		"phase event emission is orchestrator-only — subagents write SUMMARY files and return",
	);
}
