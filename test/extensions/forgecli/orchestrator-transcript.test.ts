// Unit test for OrchestratorTranscriptWriter — FORGE-BUG-040 follow-up.
//
// The orchestrator transcript is a JSONL file capturing pipeline-start,
// per-phase boundary events, loopbacks, notifies, and pipeline-end. One
// file per pipeline run, ISO-prefixed in its filename so concurrent or
// repeated runs of the same entity preserve their own logs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OrchestratorTranscriptWriter } from "../../../src/extensions/forgecli/subagent/orchestrator-transcript.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-orch-transcript-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function readLines(filePath: string): unknown[] {
	const raw = fs.readFileSync(filePath, "utf-8");
	return raw
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

describe("OrchestratorTranscriptWriter", () => {
	it("writes an ISO-prefixed JSONL file under transcripts/<entityId>/ on construction", () => {
		const startedAt = new Date("2026-05-28T13:35:00Z");
		const writer = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "bug",
			entityId: "FORGE-BUG-040",
			startedAt,
		});
		expect(fs.existsSync(writer.filePath)).toBe(true);
		expect(path.basename(writer.filePath)).toBe(
			"20260528T133500Z__FORGE-BUG-040__orchestrator.jsonl",
		);
		expect(path.basename(path.dirname(writer.filePath))).toBe("FORGE-BUG-040");
	});

	it("emits a pipeline-start event in the first line", () => {
		const writer = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "bug",
			entityId: "FORGE-BUG-040",
		});
		const lines = readLines(writer.filePath);
		expect(lines).toHaveLength(1);
		const first = lines[0] as { kind: string; entityKind: string; entityId: string };
		expect(first.kind).toBe("pipeline-start");
		expect(first.entityKind).toBe("bug");
		expect(first.entityId).toBe("FORGE-BUG-040");
	});

	it("appends events across the pipeline as JSONL lines", () => {
		const writer = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "task",
			entityId: "FORGE-S26-T05",
		});
		writer.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: "plan",
			phaseIndex: 0,
			phaseCount: 7,
			attempt: 1,
			workflowFile: "plan_task",
			persona: "engineer",
		});
		writer.record({
			kind: "notify",
			ts: new Date().toISOString(),
			level: "info",
			message: "→ plan starting",
		});
		writer.record({
			kind: "phase-end",
			ts: new Date().toISOString(),
			phase: "plan",
			phaseIndex: 0,
			attempt: 1,
			verdict: "n/a",
			elapsedMs: 12345,
			turns: 5,
			toolCount: 17,
			errCount: 0,
		});
		writer.close("complete");

		const lines = readLines(writer.filePath);
		// pipeline-start + 3 records + pipeline-end = 5
		expect(lines).toHaveLength(5);
		expect((lines[0] as { kind: string }).kind).toBe("pipeline-start");
		expect((lines[1] as { kind: string }).kind).toBe("phase-start");
		expect((lines[2] as { kind: string }).kind).toBe("notify");
		expect((lines[3] as { kind: string }).kind).toBe("phase-end");
		const last = lines[4] as { kind: string; outcome: string };
		expect(last.kind).toBe("pipeline-end");
		expect(last.outcome).toBe("complete");
	});

	it("records phase-loopback events for review revision loops", () => {
		const writer = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "bug",
			entityId: "FORGE-BUG-100",
		});
		writer.record({
			kind: "phase-loopback",
			ts: new Date().toISOString(),
			fromPhase: "review-plan",
			toPhase: "plan-fix",
			fromPhaseIndex: 2,
			toPhaseIndex: 1,
			reason: "review-plan returned revision (attempt 1/3)",
		});

		const lines = readLines(writer.filePath);
		expect(lines).toHaveLength(2);
		const loopback = lines[1] as { kind: string; fromPhase: string; toPhase: string };
		expect(loopback.kind).toBe("phase-loopback");
		expect(loopback.fromPhase).toBe("review-plan");
		expect(loopback.toPhase).toBe("plan-fix");
	});

	it("close() is idempotent — calling twice emits only one pipeline-end", () => {
		const writer = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "task",
			entityId: "FORGE-S26-T05",
		});
		writer.close("complete");
		writer.close("error", "should be ignored");
		writer.record({
			kind: "notify",
			ts: new Date().toISOString(),
			level: "info",
			message: "this should also be ignored",
		});

		const lines = readLines(writer.filePath);
		// pipeline-start + one pipeline-end only
		expect(lines).toHaveLength(2);
		expect((lines[1] as { kind: string; outcome: string }).outcome).toBe("complete");
	});

	it("sanitises entityId for the filename", () => {
		const writer = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "bug",
			entityId: "../bad/id",
		});
		const fname = path.basename(writer.filePath);
		expect(fname).not.toMatch(/\//);
		expect(fname).not.toMatch(/\.\./);
		expect(fname).toMatch(/__orchestrator\.jsonl$/);
	});

	it("two concurrent writers on the same entityId at different start times do not collide", () => {
		const w1 = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "bug",
			entityId: "FORGE-BUG-040",
			startedAt: new Date("2026-05-28T08:00:00Z"),
		});
		const w2 = new OrchestratorTranscriptWriter({
			cwd: tmpRoot,
			entityKind: "bug",
			entityId: "FORGE-BUG-040",
			startedAt: new Date("2026-05-28T09:00:00Z"),
		});
		expect(w1.filePath).not.toBe(w2.filePath);
		expect(fs.existsSync(w1.filePath)).toBe(true);
		expect(fs.existsSync(w2.filePath)).toBe(true);
		expect(path.dirname(w1.filePath)).toBe(path.dirname(w2.filePath));
	});
});
