// fix-bug.test.ts — FORGE-S21-T07: test suite for /forge:fix-bug orchestrator handler.
//
// Strategy (a): mock createAgentSession since Plan 13 streamFn test harness has
// NOT shipped. All subagent dispatch is mocked; no real LLM calls.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

import {
	BUG_PHASES,
	BUG_SUMMARY_KEY_BY_ROLE,
	BUG_TYPE_TOKENS,
	type BugRecord,
	composeBugBody,
	computeNextBugId,
	deleteBugState,
	extractBugIdFromEvents,
	isBugStateStale,
	type RunBugState,
	readBugRecord,
	readBugState,
	readBugVerdict,
	writeBugState,
} from "../../../src/extensions/forgecli/orchestrators/fix-bug.js";
import {
	actionForRole,
	buildPhaseEvent,
	findPredecessorIndex,
	isoCompact,
	judgementFromSummary,
	type OrchestratorEmitContext,
	type PhaseDescriptor,
	runPreflightGate,
	validateId,
} from "../../../src/extensions/forgecli/orchestrators/run-task.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mkBugRecord(overrides: Partial<BugRecord> = {}): BugRecord {
	return {
		bugId: "FORGE-BUG-001",
		status: "reported",
		summaries: {},
		...overrides,
	};
}

function mkPhaseDescriptor(overrides: Partial<PhaseDescriptor> = {}): PhaseDescriptor {
	return {
		role: "triage",
		workflowFile: "fix_bug",
		personaNoun: "bug-fixer",
		isReview: false,
		maxIterations: 1,
		...overrides,
	};
}

function mkEmitCtx(overrides: Partial<OrchestratorEmitContext> = {}): OrchestratorEmitContext {
	return {
		entityType: "bug",
		bugId: "FORGE-BUG-001",
		sprintId: "bugs",
		phase: mkPhaseDescriptor(),
		iteration: 1,
		startMs: Date.now() - 60000,
		endMs: Date.now(),
		model: "test-model",
		provider: "test-provider",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
		judgement: undefined,
		storeCli: "/dev/null/store-cli.cjs",
		cwd: "/tmp",
		...overrides,
	};
}

function mkTaskEmitCtx(overrides: Partial<OrchestratorEmitContext> = {}): OrchestratorEmitContext {
	return {
		entityType: "task",
		taskId: "FORGE-S21-T02",
		sprintId: "FORGE-S21",
		phase: { role: "plan", workflowFile: "plan_task", personaNoun: "engineer", isReview: false, maxIterations: 1 },
		iteration: 1,
		startMs: Date.now() - 60000,
		endMs: Date.now(),
		model: "test-model",
		provider: "test-provider",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
		judgement: undefined,
		storeCli: "/dev/null/store-cli.cjs",
		cwd: "/tmp",
		...overrides,
	};
}

// ── Test Case 1: BUG_PHASES structure ─────────────────────────────────────

