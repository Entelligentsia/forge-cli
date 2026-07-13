// task-record.ts — store-cli verdict + task-record reads for the run-task
// pipeline. Extracted from run-task.ts (no logic changes). run-task.ts
// re-exports these.

import { spawnSync } from "node:child_process";

import { SUMMARY_KEY_BY_ROLE } from "./task-phases.js";

// ── Verdict read from store-cli ────────────────────────────────────────────

type Verdict = "approved" | "revision" | "n/a" | "missing";

export function readVerdict(taskId: string, phaseRole: string, storeCli: string, cwd: string): Verdict {
	const result = spawnSync("node", [storeCli, "read", "task", taskId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return "missing";
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		const record = JSON.parse(raw) as {
			status?: string;
			summaries?: Record<string, { verdict?: string }>;
		};

		// Phases like `approve` do not write a summaries entry; they
		// transition task.status to "approved" instead. For those, the
		// verdict source is task.status.
		const summaryKey = SUMMARY_KEY_BY_ROLE[phaseRole];
		if (summaryKey === null) {
			return record.status === "approved" ? "approved" : "missing";
		}

		// Verdict lookup with three fallbacks:
		//   1. Canonical mapped summary key (e.g. "code_review" for review-code).
		//   2. Underscore-swapped phase role ("review_code") — legacy/defensive.
		//   3. Raw hyphenated phase role ("review-code") — defensive only.
		const summaries = record.summaries ?? {};
		const underscoreKey = phaseRole.replace(/-/g, "_");
		const candidates = [summaryKey ?? "", underscoreKey, phaseRole].filter(Boolean);
		let verdict: string | undefined;
		for (const k of candidates) {
			if (summaries[k]?.verdict) {
				verdict = summaries[k].verdict;
				break;
			}
		}
		if (!verdict) return "missing";
		if (verdict === "approved") return "approved";
		if (verdict === "revision") return "revision";
		return "missing";
	} catch {
		return "missing";
	}
}

// ── Verdict + written_at read (stale-summary divergence guard, WI-S48-T01) ──

/** Like readVerdict but also returns the stored summary's `written_at`. Used by
 *  the verdict loop to detect a stale stored verdict whose written_at predates
 *  the current phase dispatch (the subagent did not refresh the store this
 *  round — e.g. wrote the summary sidecar to the wrong artifact kind and
 *  `set-summary` re-ingested the prior round's sidecar). */
export function readVerdictWithMeta(taskId: string, phaseRole: string, storeCli: string, cwd: string): VerdictMeta {
	const result = spawnSync("node", [storeCli, "read", "task", taskId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return { verdict: "missing" };
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		const record = JSON.parse(raw) as {
			status?: string;
			summaries?: Record<string, { verdict?: string; written_at?: string }>;
		};
		const summaryKey = SUMMARY_KEY_BY_ROLE[phaseRole];
		if (summaryKey === null) {
			return { verdict: record.status === "approved" ? "approved" : "missing" };
		}
		const summaries = record.summaries ?? {};
		const underscoreKey = phaseRole.replace(/-/g, "_");
		const candidates = [summaryKey ?? "", underscoreKey, phaseRole].filter(Boolean);
		let s: { verdict?: string; written_at?: string } | undefined;
		for (const k of candidates) {
			if (summaries[k]?.verdict) {
				s = summaries[k];
				break;
			}
		}
		if (!s || !s.verdict) return { verdict: "missing" };
		if (s.verdict === "approved") return { verdict: "approved", writtenAt: s.written_at };
		if (s.verdict === "revision") return { verdict: "revision", writtenAt: s.written_at };
		return { verdict: "missing" };
	} catch {
		return { verdict: "missing" };
	}
}

export interface VerdictMeta {
	verdict: Verdict;
	/** ISO 8601 written_at of the stored summary, if present. */
	writtenAt?: string;
}

// ── Task record + summary helpers (Plan 11 / Slice 2) ────────────────────

export interface TaskRecord {
	sprintId?: string;
	status?: string;
	summaries?: Record<string, unknown>;
}

export function readTaskRecord(taskId: string, storeCli: string, cwd: string): TaskRecord | null {
	const result = spawnSync("node", [storeCli, "read", "task", taskId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return null;
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		return JSON.parse(raw) as TaskRecord;
	} catch {
		return null;
	}
}
