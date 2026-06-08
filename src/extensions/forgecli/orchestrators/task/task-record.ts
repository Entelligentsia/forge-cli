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
