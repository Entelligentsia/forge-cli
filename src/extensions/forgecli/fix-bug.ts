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
//
// N-H-C — bugId dual-assignment lifecycle:
//   Phase 1 (handler entry, ~line 1372): bugId = `PENDING-${Date.now()}`, isNewBug = true.
//     A temporary placeholder; the timestamp is later used to find the real bug record.
//   Phase 2 (pre-init, ~line 1495–1500): preCreateBug() writes a minimal bug record with a
//     real FORGE-BUG-NNN ID so the triage subagent has a stable ID to reference.
//     If preCreateBug fails, the PENDING- placeholder is kept for fallback capture.
//   Phase 3 (post-triage, ~line 962–989): capture real ID from BugCreated events emitted by
//     the triage subagent; fall back to listing the most-recent bug after pipelineStart if
//     event capture fails. The PENDING- prefix is used throughout as a guard for
//     state-write paths (see ~line 176 and CallerContextStore guards).
//   Reference: PENDING- prefix semantics defined in CallerContextStore guards.
//
// N-H-H — Preflight gate design (closed by FORGE-S25-T17):
//   Entry-level: runOrchestratorPreflight is called at runBugPipeline entry (~line 523).
//     Validates persona/model config before any LLM dispatch (mirrors run-task.ts design).
//   Per-phase: runPreflightGate (store-cli gate) is called per phase (~line 667).
//     Evaluates declarative gate conditions from the workflow's gate block.
//   This two-level design ensures both structural validity (model/persona config) and
//   store-state validity (predecessor verdicts, status guards) are checked.
//   Reference: orchestrator-preflight.ts (N-H-H, FORGE-S25-T17).
//
// N-H-E tag: see inline comment at the materialization skip (~line 707 / checkMaterialization).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { assertAudience, CallerContextStore } from "./audience-gate.js";
import type { PhaseRole } from "./subagent/caller-context.js";
// ModelRegistry/AuthStorage no longer instantiated here — use ctx.modelRegistry
// so extension-registered providers (registered against the live session) are
// visible to validateModelConfig. Creating a fresh registry here would miss
// them and produce spurious MODEL_UNAVAILABLE warnings (FORGE-BUG-001).
import { loadLayeredConfig } from "./config-layer.js";
import { loadForgePersona, runForgeSubagent } from "./forge-subagent.js";
import { type ForgeToolDefs, getSubagentTools } from "./forge-tools.js";
import {
	readPersonaDir as readPersonaDirBug,
	readPipelineNames as readPipelineNamesBug,
} from "./lib/catalog-helpers.js";
import { discoverForgeConfigCached } from "./lib/forge-config.js";
import { resolveAdvisorModel, runHaltAdvisor } from "./halt-advisor.js";
import { checkMaterialization } from "./lib/manifest-checker.js";
import { runOrchestratorPreflight } from "./orchestrator-preflight.js";
import { resolveModelForPhase } from "./model-resolver.js";
import { type AudienceValue, loadWorkflow } from "./parsers/workflow-loader.js";
import {
	buildPhaseEvent,
	buildSummariesBlock,
	drainFrictionFile,
	emitEvent,
	emitIncompletePhaseEvent,
	findPredecessorIndex,
	formatLocalTime,
	isNonInteractive,
	isoCompact,
	judgementFromSummary,
	type OrchestratorEmitContext,
	type PhaseDescriptor,
	type PreflightResult,
	runPreflightGate,
	runPreflightGateWithData,
	validateId,
} from "./run-task.js";
import { getSessionRegistry } from "./session-registry.js";
import { getOrchestratorTree } from "./orchestrator-tree.js";
import { OrchestratorTranscriptWriter } from "./subagent/orchestrator-transcript.js";
import { resolveToCanonicalId, resolveToolDir } from "./store/store-resolver.js";
import { attachViewportObserver } from "./viewport/events.js";
import { fmtPhaseSummary } from "./viewport/renderer.js";

// ── Bug phase descriptor table ──────────────────────────────────────────────
//
// Decoded from .forge/workflows/fix_bug.md and the task prompt's BUG_PHASES.
// triage / plan-fix / implement all read the same fix_bug.md body — the
// workflow handles all three phases through prose.

// FORGE-S25-T16: readPersonaDirBug / readPipelineNamesBug extracted to
// lib/catalog-helpers.ts and imported above with aliases (H-4, N-H-G).

