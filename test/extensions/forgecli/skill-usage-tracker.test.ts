// Unit tests for skill-usage-tracker module (FORGE-S24-T09).
//
// Coverage:
//   classifySkillUsage:
//     1. ≥2 workflow-step / tool-call overlaps → used: true (overlap signal).
//     2. Skill name appears in agent reasoning → used: true (reasoning signal).
//     3. Single overlap, no reasoning mention → used: false.
//     4. No overlap, no reasoning mention → used: false.
//     5. Empty trajectory → used: false (no overlap, no mention).
//     6. tool_call_success_rate matches observed overlap fraction in [0,1].
//
//   emitSkillUsageTrackingEvents:
//     7. Emits one `skill_usage` event per retrieved skill via
//        `node <storeCli> emit <sprintId> <json>` (Iron Law 6: argv array, no shell).
//     8. Each emitted event has retrieved=true, used set per classifier,
//        type="skill_usage", tool_call_success_rate populated, plus all
//        canonical attribution fields (T01 schema variant).
//     9. Surfaces non-zero subprocess exit as failed without throwing (IL7).
//
// All subprocess calls are mocked — no real store, no real tool dispatch.

import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import {
	classifySkillUsage,
	emitSkillUsageTrackingEvents,
	type RetrievedSkillForTracking,
	type TaskTrajectory,
} from "../../../src/extensions/forgecli/skill-usage-tracker.js";

const mockSpawnSync = vi.mocked(childProcess.spawnSync);

beforeEach(() => {
	mockSpawnSync.mockReset();
	// FORGE-S24-T12 — flag-on path. See skill-curation-flag.test.ts for default-off coverage.
	process.env.FORGE_CLI_SKILL_CURATION_ENABLED = "1";
});

