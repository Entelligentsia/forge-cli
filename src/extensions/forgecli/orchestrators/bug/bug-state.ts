// bug-state.ts — bug-pipeline state persistence (RunBugState + the cache-file
// read/write/delete/stale helpers). Extracted VERBATIM from fix-bug.ts
// (FORGE-S31 file-size refactor); no logic changes.

import * as fs from "node:fs";
import * as path from "node:path";

import { validateId } from "../common/orchestrator-misc.js";

// ── Bug state persistence ──────────────────────────────────────────────────

export interface RunBugState {
	bugId: string;
	phaseIndex: number;
	iterationCounts: Record<string, number>;
	halted: boolean;
	/** Set on cancellation so the resume prompt says "cancelled" vs "halted". */
	status?: "cancelled" | "halted" | "running";
	lastError?: string;
	savedAt: string;
}

function bugStateFilePath(cwd: string, bugId: string, sessionId?: string): string {
	if (!validateId(bugId)) {
		throw new Error(`Invalid bugId for state file path: ${bugId}`);
	}
	const suffix = sessionId ?? process.env.FORGE_SESSION_ID ?? `${process.pid}`;
	return path.join(cwd, ".forge", "cache", `fix-bug-state-${bugId}-${suffix}.json`);
}

export function readBugState(cwd: string, bugId: string, sessionId?: string): RunBugState | null {
	// If a specific session ID is given, read that file directly.
	if (sessionId || process.env.FORGE_SESSION_ID) {
		const fp = bugStateFilePath(cwd, bugId, sessionId);
		try {
			if (!fs.existsSync(fp)) return null;
			const raw = fs.readFileSync(fp, "utf8");
			return JSON.parse(raw) as RunBugState;
		} catch {
			return null;
		}
	}
	// No specific session — glob for the most recent matching state file.
	// Single-writer assumption: normally only one session per bug.
	const cacheDir = path.join(cwd, ".forge", "cache");
	const prefix = `fix-bug-state-${bugId}-`;
	let bestFile: string | null = null;
	let bestMtime = 0;
	try {
		const entries = fs.readdirSync(cacheDir);
		for (const entry of entries) {
			if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
			const fp = path.join(cacheDir, entry);
			try {
				const st = fs.statSync(fp);
				if (st.mtimeMs > bestMtime) {
					bestMtime = st.mtimeMs;
					bestFile = fp;
				}
			} catch {}
		}
	} catch {
		return null;
	}
	if (!bestFile) return null;
	try {
		const raw = fs.readFileSync(bestFile, "utf8");
		return JSON.parse(raw) as RunBugState;
	} catch {
		return null;
	}
}

export function writeBugState(cwd: string, state: RunBugState): void {
	// Guard: never write state for PENDING bugIds — wait for real bugId capture.
	if (state.bugId.startsWith("PENDING-")) return;
	const fp = bugStateFilePath(cwd, state.bugId);
	const dir = path.dirname(fp);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(fp, JSON.stringify(state, null, 2), "utf8");
}

export function deleteBugState(cwd: string, bugId: string): void {
	// Clean up all state files for this bug (all sessions)
	const cacheDir = path.join(cwd, ".forge", "cache");
	const statePrefix = `fix-bug-state-${bugId}-`;
	const debugPrefix = `fix-bug-debug-${bugId}`;
	try {
		const entries = fs.readdirSync(cacheDir);
		for (const entry of entries) {
			if ((entry.startsWith(statePrefix) && entry.endsWith(".json")) || entry.startsWith(debugPrefix)) {
				try {
					fs.unlinkSync(path.join(cacheDir, entry));
				} catch {
					/* non-fatal */
				}
			}
		}
	} catch {
		// non-fatal
	}
}

export function isBugStateStale(state: RunBugState): boolean {
	const savedAt = new Date(state.savedAt).getTime();
	const ageMs = Date.now() - savedAt;
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
	return ageMs > sevenDaysMs;
}
