// fix-bug.ts — /forge:fix-bug Orchestrator native handler (FORGE-S21-T07).
//
// BARREL (FORGE-S31 file-size refactor). The implementation was decomposed into
// themed modules under ./bug/ to satisfy the per-file architectural line cap.
// This file re-exports the full public surface so existing importers
// (index.ts, bin/config.ts, the test suite) keep resolving unchanged.
//
// Iron Laws (enforced in the extracted modules):
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff calls here)
//
// sendKickoff is NEVER called from this file or its extracted modules.

// ── Bug phase descriptor table + FSM transitions + event tokens ────────────
export { BUG_PHASES, BUG_TYPE_TOKENS, postTriageTransitions } from "./bug/bug-phases.js";

// ── Post-triage routing (status transitions + Path A/B branch) ─────────────
export {
	type RouteAfterTriageOutcome,
	type RouteAfterTriageParams,
	routeAfterTriage,
} from "./bug/bug-triage-routing.js";

// BUG_SUMMARY_KEY_BY_ROLE lives in subagent/phase-summary-map.ts; re-exported
// here for backwards-compatibility with existing call sites and tests.
export { BUG_SUMMARY_KEY_BY_ROLE } from "../subagent/phase-summary-map.js";

// ── State persistence ─────────────────────────────────────────────────────
export {
	deleteBugState,
	isBugStateStale,
	readBugState,
	type RunBugState,
	writeBugState,
} from "./bug/bug-state.js";

// ── Bug record + ID minting / capture helpers ──────────────────────────────
export {
	assignNextBugId,
	type BugRecord,
	computeNextBugId,
	extractBugIdFromEvents,
	extractBugIdFromReportText,
	preCreateBug,
	readBugRecord,
} from "./bug/bug-id.js";

// ── Verdict read ───────────────────────────────────────────────────────────
export { readBugVerdict } from "./bug/bug-verdict.js";

// ── Bug body composition ───────────────────────────────────────────────────
export { composeBugBody } from "./bug/bug-body.js";

// ── Pipeline option/result types ───────────────────────────────────────────
export {
	type RunBugPipelineOptions,
	type RunBugPipelineResult,
	type RunBugPipelineStatus,
} from "./bug/run-bug-types.js";

// ── Pipeline + command handler ─────────────────────────────────────────────
export { runBugPipeline } from "./bug/run-bug-pipeline.js";
export { type RegisterFixBugOptions, registerFixBug } from "./bug/run-bug-command.js";