afterEach(() => {
	vi.clearAllMocks();
	delete process.env.FORGE_CLI_SKILL_CURATION_ENABLED;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const storeQueryNlp: RetrievedSkillForTracking = {
	skillId: "store-query-nlp",
	name: "store-query-nlp",
	workflowSteps: ["store-cli query", "store-cli list", "store-cli read"],
};

const refreshKbLinks: RetrievedSkillForTracking = {
	skillId: "refresh-kb-links",
	name: "refresh-kb-links",
	workflowSteps: ["refresh-kb-links", "validate-store"],
};

const reasoningOnly: RetrievedSkillForTracking = {
	skillId: "calibrate",
	name: "calibrate",
	workflowSteps: ["calibrate-drift", "propose-patch"],
};

// ── classifySkillUsage ────────────────────────────────────────────────────────

describe("skill-usage-tracker / classifySkillUsage", () => {
	it("flags used=true when ≥2 workflow steps overlap with executed tool calls", () => {
		const trajectory: TaskTrajectory = {
			toolCalls: [{ name: "store-cli query" }, { name: "store-cli list" }, { name: "unrelated-tool" }],
			reasoningText: "Doing some work.",
		};

		const verdict = classifySkillUsage(storeQueryNlp, trajectory);
		expect(verdict.used).toBe(true);
		expect(verdict.signal).toBe("overlap");
		// 2 of 3 workflow steps observed
		expect(verdict.tool_call_success_rate).toBeCloseTo(2 / 3, 5);
	});

	it("flags used=true when skill name appears in agent reasoning (no overlap)", () => {
		const trajectory: TaskTrajectory = {
			toolCalls: [{ name: "unrelated-tool" }],
			reasoningText: "I should consult the calibrate skill before applying patches.",
		};

		const verdict = classifySkillUsage(reasoningOnly, trajectory);
		expect(verdict.used).toBe(true);
		expect(verdict.signal).toBe("reasoning");
		// No overlap observed → rate is 0.
		expect(verdict.tool_call_success_rate).toBe(0);
	});

	it("flags used=false when only one workflow step overlaps and no reasoning mention", () => {
		const trajectory: TaskTrajectory = {
			toolCalls: [{ name: "store-cli query" }, { name: "unrelated-tool" }],
			reasoningText: "Doing some work.",
		};

		const verdict = classifySkillUsage(storeQueryNlp, trajectory);
		expect(verdict.used).toBe(false);
		expect(verdict.tool_call_success_rate).toBeCloseTo(1 / 3, 5);
	});

	it("flags used=false when no overlap and no reasoning mention", () => {
		const trajectory: TaskTrajectory = {
			toolCalls: [{ name: "totally-unrelated" }],
			reasoningText: "Doing some work.",
		};

		const verdict = classifySkillUsage(refreshKbLinks, trajectory);
		expect(verdict.used).toBe(false);
		expect(verdict.tool_call_success_rate).toBe(0);
	});

	it("flags used=false for an empty trajectory", () => {
		const trajectory: TaskTrajectory = {
			toolCalls: [],
			reasoningText: "",
		};

		const verdict = classifySkillUsage(refreshKbLinks, trajectory);
		expect(verdict.used).toBe(false);
		expect(verdict.tool_call_success_rate).toBe(0);
	});

	it("clamps tool_call_success_rate into [0,1] for any input", () => {
		const trajectory: TaskTrajectory = {
			toolCalls: [
				{ name: "store-cli query" },
				{ name: "store-cli query" }, // duplicate — should not double-count
				{ name: "store-cli list" },
				{ name: "store-cli read" },
			],
			reasoningText: "",
		};

		const verdict = classifySkillUsage(storeQueryNlp, trajectory);
		expect(verdict.tool_call_success_rate).toBeGreaterThanOrEqual(0);
		expect(verdict.tool_call_success_rate).toBeLessThanOrEqual(1);
		// All 3 distinct steps observed → 1.0
		expect(verdict.tool_call_success_rate).toBe(1);
	});
});

// ── emitSkillUsageTrackingEvents ─────────────────────────────────────────────

describe("skill-usage-tracker / emitSkillUsageTrackingEvents", () => {
	const runtime = {
		storeCli: "/tmp/store-cli.cjs",
		cwd: "/tmp/proj",
		sprintId: "FORGE-S24",
		taskId: "FORGE-S24-T09",
		role: "engineer",
		action: "/forge:run-task",
		phase: "engineer",
		iteration: 1,
		startTimestamp: "2026-05-22T00:00:00.000Z",
		endTimestamp: "2026-05-22T00:00:10.000Z",
		durationMinutes: 0.17,
		model: "claude-opus-4-7",
		provider: "anthropic",
	};

	it("emits one event per retrieved skill via spawnSync argv-array", () => {
		mockSpawnSync.mockReturnValue({
			status: 0,
			stderr: "",
			stdout: "",
			pid: 0,
			output: [],
			signal: null,
		} as unknown as ReturnType<typeof childProcess.spawnSync>);

		const retrieved = [storeQueryNlp, refreshKbLinks];
		const trajectory: TaskTrajectory = {
			toolCalls: [{ name: "store-cli query" }, { name: "store-cli list" }],
			reasoningText: "Used store query.",
		};

		const result = emitSkillUsageTrackingEvents(retrieved, trajectory, runtime);
		expect(result.emitted).toBe(2);
		expect(result.failed).toBe(0);
		expect(mockSpawnSync).toHaveBeenCalledTimes(2);

		const firstCall = mockSpawnSync.mock.calls[0];
		// FORGE-S25-T17: spawnStoreCliEmit uses process.execPath (not bare "node")
		expect(firstCall[0]).toBe(process.execPath);
		const argv = firstCall[1] as string[];
		expect(Array.isArray(argv)).toBe(true);
		expect(argv[0]).toBe(runtime.storeCli);
		expect(argv[1]).toBe("emit");
		expect(argv[2]).toBe(runtime.sprintId);

		const event = JSON.parse(argv[3]);
		expect(event.type).toBe("skill_usage");
		expect(event.retrieved).toBe(true);
		expect(event.used).toBe(true);
		expect(event.skillId).toBe("store-query-nlp");
		expect(event.sprintId).toBe("FORGE-S24");
		expect(event.taskId).toBe("FORGE-S24-T09");
		expect(event.role).toBe("engineer");
		expect(event.action).toBe("/forge:run-task");
		expect(event.startTimestamp).toBe(runtime.startTimestamp);
		expect(event.endTimestamp).toBe(runtime.endTimestamp);
		expect(event.durationMinutes).toBe(runtime.durationMinutes);
		expect(event.model).toBe(runtime.model);
		expect(event.provider).toBe(runtime.provider);
		expect(typeof event.eventId).toBe("string");
		expect(event.eventId.length).toBeGreaterThan(0);

		// tool_call_success_rate must be finite and in [0,1].
		expect(typeof event.tool_call_success_rate).toBe("number");
		expect(event.tool_call_success_rate).toBeGreaterThanOrEqual(0);
		expect(event.tool_call_success_rate).toBeLessThanOrEqual(1);

		// retrieval_score is set to 0 — T08 already emitted the populated
		// retrieval_score; T09 emits a tracking-time follow-up.
		expect(event.retrieval_score).toBe(0);

		// Second skill (refresh-kb-links) had no overlap and no reasoning mention.
		const secondArgv = mockSpawnSync.mock.calls[1][1] as string[];
		const secondEvent = JSON.parse(secondArgv[3]);
		expect(secondEvent.skillId).toBe("refresh-kb-links");
		expect(secondEvent.used).toBe(false);
		expect(secondEvent.tool_call_success_rate).toBe(0);
	});

	it("surfaces non-zero subprocess exit as failed without throwing (IL7)", () => {
		mockSpawnSync.mockReturnValue({
			status: 1,
			stderr: "store-cli: validation error",
			stdout: "",
			pid: 0,
			output: [],
			signal: null,
		} as unknown as ReturnType<typeof childProcess.spawnSync>);

		const retrieved = [storeQueryNlp];
		const trajectory: TaskTrajectory = {
			toolCalls: [{ name: "store-cli query" }, { name: "store-cli list" }],
			reasoningText: "",
		};
		expect(() => emitSkillUsageTrackingEvents(retrieved, trajectory, runtime)).not.toThrow();

		const r = emitSkillUsageTrackingEvents(retrieved, trajectory, runtime);
		expect(r.emitted).toBe(0);
		expect(r.failed).toBe(1);
		expect(r.stderrs[0]).toContain("store-cli");
	});
});
