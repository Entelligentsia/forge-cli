// OrchestratorTranscriptWriter close semantics — every pipeline outcome must
// terminate the JSONL with exactly ONE pipeline-end (the archive derives the
// run outcome from it; runs without one surface as "incomplete").

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

function readEvents(filePath: string): Array<{ kind: string; outcome?: string }> {
	return fs
		.readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as { kind: string; outcome?: string });
}

describe("OrchestratorTranscriptWriter close semantics", () => {
	it("close() after a directly-recorded pipeline-end is a no-op (single line)", () => {
		const w = new OrchestratorTranscriptWriter({ cwd: tmpRoot, entityKind: "task", entityId: "T-1" });
		w.record({ kind: "pipeline-end", ts: new Date().toISOString(), outcome: "complete", elapsedMs: 10 });
		w.close("error", "should not be written");

		const ends = readEvents(w.filePath).filter((e) => e.kind === "pipeline-end");
		expect(ends).toHaveLength(1);
		expect(ends[0].outcome).toBe("complete");
	});

	it("safety-net close() records the outcome for paths that never did (cancel bug)", () => {
		const w = new OrchestratorTranscriptWriter({ cwd: tmpRoot, entityKind: "bug", entityId: "B-1" });
		w.record({
			kind: "phase-start",
			ts: new Date().toISOString(),
			phase: "triage",
			phaseIndex: 0,
			phaseCount: 7,
			attempt: 1,
			workflowFile: "fix_bug.md",
			persona: "bug-fixer",
		});
		// Simulates the wrapper's guaranteed close after a cancel return.
		w.close("cancelled");

		const ends = readEvents(w.filePath).filter((e) => e.kind === "pipeline-end");
		expect(ends).toHaveLength(1);
		expect(ends[0].outcome).toBe("cancelled");
	});

	it("double close() stays single", () => {
		const w = new OrchestratorTranscriptWriter({ cwd: tmpRoot, entityKind: "task", entityId: "T-2" });
		w.close("halted");
		w.close("error");
		const ends = readEvents(w.filePath).filter((e) => e.kind === "pipeline-end");
		expect(ends).toHaveLength(1);
		expect(ends[0].outcome).toBe("halted");
	});
});