export const BUG_PHASES: PhaseDescriptor[] = [
	// FORGE-BUG-040: each phase points at its own phase-scoped subagent workflow.
	// Previously triage/plan-fix/implement all pointed at fix_bug.md (the
	// orchestrator-only body), which caused the triage subagent to execute
	// the full lifecycle in a single invocation. plan-fix and implement reuse
	// plan_task.md / implement_plan.md (bug-mode) per meta-fix-bug.md
	// § Pipeline Phases — the bug-mode entity-kind detection is built into
	// those workflows already.
	{ role: "triage", workflowFile: "triage", personaNoun: "bug-fixer", isReview: false, maxIterations: 1 },
	{ role: "plan-fix", workflowFile: "plan_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-plan", workflowFile: "review_plan", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "implement", workflowFile: "implement_plan", personaNoun: "engineer", isReview: false, maxIterations: 1 },
	{ role: "review-code", workflowFile: "review_code", personaNoun: "supervisor", isReview: true, maxIterations: 3 },
	{ role: "approve", workflowFile: "architect_approve", personaNoun: "architect", isReview: true, maxIterations: 3 },
	{ role: "commit", workflowFile: "commit_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
];

// FORGE-BUG-040: BUG_SUMMARY_KEY_BY_ROLE lives in
// subagent/phase-summary-map.ts so the new phase-guard.ts can import
// it without dragging fix-bug.ts into a forge-tools import cycle.
// Re-exported here for backwards-compatibility with existing call sites.
export { BUG_SUMMARY_KEY_BY_ROLE } from "./subagent/phase-summary-map.js";
import { BUG_SUMMARY_KEY_BY_ROLE } from "./subagent/phase-summary-map.js";

// Bug-event type tokens — explicit mapping per review finding #3.
// Non-review phases always emit the pass token. Review phases select
// pass or fail based on ec.judgement.verdict.
export const BUG_TYPE_TOKENS: Record<string, { pass: string; fail: string }> = {
	triage: { pass: "bug-triaged", fail: "bug-triaged" },
	"plan-fix": { pass: "fix-planned", fail: "fix-planned" },
	"review-plan": { pass: "fix-review-passed", fail: "fix-review-failed" },
	implement: { pass: "fix-implemented", fail: "fix-implemented" },
	"review-code": { pass: "fix-code-review-passed", fail: "fix-code-review-failed" },
	approve: { pass: "fix-approved", fail: "fix-revision-requested" },
	commit: { pass: "bug-committed", fail: "bug-commit-failed" },
};

// ── Bug FSM transitions ────────────────────────────────────────────────────
// Mirrors store-cli BUG_TRANSITIONS. Terminal: `fixed`.
// `approved` and `verified` enum values were dropped in forge v0.44.0
// (FORGE-BUG-002 trap). The canonical source is store-cli.cjs.

const BUG_TERMINAL_STATES = new Set(["fixed"]);

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
		} catch {
			/* empty store — start from 1 */
		}
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

	// Approve phase: read approve summary verdict (set via set-bug-summary).
	// The forge v0.44.0 contract makes summaries.approve.verdict the canonical
	// approve signal for bugs — `bug.status` does NOT carry an "approved"
	// value (that enum was dropped). See read-verdict.cjs §
	// BUG_PHASE_VERDICT_SOURCE for the matching plugin-side wiring.
	if (phaseRole === "approve") {
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
		return "missing";
	}

	// Commit phase: read bug status directly. Terminal target is `fixed`.
	if (phaseRole === "commit") {
		if (bugRecord.status === "fixed") return "approved";
		// in-progress means commit did not advance status — treat as revision-needed.
		if (bugRecord.status === "in-progress") return "revision";
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

export type RunBugPipelineStatus = "completed" | "halted" | "escalated" | "failed" | "cancelled";

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
	/**
	 * Optional AbortSignal from SessionRegistry. When provided, the pipeline
	 * checks signal.aborted between phases and passes the signal to
	 * runForgeSubagent so in-flight subagents can be aborted.
	 */
	signal?: AbortSignal;
	forgeToolDefs?: ForgeToolDefs;
}

const STATUS_KEY = "forge:fix-bug";
const MESSAGE_KEY = "forge:fix-bug:message";