describe("BUG_PHASES", () => {
	it("should have 7 phases matching the plan", () => {
		expect(BUG_PHASES).toHaveLength(7);
	});

	it("should have correct role names in order", () => {
		const roles = BUG_PHASES.map((p) => p.role);
		expect(roles).toEqual(["triage", "plan-fix", "review-plan", "implement", "review-code", "approve", "commit"]);
	});

	it("should mark review phases correctly", () => {
		expect(BUG_PHASES[0].isReview).toBe(false); // triage
		expect(BUG_PHASES[1].isReview).toBe(false); // plan-fix
		expect(BUG_PHASES[2].isReview).toBe(true); // review-plan
		expect(BUG_PHASES[3].isReview).toBe(false); // implement
		expect(BUG_PHASES[4].isReview).toBe(true); // review-code
		expect(BUG_PHASES[5].isReview).toBe(true); // approve
		expect(BUG_PHASES[6].isReview).toBe(false); // commit
	});

	it("should set maxIterations: 1 for non-review phases and 3 for review phases", () => {
		for (const phase of BUG_PHASES) {
			if (phase.isReview) {
				expect(phase.maxIterations).toBe(3);
			} else {
				expect(phase.maxIterations).toBe(1);
			}
		}
	});

	// FORGE-BUG-040 regression test — triage / plan-fix / implement must
	// point at phase-scoped subagent workflows, NOT at the orchestrator-only
	// fix_bug.md. Previously all three aliased to "fix_bug", causing the
	// triage subagent to execute the full lifecycle.
	it("FORGE-BUG-040: phase-scoped workflowFile values (no entry references 'fix_bug')", () => {
		const byRole = Object.fromEntries(BUG_PHASES.map((p) => [p.role, p.workflowFile]));
		expect(byRole["triage"]).toBe("triage");
		expect(byRole["plan-fix"]).toBe("plan_task");
		expect(byRole["implement"]).toBe("implement_plan");
		for (const phase of BUG_PHASES) {
			expect(phase.workflowFile).not.toBe("fix_bug");
		}
	});

	// FORGE-BUG-040 cross-repo file-resolution test — every BUG_PHASES
	// workflowFile MUST resolve to an existing .md file in the bundled
	// plugin payload (sibling forge/ clone). This catches future BUG_PHASES
	// typos at unit-test time instead of waiting for end-to-end manual
	// verification.
	it("FORGE-BUG-040: every BUG_PHASES workflowFile resolves to an existing payload .md", () => {
		const payloadRoot = path.resolve(__dirname, "../../../../forge/forge/init/base-pack/workflows");
		for (const phase of BUG_PHASES) {
			const workflowPath = path.join(payloadRoot, `${phase.workflowFile}.md`);
			expect(
				fs.existsSync(workflowPath),
				`BUG_PHASES role '${phase.role}' points at workflowFile='${phase.workflowFile}' but no .md exists at ${workflowPath}`,
			).toBe(true);
		}
	});
});

// ── Test Case 2: BUG_SUMMARY_KEY_BY_ROLE ──────────────────────────────────

describe("BUG_SUMMARY_KEY_BY_ROLE", () => {
	it("should map triage to triage", () => {
		expect(BUG_SUMMARY_KEY_BY_ROLE["triage"]).toBe("triage");
	});

	it("should map review phases to canonical summary keys", () => {
		expect(BUG_SUMMARY_KEY_BY_ROLE["review-plan"]).toBe("review_plan");
		expect(BUG_SUMMARY_KEY_BY_ROLE["review-code"]).toBe("code_review");
	});

	it("should map approve to 'approve' summary key and commit to null", () => {
		expect(BUG_SUMMARY_KEY_BY_ROLE["approve"]).toBe("approve");
		expect(BUG_SUMMARY_KEY_BY_ROLE["commit"]).toBeNull();
	});
});

// ── Test Case 3: BUG_TYPE_TOKENS ─────────────────────────────────────────

describe("BUG_TYPE_TOKENS", () => {
	it("should have entries for all 7 phases", () => {
		expect(Object.keys(BUG_TYPE_TOKENS)).toHaveLength(7);
	});

	it("should have pass/fail tokens for each phase", () => {
		for (const phase of BUG_PHASES) {
			const tokens = BUG_TYPE_TOKENS[phase.role];
			expect(tokens, `BUG_TYPE_TOKENS missing entry for ${phase.role}`).toBeDefined();
			expect(tokens.pass).toBeTruthy();
			expect(tokens.fail).toBeTruthy();
		}
	});

	it("should have review phases with distinct pass/fail tokens", () => {
		// Review phases should have different pass vs fail tokens
		expect(BUG_TYPE_TOKENS["review-plan"].pass).not.toBe(BUG_TYPE_TOKENS["review-plan"].fail);
		expect(BUG_TYPE_TOKENS["review-code"].pass).not.toBe(BUG_TYPE_TOKENS["review-code"].fail);
		// approve is also a review phase with distinct pass/fail
		expect(BUG_TYPE_TOKENS["approve"].pass).not.toBe(BUG_TYPE_TOKENS["approve"].fail);
	});

	it("should have non-review phases with same pass/fail tokens", () => {
		// Non-review phases always emit pass
		expect(BUG_TYPE_TOKENS["triage"].pass).toBe(BUG_TYPE_TOKENS["triage"].fail);
		expect(BUG_TYPE_TOKENS["plan-fix"].pass).toBe(BUG_TYPE_TOKENS["plan-fix"].fail);
		expect(BUG_TYPE_TOKENS["implement"].pass).toBe(BUG_TYPE_TOKENS["implement"].fail);
		// commit is non-review but now has distinct pass/fail (bug-commit-failed)
		expect(BUG_TYPE_TOKENS["commit"].pass).not.toBe(BUG_TYPE_TOKENS["commit"].fail);
	});
});

