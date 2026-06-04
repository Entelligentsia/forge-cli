// state-helpers.test.ts — FORGE-S25-T16 (N-H-B)
//
// Unit tests for lib/state-helpers.ts: readJsonState(), writeJsonState(),
// isStateStale(), taskStateFilePath(), sprintStateFilePath().
// Regression tests verify that run-task.ts's readState/writeState continue to
// work correctly after delegating to lib helpers internally.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isStateStale,
	readJsonState,
	sprintStateFilePath,
	taskStateFilePath,
	writeJsonState,
} from "../../../../src/extensions/forgecli/lib/state-helpers.js";
// Regression imports: run-task.ts re-exports readState/writeState which internally
// delegate to lib helpers. These tests verify the chain is intact.
import { type RunTaskState, readState, writeState } from "../../../../src/extensions/forgecli/orchestrators/run-task.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-state-helpers-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface TestState {
	id: string;
	value: number;
	savedAt: string;
}

// ── readJsonState ──────────────────────────────────────────────────────────

describe("readJsonState (lib/state-helpers.ts)", () => {
	it("returns null when the file does not exist", () => {
		const fp = path.join(tmpRoot, "nonexistent.json");
		const result = readJsonState<TestState>(fp);
		expect(result).toBeNull();
	});

	it("returns null when the file contains invalid JSON", () => {
		const fp = path.join(tmpRoot, "bad.json");
		fs.writeFileSync(fp, "{ not valid json");
		const result = readJsonState<TestState>(fp);
		expect(result).toBeNull();
	});

	it("returns parsed data when the file contains valid JSON", () => {
		const fp = path.join(tmpRoot, "state.json");
		const data: TestState = { id: "TASK-001", value: 42, savedAt: new Date().toISOString() };
		fs.writeFileSync(fp, JSON.stringify(data));
		const result = readJsonState<TestState>(fp);
		expect(result).toEqual(data);
	});
});

// ── writeJsonState ─────────────────────────────────────────────────────────

describe("writeJsonState (lib/state-helpers.ts)", () => {
	it("creates the directory and writes JSON to the file", () => {
		const fp = path.join(tmpRoot, "nested", "dir", "state.json");
		const data: TestState = { id: "TASK-001", value: 7, savedAt: new Date().toISOString() };
		writeJsonState(fp, data);
		expect(fs.existsSync(fp)).toBe(true);
		const raw = fs.readFileSync(fp, "utf8");
		expect(JSON.parse(raw)).toEqual(data);
	});

	it("overwrites existing file content", () => {
		const fp = path.join(tmpRoot, "state.json");
		const data1: TestState = { id: "TASK-001", value: 1, savedAt: "2026-01-01T00:00:00.000Z" };
		const data2: TestState = { id: "TASK-001", value: 2, savedAt: "2026-01-02T00:00:00.000Z" };
		writeJsonState(fp, data1);
		writeJsonState(fp, data2);
		const raw = fs.readFileSync(fp, "utf8");
		expect(JSON.parse(raw)).toEqual(data2);
	});
});

// ── isStateStale ──────────────────────────────────────────────────────────

describe("isStateStale (lib/state-helpers.ts)", () => {
	it("returns false for a state saved 1 hour ago (within 7-day default)", () => {
		const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		expect(isStateStale(oneHourAgo)).toBe(false);
	});

	it("returns true for a state saved 8 days ago (beyond 7-day default)", () => {
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		expect(isStateStale(eightDaysAgo)).toBe(true);
	});

	it("returns false for exactly 6.9 days ago", () => {
		const justUnder7Days = new Date(Date.now() - 6.9 * 24 * 60 * 60 * 1000).toISOString();
		expect(isStateStale(justUnder7Days)).toBe(false);
	});

	it("respects a custom maxAgeMs parameter", () => {
		const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		// With maxAge of 30 minutes, 1-hour-old state should be stale
		expect(isStateStale(oneHourAgo, 30 * 60 * 1000)).toBe(true);
		// With maxAge of 2 hours, 1-hour-old state should be fresh
		expect(isStateStale(oneHourAgo, 2 * 60 * 60 * 1000)).toBe(false);
	});
});

// ── Path builders ─────────────────────────────────────────────────────────

describe("taskStateFilePath / sprintStateFilePath", () => {
	it("taskStateFilePath returns expected cache path", () => {
		const fp = taskStateFilePath("/project", "FORGE-S25-T01");
		expect(fp).toBe(path.join("/project", ".forge", "cache", "run-task-state-FORGE-S25-T01.json"));
	});

	it("sprintStateFilePath returns expected cache path", () => {
		const fp = sprintStateFilePath("/project", "FORGE-S25");
		expect(fp).toBe(path.join("/project", ".forge", "cache", "run-sprint-state-FORGE-S25.json"));
	});
});

// ── Regression tests ──────────────────────────────────────────────────────

describe("state-helpers regression — run-task.ts readState / writeState chain", () => {
	it("writeState + readState roundtrip works after lib delegation", () => {
		const state: RunTaskState = {
			taskId: "FORGE-S25-T16",
			phaseIndex: 2,
			iterationCounts: { "review-plan": 1 },
			halted: false,
			status: "running",
			savedAt: new Date().toISOString(),
		};
		writeState(tmpRoot, state);
		const loaded = readState(tmpRoot, "FORGE-S25-T16");
		expect(loaded).toEqual(state);
	});

	it("readState returns null when no state file exists", () => {
		const result = readState(tmpRoot, "FORGE-S25-T99");
		expect(result).toBeNull();
	});

	it("writeState creates the expected file path", () => {
		const state: RunTaskState = {
			taskId: "FORGE-S25-T16",
			phaseIndex: 0,
			iterationCounts: {},
			halted: false,
			savedAt: new Date().toISOString(),
		};
		writeState(tmpRoot, state);
		const expectedPath = path.join(tmpRoot, ".forge", "cache", "run-task-state-FORGE-S25-T16.json");
		expect(fs.existsSync(expectedPath)).toBe(true);
	});
});
