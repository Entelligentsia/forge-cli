// bug-verdict-loop.test.ts — FEAT-009: the fix-bug revision-cap escalation must
// hand off to the halt-recovery advisor (and recovery menu), not emit a lone
// bare error notify. Mirrors the run-task twin asserted in run-task.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Mock the halt-recovery advisor so we can assert the hand-off without spawning
// a real advisor subagent (the advisor itself is covered by halt-advisor.test.ts).
vi.mock("../../../../../src/extensions/forgecli/orchestrators/halt-advisor.js", () => ({
	resolveAdvisorModel: vi.fn(() => undefined),
	runHaltAdvisor: vi.fn(() => Promise.resolve()),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { runHaltAdvisor } from "../../../../../src/extensions/forgecli/orchestrators/halt-advisor.js";
import { handleBugReviewVerdict } from "../../../../../src/extensions/forgecli/orchestrators/bug/bug-verdict-loop.js";
import { BUG_PHASES } from "../../../../../src/extensions/forgecli/orchestrators/bug/bug-phases.js";
import { BUG_SUMMARY_KEY_BY_ROLE } from "../../../../../src/extensions/forgecli/subagent/phase-summary-map.js";

describe("handleBugReviewVerdict — revision-cap escalation (FEAT-009)", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bug-verdict-loop-"));
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("invokes runHaltAdvisor on revision-cap instead of a bare notify", async () => {
		const bugId = "FORGE-BUG-099";
		// review-code review phase, cap = 3. Store returns a revision verdict.
		const reviewCode = BUG_PHASES.find((p) => p.role === "review-code")!;
		vi.mocked(spawnSync).mockImplementation((_cmd: unknown, args?: readonly string[]) => {
			const a = args as string[] | undefined;
			if (a && String(a[0]).includes("store-cli") && a[1] === "read" && a[2] === "bug") {
				return {
					status: 0,
					stdout: JSON.stringify({ bugId, summaries: { code_review: { verdict: "revision" } } }),
					stderr: "",
				} as never;
			}
			return { status: 0, stdout: "", stderr: "" } as never;
		});

		const notifications: { msg: string; level?: string }[] = [];
		const ctx = {
			model: { provider: "anthropic", model: "claude-opus-4-8" },
			ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level }) },
		};

		// Already at cap-1 so this revision increments to the cap (3/3) and escalates.
		const outcome = await handleBugReviewVerdict({
			phase: reviewCode,
			bugId,
			storeCli: "/fake/store-cli.cjs",
			cwd,
			forgeRoot: cwd,
			iterationCounts: { "review-code": 2 },
			currentPhaseIndex: BUG_PHASES.indexOf(reviewCode),
			modelRoutingConfig: {} as never,
			ctx: ctx as never,
			orchTranscript: { record: () => {} } as never,
			summaryKeyByRole: BUG_SUMMARY_KEY_BY_ROLE,
			finishPhaseNode: vi.fn(),
			recoveredPhases: new Set<string>(),
		});

		expect(outcome.kind).toBe("return");
		expect(runHaltAdvisor).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runHaltAdvisor).mock.calls[0]![0];
		expect(opts.gateFailure.phase).toBe("review-code");
		expect(opts.gateFailure.reasonCode).toBe("revision-cap-reached");
		expect(opts.taskId).toBe(bugId);
		// The bare error notify is still emitted alongside the advisory hand-off.
		expect(notifications.some((n) => n.level === "error" && n.msg.includes("revision cap reached"))).toBe(true);
	});
});
