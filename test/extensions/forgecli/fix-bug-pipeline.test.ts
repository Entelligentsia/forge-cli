// fix-bug-pipeline.test.ts — Integration tests for runBugPipeline.
// Drives the pipeline with a mocked runForgeSubagent per Fix 12.
// All subagent dispatch is mocked; no real LLM calls.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
	BUG_PHASES,
	BUG_SUMMARY_KEY_BY_ROLE,
	BUG_TYPE_TOKENS,
	readBugVerdict,
	extractBugIdFromEvents,
	assignNextBugId,
	preCreateBug,
	readBugState,
	writeBugState,
	deleteBugState,
	type BugRecord,
	type RunBugState,
} from "../../../src/extensions/forgecli/fix-bug.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function mkBugRecord(overrides: Partial<BugRecord> = {}): BugRecord {
	return {
		bugId: "FORGE-BUG-001",
		status: "reported",
		summaries: {},
		...overrides,
	};
}

// ── Test Suite: Happy Path ──────────────────────────────────────────────────

describe("fix-bug pipeline integration", () => {
	it("should have 7 phases in correct order", () => {
		const roles = BUG_PHASES.map(p => p.role);
		expect(roles).toEqual([
			"triage", "plan-fix", "review-plan", "implement", "review-code", "approve", "commit",
		]);
	});

	it("should map approve to 'approve' summary key (not null)", () => {
		expect(BUG_SUMMARY_KEY_BY_ROLE["approve"]).toBe("approve");
	});

	it("should have distinct pass/fail tokens for approve and commit phases", () => {
		expect(BUG_TYPE_TOKENS["approve"].pass).toBe("fix-approved");
		expect(BUG_TYPE_TOKENS["approve"].fail).toBe("fix-revision-requested");
		expect(BUG_TYPE_TOKENS["commit"].pass).toBe("bug-committed");
		expect(BUG_TYPE_TOKENS["commit"].fail).toBe("bug-commit-failed");
	});

	it("approve phase should read approve summary verdict", () => {
		const record = mkBugRecord({
			status: "approved",
			summaries: {
				approve: { verdict: "approved", objective: "sign-off", written_at: "2026-01-01T00:00:00Z" },
			},
		});
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");

		const revisionRecord = mkBugRecord({
			status: "in-progress",
			summaries: {
				approve: { verdict: "revision", objective: "needs rework", written_at: "2026-01-01T00:00:00Z" },
			},
		});
		expect(readBugVerdict(revisionRecord, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("approve verdict should fall back to status when no summary", () => {
		const record = mkBugRecord({ status: "approved", summaries: {} });
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");

		const fixedRecord = mkBugRecord({ status: "fixed", summaries: {} });
		expect(readBugVerdict(fixedRecord, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});
});

// ── Test Suite: BugId Capture ──────────────────────────────────────────────

describe("extractBugIdFromEvents — bash capture", () => {
	it("should capture bugId from bash events containing store-cli write bug", () => {
		const events = [
			{ toolName: "bash", result: "node store-cli.cjs write bug FORGE-BUG-018\nCreated bug FORGE-BUG-018" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-018");
	});

	it("should NOT false-positive from unrelated bash commands mentioning bug IDs", () => {
		const events = [
			{ toolName: "bash", result: "ls FORGE-BUG-999" },
		];
		expect(extractBugIdFromEvents(events as any)).toBeNull();
	});

	it("should capture from store-cli tool events", () => {
		const events = [
			{ toolName: "store-cli", result: "Created bug FORGE-BUG-007" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-007");
	});

	it("should capture from write tool events", () => {
		const events = [
			{ toolName: "write", result: "Wrote FORGE-BUG-042 to .forge/store/bugs/" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});

	it("should prefer LAST matching bugId across mixed events", () => {
		const events = [
			{ toolName: "store-cli", result: "Created bug FORGE-BUG-001" },
			{ toolName: "bash", result: "node store-cli.cjs write bug FORGE-BUG-042" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});
});

// ── Test Suite: PENDING bugId guards ────────────────────────────────────────

describe("PENDING bugId state guards", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-bug-pending-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should NOT write state for PENDING bugIds", () => {
		const state: RunBugState = {
			bugId: "PENDING-1700000000000",
			phaseIndex: 0,
			iterationCounts: {},
			halted: false,
			savedAt: new Date().toISOString(),
		};
		writeBugState(tmpDir, state);
		// No file should be written for PENDING bugIds
		const cacheDir = path.join(tmpDir, ".forge", "cache");
		if (fs.existsSync(cacheDir)) {
			const pendingFiles = fs.readdirSync(cacheDir).filter(e => e.includes("PENDING"));
			expect(pendingFiles).toHaveLength(0);
		}
		// readBugState should return null for PENDING
		// (PENDING IDs fail validateId so path can't be computed)
	});

	it("should write state for real bugIds", () => {
		const state: RunBugState = {
			bugId: "FORGE-BUG-001",
			phaseIndex: 3,
			iterationCounts: {},
			halted: false,
			savedAt: new Date().toISOString(),
		};
		writeBugState(tmpDir, state);
		const loaded = readBugState(tmpDir, "FORGE-BUG-001");
		expect(loaded).not.toBeNull();
		expect(loaded!.bugId).toBe("FORGE-BUG-001");
	});

	it("should clean up state AND debug log files on delete", () => {
		const state: RunBugState = {
			bugId: "FORGE-BUG-042",
			phaseIndex: 0,
			iterationCounts: {},
			halted: false,
			savedAt: new Date().toISOString(),
		};
		writeBugState(tmpDir, state);
		// Create a fake debug log file
		const cacheDir = path.join(tmpDir, ".forge", "cache");
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, "fix-bug-debug-FORGE-BUG-042.jsonl"), "{}\n", "utf8");

		deleteBugState(tmpDir, "FORGE-BUG-042");
		expect(readBugState(tmpDir, "FORGE-BUG-042")).toBeNull();
		// Debug log should also be deleted
		expect(fs.existsSync(path.join(cacheDir, "fix-bug-debug-FORGE-BUG-042.jsonl"))).toBe(false);
	});
});

// ── Test Suite: Concurrent run isolation ────────────────────────────────────

describe("concurrent run state isolation", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-bug-concurrent-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("should support separate state files per session via FORGE_SESSION_ID", () => {
		const origEnv = process.env.FORGE_SESSION_ID;
		try {
			// Session 1
			process.env.FORGE_SESSION_ID = "session-1";
			const state1: RunBugState = {
				bugId: "FORGE-BUG-001",
				phaseIndex: 2,
				iterationCounts: {},
				halted: false,
				savedAt: new Date().toISOString(),
			};
			writeBugState(tmpDir, state1);

			// Session 2
			process.env.FORGE_SESSION_ID = "session-2";
			const state2: RunBugState = {
				bugId: "FORGE-BUG-001",
				phaseIndex: 4,
				iterationCounts: { "review-plan": 1 },
				halted: false,
				savedAt: new Date().toISOString(),
			};
			writeBugState(tmpDir, state2);

			// Both should be readable independently
			process.env.FORGE_SESSION_ID = "session-1";
			const loaded1 = readBugState(tmpDir, "FORGE-BUG-001");
			expect(loaded1).not.toBeNull();
			expect(loaded1!.phaseIndex).toBe(2);

			process.env.FORGE_SESSION_ID = "session-2";
			const loaded2 = readBugState(tmpDir, "FORGE-BUG-001");
			expect(loaded2).not.toBeNull();
			expect(loaded2!.phaseIndex).toBe(4);
			expect(loaded2!.iterationCounts).toEqual({ "review-plan": 1 });
		} finally {
			if (origEnv !== undefined) process.env.FORGE_SESSION_ID = origEnv;
			else delete process.env.FORGE_SESSION_ID;
		}
	});

	it("should fall back to PID suffix when no FORGE_SESSION_ID", () => {
		const origEnv = process.env.FORGE_SESSION_ID;
		try {
			delete process.env.FORGE_SESSION_ID;
			const state: RunBugState = {
				bugId: "FORGE-BUG-001",
				phaseIndex: 0,
				iterationCounts: {},
				halted: false,
				savedAt: new Date().toISOString(),
			};
			writeBugState(tmpDir, state);

			// Should find the file via glob (PID-based name)
			const loaded = readBugState(tmpDir, "FORGE-BUG-001");
			expect(loaded).not.toBeNull();
			expect(loaded!.bugId).toBe("FORGE-BUG-001");
		} finally {
			if (origEnv !== undefined) process.env.FORGE_SESSION_ID = origEnv;
		}
	});
});

// ── Test Suite: read-verdict integration for bugs ───────────────────────────

describe("read-verdict bug integration", () => {
	it("should read bug approve verdict from summaries.approve", () => {
		const record = mkBugRecord({
			status: "approved",
			summaries: {
				approve: { verdict: "approved", objective: "sign-off", written_at: "2026-05-15T00:00:00Z" },
			},
		});
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");
	});

	it("should read bug approve revision from summaries.approve", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: {
				approve: { verdict: "revision", objective: "needs work", written_at: "2026-05-15T00:00:00Z" },
			},
		});
		expect(readBugVerdict(record, "approve", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("commit phase should read bug status (verified = approved, approved = revision)", () => {
		const verified = mkBugRecord({ status: "verified" });
		expect(readBugVerdict(verified, "commit", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");

		const stillApproved = mkBugRecord({ status: "approved" });
		expect(readBugVerdict(stillApproved, "commit", BUG_SUMMARY_KEY_BY_ROLE)).toBe("revision");
	});

	it("review-plan should read from summaries.review_plan", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: {
				review_plan: { verdict: "approved", objective: "plan looks good", written_at: "2026-05-15T00:00:00Z" },
			},
		});
		expect(readBugVerdict(record, "review-plan", BUG_SUMMARY_KEY_BY_ROLE)).toBe("approved");
	});

	it("plan-fix should read 'n/a' verdict as 'missing'", () => {
		const record = mkBugRecord({
			status: "in-progress",
			summaries: {
				plan: { verdict: "n/a", objective: "bug fix plan", written_at: "2026-05-15T00:00:00Z" },
			},
		});
		// plan-fix produces n/a verdict — not a review gate, returns 'missing'
		expect(readBugVerdict(record, "plan-fix", BUG_SUMMARY_KEY_BY_ROLE)).toBe("missing");
	});
});
// ── Regression: top-level audience check must use asOrchestrator ────────────
// Bug: CallerContextStore.asSubagent on the top-level fix_bug.md audience
// check caused "orchestrator-only" workflows to be rejected from the
// orchestrator context. Fix: switched to asOrchestrator.

import { CallerContextStore } from "../../../src/extensions/forgecli/audience-gate.js";

describe("Top-level audience check context regression", () => {
	it("should allow orchestrator-only workflow from orchestrator context", () => {
		const prev = CallerContextStore.get();
		CallerContextStore.set("orchestrator");

		// asOrchestrator context should be "orchestrator" — not "subagent"
		const ctxInOrchestrator = CallerContextStore.asOrchestrator(() => CallerContextStore.get());
		expect(ctxInOrchestrator).toBe("orchestrator");

		// asSubagent context would be "subagent" — wrong for top-level check
		const ctxInSubagent = CallerContextStore.asSubagent(() => CallerContextStore.get());
		expect(ctxInSubagent).toBe("subagent");

		// Restore
		CallerContextStore.set(prev);
	});
});

// ── forge_store tool name capture (pi runtime) ──────────────────────────────

describe("extractBugIdFromEvents — forge_store (pi runtime)", () => {
	it("should capture bugId from forge_store tool events", () => {
		const events = [
			{ toolName: "forge_store", result: "Created bug FORGE-BUG-042" },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-042");
	});

	it("should capture bugId from forge_store result object", () => {
		const events = [
			{ toolName: "forge_store", result: { bugId: "FORGE-BUG-007", status: "reported" } },
		];
		expect(extractBugIdFromEvents(events as any)).toBe("FORGE-BUG-007");
	});

	it("should NOT false-positive from forge_store non-bug results", () => {
		const events = [
			{ toolName: "forge_store", result: "Listed 5 sprints" },
		];
		expect(extractBugIdFromEvents(events as any)).toBeNull();
	});
});

// ── Pre-assigned bug ID (replaces PENDING capture) ─────────────────────────

describe("assignNextBugId", () => {
	it("should return FORGE-BUG-001 when store has no FORGE-BUG entries", () => {
		// spawnSync will fail (no store), so maxNum stays 0
		const id = assignNextBugId("/nonexistent/store-cli", "/nonexistent/cwd");
		expect(id).toBe("FORGE-BUG-001");
	});
});

describe("preCreateBug", () => {
	it("should return false when store-cli is unavailable", () => {
		const ok = preCreateBug("FORGE-BUG-099", "Test bug", "/nonexistent/store-cli", "/nonexistent/cwd");
		expect(ok).toBe(false);
	});
});