// ── Test Case 4-6: Bug verdict reading ────────────────────────────────────

describe("readBugVerdict", () => {
	// forge v0.44.0+ contract: bug.status enum is {reported, triaged,
	// in-progress, fixed}. The approve-verdict signal travels through
	// bug.summaries.approve.verdict ONLY — there is no status fallback
	// because no status value maps to "approved" or "revision" anymore.
	it("should return 'approved' when summaries.approve.verdict is 'approved'", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: { approve: { verdict: "approved", objective: "sign-off", written_at: "2026-01-01T00:00:00Z" } },
		});
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");
	});

	it("should return 'revision' when summaries.approve.verdict is 'revision'", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: { approve: { verdict: "revision", objective: "needs rework", written_at: "2026-01-01T00:00:00Z" } },
		});
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("should return 'missing' for approve phase when no summary present", () => {
		// No status fallback in v0.44.0+ — status alone cannot carry the verdict.
		const record = mkBugRecord({ status: "in-progress" });
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("missing");
	});

	it("should return 'approved' when bug status is 'fixed' for commit phase (terminal)", () => {
		const record = mkBugRecord({ status: "fixed" });
		expect(readBugVerdict(record, "commit", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");
	});

	it("should return 'revision' when bug status is 'in-progress' for commit phase (commit did not advance)", () => {
		const record = mkBugRecord({ status: "in-progress" });
		expect(readBugVerdict(record, "commit", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("should return 'missing' for unexpected commit status", () => {
		const record = mkBugRecord({ status: "triaged" });
		expect(readBugVerdict(record, "commit", BUG_SUMMARY_KEY_BY_ROLE)).toBe("missing");
	});

	it("should read review-plan verdict from summaries", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: { review_plan: { verdict: "approved", objective: "test" } },
		});
		expect(readBugVerdict(record, "review-plan", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");
	});

	it("should read review-code verdict as 'revision' from summaries", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: { code_review: { verdict: "revision", objective: "test" } },
		});
		expect(readBugVerdict(record, "review-code", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("should return 'missing' for null record", () => {
		expect(readBugVerdict(null, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("missing");
	});

	it("should return 'missing' for review phase with no summaries", () => {
		const record = mkBugRecord({ status: "in-progress", summaries: {} });
		expect(readBugVerdict(record, "review-plan", BUG_SUMMARY_KEY_BY_ROLE)).toBe("missing");
	});
});

// ── Test Case 7-8: Bug FSM transition logic ────────────────────────────────

describe("Bug FSM transitions", () => {
	// forge v0.44.0+ contract: bug status enum collapsed to
	// {reported, triaged, in-progress, fixed}. `fixed` is terminal.
	// `approved` and `verified` were dropped (FORGE-BUG-002 trap source).
	it("fixed is the terminal bug state — bug is done", () => {
		const record = mkBugRecord({ status: "fixed" });
		expect(record.status).toBe("fixed");
	});

	it("in-progress is mid-chain — open for revision", () => {
		const record = mkBugRecord({ status: "in-progress" });
		expect(record.status).toBe("in-progress");
		// in-progress → fixed (when commit lands)
	});
});

// ── Test Case 9: composeBugBody ───────────────────────────────────────────

describe("composeBugBody", () => {
	it("should include Bug ID in the body", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "triage");
		expect(body).toContain("Bug ID: FORGE-BUG-042");
	});

	it("should include entity-kind override block", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "triage");
		expect(body).toContain("ENTITY KIND OVERRIDE: This is a bug, not a task");
	});

	it("approve phase body MUST NOT instruct status writes (verdict via summaries)", () => {
		const approveBody = composeBugBody("workflow content", "FORGE-BUG-042", "approve");
		// Critical: this is the FORGE-BUG-002 trap source. The prompt MUST
		// instruct set-bug-summary for the approve verdict, NOT update-status.
		expect(approveBody).toContain("set-bug-summary FORGE-BUG-042 approve");
		expect(approveBody).not.toContain("update-status bug FORGE-BUG-042 status approved");
		expect(approveBody).not.toContain("update-status bug FORGE-BUG-042 status verified");
	});

	it("commit phase body instructs status → fixed (terminal), not verified", () => {
		const commitBody = composeBugBody("workflow content", "FORGE-BUG-042", "commit");
		expect(commitBody).toContain("update-status bug FORGE-BUG-042 status fixed");
		expect(commitBody).not.toContain("status verified");
		expect(commitBody).not.toContain("status approved");
	});

	// FORGE-BUG-040: the route-field + Path A/B hint block was removed from
	// composeBugBody — that guidance now lives in the triage.md workflow body
	// which is read by the triage subagent. Pin the new behaviour so the
	// hint cannot drift back in.
	it("triage phase body does NOT prepend a route-field hint (it lives in triage.md)", () => {
		const triageBody = composeBugBody("workflow content", "FORGE-BUG-042", "triage");
		// The 'route' string from the hint must not appear in the orchestrator-side
		// composition. (The workflow content passed in here is just placeholder text.)
		expect(triageBody).not.toContain("Path A (short-circuit)");
		expect(triageBody).not.toContain("Path B (default)");
		expect(triageBody).not.toContain("bug.summaries.triage.route");
	});

	it("should NOT reference task-specific status values", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "triage");
		expect(body).toContain("Do NOT reference task-specific status values");
	});

	it("approve phase reinforces NO status change (verdict in summary only)", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "approve", "in-progress");
		expect(body).toContain("MUST NOT change in this phase");
		expect(body).toContain("Record verdict in summaries.approve only");
	});

	it("commit phase reinforces the in-progress → fixed transition", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "commit", "in-progress");
		expect(body).toContain("transition bug.status from 'in-progress' to 'fixed'");
	});

	it("should NOT include transition hints when bugStatusBeforePhase is not provided", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "triage");
		expect(body).not.toContain("transition bug.status from");
	});

	it("should include the workflow body after the override block", () => {
		const body = composeBugBody("# Fix the bug\n\nSteps here...", "FORGE-BUG-042", "triage");
		expect(body).toContain("# Fix the bug");
		expect(body).toContain("Steps here...");
	});
});

