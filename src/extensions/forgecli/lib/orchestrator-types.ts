// lib/orchestrator-types.ts — FORGE-S25-T17 (H-10)
//
// Shared orchestrator result type used by both runTaskPipeline (run-task.ts)
// and runBugPipeline (fix-bug.ts). Extracting this to a shared lib module
// allows callers (e.g. run-sprint.ts) to reference a single type when
// consuming pipeline results without importing from either concrete handler.
//
// Design: OrchestratorResult is the base interface. RunTaskPipelineResult and
// RunBugPipelineResult extend it (via structural compatibility — TypeScript's
// structural type system means no `extends` keyword is required; they just
// must satisfy the shape). Verify with the type-level tests in
// test/extensions/forgecli/lib/orchestrator-types.test.ts.

/** Shared status values used by both task and bug pipelines. */
export type OrchestratorStatus = "completed" | "halted" | "escalated" | "failed" | "cancelled";

/**
 * Base shape shared by RunTaskPipelineResult and RunBugPipelineResult.
 *
 * Both concrete result interfaces must be structurally compatible with this
 * type — i.e. a value of either concrete type must be assignable to
 * OrchestratorResult. The type-level tests in orchestrator-types.test.ts
 * enforce this at compile time.
 */
export interface OrchestratorResult {
	status: OrchestratorStatus;
	lastPhaseIndex: number;
	iterationCounts: Record<string, number>;
	lastError?: string;
	/** Model captured from last successful phase's subagent result. */
	model?: string;
	/** Provider captured from last successful phase's subagent result. */
	provider?: string;
}
