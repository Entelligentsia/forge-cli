// Unit tests for recovery-menu.ts (FEAT-009 — interactive halt recovery).

import { describe, expect, it, vi } from "vitest";

import {
	offerRecoveryMenu,
	phaseRolesFor,
} from "../../../../../src/extensions/forgecli/orchestrators/common/recovery-menu.js";

describe("phaseRolesFor()", () => {
	it("returns the task pipeline roles in order", () => {
		expect(phaseRolesFor("task")).toEqual([
			"plan",
			"review-plan",
			"implement",
			"review-code",
			"validate",
			"approve",
			"writeback",
			"commit",
		]);
	});

	it("returns the bug pipeline roles in order", () => {
		expect(phaseRolesFor("bug")).toEqual([
			"triage",
			"plan-fix",
			"review-plan",
			"implement",
			"review-code",
			"approve",
			"commit",
		]);
	});
});

describe("offerRecoveryMenu()", () => {
	it("is a no-op in non-interactive mode (no prompts)", async () => {
		const select = vi.fn();
		const notify = vi.fn();
		const result = await offerRecoveryMenu({
			ui: { select, notify },
			kind: "task",
			id: "FORGE-S32-T03",
			cwd: "/x",
			storeCli: "/x/.forge/tools/store-cli.cjs",
			interactive: false,
		});
		expect(result).toBeUndefined();
		expect(select).not.toHaveBeenCalled();
	});

	it("resets to the chosen phase and notifies the resume command", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce("Reset to a phase and resume later")
			.mockResolvedValueOnce("implement");
		const notify = vi.fn();
		const reset = vi.fn().mockReturnValue({
			ok: true,
			role: "implement",
			phaseIndex: 2,
			preStatus: "plan-approved",
		});

		const result = await offerRecoveryMenu({
			ui: { select, notify },
			kind: "task",
			id: "FORGE-S32-T03",
			cwd: "/x",
			storeCli: "/x/.forge/tools/store-cli.cjs",
			interactive: true,
			reset,
		});

		expect(result?.ok).toBe(true);
		expect(reset).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "task", id: "FORGE-S32-T03", toPhase: "implement" }),
		);
		// second select offered the task phase list
		expect(select.mock.calls[1][1]).toContain("implement");
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("/forge:run-task FORGE-S32-T03"),
			"info",
		);
	});

	it("offers bug phases and the fix-bug resume hint for bugs", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce("Reset to a phase and resume later")
			.mockResolvedValueOnce("triage");
		const notify = vi.fn();
		const reset = vi.fn().mockReturnValue({ ok: true, role: "triage", phaseIndex: 0, preStatus: "reported" });

		await offerRecoveryMenu({
			ui: { select, notify },
			kind: "bug",
			id: "FORGE-BUG-046",
			cwd: "/x",
			storeCli: "/x/.forge/tools/store-cli.cjs",
			interactive: true,
			reset,
		});

		expect(select.mock.calls[1][1]).toEqual(phaseRolesFor("bug"));
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("/forge:fix-bug FORGE-BUG-046"),
			"info",
		);
	});

	it("does nothing when the operator declines (chooses abort)", async () => {
		const select = vi.fn().mockResolvedValueOnce("Leave it halted");
		const notify = vi.fn();
		const reset = vi.fn();
		const result = await offerRecoveryMenu({
			ui: { select, notify },
			kind: "task",
			id: "T1",
			cwd: "/x",
			storeCli: "/x/store-cli.cjs",
			interactive: true,
			reset,
		});
		expect(result).toBeUndefined();
		expect(reset).not.toHaveBeenCalled();
	});

	it("warns but does not throw when a reset fails", async () => {
		const select = vi
			.fn()
			.mockResolvedValueOnce("Reset to a phase and resume later")
			.mockResolvedValueOnce("implement");
		const notify = vi.fn();
		const reset = vi.fn().mockReturnValue({ ok: false, detail: "illegal transition" });

		const result = await offerRecoveryMenu({
			ui: { select, notify },
			kind: "task",
			id: "T1",
			cwd: "/x",
			storeCli: "/x/store-cli.cjs",
			interactive: true,
			reset,
		});
		expect(result?.ok).toBe(false);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("illegal transition"), "warning");
	});
});
