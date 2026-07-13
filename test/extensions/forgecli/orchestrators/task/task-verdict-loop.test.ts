// task-verdict-loop.test.ts — defensive hardening for the run-task review-code
// verdict loop. After the WI-S48-T01 systemic halt (review-code subagent wrote
// its "approved" summary to the orphan `review-impl-summary` sidecar while
// `set-summary code_review` re-ingested the STALE `review-code-summary` sidecar
// → store verdict stayed "revision" from round 1 → orchestrator burned the
// revision cap and halted), the loop must NOT silently trust a stored verdict
// whose `written_at` predates the current phase dispatch.
//
// Guard: when verdict === "revision" and phaseStartMs is supplied, if the
// stored summary's written_at predates phaseStartMs the subagent did not
// refresh the store this round. Attempt the existing recoverPhaseSummary
// (re-ingest the canonical on-disk sidecar) once, then re-read:
//   - if the verdict is now "approved" (or written_at is now fresh) → route on
//     the fresh verdict (self-heal);
//   - if the summary is STILL stale (canonical sidecar itself was not updated
//     — the wrong-artifact-kind class) → halt with a sharpened advisory naming
//     the divergence instead of silently burning the revision cap.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../../src/extensions/forgecli/orchestrators/halt-advisor.js", () => ({
	resolveAdvisorModel: vi.fn(() => undefined),
	runHaltAdvisor: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../../../src/extensions/forgecli/orchestrators/common/recovery-menu.js", () => ({
	offerRecoveryMenu: vi.fn(() => Promise.resolve()),
}));

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import { runHaltAdvisor } from "../../../../../src/extensions/forgecli/orchestrators/halt-advisor.js";
import { PHASES } from "../../../../../src/extensions/forgecli/orchestrators/task/task-phases.js";
import { handleReviewVerdict } from "../../../../../src/extensions/forgecli/orchestrators/task/task-verdict-loop.js";

const reviewCode = PHASES.find((p) => p.role === "review-code")!;
const reviewCodeIndex = PHASES.indexOf(reviewCode);

const PHASE_START = Date.parse("2026-07-13T13:33:38.000Z"); // this run's dispatch
const STALE_WRITTEN = "2026-07-13T11:15:00.000Z"; // round 1, predates this run
const FRESH_WRITTEN = "2026-07-13T13:38:39.000Z"; // during this run, after dispatch

function makeCtx() {
	const notifications: { msg: string; level?: string }[] = [];
	return {
		notifications,
		ctx: {
			model: { provider: "anthropic", model: "claude-opus-4-8" },
			ui: { notify: (msg: string, level?: string) => notifications.push({ msg, level }) },
		} as never,
	};
}

/** Build a spawnSync mock whose `read task` results evolve via a queue, and
 *  whose `set-summary` calls return the given status sequence. */
function mockEvolvingReads(reads: { verdict: string; writtenAt: string }[], setSummaryStatuses: number[]) {
	let readIdx = 0;
	let setIdx = 0;
	vi.mocked(spawnSync).mockImplementation((_cmd: unknown, args?: readonly string[]) => {
		const a = args as string[] | undefined;
		if (a && a[1] === "read" && a[2] === "task") {
			const r = reads[Math.min(readIdx, reads.length - 1)]!;
			readIdx++;
			return {
				status: 0,
				stdout: JSON.stringify({
					taskId: "WI-S48-T01",
					summaries: { code_review: { verdict: r.verdict, written_at: r.writtenAt } },
				}),
				stderr: "",
			} as never;
		}
		if (a && a[1] === "set-summary") {
			const status = setSummaryStatuses[Math.min(setIdx, setSummaryStatuses.length - 1)] ?? 0;
			setIdx++;
			return { status, stdout: "", stderr: "" } as never;
		}
		return { status: 0, stdout: "", stderr: "" } as never;
	});
}

function baseParams(cwd: string, overrides: Record<string, unknown> = {}) {
	const { ctx, notifications } = makeCtx();
	return {
		_args: { ctx, notifications },
		params: {
			phase: reviewCode,
			taskId: "WI-S48-T01",
			storeCli: "/fake/store-cli.cjs",
			cwd,
			forgeRoot: cwd,
			iterationCounts: {} as Record<string, number>,
			currentPhaseIndex: reviewCodeIndex,
			modelRoutingConfig: {} as never,
			ctx,
			orchTranscript: { record: () => {} } as never,
			finishPhaseNode: vi.fn(),
			recoveredPhases: new Set<string>(),
			phaseStartMs: PHASE_START,
			...overrides,
		} as never,
	};
}

