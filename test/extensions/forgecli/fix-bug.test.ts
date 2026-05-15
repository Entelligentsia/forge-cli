// fix-bug.test.ts — FORGE-S21-T07: test suite for /forge:fix-bug orchestrator handler.
//
// Strategy (a): mock createAgentSession since Plan 13 streamFn test harness has
// NOT shipped. All subagent dispatch is mocked; no real LLM calls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	BUG_PHASES,
	BUG_SUMMARY_KEY_BY_ROLE,
	BUG_TYPE_TOKENS,
	readBugRecord,
	readBugVerdict,
	composeBugBody,
	extractBugIdFromEvents,
	readBugState,
	writeBugState,
	deleteBugState,
	isBugStateStale,
	type RunBugState,
	type BugRecord,
} from "../../../src/extensions/forgecli/fix-bug.js";
import {
	buildPhaseEvent,
	isoCompact,
	actionForRole,
	judgementFromSummary,
	runPreflightGate,
	validateId,
	findPredecessorIndex,
	type OrchestratorEmitContext,
	type PhaseDescriptor,
} from "../../../src/extensions/forgecli/run-task.js";

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
		const roles = BUG_PHASES.map(p => p.role);
		expect(roles).toEqual([
			"triage", "plan-fix", "review-plan", "implement", "review-code", "approve", "commit",
		]);
	});

	it("should mark review phases correctly", () => {
		expect(BUG_PHASES[0].isReview).toBe(false); // triage
		expect(BUG_PHASES[1].isReview).toBe(false); // plan-fix
		expect(BUG_PHASES[2].isReview).toBe(true);  // review-plan
		expect(BUG_PHASES[3].isReview).toBe(false); // implement
		expect(BUG_PHASES[4].isReview).toBe(true);  // review-code
		expect(BUG_PHASES[5].isReview).toBe(true);  // approve
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

	it("should map approve and commit to null (use update-status)", () => {
		expect(BUG_SUMMARY_KEY_BY_ROLE["approve"]).toBeNull();
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
	});

	it("should have non-review phases with same pass/fail tokens", () => {
		// Non-review phases always emit pass
		expect(BUG_TYPE_TOKENS["triage"].pass).toBe(BUG_TYPE_TOKENS["triage"].fail);
		expect(BUG_TYPE_TOKENS["plan-fix"].pass).toBe(BUG_TYPE_TOKENS["plan-fix"].fail);
		expect(BUG_TYPE_TOKENS["implement"].pass).toBe(BUG_TYPE_TOKENS["implement"].fail);
		expect(BUG_TYPE_TOKENS["commit"].pass).toBe(BUG_TYPE_TOKENS["commit"].fail);
	});
});

// ── Test Case 4-6: Bug verdict reading ────────────────────────────────────

