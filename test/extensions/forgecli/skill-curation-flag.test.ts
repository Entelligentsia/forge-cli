// Unit tests for the SKILL-CURATION feature flag — FORGE-S24-T12.
//
// Coverage:
//   1. parseEnvFlag accepts "1"/"true"/"0"/"false" (case-insensitive) and
//      returns null for unrecognised values (so the disk layer can decide).
//   2. isSkillCurationEnabled defaults to false when no env override, no
//      project config, and no global config provide a value.
//   3. Env override `FORGE_CLI_SKILL_CURATION_ENABLED` wins over every
//      disk layer (both for on and for off).
//   4. Project config wins over global config when env is absent.
//   5. Global config wins when project config is absent.
//
//   Flag-off no-op guarantee (FORGE-S24-T12 AC3):
//   6. `emitSkillUsageEvents` (T08) returns {emitted:0, failed:0} and
//      makes ZERO `spawnSync` calls when the flag is off.
//   7. `emitSkillUsageTrackingEvents` (T09) returns the same and makes
//      ZERO `spawnSync` calls.
//   8. `emitFrictionEvents` (T11) returns the same and makes ZERO
//      `spawnSync` calls (for skill subkinds — the gate scope).
//   9. `runSkillCurator` (T10) returns {exitCode:0, written:0} and never
//      dispatches a subagent when the flag is off.
//
//   Flag-on smoke (sanity that the gate doesn't change normal behaviour):
//  10. With the env override set to "1", `emitSkillUsageEvents` proceeds
//      to spawn `node` exactly once per hit (we mock spawnSync to assert
//      the call shape — argv array, IL6).
//
// All subprocess calls are mocked. The runForgeSubagent surface for T10
// is mocked to assert it is NOT called when the flag is off.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawnSync: vi.fn(),
}));

vi.mock("../../../src/extensions/forgecli/forge-subagent.js", () => ({
	runForgeSubagent: vi.fn(),
	getFinalOutput: vi.fn(() => ""),
}));

import {
	isSkillCurationEnabled,
	_internal,
} from "../../../src/extensions/forgecli/skill-curation-flag.js";
import {
	emitSkillUsageEvents,
	type EmitRuntime as RetrieverEmitRuntime,
	type RetrievalHit,
} from "../../../src/extensions/forgecli/skill-retriever.js";
import {
	emitSkillUsageTrackingEvents,
	type EmitRuntime as TrackerEmitRuntime,
} from "../../../src/extensions/forgecli/skill-usage-tracker.js";
import {
	emitFrictionEvents,
	type FrictionEmitRuntime,
	type FrictionSignal,
} from "../../../src/extensions/forgecli/friction-emit.js";
import { runSkillCurator } from "../../../src/extensions/forgecli/skill-curator-subagent.js";
import { runForgeSubagent } from "../../../src/extensions/forgecli/forge-subagent.js";

const mockSpawnSync = vi.mocked(childProcess.spawnSync);
const mockRunSubagent = vi.mocked(runForgeSubagent);

// ── Fixture roots — isolated per test so disk layer reads have a fresh
// cwd with no project config. Global config path is keyed off
// FORGE_CLI_HOME, also overridden per test.

let tmpRoot: string;
let projectCwd: string;
let userHome: string;

const SAVED_ENV = { ...process.env };

beforeEach(() => {
	mockSpawnSync.mockReset();
	mockRunSubagent.mockReset();

	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-curation-flag-"));
	projectCwd = path.join(tmpRoot, "project");
	userHome = path.join(tmpRoot, "userhome");
	fs.mkdirSync(projectCwd, { recursive: true });
	fs.mkdirSync(userHome, { recursive: true });

	// Force the path resolver to look inside our isolated user home for
	// the global config (~/.pi/forge-cli/config.json layout — see paths.ts).
	process.env.FORGE_CLI_HOME = path.join(userHome, ".pi", "forge-cli");
	fs.mkdirSync(process.env.FORGE_CLI_HOME, { recursive: true });

	delete process.env.FORGE_CLI_SKILL_CURATION_ENABLED;
});

