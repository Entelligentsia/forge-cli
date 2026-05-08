// init-progress.ts — read/write/delete .forge/init-progress.json
//
// Tracks the last completed phase of /forge:init so the command can resume
// after an interrupted run. Implements stale-checkpoint detection to handle
// legacy 12-phase checkpoint files from old forge plugin versions.
//
// Per INIT_PARITY_SPEC.md §4 and PLAN.md Phase B.

import * as fs from "node:fs";
import * as path from "node:path";

/** Canonical progress record written to .forge/init-progress.json */
export interface InitProgress {
	lastPhase: 1 | 2 | 3 | 4;
	timestamp: string;
}

export type ReadProgressResult =
	| { kind: "none" }
	| { kind: "stale"; reason: string }
	| { kind: "malformed" }
	| { kind: "valid"; progress: InitProgress };

const PROGRESS_FILENAME = ".forge/init-progress.json";

function progressPath(cwd: string): string {
	return path.join(cwd, PROGRESS_FILENAME);
}

/**
 * Read the init-progress checkpoint file.
 *
 * Returns:
 *   - `{ kind: "none" }` — file does not exist
 *   - `{ kind: "malformed" }` — file exists but JSON parse failed
 *   - `{ kind: "stale", reason }` — file is a legacy 12-phase checkpoint
 *   - `{ kind: "valid", progress }` — clean 4-phase checkpoint
 */
export function readInitProgress(cwd: string): ReadProgressResult {
	const filePath = progressPath(cwd);

	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err: unknown) {
		const e = err as { code?: string };
		if (e.code === "ENOENT") return { kind: "none" };
		// Unreadable — treat as missing
		return { kind: "none" };
	}

	let obj: unknown;
	try {
		obj = JSON.parse(raw);
	} catch {
		return { kind: "malformed" };
	}

	if (!obj || typeof obj !== "object") {
		return { kind: "malformed" };
	}

	const record = obj as Record<string, unknown>;

	// Stale detection per spec §4:
	// - lastPhase > 4 → old 12-phase run
	// - contains "mode" key → old format
	// - contains "phase-7-substep-map" key → old format
	// - missing "timestamp" → corrupt / incomplete write
	if ("mode" in record) {
		return { kind: "stale", reason: 'contains "mode" field (legacy 12-phase format)' };
	}
	if ("phase-7-substep-map" in record) {
		return { kind: "stale", reason: 'contains "phase-7-substep-map" field (legacy 12-phase format)' };
	}
	if (!("timestamp" in record)) {
		return { kind: "stale", reason: 'missing "timestamp" field' };
	}

	const lastPhase = record.lastPhase;
	if (typeof lastPhase !== "number" || !Number.isInteger(lastPhase)) {
		return { kind: "malformed" };
	}
	if (lastPhase > 4) {
		return { kind: "stale", reason: `lastPhase=${lastPhase} > 4 (legacy 12-phase run)` };
	}
	if (lastPhase < 1) {
		return { kind: "malformed" };
	}

	const timestamp = record.timestamp;
	if (typeof timestamp !== "string") {
		return { kind: "malformed" };
	}

	return {
		kind: "valid",
		progress: {
			lastPhase: lastPhase as 1 | 2 | 3 | 4,
			timestamp,
		},
	};
}

/**
 * Write a progress checkpoint. Called at the end of each completed phase.
 *
 * @param cwd - project working directory
 * @param lastPhase - completed phase number (1, 2, or 3; 4 is written then deleted)
 * @param timestamp - ISO 8601 timestamp; defaults to now
 */
export function writeInitProgress(cwd: string, lastPhase: 1 | 2 | 3 | 4, timestamp?: string): void {
	const record: InitProgress = {
		lastPhase,
		timestamp: timestamp ?? new Date().toISOString(),
	};
	const filePath = progressPath(cwd);
	// Ensure .forge/ dir exists before writing
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf8");
}

/**
 * Delete the init-progress checkpoint. Called at the end of Phase 4
 * to signal successful completion.
 */
export function deleteInitProgress(cwd: string): void {
	const filePath = progressPath(cwd);
	try {
		fs.unlinkSync(filePath);
	} catch (err: unknown) {
		const e = err as { code?: string };
		// ENOENT is fine — file may not exist if phase was aborted before first write
		if (e.code !== "ENOENT") {
			throw err;
		}
	}
}