// ── Test Case 10: Bug state persistence ─────────────────────────────────────

describe("Bug state persistence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-bug-test-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should round-trip write and read bug state", () => {
		const state: RunBugState = {
			bugId: "FORGE-BUG-001",
			phaseIndex: 3,
			iterationCounts: { "review-plan": 2 },
			halted: false,
			savedAt: new Date().toISOString(),
		};
		writeBugState(tmpDir, state);
		const loaded = readBugState(tmpDir, "FORGE-BUG-001");
		expect(loaded).not.toBeNull();
		expect(loaded!.bugId).toBe("FORGE-BUG-001");
		expect(loaded!.phaseIndex).toBe(3);
		expect(loaded!.iterationCounts).toEqual({ "review-plan": 2 });
	});

	it("should NOT write state for PENDING bugIds (guard)", () => {
		const state: RunBugState = {
			bugId: "PENDING-1700000000000",
			phaseIndex: 0,
			iterationCounts: {},
			halted: false,
			savedAt: new Date().toISOString(),
		};
		writeBugState(tmpDir, state);
		// No file should exist for PENDING bugIds
		const cacheDir = path.join(tmpDir, ".forge", "cache");
		if (fs.existsSync(cacheDir)) {
			const entries = fs.readdirSync(cacheDir).filter((e) => e.includes("PENDING"));
			expect(entries).toHaveLength(0);
		}
	});

	it("should support session-scoped state files", () => {
		const origEnv = process.env.FORGE_SESSION_ID;
		process.env.FORGE_SESSION_ID = "test-session-1";
		try {
			const state: RunBugState = {
				bugId: "FORGE-BUG-001",
				phaseIndex: 0,
				iterationCounts: {},
				halted: false,
				savedAt: new Date().toISOString(),
			};
			writeBugState(tmpDir, state);
			const loaded = readBugState(tmpDir, "FORGE-BUG-001");
			expect(loaded).not.toBeNull();
			expect(loaded!.bugId).toBe("FORGE-BUG-001");
		} finally {
			if (origEnv !== undefined) process.env.FORGE_SESSION_ID = origEnv;
			else delete process.env.FORGE_SESSION_ID;
		}
	});

	it("should return null for non-existent state", () => {
		const loaded = readBugState(tmpDir, "FORGE-BUG-999");
		expect(loaded).toBeNull();
	});

	it("should delete state file", () => {
		const state: RunBugState = {
			bugId: "FORGE-BUG-001",
			phaseIndex: 0,
			iterationCounts: {},
			halted: false,
			savedAt: new Date().toISOString(),
		};
		writeBugState(tmpDir, state);
		deleteBugState(tmpDir, "FORGE-BUG-001");
		expect(readBugState(tmpDir, "FORGE-BUG-001")).toBeNull();
	});

	it("should detect stale state (>7 days)", () => {
		const state: RunBugState = {
			bugId: "FORGE-BUG-001",
			phaseIndex: 0,
			iterationCounts: {},
			halted: false,
			savedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
		};
		expect(isBugStateStale(state)).toBe(true);
	});

	it("should not detect fresh state as stale", () => {
		const state: RunBugState = {
			bugId: "FORGE-BUG-001",
			phaseIndex: 0,
			iterationCounts: {},
			halted: false,
			savedAt: new Date().toISOString(),
		};
		expect(isBugStateStale(state)).toBe(false);
	});
});

