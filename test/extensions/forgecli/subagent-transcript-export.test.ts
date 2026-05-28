// Unit test for writeSubagentTranscript and formatTranscriptTimestamp.
//
// FORGE-BUG-040 follow-up: filenames are now ISO-timestamp-prefixed so
// successive runs of the same phase (review-loop iterations) preserve
// their own transcripts instead of overwriting.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	computeTranscriptPath,
	formatTranscriptTimestamp,
	writeSubagentTranscript,
} from "../../../src/extensions/forgecli/forge-subagent.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-transcript-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const emptyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

describe("formatTranscriptTimestamp", () => {
	it("produces a compact UTC string with no dashes, colons, or fractional seconds", () => {
		const d = new Date("2026-05-28T13:35:00.123Z");
		expect(formatTranscriptTimestamp(d)).toBe("20260528T133500Z");
	});

	it("lexicographic sort matches chronological order", () => {
		const stamps = [
			formatTranscriptTimestamp(new Date("2026-05-28T13:35:00Z")),
			formatTranscriptTimestamp(new Date("2026-05-28T08:00:00Z")),
			formatTranscriptTimestamp(new Date("2026-05-29T00:00:00Z")),
		];
		const sorted = [...stamps].sort();
		expect(sorted).toEqual([
			"20260528T080000Z",
			"20260528T133500Z",
			"20260529T000000Z",
		]);
	});
});

describe("computeTranscriptPath", () => {
	it("prefixes the filename with the ISO-compact timestamp", () => {
		const startedAt = new Date("2026-05-28T08:00:00Z");
		const p = computeTranscriptPath(tmpRoot, "engineer", "HLO-S01-T01__plan", startedAt);
		const fname = path.basename(p);
		expect(fname).toBe("20260528T080000Z__HLO-S01-T01__plan.json");
		expect(path.basename(path.dirname(p))).toBe("HLO-S01-T01");
	});

	it("two runs of the same phase at different times produce distinct paths", () => {
		const p1 = computeTranscriptPath(
			tmpRoot,
			"engineer",
			"FORGE-BUG-040__plan-fix",
			new Date("2026-05-28T08:00:00Z"),
		);
		const p2 = computeTranscriptPath(
			tmpRoot,
			"engineer",
			"FORGE-BUG-040__plan-fix",
			new Date("2026-05-28T09:00:00Z"),
		);
		expect(p1).not.toBe(p2);
		expect(path.basename(p1).startsWith("20260528T080000Z__")).toBe(true);
		expect(path.basename(p2).startsWith("20260528T090000Z__")).toBe(true);
	});

	it("untagged dispatch lands under general/ with timestamp prefix", () => {
		const startedAt = new Date("2026-05-28T10:00:00Z");
		const p = computeTranscriptPath(tmpRoot, "engineer", undefined, startedAt);
		expect(path.basename(path.dirname(p))).toBe("general");
		expect(path.basename(p)).toBe("20260528T100000Z__engineer.json");
	});
});

describe("writeSubagentTranscript", () => {
	const startedAt = new Date("2026-05-28T13:35:00Z");

	it("writes a JSON transcript with an ISO-prefixed filename", () => {
		const outPath = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "engineer",
			tag: "HLO-S01-T01__plan",
			result: {
				exitCode: 0,
				messages: [],
				usage: emptyUsage,
				model: "glm-5.1:cloud",
				stopReason: "endTurn",
			},
			startedAt,
		});
		expect(fs.existsSync(outPath)).toBe(true);
		expect(path.basename(outPath)).toBe("20260528T133500Z__HLO-S01-T01__plan.json");
		expect(path.basename(path.dirname(outPath))).toBe("HLO-S01-T01");
	});

	it("captures startedAt + finishedAt in payload", () => {
		const outPath = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "supervisor",
			tag: "FORGE-BUG-040__review-code",
			result: {
				exitCode: 1,
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] } as never],
				usage: { ...emptyUsage, input: 100, turns: 1 },
				model: "glm-5.1:cloud",
				stopReason: "aborted",
				errorMessage: "user cancelled",
			},
			startedAt,
		});
		const payload = JSON.parse(fs.readFileSync(outPath, "utf-8"));
		expect(payload.schema).toBe("forge-subagent-transcript/v1");
		expect(payload.startedAt).toBe(startedAt.toISOString());
		expect(typeof payload.finishedAt).toBe("string");
		expect(payload.exitCode).toBe(1);
		expect(payload.stopReason).toBe("aborted");
		expect(payload.usage.input).toBe(100);
		expect(payload.persona).toBe("supervisor");
	});

	it("works without an exportTag", () => {
		const outPath = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "engineer",
			result: { exitCode: 0, messages: [], usage: emptyUsage },
			startedAt,
		});
		expect(path.basename(path.dirname(outPath))).toBe("general");
		expect(path.basename(outPath)).toBe("20260528T133500Z__engineer.json");
	});

	it("sanitises unsafe characters from persona and tag for filesystem safety", () => {
		const outPath = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "weird/name with spaces",
			tag: "../escape/attempt",
			result: { exitCode: 0, messages: [], usage: emptyUsage },
			startedAt,
		});
		const fname = path.basename(outPath);
		expect(fname).not.toMatch(/\.\./);
		expect(fname).toMatch(/\.json$/);
		// Basename never contains slashes; the prefix is the timestamp.
		expect(fname.startsWith("20260528T133500Z__")).toBe(true);
	});

	it("two successive runs of the same phase at different times do not overwrite (FORGE-BUG-040 follow-up)", () => {
		const tag = "FORGE-BUG-040__plan-fix";
		const p1 = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "engineer",
			tag,
			result: { exitCode: 0, messages: [], usage: emptyUsage },
			startedAt: new Date("2026-05-28T08:00:00Z"),
		});
		const p2 = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "engineer",
			tag,
			result: { exitCode: 0, messages: [], usage: emptyUsage },
			startedAt: new Date("2026-05-28T09:00:00Z"),
		});
		expect(p1).not.toBe(p2);
		expect(fs.existsSync(p1)).toBe(true);
		expect(fs.existsSync(p2)).toBe(true);
		// Both transcripts live in the same entity directory.
		expect(path.dirname(p1)).toBe(path.dirname(p2));
	});
});
