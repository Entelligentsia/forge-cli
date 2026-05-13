// Unit test for writeSubagentTranscript — forge-cli#8.
//
// The integration (runForgeSubagent calls writeSubagentTranscript in finally)
// is exercised in orientation-wiring.test.ts via the captured loader.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeSubagentTranscript } from "../../../src/extensions/forgecli/forge-subagent.js";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-transcript-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const emptyUsage = {
	input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0,
};

describe("writeSubagentTranscript", () => {
	it("writes a JSON transcript to cwd with greppable filename", () => {
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
		});
		expect(fs.existsSync(outPath)).toBe(true);
		const fname = path.basename(outPath);
		expect(fname).toMatch(/^forge-subagent-/);
		expect(fname).toMatch(/__engineer__/);
		expect(fname).toMatch(/HLO-S01-T01__plan/);
		expect(fname).toMatch(/\.json$/);
	});

	it("captures stopReason, errorMessage, exitCode, usage, messages", () => {
		const outPath = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "supervisor",
			result: {
				exitCode: 1,
				messages: [{ role: "user", content: [{ type: "text", text: "hi" }] } as never],
				usage: { ...emptyUsage, input: 100, turns: 1 },
				model: "glm-5.1:cloud",
				stopReason: "aborted",
				errorMessage: "user cancelled",
			},
		});
		const payload = JSON.parse(fs.readFileSync(outPath, "utf-8"));
		expect(payload.schema).toBe("forge-subagent-transcript/v1");
		expect(payload.exitCode).toBe(1);
		expect(payload.stopReason).toBe("aborted");
		expect(payload.errorMessage).toBe("user cancelled");
		expect(payload.usage.input).toBe(100);
		expect(payload.messageCount).toBe(1);
		expect(payload.messages[0].content[0].text).toBe("hi");
		expect(payload.persona).toBe("supervisor");
		expect(payload.cwd).toBe(tmpRoot);
	});

	it("works without an exportTag", () => {
		const outPath = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "engineer",
			result: { exitCode: 0, messages: [], usage: emptyUsage },
		});
		const fname = path.basename(outPath);
		expect(fname).toMatch(/^forge-subagent-/);
		expect(fname).toMatch(/__engineer\.json$/);
	});

	it("sanitises unsafe characters from persona and tag for filesystem safety", () => {
		const outPath = writeSubagentTranscript({
			cwd: tmpRoot,
			persona: "weird/name with spaces",
			tag: "../escape/attempt",
			result: { exitCode: 0, messages: [], usage: emptyUsage },
		});
		const fname = path.basename(outPath);
		expect(fname).not.toMatch(/\//);
		expect(fname).not.toMatch(/\s/);
		expect(fname).not.toMatch(/\.\./);
		expect(fname).toMatch(/\.json$/);
	});
});
