// Unit tests for reset-pipeline.ts (FEAT-009 — halt-recovery pipeline reset).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PHASE_PRE_STATUS } from "../../../../../src/extensions/forgecli/orchestrators/task/task-phases.js";
import {
	planReset,
	resetPipelineState,
	type SetStatusResult,
} from "../../../../../src/extensions/forgecli/orchestrators/task/reset-pipeline.js";

describe("planReset()", () => {
	it("maps each known phase to its index and documented pre-status", () => {
		const expected: Record<string, string> = {
			plan: "planned",
			"review-plan": "planned",
			implement: "plan-approved",
			"review-code": "implemented",
			validate: "review-approved",
			approve: "review-approved",
			writeback: "approved",
			commit: "approved",
		};
		for (const [role, preStatus] of Object.entries(expected)) {
			const plan = planReset(role);
			expect("error" in plan, `${role} should plan cleanly`).toBe(false);
			if ("error" in plan) continue;
			expect(plan.role).toBe(role);
			expect(plan.preStatus).toBe(preStatus);
			expect(plan.phaseIndex).toBeGreaterThanOrEqual(0);
		}
	});

	it("resolves implement to phaseIndex 2 (plan, review-plan, implement)", () => {
		const plan = planReset("implement");
		expect("error" in plan).toBe(false);
		if (!("error" in plan)) expect(plan.phaseIndex).toBe(2);
	});

	it("trims surrounding whitespace on the phase name", () => {
		const plan = planReset("  review-code  ");
		expect("error" in plan).toBe(false);
		if (!("error" in plan)) {
			expect(plan.role).toBe("review-code");
			expect(plan.preStatus).toBe("implemented");
		}
	});

	it("returns an error listing known phases for an unknown phase", () => {
		const plan = planReset("frobnicate");
		expect("error" in plan).toBe(true);
		if ("error" in plan) {
			expect(plan.error).toContain("frobnicate");
			expect(plan.error).toContain("implement");
		}
	});

	it("covers exactly the phases in PHASE_PRE_STATUS", () => {
		for (const role of Object.keys(PHASE_PRE_STATUS)) {
			expect("error" in planReset(role)).toBe(false);
		}
	});
});

describe("resetPipelineState()", () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reset-test-"));
		cwd = tmpDir;
		fs.mkdirSync(path.join(cwd, ".forge", "cache"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const stateFile = () =>
		path.join(cwd, ".forge", "cache", "run-task-state-FORGE-S32-T03.json");

	it("sets the pre-status then writes a non-halted resume state at the target phase", () => {
		const calls: string[] = [];
		const setStatus = (status: string): SetStatusResult => {
			calls.push(status);
			return { ok: true };
		};

		const result = resetPipelineState({
			cwd,
			taskId: "FORGE-S32-T03",
			toPhase: "implement",
			storeCli: "/unused",
			setStatus,
		});

		expect(result.ok).toBe(true);
		expect(result.phaseIndex).toBe(2);
		expect(result.preStatus).toBe("plan-approved");
		// status was forced to the implement pre-status
		expect(calls).toEqual(["plan-approved"]);
		// resume-state cache rewritten, non-halted, at the implement phase
		const state = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
		expect(state.phaseIndex).toBe(2);
		expect(state.halted).toBe(false);
		// status is left unset so the resume prompt derives the "interrupted" label
		expect(state.status).toBeUndefined();
		expect(state.taskId).toBe("FORGE-S32-T03");
	});

	it("does NOT write resume state when the status transition fails", () => {
		const setStatus = (): SetStatusResult => ({ ok: false, detail: "illegal transition" });

		const result = resetPipelineState({
			cwd,
			taskId: "FORGE-S32-T03",
			toPhase: "implement",
			storeCli: "/unused",
			setStatus,
		});

		expect(result.ok).toBe(false);
		expect(result.detail).toContain("illegal transition");
		// no half-rewound pipeline: the resume-state file must not exist
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("fails cleanly on an unknown phase without touching status or state", () => {
		let called = false;
		const setStatus = (): SetStatusResult => {
			called = true;
			return { ok: true };
		};

		const result = resetPipelineState({
			cwd,
			taskId: "FORGE-S32-T03",
			toPhase: "nope",
			storeCli: "/unused",
			setStatus,
		});

		expect(result.ok).toBe(false);
		expect(result.detail).toContain("Unknown phase");
		expect(called).toBe(false);
		expect(fs.existsSync(stateFile())).toBe(false);
	});
});
