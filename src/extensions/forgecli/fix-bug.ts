// fix-bug.ts — /forge:fix-bug Orchestrator native handler (FORGE-S21-T07).
//
// Promotes /forge:fix-bug from stub to a full TS-driven Orchestrator-archetype
// native handler. Reads `.forge/workflows/fix_bug.md`, chains the bug-specific
// phase sequence (triage → plan-fix → review-plan → implement → review-code →
// approve → commit) by spawning a fresh runForgeSubagent per phase (IL10).
//
// Iron Laws enforced here:
//   IL1  — code only under forge-cli/src/extensions/forgecli/
//   IL6  — no shell-string interpolation; all external calls via spawnSync argv arrays
//   IL7  — every failure path emits ctx.ui.notify and returns; no silent continuation
//   IL10 — ALL LLM dispatch goes through runForgeSubagent (NO sendKickoff calls here)
//
// sendKickoff is NEVER called from this file.
// Audit-grep: grep -n "sendKickoff(" fix-bug.ts must return empty.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";

import { assertAudience, CallerContextStore } from "./audience-gate.js";
import { checkMaterialization } from "./plan.js";
import { loadForgePersona, runForgeSubagent } from "./forge-subagent.js";
import { discoverForgeConfig } from "./forge-root.js";
import { loadWorkflow, type AudienceValue } from "./loaders/workflow-loader.js";
import { getSessionRegistry } from "./session-registry.js";
import {
	type PhaseDescriptor,
	validateId,
	isoCompact,
	isNonInteractive,
	formatLocalTime,
	emitEvent,
	findPredecessorIndex,
	runPreflightGate,
	type PreflightResult,
	type OrchestratorEmitContext,
	buildPhaseEvent,
	drainFrictionFile,
	judgementFromSummary,
} from "./run-task.js";

// ── Bug phase descriptor table ──────────────────────────────────────────────
//
// Decoded from .forge/workflows/fix_bug.md and the task prompt's BUG_PHASES.
// triage / plan-fix / implement all read the same fix_bug.md body — the
// workflow handles all three phases through prose.

export const BUG_PHASES: PhaseDescriptor[] = [
	{ role: "triage",      workflowFile: "fix_bug",          personaNoun: "bug-fixer",  isReview: false, maxIterations: 1 },
	{ role: "plan-fix",   workflowFile: "fix_bug",          personaNoun: "bug-fixer",  isReview: false, maxIterations: 1 },
	{ role: "review-plan", workflowFile: "review_plan",     personaNoun: "supervisor",  isReview: true,  maxIterations: 3 },
	{ role: "implement",   workflowFile: "fix_bug",          personaNoun: "bug-fixer",  isReview: false, maxIterations: 1 },
	{ role: "review-code", workflowFile: "review_code",     personaNoun: "supervisor",  isReview: true,  maxIterations: 3 },
	{ role: "approve",     workflowFile: "architect_approve", personaNoun: "architect",   isReview: true,  maxIterations: 3 },
	{ role: "commit",      workflowFile: "commit_task",      personaNoun: "engineer",    isReview: false, maxIterations: 1 },
];

// Map phase.role → canonical summary key written by base-pack workflows.
// Phases mapped to null use update-status bug instead of set-bug-summary
// for verdict tracking (Option B).
export const BUG_SUMMARY_KEY_BY_ROLE: Record<string, string | null> = {
	"triage":      "triage",
	"plan-fix":    "plan",
	"review-plan": "review_plan",
	"implement":   "implementation",
	"review-code": "code_review",
	"approve":     "approve",  // read from bug.summaries.approve (set-bug-summary)
	"commit":      null,    // commit transitions bug.status → verified, no summaries entry
};

// Bug-event type tokens — explicit mapping per review finding #3.
// Non-review phases always emit the pass token. Review phases select
// pass or fail based on ec.judgement.verdict.
export const BUG_TYPE_TOKENS: Record<string, { pass: string; fail: string }> = {
	"triage":      { pass: "bug-triaged",            fail: "bug-triaged" },
	"plan-fix":    { pass: "fix-planned",            fail: "fix-planned" },
	"review-plan": { pass: "fix-review-passed",      fail: "fix-review-failed" },
	"implement":   { pass: "fix-implemented",        fail: "fix-implemented" },
	"review-code": { pass: "fix-code-review-passed", fail: "fix-code-review-failed" },
	"approve":     { pass: "fix-approved",           fail: "fix-revision-requested" },
	"commit":      { pass: "bug-committed",           fail: "bug-commit-failed" },
};

// ── Bug FSM transitions ────────────────────────────────────────────────────
// Mirrors store-cli BUG_TRANSITIONS. Only `verified` is terminal.
// These are used locally for preflight gate logic; the canonical source
// is store-cli.cjs.

const BUG_TERMINAL_STATES = new Set(["verified"]);

// ── Bug state persistence ──────────────────────────────────────────────────

export interface RunBugState {
	bugId: string;
	phaseIndex: number;
	iterationCounts: Record<string, number>;
	halted: boolean;
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
			} catch {
			continue;
			}
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
				try { fs.unlinkSync(path.join(cacheDir, entry)); } catch { /* non-fatal */ }
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

// ── Bug record helpers ─────────────────────────────────────────────────────

export interface BugRecord {
	bugId?: string;
	status?: string;
	summaries?: Record<string, unknown>;
	[key: string]: unknown;
}

export function readBugRecord(bugId: string, storeCli: string, cwd: string): BugRecord | null {
	const result = spawnSync("node", [storeCli, "read", "bug", bugId], { cwd, encoding: "utf8" });
	if (result.status !== 0) return null;
	try {
		const raw: string = typeof result.stdout === "string" ? result.stdout : String(result.stdout);
		return JSON.parse(raw) as BugRecord;
	} catch {
		return null;
	}
}

// Pre-assigns a real FORGE-BUG-NNN ID by listing existing bugs and incrementing.
// Returns the next ID in sequence, e.g. "FORGE-BUG-003" if bugs 001 and 002 exist.
export function assignNextBugId(storeCli: string, cwd: string): string {
	const result = spawnSync("node", [storeCli, "list", "bug", "--json"], { cwd, encoding: "utf8" });
	let maxNum = 0;
	if (result.status === 0 && result.stdout) {
		try {
			const bugs = JSON.parse(result.stdout as string);
			if (Array.isArray(bugs)) {
				for (const b of bugs) {
					const m = String(b.bugId ?? "").match(/FORGE-BUG-(\d+)/);
					if (m) {
						const n = parseInt(m[1], 10);
						if (n > maxNum) maxNum = n;
					}
				}
			}
		} catch { /* empty store — start from 1 */ }
	}
	const next = maxNum + 1;
	return `FORGE-BUG-${String(next).padStart(3, "0")}`;
}