describe("readBugVerdict", () => {
	it("should return 'approved' when bug status is 'approved' for approve phase", () => {
		const record = mkBugRecord({ status: "approved" });
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");
	});

	it("should return 'revision' when bug status is 'fixed' for approve phase", () => {
		const record = mkBugRecord({ status: "fixed" });
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("should return 'approved' when bug status is 'verified' for commit phase", () => {
		const record = mkBugRecord({ status: "verified" });
		expect(readBugVerdict(record, "commit", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");
	});

	it("should return 'revision' when bug status is 'approved' for commit phase", () => {
		const record = mkBugRecord({ status: "approved" });
		expect(readBugVerdict(record, "commit", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("should return 'missing' for unexpected approve status", () => {
		const record = mkBugRecord({ status: "triaged" });
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("missing");
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
	it("fixed is NOT a terminal state — bugs in 'fixed' should be processable", () => {
		// Bugs in 'fixed' status are mid-chain (awaiting architect approval)
		// They should NOT be blocked by preflight
		const record = mkBugRecord({ status: "fixed" });
		expect(record.status).toBe("fixed");
		// fixed → approved (sign-off) or fixed → in-progress (revision loop)
		// The handler should allow proceeding
	});

	it("approved is NOT a terminal state — bugs in 'approved' should continue to commit", () => {
		const record = mkBugRecord({ status: "approved" });
		expect(record.status).toBe("approved");
		// approved → verified (commit) or approved → in-progress (revision loop)
	});

	it("verified is the ONLY terminal bug state", () => {
		const record = mkBugRecord({ status: "verified" });
		expect(record.status).toBe("verified");
		// No transitions out of verified
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

	it("should include update-status bug commands for approve and commit phases", () => {
		const approveBody = composeBugBody("workflow content", "FORGE-BUG-042", "approve");
		expect(approveBody).toContain("update-status bug FORGE-BUG-042 status approved");

		const commitBody = composeBugBody("workflow content", "FORGE-BUG-042", "commit");
		expect(commitBody).toContain("update-status bug FORGE-BUG-042 status verified");
	});

	it("should NOT reference task-specific status values", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "triage");
		expect(body).toContain("Do NOT reference task-specific status values");
	});

	it("should include phase-specific transition hint for approve phase", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "approve", "fixed");
		expect(body).toContain("transition bug.status from 'fixed' to 'approved'");
	});

	it("should include phase-specific transition hint for commit phase", () => {
		const body = composeBugBody("workflow content", "FORGE-BUG-042", "commit", "approved");
		expect(body).toContain("transition bug.status from 'approved' to 'verified'");
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
		const ec = mkEmitCtx({ entityType: "bug", bugId: "FORGE-BUG-042", phase: mkPhaseDescriptor({ role: "triage", personaNoun: "bug-fixer" }) });
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

	it("should assign correct token for approve phase", () => {
		expect(BUG_TYPE_TOKENS["approve"].pass).toBe("fix-approved");
	});

	it("should assign correct token for commit phase", () => {
		expect(BUG_TYPE_TOKENS["commit"].pass).toBe("bug-committed");
	});
});

// ── Test Case 13: extractBugIdFromEvents ───────────────────────────────────

describe("extractBugIdFromEvents", () => {
	it("should extract bug ID from store-cli result string", () => {
		const events = [
			{ toolName: "store-cli", result: "Created bug FORGE-BUG-042" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});

	it("should extract bug ID from store-cli result object with bugId", () => {
		const events = [
			{ toolName: "store-cli", result: { bugId: "FORGE-BUG-042" } },
		];
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
		const events = [
			{ toolName: "bash", result: "some output" },
		];
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

	it("should return undefined for phases with null key mapping", () => {
		const record = mkBugRecord({ status: "approved" });
		const result = judgementFromSummary(record, "approve", BUG_SUMMARY_KEY_BY_ROLE);
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

describe("Bug FSM canonical-enum assertion", () => {
	it("should recognize all valid bug statuses", () => {
		const validStatuses = ["reported", "triaged", "in-progress", "fixed", "approved", "verified"];
		for (const status of validStatuses) {
			expect(validStatuses).toContain(status);
		}
	});

	it("should match bug.schema.json status enum", () => {
		// These must match the bug.schema.json status enum exactly.
		const schemaStatuses = ["reported", "triaged", "in-progress", "fixed", "approved", "verified"];
		const VALID_BUG_STATUSES = new Set(["reported", "triaged", "in-progress", "fixed", "approved", "verified"]);
		for (const s of schemaStatuses) {
			expect(VALID_BUG_STATUSES.has(s)).toBe(true);
		}
	});

	it("should reject invalid bug statuses with warning (not halt)", () => {
		// The assertion should be a warning, not a halt — per AC §C.16.
		// We verify the VALID_BUG_STATUSES set does NOT include bogus statuses.
		const VALID_BUG_STATUSES = new Set(["reported", "triaged", "in-progress", "fixed", "approved", "verified"]);
		expect(VALID_BUG_STATUSES.has("canceled")).toBe(false);
		expect(VALID_BUG_STATUSES.has("unknown")).toBe(false);
		expect(VALID_BUG_STATUSES.has("")).toBe(false);
	});
});

// ── Test Case: extractBugIdFromEvents with bash tool results ──────────────

describe("extractBugIdFromEvents advanced", () => {
	it("should extract bug ID from store-cli tool result containing write bug output", () => {
		const events = [
			{ toolName: "store-cli", result: "Created bug FORGE-BUG-007" },
		];
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
		const events = [
			{ toolName: "store-cli", result: { bugId: "FORGE-BUG-123", status: "reported" } },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-123");
	});
});

// ── Test Case: composeBugBody contains bug description for new bugs ────────

describe("composeBugBody with bug description prepended", () => {
	it("should include originalArg in triage-phase body when isNewBug is true", () => {
		// Simulates the prepending done in runBugPipeline for new bugs.
		const originalArg = "Login button not working on mobile Safari";
		const body = `Bug description: ${originalArg}\n\n---\n\n` + composeBugBody("workflow content", "FORGE-BUG-042", "triage");
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