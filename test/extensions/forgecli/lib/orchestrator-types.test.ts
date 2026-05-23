// orchestrator-types.test.ts — FORGE-S25-T17 (H-10)
//
// Unit tests for lib/orchestrator-types.ts: OrchestratorResult type compatibility
// with RunTaskPipelineResult and RunBugPipelineResult.
//
// Type-level tests use assignability checks; runtime tests verify the shared
// fields are structurally identical.

import { describe, expect, it } from "vitest";
import type { OrchestratorResult } from "../../../../src/extensions/forgecli/lib/orchestrator-types.js";
import type { RunTaskPipelineResult } from "../../../../src/extensions/forgecli/run-task.js";
import type { RunBugPipelineResult } from "../../../../src/extensions/forgecli/fix-bug.js";

// Type-level: OrchestratorResult must be assignable from RunTaskPipelineResult
// and RunBugPipelineResult. These are compile-time checks; if they fail,
// the type definitions are incompatible.
type _AssertTaskExtends = RunTaskPipelineResult extends OrchestratorResult ? true : false;
type _AssertBugExtends = RunBugPipelineResult extends OrchestratorResult ? true : false;
const _checkTask: _AssertTaskExtends = true;
const _checkBug: _AssertBugExtends = true;
// Suppress unused-variable warnings in tests — these are type assertion guards.
void _checkTask;
void _checkBug;

describe("OrchestratorResult (lib/orchestrator-types.ts)", () => {
	it("a RunTaskPipelineResult satisfies OrchestratorResult shape", () => {
		const taskResult: RunTaskPipelineResult = {
			status: "completed",
			lastPhaseIndex: 4,
			iterationCounts: { "review-plan": 1 },
		};
		// Assignability: OrchestratorResult must accept all fields of RunTaskPipelineResult
		const orchestratorResult: OrchestratorResult = taskResult;
		expect(orchestratorResult.status).toBe("completed");
		expect(orchestratorResult.lastPhaseIndex).toBe(4);
		expect(orchestratorResult.iterationCounts).toEqual({ "review-plan": 1 });
	});

	it("a RunBugPipelineResult satisfies OrchestratorResult shape", () => {
		const bugResult: RunBugPipelineResult = {
			status: "failed",
			lastPhaseIndex: 1,
			iterationCounts: {},
			lastError: "model config validation failed",
		};
		const orchestratorResult: OrchestratorResult = bugResult;
		expect(orchestratorResult.status).toBe("failed");
		expect(orchestratorResult.lastError).toBe("model config validation failed");
	});

	it("OrchestratorResult optional fields are preserved", () => {
		const result: OrchestratorResult = {
			status: "halted",
			lastPhaseIndex: 2,
			iterationCounts: {},
			model: "claude-sonnet-4-6",
			provider: "anthropic",
		};
		expect(result.model).toBe("claude-sonnet-4-6");
		expect(result.provider).toBe("anthropic");
	});

	it("OrchestratorResult accepts cancelled status", () => {
		const result: OrchestratorResult = {
			status: "cancelled",
			lastPhaseIndex: 0,
			iterationCounts: {},
		};
		expect(result.status).toBe("cancelled");
	});
});