// Pre-creates a minimal bug record so the subagent has a real ID to work with.
export function preCreateBug(bugId: string, title: string, storeCli: string, cwd: string): boolean {
	const data = {
		bugId,
		title,
		severity: "minor",
		status: "reported",
		path: `engineering/bugs/${bugId}`,
		reportedAt: new Date().toISOString(),
	};
	const result = spawnSync("node", [storeCli, "write", "bug", JSON.stringify(data)], { cwd, encoding: "utf8" });
	return result.status === 0;
}

// ── Bug verdict reading ──────────────────────────────────────────────────

type BugVerdict = "approved" | "revision" | "n/a" | "missing";

export function readBugVerdict(
	bugRecord: BugRecord | null,
	phaseRole: string,
	summaryKeyByRole: Record<string, string | null>,
): BugVerdict {
	if (!bugRecord) return "missing";

	// Approve phase: read bug status OR approve summary verdict.
	// After Fix 2, the approve summary key exists in bug.schema.json.
	// Prefer the summary verdict if present; fall back to status.
	if (phaseRole === "approve") {
		// Try summary first (set via set-bug-summary)
		const summaryKey = summaryKeyByRole["approve"];
		if (summaryKey) {
			const summaries = bugRecord.summaries ?? {};
			const blob = (summaries as Record<string, unknown>)[summaryKey];
			if (blob && typeof blob === "object") {
				const verdict = (blob as Record<string, unknown>)?.verdict;
				if (typeof verdict === "string") {
					if (verdict === "approved") return "approved";
					if (verdict === "revision") return "revision";
				}
			}
		}
		// Fallback: read bug status directly.
		if (bugRecord.status === "approved") return "approved";
		if (bugRecord.status === "fixed" || bugRecord.status === "in-progress") return "revision";
		return "missing";
	}

	// Commit phase: read bug status directly.
	// verified → commit succeeded; approved → revision (commit did not advance).
	if (phaseRole === "commit") {
		if (bugRecord.status === "verified") return "approved";
		if (bugRecord.status === "approved") return "revision";
		return "missing";
	}

	// Review phases: read from summaries via key map.
	const summaryKey = summaryKeyByRole[phaseRole];
	if (!summaryKey) return "missing";

	const summaries = bugRecord.summaries ?? {};
	const blob = (summaries as Record<string, unknown>)[summaryKey];
	if (!blob || typeof blob !== "object") return "missing";

	const verdict = (blob as Record<string, unknown>)?.verdict;
	if (typeof verdict !== "string") return "missing";
	if (verdict === "approved") return "approved";
	if (verdict === "revision") return "revision";
	return "missing";
}

// ── Bug body composition ──────────────────────────────────────────────────

export function composeBugBody(subWorkflowMd: string, bugId: string, phaseRole: string, bugStatusBeforePhase?: string): string {
	// Entity-kind override block prepended before workflow body.
	// This tells the subagent that it's operating on a bug, not a task,
	// and provides exact update-status commands for approve and commit phases.
	const entityKindLines: string[] = [
		`Bug ID: ${bugId}`,
		"",
		"⚠ ENTITY KIND OVERRIDE: This is a bug, not a task.",
		"- All `update-status` calls must use entity kind `bug` (not `task`).",
		`- Approve phase: on approval, run \`node "$FORGE_ROOT/tools/store-cli.cjs" update-status bug ${bugId} status approved\``,
		`- Commit phase: on success, run \`node "$FORGE_ROOT/tools/store-cli.cjs" update-status bug ${bugId} status verified\``,
		`- Do NOT reference task-specific status values (e.g., \"committed\") or task entity kind.`,
		"- CRITICAL: All `set-summary` calls must use `set-bug-summary` (not `set-summary`).",
		`  e.g. node "$FORGE_ROOT/tools/store-cli.cjs" set-bug-summary ${bugId} review_plan <jsonFile>`,
		`- Preflight gate: use \`--bug\` flag (not \`--task\`). e.g. node "$FORGE_ROOT/tools/preflight-gate.cjs" --phase review-plan --bug ${bugId}`,
		"- Skip re-running preflight-gate — the orchestrator already checked it. Proceed directly to the review.",
		"Any workflow text that says \"task\" should be read as \"bug\" for this context.",
	];

	// Add phase-specific transition hints.
	if (phaseRole === "approve" && bugStatusBeforePhase) {
		entityKindLines.push(
			`- Approve phase: on approval, transition bug.status from '${bugStatusBeforePhase}' to 'approved'.`,
		);
	}
	if (phaseRole === "commit" && bugStatusBeforePhase) {
		entityKindLines.push(
			`- Commit phase: on success, transition bug.status from '${bugStatusBeforePhase}' to 'verified'.`,
		);
	}

	return [
		`Read the workflow below and follow it. Bug ID: ${bugId}.`,
		"",
		"---",
		"",
		entityKindLines.join("\n"),
		"",
		"---",
		"",
		subWorkflowMd.trim(),
	].join("\n");
}

// ── BugId capture via tool_execution_end ──────────────────────────────────

const BUG_WRITE_TOOL_NAMES = new Set(["write", "store-cli", "bash", "forge_store"]);

/**
 * Scan tool_execution_end events to extract the bugId written by a triage
 * subagent. Returns the LAST matching tool call's bugId, or null if none found.
 *
 * In pi runtime, the forge_store tool is registered as "forge_store" (not
 * "store-cli"). In Claude Code runtime, subagents may shell out via Bash.
 * This function covers all three paths.
 */
