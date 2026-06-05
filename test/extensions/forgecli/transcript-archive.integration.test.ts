// Integration test: full write→read loop over the central transcript archive
// under the FORGE_CLI_HOME env override — fake project → archiveRun →
// /forge:transcripts list/show see the run with correct totals.
//
// Also covers the Commit-3 wiring contract: a phase-end event carrying
// `subagentTranscriptPath` (now populated by run-task/fix-bug from
// SubagentResult.subagentTranscriptPath) matches its phase file by basename
// even when role-order matching would be ambiguous.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	collectListRows,
	formatList,
	resolveRun,
} from "../../../src/extensions/forgecli/commands/transcripts-command.js";
import { archiveRun, sweepProjectTranscripts } from "../../../src/extensions/forgecli/transcript-archive.js";

let tmpRoot: string;
let projectDir: string;
const PRIOR_FORGE_CLI_HOME = process.env.FORGE_CLI_HOME;
const PRIOR_SKIP_MIGRATION = process.env.FORGE_CLI_SKIP_MIGRATION;

const TASK_ID = "FAKE-S01-T01";
const START = "2026-06-03T08:00:00.000Z";

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-archive-integration-"));
	process.env.FORGE_CLI_HOME = path.join(tmpRoot, "forge-cli-user");
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";
	projectDir = path.join(tmpRoot, "fake-project");
	fs.mkdirSync(path.join(projectDir, ".forge"), { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, ".forge", "config.json"),
		JSON.stringify({ version: "1.0", project: { prefix: "FAKE", name: "Fake Project" } }),
		"utf8",
	);
});

afterEach(() => {
	if (PRIOR_FORGE_CLI_HOME === undefined) delete process.env.FORGE_CLI_HOME;
	else process.env.FORGE_CLI_HOME = PRIOR_FORGE_CLI_HOME;
	if (PRIOR_SKIP_MIGRATION === undefined) delete process.env.FORGE_CLI_SKIP_MIGRATION;
	else process.env.FORGE_CLI_SKIP_MIGRATION = PRIOR_SKIP_MIGRATION;
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writePhase(entityDir: string, ts: string, role: string, usage: { input: number; output: number; cost: number }): string {
	const name = `${ts}__${TASK_ID}__${role}.json`;
	fs.writeFileSync(
		path.join(entityDir, name),
		JSON.stringify({
			schema: "forge-subagent-transcript/v1",
			startedAt: ts,
			persona: role,
			model: "claude-sonnet-4-6",
			provider: "anthropic",
			exitCode: 0,
			usage: { ...usage, cacheRead: 0, cacheWrite: 0, contextTokens: 0, turns: 1 },
			messageCount: 1,
			messages: [{ role: "assistant", content: [{ type: "text", text: `${role} done` }] }],
		}),
		"utf8",
	);
	return name;
}

/**
 * Seed a run shaped exactly like a wired orchestrator produces it: two
 * plan-phase attempts (revision loop) where the phase-end events carry
 * subagentTranscriptPath — basename matching must pair attempt 2's verdict
 * with attempt 2's file, not fall back to first-by-role.
 */
function seedWiredRun(): { jsonlPath: string; planFiles: string[] } {
	const entityDir = path.join(projectDir, ".forge", "transcripts", TASK_ID);
	fs.mkdirSync(entityDir, { recursive: true });

	const plan1 = writePhase(entityDir, "20260603T080001Z", "plan", { input: 1000, output: 100, cost: 0.2 });
	const plan2 = writePhase(entityDir, "20260603T081001Z", "plan", { input: 1500, output: 300, cost: 0.4 });

	const jsonlPath = path.join(entityDir, `20260603T080000Z__${TASK_ID}__orchestrator.jsonl`);
	const events = [
		{ kind: "pipeline-start", ts: START, entityKind: "task", entityId: TASK_ID },
		{
			kind: "phase-end",
			ts: "2026-06-03T08:09:00.000Z",
			phase: "plan",
			phaseIndex: 0,
			attempt: 1,
			verdict: "revision",
			elapsedMs: 540000,
			subagentTranscriptPath: path.join(entityDir, plan1),
		},
		{ kind: "phase-loopback", ts: "2026-06-03T08:10:00.000Z", fromPhase: "review-plan", toPhase: "plan", fromPhaseIndex: 1, toPhaseIndex: 0, reason: "revision" },
		{
			kind: "phase-end",
			ts: "2026-06-03T08:19:00.000Z",
			phase: "plan",
			phaseIndex: 0,
			attempt: 2,
			verdict: "approved",
			elapsedMs: 530000,
			subagentTranscriptPath: path.join(entityDir, plan2),
		},
		{ kind: "pipeline-end", ts: "2026-06-03T08:20:00.000Z", outcome: "complete", elapsedMs: 1200000 },
	];
	fs.writeFileSync(jsonlPath, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");
	return { jsonlPath, planFiles: [plan1, plan2] };
}

describe("archive write→read loop (env override)", () => {
	it("archiveRun with sprintId → list shows the run with correct totals", () => {
		const { jsonlPath } = seedWiredRun();
		const result = archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath, sprintId: "FAKE-S01" });
		expect(result.archived).toBe(true);

		const rows = collectListRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			entityId: TASK_ID,
			entityKind: "task",
			sprintId: "FAKE-S01",
			projectName: "Fake Project",
			outcome: "complete",
			input: 2500,
			output: 400,
			durationMs: 1200000,
		});
		expect(rows[0].cost).toBeCloseTo(0.6);

		// Sprint back-reference is a list filter too (no synthetic container).
		expect(collectListRows({ entityId: "FAKE-S01" })).toHaveLength(1);

		const joined = formatList(rows).join("\n");
		expect(joined).toContain(TASK_ID);
		expect(joined).toContain("(FAKE-S01)");
	});

	it("matches verdicts to phase files via subagentTranscriptPath basename", () => {
		const { jsonlPath, planFiles } = seedWiredRun();
		archiveRun({ cwd: projectDir, orchestratorJsonlPath: jsonlPath });

		const resolved = resolveRun(TASK_ID);
		expect(resolved).not.toBeNull();
		const phases = resolved!.manifest.phases;
		expect(phases).toHaveLength(2);

		const attempt1 = phases.find((p) => p.file === planFiles[0]);
		const attempt2 = phases.find((p) => p.file === planFiles[1]);
		expect(attempt1).toMatchObject({ role: "plan", attempt: 1, verdict: "revision" });
		expect(attempt2).toMatchObject({ role: "plan", attempt: 2, verdict: "approved" });
		expect(resolved!.manifest.totals.revisionLoops).toBe(1);
	});

	it("pipeline-start sweep adopts the run when the archive call never happened (crash recovery)", () => {
		seedWiredRun();
		expect(collectListRows()).toHaveLength(0);

		const swept = sweepProjectTranscripts(projectDir);
		expect(swept).toEqual({ adopted: 1, errors: 0 });
		expect(collectListRows()).toHaveLength(1);

		// Re-sweep is a no-op; a later archiveRun (resume finishing the same
		// runId) overwrites the manifest without duplicating the index line.
		expect(sweepProjectTranscripts(projectDir)).toEqual({ adopted: 0, errors: 0 });
		expect(collectListRows()).toHaveLength(1);
	});
});
