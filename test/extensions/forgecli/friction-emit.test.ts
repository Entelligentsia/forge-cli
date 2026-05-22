// Unit tests for friction-emit module (FORGE-S24-T11).
//
// Coverage:
//   computeFrictionSignals — pure classifier:
//     1. skill_unused      : retrieved && !used && task.success         → emit
//     2. skill_failed      : retrieved && used  && !task.success        → emit
//     3. skill_missing     : !retrieved && task.success && tool_errors≥2 → emit (per task)
//     4. skill_stale       : retrieved && !used in 3 consecutive sprints → emit
//     5. skill_redundant   : two retrieved skills with overlap > 0.8     → emit one pair
//     6. None of the gates fire → no signals
//     7. Payload includes skillId + subkind + evidence
//
//   emitFrictionEvents:
//     8. Emits one `friction` event per computed signal via
//        spawnSync("node", [storeCli, "emit", sprintId, JSON.stringify(event)])
//        — argv array, no shell (IL6).
//     9. Each event has type="friction", required {workflow, persona, issue},
//        subkind populated per signal, plus runtime attribution from the
//        orchestrator (IL10 — never fabricated).
//    10. Non-zero subprocess exit increments `failed`; stderr captured (IL7).
//
// All subprocess calls are mocked.

import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

import {
	computeFrictionSignals,
	emitFrictionEvents,
	type FrictionInputs,
	type FrictionEmitRuntime,
	type FrictionSignal,
} from "../../../src/extensions/forgecli/friction-emit.js";

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

// ── Fixtures ────────────────────────────────────────────────────────────────

const runtime: FrictionEmitRuntime = {
	storeCli: "/tmp/fake/store-cli.cjs",
	cwd: "/tmp/fake",
	sprintId: "FORGE-S24",
	taskId: "FORGE-S24-T11",
	role: "orchestrator",
	action: "friction_drain",
	workflow: "orchestrate",
	persona: "orchestrator",
	startTimestamp: "2026-05-22T12:00:00.000Z",
	endTimestamp: "2026-05-22T12:00:05.000Z",
	durationMinutes: 5 / 60,
	model: "claude-opus-4-7",
	provider: "anthropic",
};

// ── computeFrictionSignals ──────────────────────────────────────────────────

describe("friction-emit / computeFrictionSignals", () => {
	it("emits skill_unused when retrieved && !used && task.success", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "calibrate", retrieved: true, used: false, retrievalScore: 0.7 },
			],
			taskSuccess: true,
			toolErrorCount: 0,
			history: {},
		};

		const signals = computeFrictionSignals(inputs);
		const unused = signals.filter((s) => s.subkind === "skill_unused");
		expect(unused).toHaveLength(1);
		expect(unused[0].skillId).toBe("calibrate");
		expect(unused[0].evidence).toBeDefined();
	});

	it("emits skill_failed when retrieved && used && !task.success", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "calibrate", retrieved: true, used: true, retrievalScore: 0.7 },
			],
			taskSuccess: false,
			toolErrorCount: 3,
			history: {},
		};

		const signals = computeFrictionSignals(inputs);
		const failed = signals.filter((s) => s.subkind === "skill_failed");
		expect(failed).toHaveLength(1);
		expect(failed[0].skillId).toBe("calibrate");
	});

	it("emits skill_missing when !retrieved && task.success && tool_errors ≥ 2", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [],
			taskSuccess: true,
			toolErrorCount: 4,
			history: {},
		};

		const signals = computeFrictionSignals(inputs);
		const missing = signals.filter((s) => s.subkind === "skill_missing");
		expect(missing).toHaveLength(1);
		expect(missing[0].evidence).toMatchObject({ toolErrorCount: 4 });
	});

	it("does NOT emit skill_missing when tool_errors < 2", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [],
			taskSuccess: true,
			toolErrorCount: 1,
			history: {},
		};

		const signals = computeFrictionSignals(inputs);
		expect(signals.filter((s) => s.subkind === "skill_missing")).toHaveLength(
			0,
		);
	});

	it("emits skill_stale when skill seen retrieved && !used in 3 consecutive sprints", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "calibrate", retrieved: true, used: false, retrievalScore: 0.7 },
			],
			taskSuccess: true,
			toolErrorCount: 0,
			history: {
				calibrate: { consecutiveUnusedSprints: 3 },
			},
		};

		const signals = computeFrictionSignals(inputs);
		const stale = signals.filter((s) => s.subkind === "skill_stale");
		expect(stale).toHaveLength(1);
		expect(stale[0].skillId).toBe("calibrate");
		expect(stale[0].evidence).toMatchObject({ consecutiveUnusedSprints: 3 });
	});

	it("does NOT emit skill_stale when consecutive sprint count is < 3", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "calibrate", retrieved: true, used: false, retrievalScore: 0.7 },
			],
			taskSuccess: true,
			toolErrorCount: 0,
			history: {
				calibrate: { consecutiveUnusedSprints: 2 },
			},
		};

		const signals = computeFrictionSignals(inputs);
		expect(signals.filter((s) => s.subkind === "skill_stale")).toHaveLength(0);
	});

	it("emits skill_redundant when two retrieved skills overlap > 0.8", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "skill-a", retrieved: true, used: true, retrievalScore: 0.9 },
				{ skillId: "skill-b", retrieved: true, used: true, retrievalScore: 0.9 },
			],
			taskSuccess: true,
			toolErrorCount: 0,
			history: {},
			pairwiseRetrievalOverlap: [
				{ skillA: "skill-a", skillB: "skill-b", overlap: 0.85 },
			],
		};

		const signals = computeFrictionSignals(inputs);
		const redundant = signals.filter((s) => s.subkind === "skill_redundant");
		expect(redundant).toHaveLength(1);
		expect(redundant[0].evidence).toMatchObject({
			overlap: 0.85,
			pairedWith: "skill-b",
		});
	});

	it("does NOT emit skill_redundant when overlap ≤ 0.8", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "skill-a", retrieved: true, used: true, retrievalScore: 0.9 },
				{ skillId: "skill-b", retrieved: true, used: true, retrievalScore: 0.9 },
			],
			taskSuccess: true,
			toolErrorCount: 0,
			history: {},
			pairwiseRetrievalOverlap: [
				{ skillA: "skill-a", skillB: "skill-b", overlap: 0.8 },
			],
		};

		const signals = computeFrictionSignals(inputs);
		expect(signals.filter((s) => s.subkind === "skill_redundant")).toHaveLength(
			0,
		);
	});

	it("emits no signals when all gates fail", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "calibrate", retrieved: true, used: true, retrievalScore: 0.7 },
			],
			taskSuccess: true,
			toolErrorCount: 0,
			history: { calibrate: { consecutiveUnusedSprints: 0 } },
		};

		const signals = computeFrictionSignals(inputs);
		expect(signals).toHaveLength(0);
	});

	it("does NOT emit skill_unused on a failed task (avoids double-counting with skill_failed)", () => {
		const inputs: FrictionInputs = {
			retrievedSkills: [
				{ skillId: "calibrate", retrieved: true, used: false, retrievalScore: 0.7 },
			],
			taskSuccess: false,
			toolErrorCount: 0,
			history: {},
		};

		const signals = computeFrictionSignals(inputs);
		expect(signals.filter((s) => s.subkind === "skill_unused")).toHaveLength(0);
	});
});

