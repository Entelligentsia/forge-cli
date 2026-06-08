// bug-body.ts — compose the per-phase subagent prompt body for a bug, with the
// entity-kind override block prepended before the workflow body. Extracted
// VERBATIM from fix-bug.ts (FORGE-S31 file-size refactor); no logic changes.

// ── Bug body composition ──────────────────────────────────────────────────

export function composeBugBody(
	subWorkflowMd: string,
	bugId: string,
	phaseRole: string,
	bugStatusBeforePhase?: string,
	summariesBlock?: string,
): string {
	// Entity-kind override block prepended before workflow body.
	// Conforms to forge v0.44.x meta-fix-bug contract:
	//   - bug.status enum is {reported, triaged, in-progress, fixed}; `fixed` is terminal.
	//   - `approved` and `verified` are NOT valid bug status values (dropped in v0.44.0).
	//   - Approve phase: NO status write. Architect writes summaries.approve.verdict
	//     via set-bug-summary; verdict signal IS the summary (read by
	//     read-verdict.cjs § BUG_PHASE_VERDICT_SOURCE).
	//   - Commit phase: status → fixed (the only status transition post-triage).
	//
	// Earlier revisions of this prompt told the architect to write
	// `update-status bug ... approved` and the engineer to write `... verified`.
	// Those instructions produced the FORGE-BUG-002 trap (LLM-translation of
	// task-shaped approve workflow → illegal transition through a terminal state).
	// The new contract removes the trap at its source.
	const entityKindLines: string[] = [
		`Bug ID: ${bugId}`,
		"",
		"⚠ ENTITY KIND OVERRIDE: This is a bug, not a task.",
		"- All `update-status` calls must use entity kind `bug` (not `task`).",
		"- Approve phase: NO status write. Write the approval verdict via set-bug-summary:",
		`  node "$FORGE_ROOT/tools/store-cli.cjs" set-bug-summary ${bugId} approve <APPROVE-SUMMARY.json>`,
		`  The summary's "verdict" field MUST be "approved" or "revision". The downstream commit gate reads this, not bug.status.`,
		`- Commit phase: on successful git commit, run \`node "$FORGE_ROOT/tools/store-cli.cjs" update-status bug ${bugId} status fixed\` (terminal).`,
		`- Do NOT write "approved" or "verified" to bug.status — those values were removed from the schema in forge v0.44.0.`,
		`- Do NOT reference task-specific status values (e.g., "committed") or task entity kind.`,
		"- CRITICAL: All `set-summary` calls must use `set-bug-summary` (not `set-summary`).",
		`  e.g. node "$FORGE_ROOT/tools/store-cli.cjs" set-bug-summary ${bugId} review_plan <jsonFile>`,
		`- Preflight gate: use \`--bug\` flag (not \`--task\`). e.g. node "$FORGE_ROOT/tools/preflight-gate.cjs" --phase review-plan --bug ${bugId}`,
		"- Skip re-running preflight-gate — the orchestrator already checked it. Proceed directly to the review.",
		'Any workflow text that says "task" should be read as "bug" for this context.',
	];

	// Phase-specific reinforcement when the orchestrator can name the current status.
	if (phaseRole === "approve" && bugStatusBeforePhase) {
		entityKindLines.push(
			`- Approve phase (reinforce): bug.status is currently '${bugStatusBeforePhase}' and MUST NOT change in this phase. Record verdict in summaries.approve only.`,
		);
	}
	if (phaseRole === "commit" && bugStatusBeforePhase) {
		entityKindLines.push(
			`- Commit phase: after the git commit lands, transition bug.status from '${bugStatusBeforePhase}' to 'fixed'.`,
		);
	}
	// FORGE-BUG-040: the triage-phase hint block previously prepended here
	// compensated for the orchestrator-only fix_bug.md being delivered to
	// the triage subagent. With the new phase-scoped triage.md sub-workflow,
	// the route-field contract and Path A/B criteria are documented natively
	// in the workflow body — no compose-time injection required.

	const parts = [
		`Read the workflow below and follow it. Bug ID: ${bugId}.`,
		"",
		"---",
		"",
		entityKindLines.join("\n"),
		"",
		"---",
		"",
	];
	if (summariesBlock) {
		parts.push(summariesBlock, "", "---", "");
	}
	parts.push(subWorkflowMd.trim());
	return parts.join("\n");
}