export function extractBugIdFromEvents(events: Array<{ toolName?: string; result?: unknown }>): string | null {
	let lastBugId: string | null = null;
	for (const event of events) {
		if (!event.toolName) continue;
		// Check for store-cli write bug calls (Claude Code runtime)
		if (event.toolName === "store-cli") {
			const result = event.result;
			if (typeof result === "string") {
				const match = result.match(/FORGE-BUG-\d+/);
				if (match) lastBugId = match[0];
			} else if (result && typeof result === "object") {
				const obj = result as Record<string, unknown>;
				if (typeof obj.bugId === "string" && obj.bugId.startsWith("FORGE-BUG-")) {
					lastBugId = obj.bugId;
				}
			}
		}
		// Check for forge_store tool calls (pi runtime)
		// The pi extension registers the tool as "forge_store", not "store-cli".
		if (event.toolName === "forge_store" && event.result != null) {
			const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			const match = output.match(/FORGE-BUG-\d+/);
			if (match) lastBugId = match[0];
		}
		// Also check for write operations to .forge/store/bugs/
		if (event.toolName === "write" && typeof event.result === "string") {
			const match = event.result.match(/(FORGE-BUG-\d+)/);
			if (match) lastBugId = match[0];
		}
		// Bash events: subagents shelling out via Bash may run "store-cli write bug".
		// Only match when output includes store-cli, write, and bug together
		// to avoid false positives from unrelated Bash commands that happen to
		// mention a bug ID in a different context.
		if (event.toolName === "bash" && event.result != null) {
			const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			if (output.includes("store-cli") && output.includes("write") && output.includes("bug")) {
				const match = output.match(/FORGE-BUG-\d+/);
				if (match) lastBugId = match[0];
			}
		}
	}
	return lastBugId;
}

// ── Bug pipeline result ──────────────────────────────────────────────────

export type RunBugPipelineStatus = "completed" | "halted" | "escalated" | "failed";

export interface RunBugPipelineResult {
	status: RunBugPipelineStatus;
	lastPhaseIndex: number;
	iterationCounts: Record<string, number>;
	lastError?: string;
	model?: string;
	provider?: string;
}

// ── Bug pipeline ──────────────────────────────────────────────────────────

export interface RunBugPipelineOptions {
	bugId: string;
	/** Original free-form text argument when creating a new bug (not a FORGE-BUG-NNN ID).
	 *  Passed to triage-phase subagent so it can create the bug with a meaningful description. */
	originalArg?: string;
	/** Whether this is a new bug (free-form text) vs. an existing FORGE-BUG-NNN ID. */
	isNewBug?: boolean;
	cwd: string;
	ctx: ExtensionCommandContext;
	forgeRoot: string;
	storeCli: string;
	preflightGate: string;
	registry: ReturnType<typeof getSessionRegistry>;
	resumeFromState?: RunBugState;
}

const STATUS_KEY = "forge:fix-bug";
const MESSAGE_KEY = "forge:fix-bug:message";

