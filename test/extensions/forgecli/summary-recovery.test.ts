// summary-recovery.test.ts — unit tests for recoverPhaseSummary, the
// deterministic phase-completion recovery used by the run-task / fix-bug
// orchestrators (forge-engineering#41). When a phase's subagent stops cleanly
// but never registered its {PHASE}-SUMMARY.json sidecar in the store, the
// orchestrator registers it via store-cli set-summary (sidecar auto-resolved
// from record.path) and re-checks the gate, instead of hard-failing.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";

import { recoverPhaseSummary } from "../../../src/extensions/forgecli/orchestrators/common/summary-recovery.js";

beforeEach(() => vi.mocked(spawnSync).mockClear());

function mockExit(status: number, stderr = "") {
	vi.mocked(spawnSync).mockReturnValue({
		status,
		stdout: Buffer.from(""),
		stderr: Buffer.from(stderr),
	} as unknown as ReturnType<typeof spawnSync>);
}

describe("recoverPhaseSummary", () => {
	it("invokes store-cli set-summary with [storeCli, verb, entityId, summaryKey] via argv array (IL6)", () => {
		mockExit(0);
		recoverPhaseSummary({ storeCli: "/p/store-cli.cjs", entityId: "FORGE-S01-T01", summaryKey: "plan", cwd: "/proj" });
		expect(spawnSync).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = vi.mocked(spawnSync).mock.calls[0]!;
		expect(cmd).toBe("node");
		expect(args).toEqual(["/p/store-cli.cjs", "set-summary", "FORGE-S01-T01", "plan"]);
		expect((opts as { cwd?: string }).cwd).toBe("/proj");
	});

	it("returns ok=true on exit 0 (sidecar present + valid)", () => {
		mockExit(0);
		const r = recoverPhaseSummary({ storeCli: "s", entityId: "T", summaryKey: "validation", cwd: "/p" });
		expect(r).toEqual({ attempted: true, ok: true, stderr: "" });
	});

	it("returns ok=false on non-zero exit (no sidecar to resolve / invalid)", () => {
		mockExit(1, "no PLAN-SUMMARY.json found");
		const r = recoverPhaseSummary({ storeCli: "s", entityId: "T", summaryKey: "plan", cwd: "/p" });
		expect(r.attempted).toBe(true);
		expect(r.ok).toBe(false);
		expect(r.stderr).toContain("no PLAN-SUMMARY.json");
	});

	it("uses set-bug-summary when summaryVerb is set for the bug pipeline", () => {
		mockExit(0);
		recoverPhaseSummary({
			storeCli: "s",
			entityId: "FORGE-BUG-001",
			summaryKey: "code_review",
			cwd: "/p",
			summaryVerb: "set-bug-summary",
		});
		const [, args] = vi.mocked(spawnSync).mock.calls[0]!;
		expect((args as string[])[1]).toBe("set-bug-summary");
	});
});
