// Unit tests for skill-curator-subagent module (FORGE-S24-T10).
//
// Per-task curator: at task close, the orchestrator hands a trajectory summary,
// the retrieved skills' bodies, and the task outcome to a curator subagent.
// The curator returns zero or more proposal JSON objects, and this module
// writes the deduped batch to the project-local enhancement-proposals queue
// at `.forge/enhancement-proposals/queue/<sprintId>/<taskId>-<ts>.json` (T07
// consumes at sprint close).
//
// Coverage:
//   parseProposalsFromOutput:
//     1. Extracts a single fenced ```json [...] block of valid proposals.
//     2. Extracts proposals from a bare JSON array in the body.
//     3. Returns [] when the output is free-form prose with no JSON.
//     4. Discards items missing required schema keys (op/target_path/diff_body).
//     5. Discards items whose `op` is outside the canonical enum.
//
//   runSkillCurator (with mocked runForgeSubagent):
//     6. Composes a first-user-message that carries the trajectory summary,
//        retrieved-skill bodies, and task outcome verdict.
//     7. Dispatches via runForgeSubagent (Iron Law 10 — fresh session, isolated
//        context); does NOT call store-cli emit itself (Slice 2 contract).
//     8. Writes the deduped proposals to the canonical queue path.
//     9. Dedupes proposals by {op, target_path, sha256(diff_body)} before write.
//    10. Refuses to overwrite an existing queue file (append-only invariant) —
//        retries with a fresh ts suffix.
//    11. Returns { written: 0 } when the curator emits no parseable proposals
//        and writes NO queue file (zero-noise invariant).
//    12. Surfaces a subagent failure (exitCode=1) as a structured result
//        without throwing (IL7).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock forge-subagent BEFORE importing the curator module.
vi.mock("../../../src/extensions/forgecli/forge-subagent.js", () => ({
	runForgeSubagent: vi.fn(),
	loadForgePersona: vi.fn(),
	getFinalOutput: vi.fn(),
}));

import {
	runForgeSubagent,
	getFinalOutput,
} from "../../../src/extensions/forgecli/forge-subagent.js";
import {
	parseProposalsFromOutput,
	runSkillCurator,
	composeCuratorTask,
	type CuratorInput,
	type RetrievedSkillBody,
} from "../../../src/extensions/forgecli/skill-curator-subagent.js";

const mockRunForgeSubagent = vi.mocked(runForgeSubagent);
const mockGetFinalOutput = vi.mocked(getFinalOutput);

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-curator-"));
	fs.mkdirSync(path.join(tmpRoot, ".forge"), { recursive: true });
	mockRunForgeSubagent.mockReset();
	mockGetFinalOutput.mockReset();
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.clearAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const skill1: RetrievedSkillBody = {
	skillId: "store-query-nlp",
	name: "store-query-nlp",
	body: "# store-query-nlp\nUse this skill to query the store.\nSteps: store-cli query, store-cli list.",
};

const skill2: RetrievedSkillBody = {
	skillId: "calibrate",
	name: "calibrate",
	body: "# calibrate\nDetect drift; propose patches.",
};

function baseInput(): CuratorInput {
	return {
		sprintId: "FORGE-S24",
		taskId: "FORGE-S24-T10",
		cwd: tmpRoot,
		ts: "20260522T000000Z",
		trajectorySummary:
			"Agent planned, implemented skill-curator-subagent.ts, ran tests, all pass.",
		retrievedSkills: [skill1, skill2],
		outcome: { verdict: "approved", notes: "Tests pass; commit clean." },
	};
}

const validProposal = {
	op: "update_skill",
	target_path: "forge/skills/engineer-skills.md",
	diff_body: "@@ +line @@ add note about curator dispatch",
	rationale: "Engineer should be aware of curator at task close.",
};

const validProposal2 = {
	op: "insert_skill",
	target_path: "forge/skills/new-skill.md",
	diff_body: "# new-skill\nbody",
	rationale: "Captures recurring pattern.",
};

// ── parseProposalsFromOutput ──────────────────────────────────────────────

describe("skill-curator-subagent / parseProposalsFromOutput", () => {
	it("extracts proposals from a fenced ```json block", () => {
		const text =
			"Some reasoning.\n\n```json\n" +
			JSON.stringify([validProposal]) +
			"\n```\n\nThanks.";
		const out = parseProposalsFromOutput(text);
		expect(out.length).toBe(1);
		expect(out[0].op).toBe("update_skill");
	});

	it("extracts proposals from a bare JSON array", () => {
		const text =
			"PROPOSALS:\n" + JSON.stringify([validProposal, validProposal2]);
		const out = parseProposalsFromOutput(text);
		expect(out.length).toBe(2);
	});

	it("returns [] when output is free-form prose with no JSON", () => {
		expect(parseProposalsFromOutput("No proposals — nothing to enrich.")).toEqual([]);
	});

	it("discards items missing required schema keys", () => {
		const bad = { op: "update_skill", target_path: "x" }; // missing diff_body
		const text = "```json\n" + JSON.stringify([validProposal, bad]) + "\n```";
		const out = parseProposalsFromOutput(text);
		expect(out.length).toBe(1);
		expect(out[0].op).toBe("update_skill");
	});

	it("discards items with an unknown op enum value", () => {
		const bad = {
			op: "rewrite_universe",
			target_path: "x",
			diff_body: "y",
		};
		const text = "```json\n" + JSON.stringify([bad, validProposal]) + "\n```";
		const out = parseProposalsFromOutput(text);
		expect(out.length).toBe(1);
		expect(out[0].op).toBe("update_skill");
	});
});