export async function runBugPipeline(opts: RunBugPipelineOptions): Promise<RunBugPipelineResult> {
	const { bugId: initialBugId, originalArg, isNewBug, cwd, ctx, forgeRoot, storeCli, preflightGate, registry, resumeFromState } = opts;

	// Mutable bugId — for new bugs, pre-assign a real FORGE-BUG-NNN ID
	// before triage so the subagent never needs to create or discover one.
	// This replaces the fragile PENDING→capture pattern where the subagent was
	// expected to create the bug record and we'd fish the ID from events.
	let bugId = initialBugId;
	let currentPhaseIndex = resumeFromState?.phaseIndex ?? 0;
	let iterationCounts: Record<string, number> = resumeFromState?.iterationCounts ?? {};
	let lastModel: string | undefined;
	let lastProvider: string | undefined;

	while (currentPhaseIndex < BUG_PHASES.length) {
		const phase = BUG_PHASES[currentPhaseIndex];
		if (!phase) {
			ctx.ui.notify(`× forge:fix-bug — invalid phase index ${currentPhaseIndex}`, "error");
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `invalid phase index ${currentPhaseIndex}` };
		}

		ctx.ui.setStatus?.(
			STATUS_KEY,
			`fix-bug ${bugId}: phase ${currentPhaseIndex + 1}/${BUG_PHASES.length} (${phase.role})`,
		);
		ctx.ui.notify(
			`→ ${bugId}: ${phase.role} (phase ${currentPhaseIndex + 1}/${BUG_PHASES.length})`,
			"info",
		);

		const subWorkflowPath = path.join(cwd, ".forge", "workflows", `${phase.workflowFile}.md`);

		// ── Read sub-workflow ─────────────────────────────────────────
		let subWorkflowMd: string;
		let subWorkflowAudience: AudienceValue = "any";
		try {
			const loaded = loadWorkflow(subWorkflowPath);
			subWorkflowMd = loaded.rawMarkdown;
			subWorkflowAudience = loaded.audience;
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× forge:fix-bug — failed to read sub-workflow for ${phase.role}: ${e.message ?? "unknown"}`,
				"error",
			);
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `sub-workflow read failed: ${e.message ?? "unknown"}`,
				savedAt: new Date().toISOString(),
			});
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `sub-workflow read failed: ${e.message ?? "unknown"}` };
		}

		// ── 6a. Phase skip (state-aware) ───────────────────────────────
		// Subagents sometimes do "Path A" — fixing the bug end-to-end during
		// triage instead of just triaging. Rather than rolling back (which
		// discards work), we skip non-review phases whose output is already
		// reflected in the bug status. Review phases are never skipped —
		// they are quality gates that must always run.
		const PHASE_SKIP_STATES: Record<string, Set<string>> = {
			"plan-fix":  new Set(["fixed", "approved", "verified"]),
			"implement": new Set(["fixed", "approved", "verified"]),
			"commit":    new Set(["verified"]),    // commit produces verified
		};
		const bugNow = readBugRecord(bugId, storeCli, cwd);
		const skipStates = PHASE_SKIP_STATES[phase.role];
		if (skipStates && bugNow?.status && skipStates.has(bugNow.status) && !phase.isReview) {
			ctx.ui.notify(
				`⊘ forge:fix-bug — skipping ${phase.role}: bug ${bugId} is already '${bugNow.status}' (work already done).`,
				"info",
			);
			// Write a synthetic "approved" summary so downstream `after` predecessor
			// verdict checks find a verdict and don't block review phases.
			const summaryKey = BUG_SUMMARY_KEY_BY_ROLE[phase.role as keyof typeof BUG_SUMMARY_KEY_BY_ROLE];
			if (summaryKey) {
				const synthSummary = {
					objective: `Phase ${phase.role} skipped — bug already ${bugNow.status}`,
					findings: ["Subagent completed fix during triage (Path A); phase output implicitly satisfied."],
					verdict: "approved",
					written_at: new Date().toISOString(),
				};
				const synthFile = path.join(cwd, ".forge", "cache", `synthetic-summary-${bugId}-${summaryKey}.json`);
				fs.writeFileSync(synthFile, JSON.stringify(synthSummary, null, 2), "utf8");
				const synthResult = spawnSync("node", [storeCli, "set-bug-summary", bugId, summaryKey, synthFile], { cwd, encoding: "utf8" });
				if (synthResult.status !== 0) {
					ctx.ui.notify(
						`⚠ forge:fix-bug — synthetic summary write failed for ${phase.role}: ${String(synthResult.stderr).trim()}`,
						"warning",
					);
				}
				try { fs.unlinkSync(synthFile); } catch { /* non-fatal */ }
			}
			currentPhaseIndex++;
			continue;
		}

		// ── 6b. Preflight gate ────────────────────────────────────────
		// Skip preflight gate for triage phase of new bugs (PENDING- placeholder)
		// because the bug record doesn't exist yet — gates referencing bug fields
		// would always fail.
		const pendingBugId = bugId.startsWith("PENDING-");
		if (!pendingBugId && fs.existsSync(preflightGate)) {
			const preflightResult = runPreflightGate(preflightGate, phase.role, bugId, cwd, "bug");
			if (preflightResult === "halt") {
				ctx.ui.notify(
					`× forge:fix-bug — preflight gate failed for phase ${phase.role} (exit 1); halting.`,
					"error",
				);
				writeBugState(cwd, {
					bugId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 1 for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				return { status: "halted", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `preflight gate exit 1 for ${phase.role}` };
			}
			if (preflightResult === "escalate") {
				ctx.ui.notify(
					`× forge:fix-bug — preflight gate escalated for phase ${phase.role} (exit 2); manual intervention required.`,
					"error",
				);
				writeBugState(cwd, {
					bugId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 2 (escalate) for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				return { status: "escalated", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `preflight gate exit 2 (escalate) for ${phase.role}` };
			}
		}

		// ── 6. Materialization-marker check ───────────────────────────
		// Skip for the monolithic fix_bug.md — it is the orchestrator prose
		// algorithm, not a sub-workflow that subagents run tool calls against.
		// Triage/plan-fix/implement phases reference fix_bug.md for their
		// prose body but the actual tool-use discipline (Store-Write Verification,
		// forge_store) lives in the sub-workflows (review_plan.md, commit_task.md,
		// etc.) which get checked when their own phases run.
		if (phase.workflowFile !== "fix_bug") {
			const markerCheck = checkMaterialization(subWorkflowPath, subWorkflowMd);
			if (!markerCheck.ok) {
				for (const marker of markerCheck.missing) {
					ctx.ui.notify(
						`× workflow regression: ${marker} not found in ${subWorkflowPath}`,
						"error",
					);
				}
				return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `materialization markers missing: ${markerCheck.missing.join(", ")}` };
			}
		}

		// ── 5. Audience check ─────────────────────────────────────────
		// fix_bug.md is orchestrator-only but the subagent doesn't "run" it as a
		// workflow — the orchestrator reads its prose and composes the body text.
		// Skip the audience gate for the monolithic fix_bug.md; only check the
		// true sub-workflows (review_plan, review_code, architect_approve, commit_task)
		// which the subagent does run directly.
		const audienceOk = phase.workflowFile === "fix_bug" || CallerContextStore.asSubagent(() =>
			assertAudience({ workflowName: phase.workflowFile, audience: subWorkflowAudience }, ctx),
		);
		if (!audienceOk) {
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `audience check failed for ${phase.workflowFile}`,
				savedAt: new Date().toISOString(),
			});
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `audience check failed for ${phase.workflowFile}` };
		}

		// ── Persona load ──────────────────────────────────────────────
		let persona;
		try {
			persona = loadForgePersona(phase.personaNoun, cwd);
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× forge:fix-bug — persona '${phase.personaNoun}' not found for phase ${phase.role}: ${e.message ?? "unknown"}. ` +
					"Run /forge:regenerate to materialize persona files.",
				"error",
			);
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `persona load failed: ${e.message ?? "unknown"}`,
				savedAt: new Date().toISOString(),
			});
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `persona load failed: ${e.message ?? "unknown"}` };
		}

		// ── Read bug record for current status ────────────────────────
		// Skip for PENDING bugIds (bug doesn't exist yet).
		const bugRecordBefore = pendingBugId ? null : readBugRecord(bugId, storeCli, cwd);
		const bugStatusBeforePhase = bugRecordBefore?.status;

		// ── 4. Dispatch via runForgeSubagent (IL10) ───────────────────
		// NEVER sendKickoff here — that would reproduce issue #30.
		let bugBody = composeBugBody(subWorkflowMd, bugId, phase.role, bugStatusBeforePhase);

		// For new bugs in triage, prepend the original free-form text so the
		// subagent knows the user-provided bug description to triage.
		// The bug record already exists (pre-created with status "reported"),
		// so the subagent should update it, not create a new one.
		if (phase.role === "triage" && isNewBug && originalArg) {
			bugBody = `Bug description: ${originalArg}\n\n---\n\n${bugBody}`;
		}

		// Phase-scoped progress counters
		const phaseStart = Date.now();
		let turn = 0;
		let toolCount = 0;
		let errCount = 0;
		let lastTool = "";
		const argsByCallId = new Map<string, unknown>();

		// Track tool_execution_end events for bugId capture (Findings #1, #2).
		const toolExecutionEvents: Array<{ toolName?: string; result?: unknown }> = [];

		// Stabilization debug log
		// Skip for PENDING bugIds — create after real bugId is captured.
		// Disable entirely with FORGE_DEBUG_LOG=0.
		const debugLogDisabled = process.env.FORGE_DEBUG_LOG === "0";
		let debugLogPath: string | null = null;
		let writeDebug: (rec: Record<string, unknown>) => void = () => {};
		if (!pendingBugId && !debugLogDisabled) {
			debugLogPath = path.join(
				cwd,
				".forge",
				"cache",
				`fix-bug-debug-${bugId}.jsonl`,
			);
			writeDebug = (rec: Record<string, unknown>) => {
				try {
					fs.mkdirSync(path.dirname(debugLogPath!), { recursive: true });
					// Cap at 10 MB: truncate head when size exceeds the cap.
					try {
						const st = fs.statSync(debugLogPath!);
						if (st.size > 10 * 1024 * 1024) {
							const all = fs.readFileSync(debugLogPath!, "utf8");
							const lines = all.split("\n");
							// Keep last 80% of lines
							const keep = Math.floor(lines.length * 0.8);
							fs.writeFileSync(debugLogPath!, lines.slice(-keep).join("\n"), "utf8");
						}
					} catch { /* file may not exist yet */ }
					fs.appendFileSync(
						debugLogPath!,
						`${JSON.stringify({ ts: new Date().toISOString(), phase: phase.role, ...rec })}\n`,
						"utf8",
					);
				} catch {
					// non-fatal; debug log is best-effort
				}
			};
		}
		writeDebug({ kind: "phase_start", phaseIndex: currentPhaseIndex });
		registry.startPhase(bugId, phase.role, currentPhaseIndex);

		const argHint = (toolName: string, args: unknown): string => {
			if (!args || typeof args !== "object") return "";
			const a = args as Record<string, unknown>;
			const fp = (a.file_path ?? a.path) as unknown;
			if (typeof fp === "string") return path.basename(fp);
			if (typeof a.command === "string") {
				const head = a.command.split(/\s+/).slice(0, 2).join(" ");
				return head.length > 40 ? `${head.slice(0, 40)}…` : head;
			}
			if (typeof a.pattern === "string") return a.pattern.slice(0, 40);
			if (typeof a.query === "string") return a.query.slice(0, 40);
			return "";
		};

		// Tail-line formatters
		const formatTime = (ms: number): string => {
			const d = new Date(ms);
			const pad = (n: number) => String(n).padStart(2, "0");
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		};
		const tailPrefix = () => `[${phase.role} ${formatTime(Date.now())}]`;
		const extractErrorSummary = (result: unknown): string => {
			const raw =
				typeof result === "string"
					? result
					: typeof result === "object" && result !== null
					? JSON.stringify(result)
					: String(result);
			const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? raw;
			return firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine;
		};
		const appendTail = (line: string, opts?: { warning?: boolean }) => {
			registry.appendTail(bugId, phase.role, line, opts);
		};

		appendTail(`${tailPrefix()} ─── phase ${phase.role} begin ───`);

		const refreshStatus = () => {
			if (process.env.FORGE_VERBOSE !== "1") return;
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			const tail = lastTool ? ` · ${lastTool}` : "";
			ctx.ui.setStatus?.(
				STATUS_KEY,
				`fix-bug ${bugId}: ${phase.role} · t${turn} · tools ${toolCount}${errCount ? ` · err ${errCount}` : ""} · ${elapsed}s${tail}`,
			);
		};

		let result;
		try {
			result = await runForgeSubagent({
				persona,
				task: bugBody,
				cwd,
				exportTag: `${bugId}__${phase.role}`,
				// Sprint-scoped if the bug is attached to one, else bug-scoped.
				// Keeps every phase of this bug-fix pipeline in a single cache
				// namespace so the system-prompt + persona prefix stays warm
				// across the ~10-minute phases.
				cacheSessionId: typeof bugRecordBefore?.sprintId === "string" ? `forge:${bugRecordBefore.sprintId}` : `forge:bug:${bugId}`,
				onEvent: (event) => {
					switch (event.type) {
						case "turn_start": {
							turn++;
							lastTool = "";
							registry.bumpTurn(bugId);
							refreshStatus();
							break;
						}
						case "turn_end": {
							// Extract turn preview from assistant message
							break;
						}
						case "tool_execution_start": {
							toolCount++;
							argsByCallId.set(event.toolCallId, event.args);
							const hint = argHint(event.toolName, event.args);
							lastTool = `${event.toolName}${hint ? ` ${hint}` : ""}`;
							writeDebug({
								kind: "tool_start",
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								args: event.args,
							});
							registry.recordToolStart(
								bugId,
								event.toolCallId,
								event.toolName,
								event.args,
							);
							appendTail(`${tailPrefix()} → ${event.toolName}${hint ? ` ${hint}` : ""}`);
							refreshStatus();
							break;
						}
						case "tool_execution_end": {
							const startArgs = argsByCallId.get(event.toolCallId);
							argsByCallId.delete(event.toolCallId);
							// Collect tool_execution_end events for bugId capture (Findings #1, #2).
							toolExecutionEvents.push({ toolName: event.toolName, result: event.result });
							writeDebug({
								kind: "tool_end",
								toolName: event.toolName,
								toolCallId: event.toolCallId,
								isError: event.isError,
								args: startArgs,
								result: event.result,
							});
							registry.recordToolEnd(
								bugId,
								event.toolCallId,
								event.toolName,
								event.isError,
								event.result,
							);
							if (event.isError) {
								errCount++;
								appendTail(
									`${tailPrefix()} ⚠ ${event.toolName} failed: ${extractErrorSummary(event.result)}`,
									{ warning: true },
								);
							} else {
								appendTail(`${tailPrefix()} ← ${event.toolName} ok`);
							}
							refreshStatus();
							break;
						}
						case "compaction_start": {
							ctx.ui.notify(
								`◌ ${phase.role}: context compacting (${event.reason})…`,
								"info",
							);
							appendTail(`${tailPrefix()} ◌ compacting (${event.reason})`);
							break;
						}
						case "auto_retry_start": {
							const err = event.errorMessage ?? "";
							ctx.ui.notify(
								`↻ ${phase.role}: model retry ${event.attempt}/${event.maxAttempts}${err ? `\n${err}` : ""}`,
								"warning",
							);
							appendTail(
								`${tailPrefix()} ↻ retry ${event.attempt}/${event.maxAttempts}${err ? `: ${extractErrorSummary(err)}` : ""}`,
								{ warning: true },
							);
							break;
						}
					}
				},
			});
		} catch (err: unknown) {
			const e = err as { message?: string };
			ctx.ui.notify(
				`× forge:fix-bug — runForgeSubagent threw for phase ${phase.role}: ${e.message ?? "unknown"}`,
				"error",
			);
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}`,
				savedAt: new Date().toISOString(),
			});
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}` };
		}

		// ── Halt-on-failure ───────────────────────────────────────────
		if (result.exitCode !== 0) {
			ctx.ui.notify(
				`× forge:fix-bug — phase ${phase.role} failed (exit ${result.exitCode})` +
					(result.errorMessage ? `: ${result.errorMessage}` : "") +
					(result.stopReason ? ` [${result.stopReason}]` : ""),
				"error",
			);
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
				savedAt: new Date().toISOString(),
			});
			return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero" };
		}

		// Capture model/provider from subagent result.
		if (result.model) lastModel = result.model;
		if (result.provider) lastProvider = result.provider;

		// ── BugId capture after triage phase (Finding #1, #2) ──────────
		// For new bugs, the triage subagent creates the bug record via store-cli.
		// We capture the bugId by scanning tool_execution_end events.
		if (phase.role === "triage" && isNewBug && bugId.startsWith("PENDING-")) {
			const capturedBugId = extractBugIdFromEvents(toolExecutionEvents);
			if (capturedBugId) {
				ctx.ui.notify(`forge:fix-bug — captured bug ID: ${capturedBugId}`, "info");
				bugId = capturedBugId;
			} else {
				// Fallback: list bugs and find the most recent one created after pipeline start.
				const listResult = spawnSync("node", [storeCli, "list", "bug", "--json"], { cwd, encoding: "utf8" });
				if (listResult.status === 0 && listResult.stdout) {
					try {
						const bugs = JSON.parse(listResult.stdout);
						if (Array.isArray(bugs)) {
							// Find most recent bug whose reportedAt is after the pipeline start
							const pipelineStartIso = new Date(parseInt(bugId.replace("PENDING-", ""))).toISOString();
							const recent = bugs
								.filter((b: Record<string, unknown>) => b.reportedAt && b.reportedAt >= pipelineStartIso)
								.sort((a: Record<string, unknown>, b: Record<string, unknown>) => String(b.reportedAt).localeCompare(String(a.reportedAt)))[0];
							if (recent && recent.bugId && typeof recent.bugId === "string" && recent.bugId.startsWith("FORGE-BUG-")) {
								bugId = recent.bugId;
								ctx.ui.notify(`forge:fix-bug — captured bug ID via store fallback: ${bugId}`, "info");
							}
							}
						} catch { /* parse failure — fall through to assertion */ }
					}
			}

			// Defensive guard: if bugId is still PENDING after triage, pipeline cannot proceed.
			if (bugId.startsWith("PENDING-")) {
				ctx.ui.notify(
					"× forge:fix-bug — failed to capture real bug ID after triage. Cannot proceed with PENDING placeholder.",
					"error",
				);
				return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: "bugId still PENDING after triage" };
			}

			// Re-initialize debug log now that real bugId is available.
			if (!debugLogDisabled) {
				debugLogPath = path.join(
					cwd,
					".forge",
					"cache",
					`fix-bug-debug-${bugId}.jsonl`,
				);
				const savedWriteDebug = writeDebug;
				writeDebug = (rec: Record<string, unknown>) => {
					try {
						fs.mkdirSync(path.dirname(debugLogPath!), { recursive: true });
						try {
							const st = fs.statSync(debugLogPath!);
							if (st.size > 10 * 1024 * 1024) {
								const all = fs.readFileSync(debugLogPath!, "utf8");
								const lines = all.split("\n");
								const keep = Math.floor(lines.length * 0.8);
								fs.writeFileSync(debugLogPath!, lines.slice(-keep).join("\n"), "utf8");
							}
						} catch { /* file may not exist yet */ }
						fs.appendFileSync(
							debugLogPath!,
							`${JSON.stringify({ ts: new Date().toISOString(), phase: phase.role, ...rec })}\n`,
							"utf8",
						);
					} catch {
						// non-fatal
					}
				};
				writeDebug({ kind: "bugid_captured", bugId });
			}
		}

		{
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			ctx.ui.notify(
				`✓ ${phase.role}: ${turn} turn${turn === 1 ? "" : "s"} · ${toolCount} tool call${toolCount === 1 ? "" : "s"}${errCount ? ` · ${errCount} err` : ""} · ${elapsed}s`,
				"info",
			);
		}

		// ── Slice-2: orchestrator emits phase event ──────────────────
		// sprintId for bug event emission is the literal "bugs" (routing key),
		// matching the convention in .forge/workflows/fix_bug.md.
		const phaseEndMs = Date.now();
		const bugRecord = readBugRecord(bugId, storeCli, cwd);
		const sprintId = "bugs"; // routing key for bug events — not a sprint reference
		const phaseIteration = (iterationCounts[phase.role] ?? 0) + 1;

		// Read summary judgement for review phases (using bug summary key map)
		const judgement = phase.isReview
			? judgementFromSummary(bugRecord ?? null, phase.role, BUG_SUMMARY_KEY_BY_ROLE)
			: undefined;

		const emitCtx: OrchestratorEmitContext = {
			entityType: "bug",
			bugId,
			sprintId,    // routing key "bugs" — not a sprint reference
			phase,
			iteration:  phaseIteration,
			startMs:    phaseStart,
			endMs:      phaseEndMs,
			model:      result.model    ?? "unknown",
			provider:   result.provider ?? "unknown",
			usage:      {
				input:      result.usage.input,
				output:     result.usage.output,
				cacheRead:  result.usage.cacheRead,
				cacheWrite: result.usage.cacheWrite,
			},
			judgement,
			storeCli,
			cwd,
		};
		const phaseEvent = buildPhaseEvent(emitCtx);

		// Set bug event type based on BUG_TYPE_TOKENS mapping.
		const typeTokenEntry = BUG_TYPE_TOKENS[phase.role];
		if (typeTokenEntry) {
			if (phase.isReview && judgement?.verdict === "revision") {
				phaseEvent.type = typeTokenEntry.fail;
			} else {
				phaseEvent.type = typeTokenEntry.pass;
			}
		}

		const emitResult = emitEvent(storeCli, cwd, sprintId, phaseEvent);
		if (!emitResult.ok) {
			ctx.ui.notify(
				`⚠ forge:fix-bug — phase event emit failed for ${phase.role}: ${emitResult.stderr.trim()}`,
				"warning",
			);
			writeDebug({ kind: "emit_failed", stderr: emitResult.stderr });
		} else {
			writeDebug({ kind: "emit_ok", eventId: phaseEvent.eventId });
		}

		// Drain friction file for this phase.
		const frictionPath = path.join(cwd, ".forge", "cache", `FRICTION-${phase.role}.jsonl`);
		const drain = drainFrictionFile(frictionPath, emitCtx);
		if (drain.emitted + drain.failed > 0) {
			writeDebug({ kind: "friction_drain", ...drain });
			if (drain.failed > 0) {
				ctx.ui.notify(
					`⚠ forge:fix-bug — friction drain for ${phase.role}: ${drain.emitted} ok, ${drain.failed} failed`,
					"warning",
				);
			}
		}

		// ── AC §C.16: Bug FSM canonical-enum assertion ────────────────
		// After each phase that could transition bug status, validate the new
		// status via store-cli (single source of truth). Surface a warning (not halt) if invalid.
		const currentBugRecordForAssert = readBugRecord(bugId, storeCli, cwd);
		if (currentBugRecordForAssert && currentBugRecordForAssert.status) {
			// Defer to store-cli's isLegalTransition as authoritative guard.
			// Only warn on statuses store-cli itself would reject.
			const validateResult = spawnSync("node", [storeCli, "validate", "bug", JSON.stringify(currentBugRecordForAssert)], { cwd, encoding: "utf8" });
			if (validateResult.status !== 0) {
				const detail = typeof validateResult.stderr === "string" ? validateResult.stderr.trim() : "unknown";
				ctx.ui.notify(
					`⚠ forge:fix-bug — bug ${bugId} validation warning: ${detail}`,
					"warning",
				);
				writeDebug({ kind: "fsm_assertion_warning", bugId, status: currentBugRecordForAssert.status, detail });
			}
		}

		// ── 6b. Verdict check (review phases only) ────────────────────
		if (phase.isReview) {
			// Re-read bug record for latest status after subagent ran
			const updatedBugRecord = readBugRecord(bugId, storeCli, cwd);
			const verdict = readBugVerdict(updatedBugRecord, phase.role, BUG_SUMMARY_KEY_BY_ROLE);

			if (verdict === "missing") {
				ctx.ui.notify(
					`× forge:fix-bug — verdict missing for phase ${phase.role} after subagent completed. Escalating.`,
					"error",
				);
				writeBugState(cwd, {
					bugId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `verdict missing for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				return { status: "failed", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `verdict missing for ${phase.role}` };
			}

			if (verdict === "revision") {
				iterationCounts[phase.role] = (iterationCounts[phase.role] ?? 0) + 1;

				if (iterationCounts[phase.role] >= phase.maxIterations) {
					ctx.ui.notify(
						`× forge:fix-bug — revision cap reached for phase ${phase.role} ` +
							`(${iterationCounts[phase.role]}/${phase.maxIterations} iterations). Escalating.`,
						"error",
					);
					writeBugState(cwd, {
						bugId,
						phaseIndex: currentPhaseIndex,
						iterationCounts,
						halted: true,
						lastError: `revision cap reached for ${phase.role}`,
						savedAt: new Date().toISOString(),
					});
					return { status: "escalated", lastPhaseIndex: currentPhaseIndex, iterationCounts, lastError: `revision cap reached for ${phase.role}` };
				}

				// Transition bug back to in-progress before re-dispatching implement.
				// This is required for review-code → implement and approve → implement loops.
				const currentBugStatus = updatedBugRecord?.status;
				if (currentBugStatus === "fixed" || currentBugStatus === "approved") {
					const transitionResult = spawnSync("node", [storeCli, "update-status", "bug", bugId, "status", "in-progress"], { cwd, encoding: "utf8" });
					if (transitionResult.status !== 0) {
						ctx.ui.notify(
							`⚠ forge:fix-bug — failed to transition bug ${bugId} from ${currentBugStatus} to in-progress: ${transitionResult.stderr ?? "unknown"}`,
							"warning",
						);
					} else {
						ctx.ui.notify(
							`⟳ forge:fix-bug — transitioned bug ${bugId}: ${currentBugStatus} → in-progress`,
							"info",
						);
					}
				}

				const predIndex = findPredecessorIndex(BUG_PHASES, currentPhaseIndex);
				ctx.ui.notify(
					`⟳ forge:fix-bug — ${phase.role} returned revision; looping to ${BUG_PHASES[predIndex]?.role ?? predIndex} ` +
						`(attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
					"info",
				);
				writeBugState(cwd, {
					bugId,
					phaseIndex: predIndex,
					iterationCounts,
					halted: false,
					savedAt: new Date().toISOString(),
				});
				currentPhaseIndex = predIndex;
				continue;
			}

			// verdict === "approved": fall through to advance
		}

		// ── Advance to next phase ─────────────────────────────────────
		registry.completePhase(bugId, phase.role, "completed");
		writeBugState(cwd, {
			bugId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: false,
			savedAt: new Date().toISOString(),
		});
		currentPhaseIndex++;
	}

	// ── All phases complete ───────────────────────────────────────────
	deleteBugState(cwd, bugId);
	return { status: "completed", lastPhaseIndex: BUG_PHASES.length - 1, iterationCounts, model: lastModel, provider: lastProvider };
}