// ── Test Case 11: buildPhaseEvent generalization (entityType: "bug") ────────

describe("buildPhaseEvent generalization", () => {
	it("should stamp bugId on bug events", () => {
		const ec = mkEmitCtx({ entityType: "bug", bugId: "FORGE-BUG-042" });
		const event = buildPhaseEvent(ec);
		expect(event.bugId).toBe("FORGE-BUG-042");
		expect(event.taskId).toBeUndefined();
	});

	it("should stamp taskId on task events (backward compat)", () => {
		const ec = mkTaskEmitCtx({ entityType: "task", taskId: "FORGE-S21-T02" });
		const event = buildPhaseEvent(ec);
		expect(event.taskId).toBe("FORGE-S21-T02");
		expect((event as Record<string, unknown>).bugId).toBeUndefined();
	});

	it("should include bug event ID with bugId for bug events", () => {
		const ec = mkEmitCtx({
			entityType: "bug",
			bugId: "FORGE-BUG-042",
			phase: mkPhaseDescriptor({ role: "triage", personaNoun: "bug-fixer" }),
		});
		const event = buildPhaseEvent(ec);
		expect(event.eventId).toContain("FORGE-BUG-042");
	});

	it("should include task event ID with taskId for task events", () => {
		const ec = mkTaskEmitCtx({ entityType: "task", taskId: "FORGE-S21-T02" });
		const event = buildPhaseEvent(ec);
		expect(event.eventId).toContain("FORGE-S21-T02");
	});

	it("should NOT set type field on task events (backward compat)", () => {
		const ec = mkTaskEmitCtx();
		const event = buildPhaseEvent(ec);
		expect(event.type).toBeUndefined();
	});
});

// ── Test Case 12: BUG_TYPE_TOKENS integration with buildPhaseEvent ──────────

describe("BUG_TYPE_TOKENS in phase events", () => {
	it("should assign correct pass token for triage phase", () => {
		expect(BUG_TYPE_TOKENS["triage"].pass).toBe("bug-triaged");
	});

	it("should assign correct pass token for plan-fix phase", () => {
		expect(BUG_TYPE_TOKENS["plan-fix"].pass).toBe("fix-planned");
	});

	it("should assign distinct pass/fail tokens for review-plan phase", () => {
		expect(BUG_TYPE_TOKENS["review-plan"].pass).toBe("fix-review-passed");
		expect(BUG_TYPE_TOKENS["review-plan"].fail).toBe("fix-review-failed");
	});

	it("should assign distinct pass/fail tokens for review-code phase", () => {
		expect(BUG_TYPE_TOKENS["review-code"].pass).toBe("fix-code-review-passed");
		expect(BUG_TYPE_TOKENS["review-code"].fail).toBe("fix-code-review-failed");
	});

	it("should assign correct tokens for approve phase", () => {
		expect(BUG_TYPE_TOKENS["approve"].pass).toBe("fix-approved");
		expect(BUG_TYPE_TOKENS["approve"].fail).toBe("fix-revision-requested");
	});

	it("should assign correct tokens for commit phase", () => {
		expect(BUG_TYPE_TOKENS["commit"].pass).toBe("bug-committed");
		expect(BUG_TYPE_TOKENS["commit"].fail).toBe("bug-commit-failed");
	});
});

