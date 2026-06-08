// run-task.ts — /forge:run-task native Orchestrator handler (FORGE-S21-T02).
//
// BARREL (FORGE-S31 file-size refactor). The implementation was decomposed into
// themed modules under ./task/ and ./common/ to satisfy the per-file
// architectural line cap. This file re-exports the full public surface so
// existing importers (run-sprint.ts, fix-bug.ts, index.ts, bin/config.ts, the
// test suite, calibrate.ts, wf-engine/engine.ts) keep resolving unchanged.
//
// Iron Laws (enforced in the extracted modules):
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff calls here)
//
// sendKickoff is NEVER called from this file or its extracted modules.
//
// Orchestrator emit path (Plan 11 / Slice 2): the pipeline composes each phase
// event and emits it via `node <forgeRoot>/tools/store-cli.cjs "emit" <sprintId>
// <eventJson>` — see emitEvent in ./task/task-events.js. The subagent never
// calls store-cli emit itself; the orchestrator owns the emit path here.

// ── Generic orchestrator helpers (common) ─────────────────────────────────
export { formatLocalTime, isNonInteractive, validateId } from "./common/orchestrator-misc.js";

// ── Phase descriptor table ─────────────────────────────────────────────────
export { type PhaseDescriptor, PHASES, SUMMARY_KEY_BY_ROLE } from "./task/task-phases.js";

// ── State persistence ─────────────────────────────────────────────────────
export {
	deleteState,
	isStateStale,
	readState,
	type RunTaskState,
	writeState,
} from "./task/task-state.js";

// ── Verdict + task-record reads ────────────────────────────────────────────
export { readTaskRecord, readVerdict, type TaskRecord } from "./task/task-record.js";

// ── Event composition + emission ───────────────────────────────────────────
export {
	actionForRole,
	buildPhaseEvent,
	drainFrictionFile,
	emitEvent,
	emitIncompletePhaseEvent,
	isoCompact,
	judgementFromSummary,
	type OrchestratorEmitContext,
} from "./task/task-events.js";

// ── Gates ──────────────────────────────────────────────────────────────────
export {
	type GateFailureData,
	type PreflightOutcome,
	type PreflightResult,
	runPostflightGate,
	runPreflightGate,
	runPreflightGateWithData,
} from "./task/task-gates.js";

// ── Task body composition + predecessor finder ─────────────────────────────
export { buildSummariesBlock, composeTaskBody, findPredecessorIndex } from "./task/task-body.js";

// ── Pipeline option/result types ───────────────────────────────────────────
export {
	type RunTaskPipelineOptions,
	type RunTaskPipelineResult,
	type RunTaskPipelineStatus,
} from "./task/run-task-types.js";

// ── Pipeline + command handler ─────────────────────────────────────────────
export { runTaskPipeline } from "./task/run-task-pipeline.js";
export { type RegisterRunTaskOptions, registerRunTask } from "./task/run-task-command.js";

// extractTurnPreview moved to viewport/renderer.ts; re-exported here for
// backwards-compatibility with existing imports (e.g. tests, wf-engine/engine).
export { extractTurnPreview } from "../viewport/renderer.js";