describe("handleReviewVerdict — stale-summary divergence guard", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-verdict-loop-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("self-heals when a stale stored 'revision' is re-ingested as 'approved' (sidecar fresh, set-summary was skipped)", async () => {
		// read #1 (top readVerdict): stale revision. read #2 (meta): stale revision.
		// set-summary exit 0. read #3 (re-check): approved + fresh written_at.
		mockEvolvingReads(
			[
				{ verdict: "revision", writtenAt: STALE_WRITTEN },
				{ verdict: "revision", writtenAt: STALE_WRITTEN },
				{ verdict: "approved", writtenAt: FRESH_WRITTEN },
			],
			[0],
		);
		const { params, _args } = baseParams(cwd);
		const outcome = await handleReviewVerdict(params);
		expect(outcome.kind).toBe("advance");
		// Recovery actually ran (set-summary was invoked once).
		const setSummaryCalls = vi
			.mocked(spawnSync)
			.mock.calls.filter((c) => (c[1] as string[] | undefined)?.[1] === "set-summary");
		expect(setSummaryCalls).toHaveLength(1);
		expect(_args.notifications.some((n) => /stale/i.test(n.msg) && n.level === "info")).toBe(true);
	});

	it("halts with a stale-summary advisory (not a bare revision-cap) when the canonical sidecar itself is stale (WI-S48 wrong-artifact class)", async () => {
		// Stored 'revision' written_at predates phaseStart; set-summary re-ingests
		// the SAME stale canonical sidecar → re-read still revision + stale.
		// iterationCounts already 2 → this revision hits the cap (3/3).
		mockEvolvingReads(
			[
				{ verdict: "revision", writtenAt: STALE_WRITTEN },
				{ verdict: "revision", writtenAt: STALE_WRITTEN },
				{ verdict: "revision", writtenAt: STALE_WRITTEN },
			],
			[0],
		);
		const { params, _args } = baseParams(cwd, { iterationCounts: { "review-code": 2 } });
		const outcome = await handleReviewVerdict(params);
		expect(outcome.kind).toBe("return");
		expect(runHaltAdvisor).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runHaltAdvisor).mock.calls[0]![0];
		expect(opts.gateFailure.reasonCode).toBe("stale-summary-revision-cap");
		expect(opts.gateFailure.detail).toMatch(/was not refreshed/i);
		expect(_args.notifications.some((n) => n.level === "error" && /stale/i.test(n.msg))).toBe(true);
	});

	it("does NOT attempt recovery for a fresh 'revision' (reviewer genuinely wants changes) → normal loopback", async () => {
		mockEvolvingReads(
			[
				{ verdict: "revision", writtenAt: FRESH_WRITTEN },
				{ verdict: "revision", writtenAt: FRESH_WRITTEN },
			],
			[0],
		);
		const { params } = baseParams(cwd, { iterationCounts: {} });
		const outcome = await handleReviewVerdict(params);
		expect(outcome.kind).toBe("loopback");
		const setSummaryCalls = vi
			.mocked(spawnSync)
			.mock.calls.filter((c) => (c[1] as string[] | undefined)?.[1] === "set-summary");
		expect(setSummaryCalls).toHaveLength(0);
	});

	it("backward-compat: without phaseStartMs, a cap-hit revision escalates with the legacy reasonCode (no stale check)", async () => {
		mockEvolvingReads(
			[
				{ verdict: "revision", writtenAt: STALE_WRITTEN },
				{ verdict: "revision", writtenAt: STALE_WRITTEN },
			],
			[0],
		);
		const { params } = baseParams(cwd, { iterationCounts: { "review-code": 2 }, phaseStartMs: undefined });
		const outcome = await handleReviewVerdict(params);
		expect(outcome.kind).toBe("return");
		expect(runHaltAdvisor).toHaveBeenCalledTimes(1);
		const opts = vi.mocked(runHaltAdvisor).mock.calls[0]![0];
		expect(opts.gateFailure.reasonCode).toBe("revision-cap-reached");
	});
});