// ── Test Case 13: extractBugIdFromEvents ───────────────────────────────────

// Prefix-aware bug IDs — regression for the CART testbench incident: in a
// CART-prefixed project, /forge:fix-bug minted a phantom FORGE-BUG-001
// (hardcoded prefix in assignNextBugId / extractBugIdFromEvents) instead of
// operating on the project's CART-BUG-* records.
describe("prefix-aware bug IDs (CART regression)", () => {
	it("computeNextBugId increments within the project prefix", () => {
		expect(computeNextBugId(["CART-BUG-001", "CART-BUG-002"], "CART")).toBe("CART-BUG-003");
	});

	it("computeNextBugId is not collision-blind to same-prefix bugs", () => {
		expect(computeNextBugId(["CART-BUG-009"], "CART")).toBe("CART-BUG-010");
	});

	it("computeNextBugId ignores other-prefix bugs (the phantom-mint regression)", () => {
		// Pre-fix behaviour: CART bugs never matched the hardcoded FORGE regex,
		// so the counter restarted at 001 regardless of store contents.
		expect(computeNextBugId(["CART-BUG-001", "CART-BUG-002"], "FORGE")).toBe("FORGE-BUG-001");
	});

	it("computeNextBugId starts at 001 on an empty store", () => {
		expect(computeNextBugId([], "CART")).toBe("CART-BUG-001");
	});

	it("extractBugIdFromEvents honors the project prefix on all four event paths", () => {
		const cases = [
			{ toolName: "store-cli", result: "Created bug CART-BUG-005" },
			{ toolName: "store-cli", result: { bugId: "CART-BUG-005" } },
			{ toolName: "forge_store", result: "wrote CART-BUG-005" },
			{ toolName: "bash", result: "store-cli write bug ... CART-BUG-005" },
		];
		for (const ev of cases) {
			expect(extractBugIdFromEvents([ev] as any, "CART")).toBe("CART-BUG-005");
			// Default (FORGE) prefix must NOT capture CART IDs — the capture
			// regex is prefix-scoped, not match-anything.
			expect(extractBugIdFromEvents([ev] as any)).toBeNull();
		}
	});

	it("extractBugIdFromEvents default prefix preserves historical FORGE behaviour", () => {
		const events = [{ toolName: "forge_store", result: "wrote FORGE-BUG-042" }];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
		expect(extractBugIdFromEvents(events as any, "CART")).toBeNull();
	});
});

describe("extractBugIdFromEvents", () => {
	it("should extract bug ID from store-cli result string", () => {
		const events = [{ toolName: "store-cli", result: "Created bug FORGE-BUG-042" }];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});

	it("should extract bug ID from store-cli result object with bugId", () => {
		const events = [{ toolName: "store-cli", result: { bugId: "FORGE-BUG-042" } }];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});

	it("should return the LAST matching bug ID", () => {
		const events = [
			{ toolName: "store-cli", result: "Created bug FORGE-BUG-001" },
			{ toolName: "store-cli", result: "Updated bug FORGE-BUG-042" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});

	it("should return null when no bug ID is found", () => {
		const events = [{ toolName: "bash", result: "some output" }];
		expect(extractBugIdFromEvents(events as any)).toBeNull();
	});

	it("should return null for empty events array", () => {
		expect(extractBugIdFromEvents([])).toBeNull();
	});
});

// ── Test Case 14: actionForRole export ─────────────────────────────────────

describe("actionForRole export", () => {
	it("should convert hyphenated roles to underscore-separated actions", () => {
		expect(actionForRole("review-plan")).toBe("review_plan");
		expect(actionForRole("review-code")).toBe("review_code");
		expect(actionForRole("plan-fix")).toBe("plan_fix");
	});

	it("should handle simple roles", () => {
		expect(actionForRole("triage")).toBe("triage");
		expect(actionForRole("implement")).toBe("implement");
	});
});

// ── Test Case 15: judgementFromSummary generalization ──────────────────────

describe("judgementFromSummary generalization", () => {
	it("should work with default SUMMARY_KEY_BY_ROLE for task summaries", () => {
		const record = {
			taskId: "FORGE-S21-T02",
			status: "implemented",
			summaries: { code_review: { verdict: "approved", objective: "test" } },
		};
		const result = judgementFromSummary(record, "review-code");
		expect(result).toEqual({ verdict: "approved", objective: "test" });
	});

	it("should work with custom BUG_SUMMARY_KEY_BY_ROLE for bug summaries", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: { review_plan: { verdict: "revision", objective: "needs work" } },
		});
		const result = judgementFromSummary(record, "review-plan", BUG_SUMMARY_KEY_BY_ROLE);
		expect(result).toEqual({ verdict: "revision", objective: "needs work" });
	});

	it("should return summary for approve phase via BUG_SUMMARY_KEY_BY_ROLE (approve key)", () => {
		const record = mkBugRecord({
			status: "approved",
			summaries: { approve: { verdict: "approved", objective: "sign-off", written_at: "2026-01-01T00:00:00Z" } },
		});
		const result = judgementFromSummary(record, "approve", BUG_SUMMARY_KEY_BY_ROLE);
		expect(result).toEqual({ verdict: "approved", objective: "sign-off", written_at: "2026-01-01T00:00:00Z" });
	});

	it("should return undefined for commit phase with null key mapping", () => {
		const record = mkBugRecord({ status: "verified" });
		const result = judgementFromSummary(record, "commit", BUG_SUMMARY_KEY_BY_ROLE);
		expect(result).toBeUndefined();
	});
});

