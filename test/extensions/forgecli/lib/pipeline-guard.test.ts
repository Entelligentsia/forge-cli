// Unit tests for lib/pipeline-guard.ts — FORGE-S26-T11
//
// Covers:
//   - parseGuardArgs: --force extraction, taskIdHint, cleanArgs
//   - runPipelineGuard: allowed states, blocked states, fail-open cases

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as spawnModule from "../../../../src/extensions/forgecli/lib/spawn-store-cli.js";
import {
	parseGuardArgs,
	runPipelineGuard,
	type PipelinePhase,
} from "../../../../src/extensions/forgecli/lib/pipeline-guard.js";

// ── parseGuardArgs ────────────────────────────────────────────────────────────

describe("parseGuardArgs", () => {
	it("empty args", () => {
		const r = parseGuardArgs("");
		expect(r.force).toBe(false);
		expect(r.taskIdHint).toBe("");
		expect(r.cleanArgs).toBe("");
	});

	it("task ID only", () => {
		const r = parseGuardArgs("FORGE-S26-T11");
		expect(r.force).toBe(false);
		expect(r.taskIdHint).toBe("FORGE-S26-T11");
		expect(r.cleanArgs).toBe("FORGE-S26-T11");
	});

	it("--force only", () => {
		const r = parseGuardArgs("--force");
		expect(r.force).toBe(true);
		expect(r.taskIdHint).toBe("");
		expect(r.cleanArgs).toBe("");
	});

	it("task ID + --force", () => {
		const r = parseGuardArgs("FORGE-S26-T11 --force");
		expect(r.force).toBe(true);
		expect(r.taskIdHint).toBe("FORGE-S26-T11");
		expect(r.cleanArgs).toBe("FORGE-S26-T11");
	});

	it("--force before task ID", () => {
		const r = parseGuardArgs("--force FORGE-S26-T11");
		expect(r.force).toBe(true);
		expect(r.taskIdHint).toBe("FORGE-S26-T11");
		expect(r.cleanArgs).toBe("FORGE-S26-T11");
	});

	it("extra flag tokens preserved in cleanArgs", () => {
		const r = parseGuardArgs("FORGE-S26-T11 --force @seed.md");
		expect(r.force).toBe(true);
		// cleanArgs has all non-force tokens
		expect(r.cleanArgs).toContain("FORGE-S26-T11");
		expect(r.cleanArgs).toContain("@seed.md");
		expect(r.cleanArgs).not.toContain("--force");
	});
});

// ── runPipelineGuard ──────────────────────────────────────────────────────────

describe("runPipelineGuard", () => {
	let readSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		readSpy = vi.spyOn(spawnModule, "spawnStoreCliRead");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("empty taskId → fail-open (allowed)", () => {
		const r = runPipelineGuard("plan", "", "/forge", "/cwd");
		expect(r.blocked).toBe(false);
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("store-cli lookup fails → fail-open (allowed)", () => {
		readSpy.mockReturnValue(null);
		const r = runPipelineGuard("plan", "FORGE-S26-T01", "/forge", "/cwd");
		expect(r.blocked).toBe(false);
	});

	it("no status field → fail-open (allowed)", () => {
		readSpy.mockReturnValue({ taskId: "FORGE-S26-T01" });
		const r = runPipelineGuard("plan", "FORGE-S26-T01", "/forge", "/cwd");
		expect(r.blocked).toBe(false);
	});

	// Allowed-state matrix
	const allowedCases: Array<[PipelinePhase, string]> = [
		["plan", "draft"],
		["plan", "planned"],
		["plan", "plan-revision-required"],
		["review-plan", "planned"],
		["implement", "plan-approved"],
		["review-code", "implemented"],
		["review-code", "implementing"],
		["validate", "implemented"],
		["validate", "review-approved"],
		["approve", "review-approved"],
		["commit", "approved"],
	];

	for (const [phase, status] of allowedCases) {
		it(`${phase} + status '${status}' → allowed`, () => {
			readSpy.mockReturnValue({ status });
			const r = runPipelineGuard(phase, "T01", "/forge", "/cwd");
			expect(r.blocked).toBe(false);
		});
	}

	// Blocked-state examples
	const blockedCases: Array<[PipelinePhase, string]> = [
		["plan", "approved"],
		["review-plan", "draft"],
		["implement", "planned"],
		["review-code", "plan-approved"],
		["validate", "planned"],
		["approve", "implemented"],
		["commit", "planned"],
	];

	for (const [phase, status] of blockedCases) {
		it(`${phase} + status '${status}' → blocked with AC#1 message`, () => {
			readSpy.mockReturnValue({ status });
			const r = runPipelineGuard(phase, "FORGE-S26-T01", "/forge", "/cwd");
			expect(r.blocked).toBe(true);
			expect(r.message).toContain("FORGE-S26-T01");
			expect(r.message).toContain(status);
			expect(r.message).toContain("must complete first");
			expect(r.message).toContain("/forge:run-task FORGE-S26-T01");
		});
	}

	it("error message follows AC #1 format", () => {
		readSpy.mockReturnValue({ status: "draft" });
		const r = runPipelineGuard("commit", "T11", "/forge", "/cwd");
		expect(r.blocked).toBe(true);
		// AC #1 format: × Task {ID} is in state '{state}' — ...
		expect(r.message).toMatch(/^× Task T11 is in state 'draft'/);
	});
});
