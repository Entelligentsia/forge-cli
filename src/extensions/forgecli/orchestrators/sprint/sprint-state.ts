// sprint-state.ts — sprint-level state persistence + sprint record resolution.
// Extracted from run-sprint.ts (no logic changes) so the per-file architectural
// line cap is satisfied; run-sprint.ts imports these from here.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";

import { readJsonState, sprintStateFilePath, writeJsonState } from "../../lib/state-helpers.js";
import { validateId } from "../common/orchestrator-misc.js";

// ── Sprint-level state persistence ────────────────────────────────────────

export interface RunSprintState {
	sprintId: string;
	taskIndex: number; // index into sprint.taskIds (points to NEXT task to run)
	completedTaskIds: string[]; // only tasks that returned status "completed" (advisory #6)
	halted: boolean;
	lastError?: string;
	savedAt: string;
}

// FORGE-S25-T16 (N-H-B): sprint state helpers delegate to lib/state-helpers.ts.

function getSprintStatePath(cwd: string, sprintId: string): string {
	if (!validateId(sprintId)) {
		throw new Error(`Invalid sprintId for state file path: ${sprintId}`);
	}
	return sprintStateFilePath(cwd, sprintId);
}

export function readSprintState(cwd: string, sprintId: string): RunSprintState | null {
	return readJsonState<RunSprintState>(getSprintStatePath(cwd, sprintId));
}

export function writeSprintState(cwd: string, state: RunSprintState): void {
	writeJsonState(getSprintStatePath(cwd, state.sprintId), state);
}

export function deleteSprintState(cwd: string, sprintId: string): void {
	const fp = getSprintStatePath(cwd, sprintId);
	try {
		if (fs.existsSync(fp)) fs.unlinkSync(fp);
	} catch {
		// non-fatal
	}
}

export function isSprintStateStale(state: RunSprintState): boolean {
	const savedAt = new Date(state.savedAt).getTime();
	const ageMs = Date.now() - savedAt;
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
	return ageMs > sevenDaysMs;
}

// ── Sprint record resolution ──────────────────────────────────────────────

export interface SprintRecord {
	sprintId: string;
	taskIds: string[];
	[pk: string]: unknown;
}

export function readSprintRecord(sprintId: string, storeCli: string, cwd: string): SprintRecord | null {
	const result = spawnSync("node", [storeCli, "read", "sprint", sprintId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return null;
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		const record = JSON.parse(raw) as SprintRecord;
		// Validate taskIds is a non-empty array of strings
		if (!Array.isArray(record.taskIds) || record.taskIds.length === 0) return null;
		if (!record.taskIds.every((id: unknown) => typeof id === "string")) return null;
		return record;
	} catch {
		return null;
	}
}