afterEach(() => {
	process.env = { ...SAVED_ENV };
	vi.clearAllMocks();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeProjectConfig(cfg: unknown): void {
	const dir = path.join(projectCwd, ".pi", "forge-cli");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
}

function writeGlobalConfig(cfg: unknown): void {
	const dir = process.env.FORGE_CLI_HOME as string;
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
}

// ── parseEnvFlag ────────────────────────────────────────────────────────────

describe("skill-curation-flag / parseEnvFlag", () => {
	it("accepts 1 / true / TRUE for on", () => {
		expect(_internal.parseEnvFlag("1")).toBe(true);
		expect(_internal.parseEnvFlag("true")).toBe(true);
		expect(_internal.parseEnvFlag("TRUE")).toBe(true);
		expect(_internal.parseEnvFlag(" True ")).toBe(true);
	});

	it("accepts 0 / false / FALSE for off", () => {
		expect(_internal.parseEnvFlag("0")).toBe(false);
		expect(_internal.parseEnvFlag("false")).toBe(false);
		expect(_internal.parseEnvFlag("FALSE")).toBe(false);
	});

	it("returns null for absent / unrecognised values", () => {
		expect(_internal.parseEnvFlag(undefined)).toBeNull();
		expect(_internal.parseEnvFlag("")).toBeNull();
		expect(_internal.parseEnvFlag("maybe")).toBeNull();
		expect(_internal.parseEnvFlag("yes")).toBeNull();
	});
});

// ── isSkillCurationEnabled ──────────────────────────────────────────────────

describe("skill-curation-flag / isSkillCurationEnabled", () => {
	it("defaults to false with no env, no project, no global config (AC2)", () => {
		expect(isSkillCurationEnabled(projectCwd)).toBe(false);
	});

	it("env override = '1' returns true even when both disk layers say false", () => {
		writeProjectConfig({ forgeCli: { skillCuration: { enabled: false } } });
		writeGlobalConfig({ forgeCli: { skillCuration: { enabled: false } } });
		process.env.FORGE_CLI_SKILL_CURATION_ENABLED = "1";
		expect(isSkillCurationEnabled(projectCwd)).toBe(true);
	});

	it("env override = '0' returns false even when project config says true", () => {
		writeProjectConfig({ forgeCli: { skillCuration: { enabled: true } } });
		process.env.FORGE_CLI_SKILL_CURATION_ENABLED = "0";
		expect(isSkillCurationEnabled(projectCwd)).toBe(false);
	});

	it("project config wins over global when env is absent", () => {
		writeProjectConfig({ forgeCli: { skillCuration: { enabled: true } } });
		writeGlobalConfig({ forgeCli: { skillCuration: { enabled: false } } });
		expect(isSkillCurationEnabled(projectCwd)).toBe(true);
	});

	it("global config used when project config has no opinion", () => {
		writeGlobalConfig({ forgeCli: { skillCuration: { enabled: true } } });
		expect(isSkillCurationEnabled(projectCwd)).toBe(true);
	});

	it("malformed env value falls through to disk layers", () => {
		writeProjectConfig({ forgeCli: { skillCuration: { enabled: true } } });
		process.env.FORGE_CLI_SKILL_CURATION_ENABLED = "maybe";
		expect(isSkillCurationEnabled(projectCwd)).toBe(true);
	});
});

// ── Flag-off no-op guarantee (FORGE-S24-T12 AC3) ────────────────────────────

const retrieverRuntime = (): RetrieverEmitRuntime => ({
	storeCli: "/tmp/fake/store-cli.cjs",
	cwd: projectCwd,
	sprintId: "FORGE-S24",
	taskId: "FORGE-S24-T12",
	role: "orchestrator",
	action: "retrieve",
	startTimestamp: "2026-05-22T12:00:00.000Z",
	endTimestamp: "2026-05-22T12:00:01.000Z",
	durationMinutes: 1 / 60,
	model: "claude-opus-4-7",
	provider: "anthropic",
});

const trackerRuntime = (): TrackerEmitRuntime => ({
	storeCli: "/tmp/fake/store-cli.cjs",
	cwd: projectCwd,
	sprintId: "FORGE-S24",
	taskId: "FORGE-S24-T12",
	role: "orchestrator",
	action: "track",
	startTimestamp: "2026-05-22T12:00:00.000Z",
	endTimestamp: "2026-05-22T12:00:01.000Z",
	durationMinutes: 1 / 60,
	model: "claude-opus-4-7",
	provider: "anthropic",
});

const frictionRuntime = (): FrictionEmitRuntime => ({
	storeCli: "/tmp/fake/store-cli.cjs",
	cwd: projectCwd,
	sprintId: "FORGE-S24",
	taskId: "FORGE-S24-T12",
	role: "orchestrator",
	action: "friction_drain",
	workflow: "orchestrate",
	persona: "orchestrator",
	startTimestamp: "2026-05-22T12:00:00.000Z",
	endTimestamp: "2026-05-22T12:00:01.000Z",
	durationMinutes: 1 / 60,
	model: "claude-opus-4-7",
	provider: "anthropic",
});

describe("skill-curation gate / flag-off no-op guarantee (AC3)", () => {
	it("emitSkillUsageEvents (T08) returns zero and never spawns", () => {
		const hits: RetrievalHit[] = [
			{ skillId: "calibrate", score: 0.5 },
			{ skillId: "store-query", score: 0.3 },
		];
		const result = emitSkillUsageEvents(hits, retrieverRuntime());
		expect(result).toEqual({ emitted: 0, failed: 0, stderrs: [] });
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("emitSkillUsageTrackingEvents (T09) returns zero and never spawns", () => {
		const result = emitSkillUsageTrackingEvents(
			[
				{
					skillId: "calibrate",
					name: "calibrate",
					workflowSteps: ["step a", "step b"],
				},
			],
			{ toolCalls: [{ name: "Read" }], reasoningText: "no skill mention" },
			trackerRuntime(),
		);
		expect(result).toEqual({ emitted: 0, failed: 0, stderrs: [] });
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("emitFrictionEvents (T11) returns zero and never spawns", () => {
		const signals: FrictionSignal[] = [
			{ subkind: "skill_unused", skillId: "calibrate", evidence: { retrievalScore: 0.7 } },
		];
		const result = emitFrictionEvents(signals, frictionRuntime());
		expect(result).toEqual({ emitted: 0, failed: 0, stderrs: [] });
		expect(mockSpawnSync).not.toHaveBeenCalled();
	});

	it("runSkillCurator (T10) returns written:0 and never dispatches subagent", async () => {
		const result = await runSkillCurator({
			sprintId: "FORGE-S24",
			taskId: "FORGE-S24-T12",
			cwd: projectCwd,
			ts: "20260522T120000000Z",
			trajectorySummary: "n/a",
			retrievedSkills: [],
			outcome: { verdict: "approved" },
		});
		expect(result).toEqual({ exitCode: 0, written: 0 });
		expect(mockRunSubagent).not.toHaveBeenCalled();
		// And no queue file should have been written.
		const queueDir = path.join(
			projectCwd,
			".forge",
			"enhancement-proposals",
			"queue",
			"FORGE-S24",
		);
		expect(fs.existsSync(queueDir)).toBe(false);
	});
});

// ── Flag-on smoke (sanity that the gate doesn't change normal behaviour) ────

describe("skill-curation gate / flag-on passes through to existing emit", () => {
	it("emitSkillUsageEvents proceeds to spawn when env override = '1'", () => {
		process.env.FORGE_CLI_SKILL_CURATION_ENABLED = "1";
		mockSpawnSync.mockReturnValue({
			pid: 123,
			output: [],
			stdout: "",
			stderr: "",
			status: 0,
			signal: null,
		} as ReturnType<typeof childProcess.spawnSync>);

		const result = emitSkillUsageEvents(
			[{ skillId: "calibrate", score: 0.5 }],
			retrieverRuntime(),
		);

		expect(result.emitted).toBe(1);
		expect(result.failed).toBe(0);
		expect(mockSpawnSync).toHaveBeenCalledTimes(1);
		const call = mockSpawnSync.mock.calls[0];
		// IL6: argv-array spawn — first arg is "node", second is the argv array.
		expect(call[0]).toBe("node");
		expect(Array.isArray(call[1])).toBe(true);
		const argv = call[1] as string[];
		expect(argv[1]).toBe("emit");
		expect(argv[2]).toBe("FORGE-S24");
	});
});
