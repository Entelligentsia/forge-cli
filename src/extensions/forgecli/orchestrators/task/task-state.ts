// task-state.ts — run-task state persistence. Extracted from run-task.ts
// (no logic changes). run-task.ts re-exports these; run-sprint.ts imports
// readState as readTaskState from the barrel.

import * as fs from "node:fs";

import {
	isStateStale as isJsonStateStale,
	readJsonState,
	taskStateFilePath,
	writeJsonState,
} from "../../lib/state-helpers.js";
import { validateId } from "../common/orchestrator-misc.js";

// ── State persistence ─────────────────────────────────────────────────────

export interface RunTaskState {
	taskId: string;
	phaseIndex: number;
	iterationCounts: Record<string, number>;
	halted: boolean;
	/** Set on cancellation so the resume prompt can say "cancelled" vs "halted". */
	status?: "cancelled" | "halted" | "running";
	lastError?: string;
	savedAt: string;
}

// FORGE-S25-T16 (N-H-B): state helpers delegate to lib/state-helpers.ts.
// Public API (readState, writeState, deleteState, isStateStale) is preserved —
// run-sprint.ts imports readState as readTaskState from this file.

function stateFilePath(cwd: string, taskId: string): string {
	if (!validateId(taskId)) {
		throw new Error(`Invalid taskId for state file path: ${taskId}`);
	}
	return taskStateFilePath(cwd, taskId);
}

export function readState(cwd: string, taskId: string): RunTaskState | null {
	return readJsonState<RunTaskState>(stateFilePath(cwd, taskId));
}

export function writeState(cwd: string, state: RunTaskState): void {
	writeJsonState(stateFilePath(cwd, state.taskId), state);
}

export function deleteState(cwd: string, taskId: string): void {
	const fp = stateFilePath(cwd, taskId);
	try {
		if (fs.existsSync(fp)) fs.unlinkSync(fp);
	} catch {
		// non-fatal
	}
}

export function isStateStale(state: RunTaskState): boolean {
	return isJsonStateStale(state.savedAt);
}