// ── composeCuratorTask ────────────────────────────────────────────────────

describe("skill-curator-subagent / composeCuratorTask", () => {
	it("includes trajectory summary, retrieved-skill bodies, and outcome verdict", () => {
		const body = composeCuratorTask(baseInput());
		expect(body).toContain("FORGE-S24-T10");
		expect(body).toContain("Agent planned, implemented");
		expect(body).toContain("store-query-nlp");
		expect(body).toContain("calibrate");
		expect(body).toContain("approved");
	});
});

// ── runSkillCurator ───────────────────────────────────────────────────────

describe("skill-curator-subagent / runSkillCurator", () => {
	function mockSubagentReturning(finalText: string) {
		mockRunForgeSubagent.mockResolvedValue({
			exitCode: 0,
			messages: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 1,
			},
			model: "claude-opus-4-7",
			provider: "anthropic",
		} as unknown as Awaited<ReturnType<typeof runForgeSubagent>>);
		mockGetFinalOutput.mockReturnValue(finalText);
	}

	it("dispatches via runForgeSubagent and writes deduped proposals to the canonical queue path", async () => {
		mockSubagentReturning(
			"```json\n" + JSON.stringify([validProposal, validProposal2]) + "\n```",
		);

		const result = await runSkillCurator(baseInput());

		// Dispatch invariants (Iron Law 10).
		expect(mockRunForgeSubagent).toHaveBeenCalledTimes(1);
		const dispatchArgs = mockRunForgeSubagent.mock.calls[0][0];
		expect(dispatchArgs.cwd).toBe(tmpRoot);
		// First user message carries trajectory + retrieved skills + outcome.
		expect(typeof dispatchArgs.task).toBe("string");
		expect(dispatchArgs.task).toContain("FORGE-S24-T10");
		expect(dispatchArgs.task).toContain("store-query-nlp");

		// Queue write at canonical path.
		const expectedPath = path.join(
			tmpRoot,
			".forge",
			"enhancement-proposals",
			"queue",
			"FORGE-S24",
			"FORGE-S24-T10-20260522T000000Z.json",
		);
		expect(result.queueFile).toBe(expectedPath);
		expect(result.written).toBe(2);
		expect(fs.existsSync(expectedPath)).toBe(true);

		const written = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
		expect(Array.isArray(written)).toBe(true);
		expect(written.length).toBe(2);
		expect(written[0].op).toBe("update_skill");
	});

	it("dedupes proposals by {op, target_path, sha256(diff_body)} before writing", async () => {
		const dupe = { ...validProposal, rationale: "different rationale, same diff body" };
		mockSubagentReturning(
			"```json\n" + JSON.stringify([validProposal, dupe, validProposal2]) + "\n```",
		);

		const result = await runSkillCurator(baseInput());
		expect(result.written).toBe(2);

		const written = JSON.parse(fs.readFileSync(result.queueFile!, "utf8"));
		expect(written.length).toBe(2);

		// Verify the dedupe key actually collapsed the duplicate (sha256 same).
		const h1 = crypto
			.createHash("sha256")
			.update(validProposal.diff_body, "utf8")
			.digest("hex");
		const h2 = crypto
			.createHash("sha256")
			.update(dupe.diff_body, "utf8")
			.digest("hex");
		expect(h1).toBe(h2);
	});

	it("refuses to overwrite an existing queue file and retries with a fresh ts (append-only invariant)", async () => {
		mockSubagentReturning("```json\n" + JSON.stringify([validProposal]) + "\n```");

		// Pre-create the canonical path so the first attempted ts collides.
		const collisionPath = path.join(
			tmpRoot,
			".forge",
			"enhancement-proposals",
			"queue",
			"FORGE-S24",
			"FORGE-S24-T10-20260522T000000Z.json",
		);
		fs.mkdirSync(path.dirname(collisionPath), { recursive: true });
		fs.writeFileSync(collisionPath, "[]", "utf8");

		const result = await runSkillCurator(baseInput());
		expect(result.written).toBe(1);
		// New file at a different (suffixed) path.
		expect(result.queueFile).not.toBe(collisionPath);
		expect(result.queueFile!.startsWith(path.dirname(collisionPath))).toBe(true);
		expect(fs.existsSync(result.queueFile!)).toBe(true);

		// Original file untouched.
		expect(fs.readFileSync(collisionPath, "utf8")).toBe("[]");
	});

	it("writes no file when the curator emits zero parseable proposals (zero-noise)", async () => {
		mockSubagentReturning("No actionable enrichment proposals at this time.");
		const result = await runSkillCurator(baseInput());
		expect(result.written).toBe(0);
		expect(result.queueFile).toBeUndefined();

		const dir = path.join(
			tmpRoot,
			".forge",
			"enhancement-proposals",
			"queue",
			"FORGE-S24",
		);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("surfaces a subagent failure (exitCode=1) without throwing (IL7)", async () => {
		mockRunForgeSubagent.mockResolvedValue({
			exitCode: 1,
			messages: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			model: "claude-opus-4-7",
			provider: "anthropic",
			errorMessage: "session aborted",
			stopReason: "error",
		} as unknown as Awaited<ReturnType<typeof runForgeSubagent>>);
		mockGetFinalOutput.mockReturnValue("");

		const result = await runSkillCurator(baseInput());
		expect(result.exitCode).toBe(1);
		expect(result.written).toBe(0);
		expect(result.errorMessage).toContain("session aborted");
		// Subagent path must NOT have emitted any store-cli events itself
		// (Slice 2 contract — orchestrator emits; curator returns silently).
	});
});