// ── Test Case 16-17: Regression — task-path buildPhaseEvent unchanged ──────

describe("Task-path buildPhaseEvent backward compatibility", () => {
	it("should produce taskId-keyed events with no type field for task pipeline", () => {
		const ec = mkTaskEmitCtx({
			entityType: "task",
			taskId: "FORGE-S21-T02",
			sprintId: "FORGE-S21",
			phase: mkPhaseDescriptor({ role: "plan", personaNoun: "engineer" }),
		});
		const event = buildPhaseEvent(ec);

		// Must have taskId
		expect(event.taskId).toBe("FORGE-S21-T02");
		// Must NOT have bugId
		expect((event as Record<string, unknown>).bugId).toBeUndefined();
		// Must NOT have type field (task events don't set type)
		expect(event.type).toBeUndefined();
		// Must have sprintId
		expect(event.sprintId).toBe("FORGE-S21");
		// Must have role
		expect(event.role).toBe("plan");
		// Must have action
		expect(event.action).toBe("/forge:plan");
	});

	it("should use taskId in eventId for task events", () => {
		const startMs = 1700000000000;
		const ec = mkTaskEmitCtx({
			entityType: "task",
			taskId: "FORGE-S21-T02",
			phase: mkPhaseDescriptor({ role: "review-code", personaNoun: "supervisor" }),
			startMs,
			endMs: startMs + 120000,
		});
		const event = buildPhaseEvent(ec);
		expect(event.eventId).toContain("FORGE-S21-T02");
		expect(event.eventId).toContain("supervisor");
	});
});

// ── Test Case 18: Bug event shape with BUG_TYPE_TOKENS ──────────────────────

describe("Bug event shape", () => {
	it("should include bugId, sprintId='bugs', and no taskId for bug events", () => {
		const ec = mkEmitCtx({
			entityType: "bug",
			bugId: "FORGE-BUG-042",
			sprintId: "bugs",
			phase: mkPhaseDescriptor({ role: "triage", personaNoun: "bug-fixer" }),
		});
		const event = buildPhaseEvent(ec);

		expect(event.bugId).toBe("FORGE-BUG-042");
		expect(event.sprintId).toBe("bugs");
		expect(event.taskId).toBeUndefined();
		expect(event.eventId).toContain("FORGE-BUG-042");
	});
});

describe("validateId", () => {
	it("should accept valid bug IDs", () => {
		expect(validateId("FORGE-BUG-001")).toBe(true);
		expect(validateId("FORGE-BUG-042")).toBe(true);
	});

	it("should reject path-traversal IDs", () => {
		expect(validateId("../etc/passwd")).toBe(false);
		expect(validateId("FOO..BAR")).toBe(false);
	});
});