export async function runBugPipeline(opts: RunBugPipelineOptions): Promise<RunBugPipelineResult> {
	const {
		bugId: initialBugId,
		originalArg,
		isNewBug,
		cwd,
		ctx,
		forgeRoot,
		storeCli,
		preflightGate,
		registry,
		resumeFromState,
	} = opts;

	const tree = getOrchestratorTree();

	// Mutable bugId — for new bugs, pre-assign a real FORGE-BUG-NNN ID
	// before triage so the subagent never needs to create or discover one.
	// This replaces the fragile PENDING→capture pattern where the subagent was
	// expected to create the bug record and we'd fish the ID from events.
	let bugId = initialBugId;
	let currentPhaseIndex = resumeFromState?.phaseIndex ?? 0;
	const iterationCounts: Record<string, number> = resumeFromState?.iterationCounts ?? {};
	let lastModel: string | undefined;
	let lastProvider: string | undefined;

	// ── Per-persona model routing (Plan 16) ─────────────────────────────────
	// Load layered routing config once at bug-pipeline entry. Empty / absent
	// config produces inherit for every phase — no behaviour change. Pipeline
	// name "fix-bug" lets users configure per-phase overrides distinctly from
	// task pipelines under pipelines["fix-bug"] in their routing config.
	// N-B-E: surface schema errors to caller (Decision 9 — orchestrators fail-fast).
	// See doc/decisions/layered-config-error-policy.md.
	const { merged: modelRoutingConfig, errors: layeredConfigErrors } = loadLayeredConfig(cwd);
	if (layeredConfigErrors.length > 0) {
		for (const e of layeredConfigErrors) {
			ctx.ui.notify(`× forge:fix-bug — forge-cli config schema error: ${e}`, "error");
		}
		return {
			status: "failed",
			lastPhaseIndex: currentPhaseIndex,
			iterationCounts,
			lastError: `forge-cli config schema errors: ${layeredConfigErrors.join("; ")}`,
		};
	}

	// Pre-flight validation — same shape as run-task / run-sprint.
	// FORGE-S25-T17: delegated to orchestrator-preflight.ts (H-13).
	{
		const personasDir = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"forge-payload",
			".base-pack",
			"personas",
		);
		const personaCatalogue = readPersonaDirBug(personasDir);
		const forgeCfgPath = path.join(cwd, ".forge", "config.json");
		const pipelineCatalogue = readPipelineNamesBug(forgeCfgPath);
		const availableModels = ctx.modelRegistry?.getAvailable?.() ?? [];

		const preflightResult = runOrchestratorPreflight({
			mode: "task",
			ctx,
			notifyPrefix: "forge:fix-bug",
			personaCatalogue,
			pipelineCatalogue,
			modelRoutingConfig,
			availableModels: availableModels.map((m) => ({ provider: m.provider, id: m.id })),
		});
		if (!preflightResult.proceed) {
			return {
				...preflightResult.result,
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
			} as RunBugPipelineResult;
		}
	}

	// ── Orchestrator transcript ──────────────────────────────────────────
	// One JSONL file per pipeline run, ISO-prefixed in its filename so
	// review-loop iterations (plan → review → plan → review) preserve
	// their own logs instead of overwriting each other. Captures every
	// ctx.ui.notify line plus structured phase-boundary events.
	const orchTranscript = new OrchestratorTranscriptWriter({
		cwd,
		entityKind: "bug",
		entityId: bugId,
	});
	const __origNotify: typeof ctx.ui.notify = ctx.ui.notify.bind(ctx.ui);
	ctx.ui.notify = ((msg: string, level?: Parameters<typeof __origNotify>[1]) => {
		__origNotify(msg, level);
		orchTranscript.record({
			kind: "notify",
			ts: new Date().toISOString(),
			level: (level ?? "info") as "info" | "warn" | "error" | "success",
			message: typeof msg === "string" ? msg : String(msg),
		});
	}) as typeof ctx.ui.notify;
	const pipelineStartMs = Date.now();

	try {
	while (currentPhaseIndex < BUG_PHASES.length) {
		// ── Between-phase cancellation gate ────────────────────────────
		if (opts.signal?.aborted) {
			ctx.ui.notify(`⊘ forge:fix-bug — ${bugId} cancelled by user.`, "info");
			registry.completePhase(bugId, BUG_PHASES[currentPhaseIndex]?.role ?? "unknown", "cancelled");
			registry.confirmCancelled(bugId);
			// ADR-S21-01: preserve state file so cancelled runs are resumable
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: false,
				status: "cancelled",
				lastError: undefined,
				savedAt: new Date().toISOString(),
			});
			return { status: "cancelled", lastPhaseIndex: currentPhaseIndex, iterationCounts };
		}

		const phase = BUG_PHASES[currentPhaseIndex];
		if (!phase) {
			ctx.ui.notify(`× forge:fix-bug — invalid phase index ${currentPhaseIndex}`, "error");
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `invalid phase index ${currentPhaseIndex}`,
			};
		}

		ctx.ui.setStatus?.(
			STATUS_KEY,
			`fix-bug ${bugId}: phase ${currentPhaseIndex + 1}/${BUG_PHASES.length} (${phase.role})`,
		);
		ctx.ui.notify(`→ ${bugId}: ${phase.role} (phase ${currentPhaseIndex + 1}/${BUG_PHASES.length})`, "info");
		orchTranscript.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: phase.role,
			phaseIndex: currentPhaseIndex,
			phaseCount: BUG_PHASES.length,
			attempt: (iterationCounts[phase.role] ?? 0) + 1,
			workflowFile: phase.workflowFile,
			persona: phase.personaNoun,
		});

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
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `sub-workflow read failed: ${e.message ?? "unknown"}`,
			};
		}

		// ── 6a. Phase skip (state-aware, defense-in-depth) ─────────────
		// Belt-and-suspenders alongside the explicit summaries.triage.route
		// branch (handled in section 6c below). Some subagents in some
		// runtimes still go end-to-end during triage instead of just triaging
		// — rather than roll back the work they did, skip non-review phases
		// whose output is already reflected in the bug status. Review phases
		// are never skipped — they are quality gates that must always run.
		//
		// Post-v0.44.0: terminal status is `fixed` only. `approved` and
		// `verified` are no longer valid bug status values; references
		// removed.
		const PHASE_SKIP_STATES: Record<string, Set<string>> = {
			"plan-fix": new Set(["fixed"]),
			implement: new Set(["fixed"]),
			commit: new Set(["fixed"]), // commit writes the terminal status; skip if already there
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
					// Non-review phases should have verdict "n/a" — the phase
					// didn't produce a gate verdict. This matches the `after
					// <phase> = n/a` preflight gate contract. Review phases
					// use "approved" since they are gate phases.
					verdict: phase.isReview ? "approved" : "n/a",
					written_at: new Date().toISOString(),
				};
				const synthFile = path.join(cwd, ".forge", "cache", `synthetic-summary-${bugId}-${summaryKey}.json`);
				fs.writeFileSync(synthFile, JSON.stringify(synthSummary, null, 2), "utf8");
				const synthResult = spawnSync("node", [storeCli, "set-bug-summary", bugId, summaryKey, synthFile], {
					cwd,
					encoding: "utf8",
				});
				if (synthResult.status !== 0) {
					ctx.ui.notify(
						`⚠ forge:fix-bug — synthetic summary write failed for ${phase.role}: ${String(synthResult.stderr).trim()}`,
						"warning",
					);
				}
				try {
					fs.unlinkSync(synthFile);
				} catch {
					/* non-fatal */
				}
			}
			currentPhaseIndex++;
			continue;
		}

		// ── 6b. Preflight gate ────────────────────────────────────────
		// Skip preflight gate for triage phase of new bugs (PENDING- placeholder)
		// because the bug record doesn't exist yet — gates referencing bug fields
		// would always fail.
		//
		// Also skip for review phases when the bug is already in a terminal
		// state ("fixed"). Path A bugs get fixed during triage, then the
		// preflight gate's `forbid bug.status == fixed` and `after implement
		// = n/a` checks block review-code/review-plan even though we
		// deliberately want to run those reviews. The review subagent handles
		// the already-fixed scenario internally.
		const pendingBugId = bugId.startsWith("PENDING-");
		const bugAlreadyFixed = bugNow?.status === "fixed" && phase.isReview;
		if (!pendingBugId && !bugAlreadyFixed && fs.existsSync(preflightGate)) {
			const preflightOutcome = runPreflightGateWithData(preflightGate, phase.role, bugId, cwd, "bug");
			if (preflightOutcome.result === "halt") {
				// Render structured failure reason if available.
				if (preflightOutcome.gateFailure) {
					ctx.ui.notify(
						`× forge:fix-bug — preflight gate failed for phase ${phase.role} ` +
						`[${preflightOutcome.gateFailure.reasonCode}]: ${preflightOutcome.gateFailure.detail}`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`× forge:fix-bug — preflight gate failed for phase ${phase.role} (exit 1); halting.`,
						"error",
					);
				}
				writeBugState(cwd, {
					bugId,
					phaseIndex: currentPhaseIndex,
					iterationCounts,
					halted: true,
					lastError: `preflight gate exit 1 for ${phase.role}`,
					savedAt: new Date().toISOString(),
				});
				// Spawn halt-recovery advisor (Tier 1, best-effort — non-fatal).
				if (preflightOutcome.gateFailure) {
					const advisorModel = resolveAdvisorModel(
						modelRoutingConfig,
						ctx.model as any,
					);
					void runHaltAdvisor({
						gateFailure: preflightOutcome.gateFailure,
						advisorModel,
						taskId: bugId,
						cwd,
						ctx: { ui: ctx.ui as any },
						forgeRoot,
					});
				}
				return {
					status: "halted",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `preflight gate exit 1 for ${phase.role}`,
				};
			}
			if (preflightOutcome.result === "escalate") {
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
				return {
					status: "escalated",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `preflight gate exit 2 (escalate) for ${phase.role}`,
				};
			}
		}

		// ── 6. Materialization-marker check ───────────────────────────
		// FORGE-BUG-040: every BUG phase is now a true `audience: subagent`
		// sub-workflow — triage / plan-fix / implement no longer alias to
		// fix_bug.md. The marker check is therefore unconditional; a missing
		// marker is a hard failure on the first dispatch.
		{
			const markerCheck = checkMaterialization(subWorkflowPath, subWorkflowMd);
			if (!markerCheck.ok) {
				for (const marker of markerCheck.missing) {
					ctx.ui.notify(`× workflow regression: ${marker} not found in ${subWorkflowPath}`, "error");
				}
				return {
					status: "failed",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `materialization markers missing: ${markerCheck.missing.join(", ")}`,
				};
			}
		}

		// ── 5. Audience check ─────────────────────────────────────────
		// FORGE-BUG-040: every BUG phase is a true `audience: subagent`
		// workflow now; the previous `fix_bug.md` audience-bypass is gone.
		const audienceOk = CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
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
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `audience check failed for ${phase.workflowFile}`,
			};
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
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `persona load failed: ${e.message ?? "unknown"}`,
			};
		}

		// ── Read bug record for current status ────────────────────────
		// Skip for PENDING bugIds (bug doesn't exist yet).
		const bugRecordBefore = pendingBugId ? null : readBugRecord(bugId, storeCli, cwd);
		const bugStatusBeforePhase = bugRecordBefore?.status;

		// ── 4. Dispatch via runForgeSubagent (IL10) ───────────────────
		// NEVER sendKickoff here — that would reproduce issue #30.
		// Carry forward prior phase summaries (forge-cli#19).
		const bugSummariesBlock = currentPhaseIndex > 0
			? buildSummariesBlock(bugRecordBefore?.summaries) || undefined
			: undefined;
		let bugBody = composeBugBody(subWorkflowMd, bugId, phase.role, bugStatusBeforePhase, bugSummariesBlock);

		// For new bugs in triage, prepend the original free-form text so the
		// subagent knows the user-provided bug description to triage.
		// The bug record already exists (pre-created with status "reported"),
		// so the subagent should update it, not create a new one.
		if (phase.role === "triage" && isNewBug && originalArg) {
			bugBody = `Bug description: ${originalArg}\n\n---\n\n${bugBody}`;
		}

		// Phase-scoped progress counters
		const phaseStart = Date.now();

		// Track tool_execution_end events for bugId capture (Findings #1, #2).
		const toolExecutionEvents: Array<{ toolName?: string; result?: unknown }> = [];

		// Stabilization debug log
		// Skip for PENDING bugIds — create after real bugId is captured.
		// Disable entirely with FORGE_DEBUG_LOG=0.
		const debugLogDisabled = process.env.FORGE_DEBUG_LOG === "0";
		let debugLogPath: string | null = null;
		let writeDebug: (rec: Record<string, unknown>) => void = () => {};
		if (!pendingBugId && !debugLogDisabled) {
			debugLogPath = path.join(cwd, ".forge", "cache", `fix-bug-debug-${bugId}.jsonl`);
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
					} catch {
						/* file may not exist yet */
					}
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

		// Bridge: register phase in OrchestratorTree
		const iteration = (iterationCounts[phase.role] ?? 0) + 1;
		const phaseNodeId = `${bugId}:${phase.role}:${iteration}`;
		tree.startNode(phaseNodeId, {
			parentId: bugId,
			label: `${phase.role}:${iteration}`,
			kind: "leaf",
			promptPreview: bugBody.slice(0, 200),
		});

		const refreshStatus = () => {
			if (process.env.FORGE_VERBOSE !== "1") return;
			const elapsed = Math.floor((Date.now() - phaseStart) / 1000);
			const tail = observer.state.lastTool ? ` · ${observer.state.lastTool}` : "";
			ctx.ui.setStatus?.(
				STATUS_KEY,
				`fix-bug ${bugId}: ${phase.role} · t${observer.state.turn} · tools ${observer.state.toolCount}${observer.state.errCount ? ` · err ${observer.state.errCount}` : ""} · ${elapsed}s${tail}`,
			);
		};

		const observer = attachViewportObserver({
			registry,
			sessionId: bugId,
			phaseRole: phase.role,
			beginHeader: `─── phase ${phase.role} begin ───`,
			writeDebug,
			notify: (msg, level) => ctx.ui.notify(msg, level),
			setStatusVerbose: process.env.FORGE_VERBOSE === "1" ? (k, v) => ctx.ui.setStatus?.(k, v) : undefined,
			verboseKeys: { messageKey: `${STATUS_KEY}:message` },
			afterEach: refreshStatus,
		});

		// Wrap the observer's onEvent to also capture tool_execution_end events
		// for bugId capture downstream (findings #1, #2), plus the first turn_end
		// per phase (IL10 visibility — stream-observed model id).
		let modelObservedLogged = false;
		const onSubagentEvent = (event: any) => {
			if (event?.type === "tool_execution_end") {
				toolExecutionEvents.push({ toolName: event.toolName, result: event.result });
			}
			if (!modelObservedLogged && event?.type === "turn_end" && event.message?.model) {
				modelObservedLogged = true;
				writeDebug({
					kind: "model_observed",
					provider: event.message.provider ?? null,
					model: event.message.model,
				});
			}
			observer.onEvent(event);
		};

		// Per-phase model resolution. When config is absent or cascade bottoms
		// out, resolves to inherit (model: undefined) — setModel is skipped and
		// pi's current model is used. IL10 still holds: result.model below is
		// the stream-observed runtime model, not whatever we requested here.
		const modelResolution = resolveModelForPhase("fix-bug", phase.role, phase.personaNoun, modelRoutingConfig);
		writeDebug({
			kind: "requested_model",
			requested: modelResolution.model ?? null,
			source: modelResolution.source,
			persona: phase.personaNoun,
		});

		let result;
		try {
			// FORGE-BUG-040: wrap the runForgeSubagent dispatch in the phase
			// caller context so downstream tool calls (forge_preflight,
			// forge_store update-status / set-bug-summary / set-summary / emit)
			// can verify the caller's phase matches the phase named in the
			// tool's arguments. This is the single setter of phase context
			// for the bug pipeline; the audience-test wrap above is a
			// short-lived test, not the canonical dispatch context.
			result = await CallerContextStore.asSubagent(phase.role as PhaseRole, () =>
				runForgeSubagent({
				persona,
				task: bugBody,
				cwd,
				exportTag: `${bugId}__${phase.role}`,
				// Sprint-scoped if the bug is attached to one, else bug-scoped.
				// Keeps every phase of this bug-fix pipeline in a single cache
				// namespace so the system-prompt + persona prefix stays warm
				// across the ~10-minute phases.
				cacheSessionId:
					typeof bugRecordBefore?.sprintId === "string"
						? `forge:${bugRecordBefore.sprintId}`
						: `forge:bug:${bugId}`,
				onEvent: onSubagentEvent,
				requestedModel: modelResolution.model,
				modelRegistry: ctx.modelRegistry,
				signal: opts.signal,
				customTools: opts.forgeToolDefs ? getSubagentTools(opts.forgeToolDefs, persona.name) : undefined,
				}),
			);
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
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: `runForgeSubagent threw: ${e.message ?? "unknown"}`,
			};
		}

		// ── Post-subagent abort detection ─────────────────────────────────
		if (result.stopReason === "aborted" || opts.signal?.aborted) {
			ctx.ui.notify(`⊘ forge:fix-bug — ${bugId} phase ${phase.role} cancelled.`, "info");
			registry.completePhase(bugId, phase.role, "cancelled");
			tree.completeNode(phaseNodeId, "cancelled");
			registry.confirmCancelled(bugId);
			// Bug B parity with run-task: account billed tokens of the aborted attempt.
			// sprintId "bugs" = routing key for bug events (matches success path).
			// The optional `type` token is omitted — verdict carries the outcome.
			emitIncompletePhaseEvent({
				emitCtx: {
					entityType: "bug",
					bugId,
					sprintId: "bugs",
					phase,
					iteration: (iterationCounts[phase.role] ?? 0) + 1,
					startMs: phaseStart,
					endMs: Date.now(),
					model: result.model ?? "unknown",
					provider: result.provider ?? "unknown",
					usage: {
						input: result.usage.input,
						output: result.usage.output,
						cacheRead: result.usage.cacheRead,
						cacheWrite: result.usage.cacheWrite,
					},
					judgement: undefined,
					storeCli,
					cwd,
				},
				outcome: "aborted",
				notes: result.errorMessage ?? result.stopReason ?? undefined,
				onDebug: writeDebug,
			});
			// ADR-S21-01: preserve state file so cancelled runs are resumable
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: false,
				status: "cancelled",
				lastError: undefined,
				savedAt: new Date().toISOString(),
			});
			return { status: "cancelled", lastPhaseIndex: currentPhaseIndex, iterationCounts };
		}

		// ── Halt-on-failure ───────────────────────────────────────────
		if (result.exitCode !== 0) {
			ctx.ui.notify(
				`× forge:fix-bug — phase ${phase.role} failed (exit ${result.exitCode})` +
					(result.errorMessage ? `: ${result.errorMessage}` : "") +
					(result.stopReason ? ` [${result.stopReason}]` : ""),
				"error",
			);
			// Bug B parity with run-task: account billed tokens of the failed attempt.
			emitIncompletePhaseEvent({
				emitCtx: {
					entityType: "bug",
					bugId,
					sprintId: "bugs",
					phase,
					iteration: (iterationCounts[phase.role] ?? 0) + 1,
					startMs: phaseStart,
					endMs: Date.now(),
					model: result.model ?? "unknown",
					provider: result.provider ?? "unknown",
					usage: {
						input: result.usage.input,
						output: result.usage.output,
						cacheRead: result.usage.cacheRead,
						cacheWrite: result.usage.cacheWrite,
					},
					judgement: undefined,
					storeCli,
					cwd,
				},
				outcome: "failed",
				notes: result.errorMessage ?? result.stopReason ?? undefined,
				onDebug: writeDebug,
			});
			writeBugState(cwd, {
				bugId,
				phaseIndex: currentPhaseIndex,
				iterationCounts,
				halted: true,
				lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
				savedAt: new Date().toISOString(),
			});
			return {
				status: "failed",
				lastPhaseIndex: currentPhaseIndex,
				iterationCounts,
				lastError: result.errorMessage ?? result.stopReason ?? "subagent exit non-zero",
			};
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
								.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
									String(b.reportedAt).localeCompare(String(a.reportedAt)),
								)[0];
							if (
								recent &&
								recent.bugId &&
								typeof recent.bugId === "string" &&
								recent.bugId.startsWith("FORGE-BUG-")
							) {
								bugId = recent.bugId;
								ctx.ui.notify(`forge:fix-bug — captured bug ID via store fallback: ${bugId}`, "info");
							}
						}
					} catch {
						/* parse failure — fall through to assertion */
					}
				}
			}

			// Defensive guard: if bugId is still PENDING after triage, pipeline cannot proceed.
			if (bugId.startsWith("PENDING-")) {
				ctx.ui.notify(
					"× forge:fix-bug — failed to capture real bug ID after triage. Cannot proceed with PENDING placeholder.",
					"error",
				);
				return {
					status: "failed",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: "bugId still PENDING after triage",
				};
			}

			// Re-initialize debug log now that real bugId is available.
			if (!debugLogDisabled) {
				debugLogPath = path.join(cwd, ".forge", "cache", `fix-bug-debug-${bugId}.jsonl`);
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
						} catch {
							/* file may not exist yet */
						}
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
			const { turn, toolCount, errCount, cumUsage, cumCompression } = observer.state;
			ctx.ui.notify(
				`✓ ${phase.role}: ${turn} turn${turn === 1 ? "" : "s"} · ${toolCount} tool call${toolCount === 1 ? "" : "s"}${errCount ? ` · ${errCount} err` : ""} · ${elapsed}s`,
				"info",
			);
			orchTranscript.record({
				kind: "phase-end",
				ts: new Date().toISOString(),
				phase: phase.role,
				phaseIndex: currentPhaseIndex,
				attempt: (iterationCounts[phase.role] ?? 0) + 1,
				verdict: "n/a",
				elapsedMs: Date.now() - phaseStart,
				turns: turn,
				toolCount,
				errCount,
			});
			registry.appendTail(
				bugId,
				phase.role,
				fmtPhaseSummary({
					role: phase.role,
					turns: turn,
					tools: toolCount,
					errors: errCount,
					wallSeconds: elapsed,
					usage: cumUsage,
					model: result.model,
					provider: result.provider,
					compression: cumCompression.tokensSaved > 0 ? cumCompression : undefined,
				}),
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
			sprintId, // routing key "bugs" — not a sprint reference
			phase,
			iteration: phaseIteration,
			startMs: phaseStart,
			endMs: phaseEndMs,
			model: result.model ?? "unknown",
			provider: result.provider ?? "unknown",
			usage: {
				input: result.usage.input,
				output: result.usage.output,
				cacheRead: result.usage.cacheRead,
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
			const validateResult = spawnSync(
				"node",
				[storeCli, "validate", "bug", JSON.stringify(currentBugRecordForAssert)],
				{ cwd, encoding: "utf8" },
			);
			if (validateResult.status !== 0) {
				const detail = typeof validateResult.stderr === "string" ? validateResult.stderr.trim() : "unknown";
				ctx.ui.notify(`⚠ forge:fix-bug — bug ${bugId} validation warning: ${detail}`, "warning");
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
					`× forge:fix-bug — verdict missing for phase ${phase.role} after subagent completed. Halting for advisory.`,
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
				// A missing verdict IS a postflight-outputs failure: the canonical
				// phase summary the subagent must write (e.g. summaries.code_review,
				// linked via set-bug-summary) was never recorded, so there is no
				// verdict to route on. Route it through the halt-recovery advisor
				// (FORGE-S26-T18) — the same hand-off the preflight/postflight gate
				// failures use — instead of a bare escalation. Best-effort, non-fatal.
				const advisorModel = resolveAdvisorModel(
					modelRoutingConfig,
					ctx.model as any,
				);
				void runHaltAdvisor({
					gateFailure: {
						phase: phase.role,
						reasonCode: "verdict-missing",
						detail:
							`Phase '${phase.role}' completed but no verdict was found in the store. ` +
							"The canonical phase summary was not written, so the orchestrator has no verdict to route on.",
						remediation:
							"Re-run the phase and ensure the subagent's forge_store set-bug-summary call " +
							'uses args:["<bugId>", "<phaseKey>"] with the literal phase key as args[1] ' +
							"(e.g. code_review), and that the call exits zero before the subagent returns.",
					},
					advisorModel,
					taskId: bugId,
					cwd,
					ctx: { ui: ctx.ui as any },
					forgeRoot,
				});
				return {
					status: "halted",
					lastPhaseIndex: currentPhaseIndex,
					iterationCounts,
					lastError: `verdict missing for ${phase.role}`,
				};
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
					return {
						status: "escalated",
						lastPhaseIndex: currentPhaseIndex,
						iterationCounts,
						lastError: `revision cap reached for ${phase.role}`,
					};
				}

				// Transition bug back to in-progress before re-dispatching implement.
				// This is required for review-code → implement and approve → implement loops.
				const currentBugStatus = updatedBugRecord?.status;
				if (currentBugStatus === "fixed" || currentBugStatus === "approved") {
					const transitionResult = spawnSync(
						"node",
						[storeCli, "update-status", "bug", bugId, "status", "in-progress"],
						{ cwd, encoding: "utf8" },
					);
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
				orchTranscript.record({
					kind: "phase-loopback",
					ts: new Date().toISOString(),
					fromPhase: phase.role,
					toPhase: BUG_PHASES[predIndex]?.role ?? String(predIndex),
					fromPhaseIndex: currentPhaseIndex,
					toPhaseIndex: predIndex,
					reason: `${phase.role} returned revision (attempt ${iterationCounts[phase.role]}/${phase.maxIterations})`,
				});
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
		tree.completeNode(phaseNodeId, "completed");
		tree.setNodeUsage(phaseNodeId, { input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead });
		if (result.model) tree.setNodeModel(phaseNodeId, result.model, result.provider ?? "");
		writeBugState(cwd, {
			bugId,
			phaseIndex: currentPhaseIndex,
			iterationCounts,
			halted: false,
			savedAt: new Date().toISOString(),
		});

		// ── 6c. Path A / Path B branch (post-triage) ──────────────────
		// Per meta-fix-bug.md § Triage Judgement (forge v0.44.0+), the
		// triage subagent records the route decision in
		// bug.summaries.triage.route. The orchestrator reads it after
		// triage returns and selects the downstream phase list:
		//   Path A (short-circuit): skip plan-fix + review-plan
		//   Path B (default, full loop): run all phases
		//
		// If route is missing or malformed, default to Path B (the safe
		// choice — running extra phases never produces an unsafe outcome).
		// The PHASE_SKIP_STATES heuristic at section 6a remains as
		// defense-in-depth for cases where the field is missing but the
		// bug status proves the work happened.
		if (phase.role === "triage") {
			const bugAfterTriage = readBugRecord(bugId, storeCli, cwd);
			const triageSummary = bugAfterTriage?.summaries?.triage as { route?: unknown } | undefined;
			const route = triageSummary?.route;
			if (route === "A") {
				const skipUntilIndex = BUG_PHASES.findIndex((p) => p.role === "implement");
				if (skipUntilIndex > currentPhaseIndex + 1) {
					ctx.ui.notify(`⊘ forge:fix-bug — Path A selected by triage; skipping plan-fix and review-plan.`, "info");
					currentPhaseIndex = skipUntilIndex;
					continue;
				}
			}
			// route === "B", missing, or any other value → fall through to standard advance
		}

		currentPhaseIndex++;
	}

	// ── All phases complete ───────────────────────────────────────────
	deleteBugState(cwd, bugId);
	orchTranscript.record({
		kind: "pipeline-end",
		ts: new Date().toISOString(),
		outcome: "complete",
		elapsedMs: Date.now() - pipelineStartMs,
	});
	return {
		status: "completed",
		lastPhaseIndex: BUG_PHASES.length - 1,
		iterationCounts,
		model: lastModel,
		provider: lastProvider,
	};
	} finally {
		ctx.ui.notify = __origNotify;
	}
}