// ── Thin wrapper registration ────────────────────────────────────────────

export interface RegisterFixBugOptions {
	cwd?: string;
}

export function registerFixBug(pi: ExtensionAPI, options: RegisterFixBugOptions = {}): void {
	pi.registerCommand("forge:fix-bug", {
		description:
			"Run the full bug-fix pipeline (triage → plan-fix → review-plan → implement → review-code → approve → commit). " +
			"Usage: /forge:fix-bug <BUG_ID_OR_SUMMARY>. " +
			"Orchestrator archetype: each phase is an isolated subagent session (IL10).",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = options.cwd ?? process.cwd();
			const rawArg = args.trim();

			if (!rawArg) {
				ctx.ui.notify("× forge:fix-bug — bug ID or summary required. Usage: /forge:fix-bug <BUG_ID_OR_SUMMARY>", "error");
				return;
			}

			ctx.ui.setStatus?.(STATUS_KEY, `fix-bug: initializing…`);

			// ── Discover forge config ────────────────────────────────────────
			const forgeConfig = discoverForgeConfig(cwd);
			if (!forgeConfig) {
				ctx.ui.notify("× forge:fix-bug — no Forge project found at cwd. Run /forge:init first.", "error");
				ctx.ui.setStatus?.(STATUS_KEY, undefined);
				ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
				return;
			}
			const forgeRoot = forgeConfig.forgeRoot;

			// Tool paths
			const storeCli = path.join(forgeRoot, "tools", "store-cli.cjs");
			const preflightGate = path.join(forgeRoot, "tools", "preflight-gate.cjs");

			// ── Determine bugId ────────────────────────────────────────────
			let bugId: string;
			let isNewBug = false;

			if (/^FORGE-BUG-\d+$/.test(rawArg)) {
				// Existing bug ID — verify it exists
				bugId = rawArg;
				const bugRecord = readBugRecord(bugId, storeCli, cwd);
				if (!bugRecord) {
					ctx.ui.notify(`× forge:fix-bug — bug ${bugId} not found in store.`, "error");
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
				// Check if bug is already in a terminal state
				if (BUG_TERMINAL_STATES.has(bugRecord.status ?? "")) {
					ctx.ui.notify(
						`× forge:fix-bug — bug ${bugId} is already in terminal state '${bugRecord.status}'. No further processing.`,
						"error",
					);
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
			} else {
				// Free-form text — defer bug creation to triage-phase subagent
				// Use a temporary bugId placeholder; will be captured from subagent events
				bugId = `PENDING-${Date.now()}`;
				isNewBug = true;
			}

			// ── Pre-flight confirm ───────────────────────────────────────────
			if (!isNonInteractive()) {
				const confirmMsg = isNewBug
					? `Fix bug: "${rawArg.slice(0, 80)}"? A bug record will be created during triage.`
					: `Fix bug ${bugId}?`;
				const proceed = await ctx.ui.confirm(
					`Fix bug?`,
					confirmMsg,
				);
				if (!proceed) {
					ctx.ui.notify("forge:fix-bug — cancelled.", "info");
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
			}

			// ── Resume detection ─────────────────────────────────────────────
			const registry = getSessionRegistry();
			const existing = isNewBug ? null : readBugState(cwd, bugId);
			let resumeFromState: RunBugState | undefined;

			if (existing) {
				if (isBugStateStale(existing)) {
					ctx.ui.notify(
						`⚠ forge:fix-bug — cached state for ${bugId} is stale (>7 days old, saved at ${formatLocalTime(existing.savedAt)}). Offering purge.`,
						"warning",
					);
					if (!isNonInteractive()) {
						const purge = await ctx.ui.confirm(
							`Purge stale state for ${bugId}?`,
							"The cached state is older than 7 days. Purge and restart from the beginning?",
						);
						if (purge) {
							deleteBugState(cwd, bugId);
						} else {
							ctx.ui.notify("forge:fix-bug — stale state kept; aborting.", "info");
							ctx.ui.setStatus?.(STATUS_KEY, undefined);
							ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
							return;
						}
					} else {
						ctx.ui.notify("forge:fix-bug — stale state; non-interactive mode auto-aborting.", "info");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}
				} else {
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume ${bugId}?`,
							`Cached state found at phase ${existing.phaseIndex} (saved at ${formatLocalTime(existing.savedAt)}). Resume from here?`,
						);
						if (resume) {
							resumeFromState = existing;
							ctx.ui.notify(
								`forge:fix-bug — resuming ${bugId} from phase ${BUG_PHASES[existing.phaseIndex]?.role ?? existing.phaseIndex}`,
								"info",
							);
						} else {
							deleteBugState(cwd, bugId);
						}
					} else {
						ctx.ui.notify(
							`forge:fix-bug — cached state for ${bugId} found but non-interactive mode; aborting.`,
							"info",
						);
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}
				}
			}

			// For new bugs, triage phase will create the bug record.
			// After triage, we need to capture the bugId from the subagent events.
			// This is handled inside runBugPipeline via onEvent interception.
			// For now, we pass the temporary bugId; runBugPipeline will update it.

			// ── Materialization check (top-level workflow) ──────────────────
			const workflowPath = path.join(cwd, ".forge", "workflows", "fix_bug.md");
			if (fs.existsSync(workflowPath)) {
				try {
					const loaded = loadWorkflow(workflowPath);
					// AC#12: Top-level audience check for the fix_bug.md workflow.
					// The orchestrator ITSELF runs fix_bug.md (not a subagent), so check
					// from orchestrator context. Using asSubagent would falsely reject
					// orchestrator-only workflows called by the orchestrator.
					const topAudienceOk = CallerContextStore.asOrchestrator(() =>
						assertAudience({ workflowName: "fix_bug", audience: loaded.audience }, ctx),
					);
					if (!topAudienceOk) {
						ctx.ui.notify("× forge:fix-bug — audience check failed for top-level fix_bug workflow.", "error");
						ctx.ui.setStatus?.(STATUS_KEY, undefined);
						ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
						return;
					}

					// Note: no materialization-marker check here. fix_bug.md is the
					// orchestrator workflow (prose algorithm), not a sub-workflow that
					// subagents run directly. Per-phase sub-workflows (architect_approve,
					// review_code, etc.) each get their own materialization check inside
					// runBugPipeline at line ~481, which is the correct guard layer.
				} catch {
					// Workflow file exists but couldn't be read — non-fatal, continue
				}
			}

			// ── Pre-assign real bug ID for new bugs ────────────────────────
			// Previously this was done inside runBugPipeline, but the session registry
			// needs the real ID before startSession is called.
			if (isNewBug && bugId.startsWith("PENDING-")) {
				const realBugId = assignNextBugId(storeCli, cwd);
				const title = (rawArg && !rawArg.startsWith("@")) ? rawArg.slice(0, 120) : "New bug (pending triage)";
				if (preCreateBug(realBugId, title, storeCli, cwd)) {
					ctx.ui.notify(`forge:fix-bug — pre-assigned bug ID: ${realBugId}`, "info");
					bugId = realBugId;
				} else {
					ctx.ui.notify("× forge:fix-bug — failed to pre-create bug record. Falling back to PENDING capture.", "error");
				}
			}

			// Register session
			registry.startSession(bugId);

			// ── Delegate to pipeline ─────────────────────────────────────────
			const pipelineResult = await runBugPipeline({
				bugId,
				originalArg: isNewBug ? rawArg : undefined,
				isNewBug,
				cwd,
				ctx,
				forgeRoot,
				storeCli,
				preflightGate,
				registry,
				resumeFromState,
			});

			// ── Handle result ────────────────────────────────────────────────
			if (pipelineResult.status === "completed") {
				registry.completeSession(bugId, "completed");
				ctx.ui.notify(
					`〇 forge:fix-bug — ${bugId} pipeline complete (${BUG_PHASES.length} phases).`,
					"info",
				);
			} else {
				registry.completeSession(bugId, "failed");
			}

			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
		},
	});
}