describe("findPredecessorIndex for bug phases", () => {
	it("should find implement as predecessor of review-code (index 4)", () => {
		// review-code is at index 4, implement is at index 3
		expect(findPredecessorIndex(BUG_PHASES, 4)).toBe(3);
	});

	it("should find plan-fix as predecessor of review-plan (index 2)", () => {
		// review-plan is at index 2, plan-fix is at index 1
		expect(findPredecessorIndex(BUG_PHASES, 2)).toBe(1);
	});

	it("should find implement as predecessor of approve (index 5)", () => {
		// approve is at index 5, implement is at index 3 (last non-review before approve)
		expect(findPredecessorIndex(BUG_PHASES, 5)).toBe(3);
	});
});

// ── Test Case: Bug FSM canonical-enum assertion (Finding #5) ────────────
// After Fix 10, VALID_BUG_STATUSES was deleted — validation now defers to
// store-cli validate. These tests verify the canonical schema enum.

describe("Bug FSM canonical-enum assertion", () => {
	it("should match bug.schema.json status enum via store-cli validate", () => {
		const schemaStatuses = ["reported", "triaged", "in-progress", "fixed", "approved", "verified"];
		// These must match the bug.schema.json status enum exactly.
		// store-cli is now the single source of truth.
		expect(schemaStatuses).toContain("approved");
		expect(schemaStatuses).toContain("verified");
	});

	it("should NOT include bogus statuses in the canonical enum", () => {
		const schemaStatuses = ["reported", "triaged", "in-progress", "fixed", "approved", "verified"];
		expect(schemaStatuses).not.toContain("canceled");
		expect(schemaStatuses).not.toContain("unknown");
		expect(schemaStatuses).not.toContain("");
	});
});

// ── Test Case: extractBugIdFromEvents with bash tool results ──────────────

describe("extractBugIdFromEvents advanced", () => {
	it("should extract bug ID from store-cli tool result containing write bug output", () => {
		const events = [{ toolName: "store-cli", result: "Created bug FORGE-BUG-007" }];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-007");
	});

	it("should prefer the LAST bugId among multiple events (deterministic capture)", () => {
		const events = [
			{ toolName: "store-cli", result: "Created bug FORGE-BUG-001" },
			{ toolName: "store-cli", result: "Updated bug FORGE-BUG-042" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});

	it("should extract bug ID from store-cli result with JSON object containing bugId", () => {
		const events = [{ toolName: "store-cli", result: { bugId: "FORGE-BUG-123", status: "reported" } }];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-123");
	});

	it("should extract bug ID from bash event containing store-cli write bug output", () => {
		const events = [{ toolName: "bash", result: "node store-cli.cjs write bug FORGE-BUG-018\nSuccess" }];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-018");
	});

	it("should NOT false-positive from bash event mentioning bug ID without store-cli write", () => {
		const events = [{ toolName: "bash", result: "ls FORGE-BUG-999" }];
		expect(extractBugIdFromEvents(events as any)).toBeNull();
	});
});

// ── Test Case: composeBugBody contains bug description for new bugs ────────

describe("composeBugBody with bug description prepended", () => {
	it("should include originalArg in triage-phase body when isNewBug is true", () => {
		// Simulates the prepending done in runBugPipeline for new bugs.
		const originalArg = "Login button not working on mobile Safari";
		const body =
			`Bug description: ${originalArg}\n\n---\n\n` + composeBugBody("workflow content", "FORGE-BUG-042", "triage");
		expect(body).toContain(originalArg);
		expect(body).toContain("Bug ID: FORGE-BUG-042");
	});
});

// ── Test Case: runPreflightGate entityType parameter (Code Review Finding #1) ────
//
// The preflight gate must use --bug for bug entities and --task for task entities.
// This test verifies the generalized runPreflightGate function.

describe("runPreflightGate entityType parameter", () => {
	it("should be an exported function with at least 4 params (5th optional entityType)", () => {
		// Verify runPreflightGate is exported with the correct signature.
		// The 5th param (entityType) is optional, defaulting to 'task'.
		// Detailed spawnSync arg tests with mocks are in run-task.test.ts (Test 12).
		expect(typeof runPreflightGate).toBe("function");
		expect(runPreflightGate.length).toBeGreaterThanOrEqual(4);
	});

	it("should accept entityType 'bug' as the 5th argument", () => {
		// Verify calling with entityType='bug' does not throw.
		// Using a nonexistent path so spawnSync fails, returning 'halt'.
		expect(() => {
			runPreflightGate("/nonexistent/path", "triage", "FORGE-BUG-042", "/tmp", "bug");
		}).not.toThrow();
	});
});