// ── Thin wrapper registration ────────────────────────────────────────────

export interface RegisterFixBugOptions {
	cwd?: string;
	forgeToolDefs?: ForgeToolDefs;
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
				ctx.ui.notify(
					"× forge:fix-bug — bug ID or summary required. Usage: /forge:fix-bug <BUG_ID_OR_SUMMARY>",
					"error",
				);
				return;
			}

			ctx.ui.setStatus?.(STATUS_KEY, `fix-bug: initializing…`);

			// ── Discover forge config ────────────────────────────────────────
			const forgeConfig = discoverForgeConfigCached(cwd);
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

			// Check if arg looks like it could be a bug ID (prefixed or unprefixed).
			// Covers: FORGE-BUG-042, BUG-042, B042.
			const looksLikeBugId = /^(?:[A-Z0-9]+-)?(?:BUG-?\d+|B\d+)$/i.test(rawArg) || /^BUG-\d+$/i.test(rawArg);

			if (/^FORGE-BUG-\d+$/.test(rawArg)) {
				// Canonical bug ID — verify it exists
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
			} else if (looksLikeBugId) {
				// Unprefixed bug ID — resolve through the store cascade.
				// Issue #20: unprefixed entity IDs silently poisoned substitutions.
				const toolDir = resolveToolDir(forgeRoot);
				const resolvedBugId = await resolveToCanonicalId(rawArg, toolDir, cwd, "bug", {
					ctx,
					commandLabel: "forge:fix-bug",
				});
				if (!resolvedBugId) {
					// Error already emitted by resolver
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
					return;
				}
				bugId = resolvedBugId;
				// Re-verify the resolved bug exists
				const bugRecord = readBugRecord(bugId, storeCli, cwd);
				if (!bugRecord) {
					ctx.ui.notify(`× forge:fix-bug — bug ${bugId} not found in store.`, "error");
					ctx.ui.setStatus?.(STATUS_KEY, undefined);
					return;
				}
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
				const proceed = await ctx.ui.confirm(`Fix bug?`, confirmMsg);
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
					// ADR-S21-01: offer resume for ALL non-stale states — halted=true
					// (explicit failure), halted=false (cancelled/interrupted), and
					// any state with existing.status set.
					const stateStatus = existing.status ?? (existing.halted ? "halted" : "interrupted");
					const statusLabel =
						stateStatus === "cancelled" ? "cancelled" : stateStatus === "halted" ? "halted" : "interrupted";
					const phaseRole = BUG_PHASES[existing.phaseIndex]?.role ?? existing.phaseIndex;
					if (!isNonInteractive()) {
						const resume = await ctx.ui.confirm(
							`Resume ${bugId}?`,
							`Cached state — phase ${existing.phaseIndex} (${phaseRole}), ${statusLabel}, ` +
								`saved at ${formatLocalTime(existing.savedAt)}. Resume from here?`,
						);
						if (resume) {
							resumeFromState = existing;
							ctx.ui.notify(
								`forge:fix-bug — resuming ${bugId} from phase ${phaseRole} (${statusLabel})`,
								"info",
							);
						} else {
							deleteBugState(cwd, bugId);
						}
					} else {
						// Non-interactive: auto-resume from state (no confirmation).
						// Cancelled/interrupted states are valid resume points.
						resumeFromState = existing;
						ctx.ui.notify(`forge:fix-bug — resuming ${bugId} from phase ${phaseRole} (${statusLabel})`, "info");
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
				const title = rawArg && !rawArg.startsWith("@") ? rawArg.slice(0, 120) : "New bug (pending triage)";
				if (preCreateBug(realBugId, title, storeCli, cwd)) {
					ctx.ui.notify(`forge:fix-bug — pre-assigned bug ID: ${realBugId}`, "info");
					bugId = realBugId;
				} else {
					ctx.ui.notify(
						"× forge:fix-bug — failed to pre-create bug record. Falling back to PENDING capture.",
						"error",
					);
				}
			}

			// Register session
			registry.startSession(bugId);

			// Bridge: register bug in OrchestratorTree.
			const tree = getOrchestratorTree();
			tree.startNode(bugId, { label: `fix-bug ${bugId}`, kind: "orchestrator" });

			// ── Delegate to pipeline ─────────────────────────────────────────
			// ── Delegate to pipeline ─────────────────────────────────────────
			const signal = registry.getAbortSignal(bugId);

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
				signal,
				forgeToolDefs: options.forgeToolDefs,
			});

			// ── Handle result ────────────────────────────────────────────────
			if (pipelineResult.status === "completed") {
				registry.completeSession(bugId, "completed");
				tree.completeNode(bugId, "completed");
				ctx.ui.notify(`〇 forge:fix-bug — ${bugId} pipeline complete (${BUG_PHASES.length} phases).`, "info");
			} else if (pipelineResult.status === "cancelled") {
				registry.completeSession(bugId, "cancelled");
				tree.completeNode(bugId, "cancelled");
			} else {
				registry.completeSession(bugId, "failed");
				tree.completeNode(bugId, "failed");
			}

			ctx.ui.setStatus?.(STATUS_KEY, undefined);
			ctx.ui.setStatus?.(MESSAGE_KEY, undefined);
		},
	});
}
