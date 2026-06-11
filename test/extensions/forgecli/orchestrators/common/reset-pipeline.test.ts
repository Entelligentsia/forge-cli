// Unit tests for reset-pipeline.ts (FEAT-009 — halt-recovery pipeline reset).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUG_PHASE_PRE_STATUS } from "../../../../../src/extensions/forgecli/orchestrators/bug/bug-phases.js";
import { PHASE_PRE_STATUS } from "../../../../../src/extensions/forgecli/orchestrators/task/task-phases.js";
import {
	planReset,
	resetPipelineState,
	type SetStatusResult,
} from "../../../../../src/extensions/forgecli/orchestrators/common/reset-pipeline.js";

describe("planReset() — task", () => {
	it("maps each known task phase to its index and documented pre-status", () => {
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
			const plan = planReset("task", role);
			expect("error" in plan, `${role} should plan cleanly`).toBe(false);
			if ("error" in plan) continue;
			expect(plan.role).toBe(role);
			expect(plan.preStatus).toBe(preStatus);
			expect(plan.phaseIndex).toBeGreaterThanOrEqual(0);
		}
	});

	it("resolves implement to phaseIndex 2 (plan, review-plan, implement)", () => {
		const plan = planReset("task", "implement");
		expect("error" in plan).toBe(false);
		if (!("error" in plan)) expect(plan.phaseIndex).toBe(2);
	});

	it("trims surrounding whitespace on the phase name", () => {
		const plan = planReset("task", "  review-code  ");
		expect("error" in plan).toBe(false);
		if (!("error" in plan)) {
			expect(plan.role).toBe("review-code");
			expect(plan.preStatus).toBe("implemented");
		}
	});

	it("returns an error listing known phases for an unknown phase", () => {
		const plan = planReset("task", "frobnicate");
		expect("error" in plan).toBe(true);
		if ("error" in plan) {
			expect(plan.error).toContain("frobnicate");
			expect(plan.error).toContain("implement");
		}
	});

	it("covers exactly the phases in PHASE_PRE_STATUS", () => {
		for (const role of Object.keys(PHASE_PRE_STATUS)) {
			expect("error" in planReset("task", role)).toBe(false);
		}
	});
});

describe("planReset() — bug", () => {
	it("maps triage to reported and every post-triage phase to in-progress", () => {
		expect((planReset("bug", "triage") as { preStatus: string }).preStatus).toBe("reported");
		for (const role of ["plan-fix", "review-plan", "implement", "review-code", "approve", "commit"]) {
			const plan = planReset("bug", role);
			expect("error" in plan, `${role} should plan cleanly`).toBe(false);
			if (!("error" in plan)) expect(plan.preStatus).toBe("in-progress");
		}
	});

	it("resolves triage to phaseIndex 0 and covers every bug phase", () => {
		expect((planReset("bug", "triage") as { phaseIndex: number }).phaseIndex).toBe(0);
		for (const role of Object.keys(BUG_PHASE_PRE_STATUS)) {
			expect("error" in planReset("bug", role)).toBe(false);
		}
	});

	it("rejects a task-only phase (validate) for a bug", () => {
		const plan = planReset("bug", "validate");
		expect("error" in plan).toBe(true);
		if ("error" in plan) expect(plan.error).toContain("bug phase");
	});
});

describe("resetPipelineState() — task", () => {
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
			kind: "task",
			cwd,
			id: "FORGE-S32-T03",
			toPhase: "implement",
			storeCli: "/unused",
			setStatus,
		});

		expect(result.ok).toBe(true);
		expect(result.phaseIndex).toBe(2);
		expect(result.preStatus).toBe("plan-approved");
		expect(calls).toEqual(["plan-approved"]);
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
			kind: "task",
			cwd,
			id: "FORGE-S32-T03",
			toPhase: "implement",
			storeCli: "/unused",
			setStatus,
		});

		expect(result.ok).toBe(false);
		expect(result.detail).toContain("illegal transition");
		expect(fs.existsSync(stateFile())).toBe(false);
	});

	it("fails cleanly on an unknown phase without touching status or state", () => {
		let called = false;
		const setStatus = (): SetStatusResult => {
			called = true;
			return { ok: true };
		};

		const result = resetPipelineState({
			kind: "task",
			cwd,
			id: "FORGE-S32-T03",
			toPhase: "nope",
			storeCli: "/unused",
			setStatus,
		});

		expect(result.ok).toBe(false);
		expect(result.detail).toContain("Unknown task phase");
		expect(called).toBe(false);
		expect(fs.existsSync(stateFile())).toBe(false);
	});
});

describe("resetPipelineState() — bug", () => {
	let tmpDir: string;
	let cwd: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-reset-bug-test-"));
		cwd = tmpDir;
		fs.mkdirSync(path.join(cwd, ".forge", "cache"), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	const cacheDir = () => path.join(cwd, ".forge", "cache");
	const bugStateFiles = () =>
		fs.readdirSync(cacheDir()).filter((f) => f.startsWith("fix-bug-state-FORGE-BUG-099-"));

	it("forces in-progress and writes exactly one fresh bug resume state at the target phase", () => {
		// Seed a stale state file from a different 'session' to prove it's cleared.
		fs.writeFileSync(
			path.join(cacheDir(), "fix-bug-state-FORGE-BUG-099-oldsession.json"),
			JSON.stringify({ bugId: "FORGE-BUG-099", phaseIndex: 5, halted: true, savedAt: "2026-01-01T00:00:00Z" }),
			"utf8",
		);

		const calls: string[] = [];
		const result = resetPipelineState({
			kind: "bug",
			cwd,
			id: "FORGE-BUG-099",
			toPhase: "implement",
			storeCli: "/unused",
			setStatus: (status) => {
				calls.push(status);
				return { ok: true };
			},
		});

		expect(result.ok).toBe(true);
		expect(result.preStatus).toBe("in-progress");
		expect(calls).toEqual(["in-progress"]);
		// the stale file was deleted and exactly one fresh state written
		const files = bugStateFiles();
		expect(files.length).toBe(1);
		const state = JSON.parse(fs.readFileSync(path.join(cacheDir(), files[0]), "utf8"));
		expect(state.bugId).toBe("FORGE-BUG-099");
		expect(state.halted).toBe(false);
		// implement is phaseIndex 3 in the bug pipeline (triage, plan-fix, review-plan, implement)
		expect(state.phaseIndex).toBe(3);
	});

	it("resets to triage with status reported", () => {
		const calls: string[] = [];
		const result = resetPipelineState({
			kind: "bug",
			cwd,
			id: "FORGE-BUG-099",
			toPhase: "triage",
			storeCli: "/unused",
			setStatus: (status) => {
				calls.push(status);
				return { ok: true };
			},
		});
		expect(result.ok).toBe(true);
		expect(result.phaseIndex).toBe(0);
		expect(calls).toEqual(["reported"]);
	});
});
