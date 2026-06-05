// Tail-log persistence tests — the producer side of verbatim transcript
// replay: attachViewportObserver records every rendered tail line in
// state.tailLog; persistTailLog writes it next to the phase transcript.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionRegistry } from "../../../src/extensions/forgecli/session-registry.js";
import {
	attachViewportObserver,
	persistTailLog,
	TAIL_LOG_CAP,
} from "../../../src/extensions/forgecli/viewport/events.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-tail-log-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function buildObserver() {
	const registry = getSessionRegistry();
	registry.startSession("TAIL-TEST-1");
	return attachViewportObserver({
		registry,
		sessionId: "TAIL-TEST-1",
		phaseRole: "triage",
	});
}

describe("observer tailLog recording", () => {
	it("records the exact rendered lines, in order, with warning flags", () => {
		const observer = buildObserver();
		observer.onEvent({ type: "turn_start" });
		observer.onEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
		observer.onEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: "boom", isError: true });

		const lines = observer.state.tailLog;
		expect(lines.length).toBeGreaterThanOrEqual(2);
		// First rendered line is the turn-bracketed tool start with args.
		expect(lines[0].line).toContain("bash");
		expect(lines[0].line).toContain("╭");
		// The error line carries the warning flag — same as the live view.
		const warn = lines.find((l) => l.warning);
		expect(warn?.line).toContain("bash failed");
	});
});

describe("persistTailLog", () => {
	it("writes <transcript-base>.tail.jsonl next to the phase transcript", () => {
		const transcriptPath = path.join(tmpRoot, "20260601T100001Z__X__triage.json");
		const out = persistTailLog(transcriptPath, [{ line: "╭ [T1] $ bash" }, { line: "⚠ failed", warning: true }]);
		expect(out).toBe(path.join(tmpRoot, "20260601T100001Z__X__triage.tail.jsonl"));
		const lines = fs
			.readFileSync(out!, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { line: string; warning?: boolean });
		expect(lines).toEqual([{ line: "╭ [T1] $ bash" }, { line: "⚠ failed", warning: true }]);
	});

	it("is a no-op for empty logs and non-.json paths; never throws", () => {
		expect(persistTailLog(path.join(tmpRoot, "x.json"), [])).toBeNull();
		expect(persistTailLog(path.join(tmpRoot, "x.txt"), [{ line: "a" }])).toBeNull();
		// Unwritable directory → null, not a throw
		expect(persistTailLog(path.join(tmpRoot, "missing-dir", "x.json"), [{ line: "a" }])).toBeNull();
	});

	it("TAIL_LOG_CAP is head-preserving with a single truncation marker", () => {
		const observer = buildObserver();
		// Drive enough tool-start events to blow past the cap.
		observer.onEvent({ type: "turn_start" });
		for (let i = 0; i < TAIL_LOG_CAP + 50; i++) {
			observer.onEvent({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "read", args: {} });
		}
		const lines = observer.state.tailLog;
		expect(lines.length).toBe(TAIL_LOG_CAP + 1);
		expect(lines[lines.length - 1].line).toContain("capped");
		expect(lines[0].line).toContain("read"); // head intact
	});
});