// ── emitFrictionEvents ──────────────────────────────────────────────────────

describe("friction-emit / emitFrictionEvents", () => {
	function ok() {
		mockSpawnSync.mockReturnValue({
			status: 0,
			stdout: "",
			stderr: "",
			pid: 1,
			output: [],
			signal: null,
		} as unknown as ReturnType<typeof childProcess.spawnSync>);
	}

	it("emits one friction event per signal via argv-array spawn (IL6)", () => {
		ok();
		const signals: FrictionSignal[] = [
			{
				subkind: "skill_unused",
				skillId: "calibrate",
				evidence: { retrievalScore: 0.7 },
			},
			{
				subkind: "skill_missing",
				skillId: undefined,
				evidence: { toolErrorCount: 3 },
			},
		];

		const result = emitFrictionEvents(signals, runtime);
		expect(result.emitted).toBe(2);
		expect(result.failed).toBe(0);
		expect(mockSpawnSync).toHaveBeenCalledTimes(2);

		const [bin, argv, opts] = mockSpawnSync.mock.calls[0];
		expect(bin).toBe("node");
		expect(Array.isArray(argv)).toBe(true);
		expect(argv?.[0]).toBe(runtime.storeCli);
		expect(argv?.[1]).toBe("emit");
		expect(argv?.[2]).toBe(runtime.sprintId);
		expect(typeof argv?.[3]).toBe("string");
		expect((opts as { cwd?: string })?.cwd).toBe(runtime.cwd);
	});

	it("includes type=friction, workflow, persona, issue, subkind, skillId, evidence", () => {
		ok();
		const signals: FrictionSignal[] = [
			{
				subkind: "skill_failed",
				skillId: "calibrate",
				evidence: { toolErrorCount: 4 },
			},
		];

		emitFrictionEvents(signals, runtime);
		const payload = JSON.parse(
			mockSpawnSync.mock.calls[0][1]?.[3] as string,
		) as Record<string, unknown>;
		expect(payload.type).toBe("friction");
		expect(payload.workflow).toBe("orchestrate");
		expect(payload.persona).toBe("orchestrator");
		expect(payload.issue).toBe("skill_failed");
		expect(payload.subkind).toBe("skill_failed");
		expect(payload.skillId).toBe("calibrate");
		expect(payload.evidence).toMatchObject({ toolErrorCount: 4 });
		expect(payload.model).toBe(runtime.model);
		expect(payload.provider).toBe(runtime.provider);
		expect(payload.sprintId).toBe(runtime.sprintId);
		expect(payload.taskId).toBe(runtime.taskId);
	});

	it("captures non-zero exit as failed with stderr (IL7)", () => {
		mockSpawnSync.mockReturnValue({
			status: 1,
			stdout: "",
			stderr: "schema error: missing workflow",
			pid: 1,
			output: [],
			signal: null,
		} as unknown as ReturnType<typeof childProcess.spawnSync>);
		const signals: FrictionSignal[] = [
			{
				subkind: "skill_unused",
				skillId: "calibrate",
				evidence: {},
			},
		];

		const result = emitFrictionEvents(signals, runtime);
		expect(result.emitted).toBe(0);
		expect(result.failed).toBe(1);
		expect(result.stderrs[0]).toContain("schema error");
	});
});
