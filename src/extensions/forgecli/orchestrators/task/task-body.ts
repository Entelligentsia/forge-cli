// task-body.ts — task body composition + summary carry-forward helpers and the
// revision-loop predecessor finder. Extracted from run-task.ts (no logic
// changes). run-task.ts re-exports these.

import type { PhaseDescriptor } from "./task-phases.js";

// ── Find predecessor non-review phase for revision loop ───────────────────

export function findPredecessorIndex(phases: PhaseDescriptor[], reviewIndex: number): number {
	for (let i = reviewIndex - 1; i >= 0; i--) {
		if (!phases[i].isReview) return i;
	}
	return 0;
}

// ── Task body composition ─────────────────────────────────────────────────

interface PhaseSummary {
	objective?: string;
	key_changes?: string[];
	findings?: string[];
	verdict?: string;
	artifact_ref?: string;
}

// Phase ordering for summary injection — earlier phases first.
const PHASE_ORDER: readonly string[] = ["plan", "review_plan", "implementation", "code_review", "validation"];

export function buildSummariesBlock(summaries: Record<string, unknown> | undefined): string {
	if (!summaries) return "";
	const lines: string[] = [];
	for (const key of PHASE_ORDER) {
		const raw = summaries[key];
		if (!raw || typeof raw !== "object") continue;
		const s = raw as PhaseSummary;
		const parts: string[] = [`### ${key}`];
		if (s.objective) parts.push(`Objective: ${s.objective}`);
		if (s.verdict) parts.push(`Verdict: ${s.verdict}`);
		if (s.key_changes?.length) parts.push(`Key changes: ${s.key_changes.join("; ")}`);
		if (s.findings?.length) parts.push(`Findings: ${s.findings.join("; ")}`);
		if (s.artifact_ref) parts.push(`Full artifact: ${s.artifact_ref}`);
		lines.push(parts.join("\n"));
	}
	if (lines.length === 0) return "";
	return ["## Prior phase summaries (carry-forward)", "", ...lines].join("\n");
}

export function composeTaskBody(subWorkflowMd: string, taskId: string, summariesBlock?: string): string {
	const parts = [`Read the workflow below and follow it. Task ID: ${taskId}.`, "", "---", ""];
	if (summariesBlock) {
		parts.push(summariesBlock, "", "---", "");
	}
	parts.push(subWorkflowMd.trim());
	return parts.join("\n");
}
