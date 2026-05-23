// lib/state-helpers.ts — FORGE-S25-T16
//
// Centralizes the orchestrator session-state helpers for /forge:run-task and
// /forge:run-sprint. Addresses finding N-H-B (Pass-3): naming divergence across
// run-task.ts (readState/writeState), run-sprint.ts (readSprintState/writeSprintState).
//
// Design decisions per review-plan approval (2026-05-23):
//   - Bug-state helpers (readBugState, writeBugState, deleteBugState) remain in
//     fix-bug.ts ONLY. Exporting them here would create a circular dep:
//     fix-bug.ts → lib/state-helpers.ts → fix-bug.ts.
//   - run-sprint.ts continues to import readState/writeState from run-task.ts
//     (no import-path change needed). run-task.ts delegates to this lib internally.
//   - lib/state-helpers.ts has no imports from handler files — clean dependency direction.
//
// Task state  — .forge/cache/run-task-state-{taskId}.json
// Sprint state — .forge/cache/run-sprint-state-{sprintId}.json

import * as fs from "node:fs";
import * as path from "node:path";

// ──────────────────────────────────────────────────────────────────────────────
// Shared utilities
// ──────────────────────────────────────────────────────────────────────────────

/** Seven days in milliseconds — default staleness window for state files. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Read a JSON state file from disk.
 * Returns null if the file does not exist or cannot be parsed.
 */
export function readJsonState<T>(filePath: string): T | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Write a JSON state file to disk, creating intermediate directories as needed.
 */
export function writeJsonState<T>(filePath: string, data: T): void {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Returns true if a saved-at timestamp is older than maxAgeMs (default: 7 days).
 */
export function isStateStale(savedAt: string, maxAgeMs = SEVEN_DAYS_MS): boolean {
	const savedAtMs = new Date(savedAt).getTime();
	const ageMs = Date.now() - savedAtMs;
	return ageMs > maxAgeMs;
}

// ──────────────────────────────────────────────────────────────────────────────
// Task state — run-task.ts
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal interface shared by task state. Full interface in run-task.ts. */
export interface TaskStateBase {
	taskId: string;
	savedAt: string;
}

/**
 * Build the canonical state file path for a run-task session.
 * Exported so run-task.ts can use it without duplicating the path logic.
 */
export function taskStateFilePath(cwd: string, taskId: string): string {
	return path.join(cwd, ".forge", "cache", `run-task-state-${taskId}.json`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Sprint state — run-sprint.ts
// ──────────────────────────────────────────────────────────────────────────────

/** Minimal interface shared by sprint state. Full interface in run-sprint.ts. */
export interface SprintStateBase {
	sprintId: string;
	savedAt: string;
}

/**
 * Build the canonical state file path for a run-sprint session.
 * Exported so run-sprint.ts can use it without duplicating the path logic.
 */
export function sprintStateFilePath(cwd: string, sprintId: string): string {
	return path.join(cwd, ".forge", "cache", `run-sprint-state-${sprintId}.json`);
}
